import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SamplingController,
  createManualScheduler,
  LIVE_DENSITY,
  cacheKey,
  type ProbeSpec,
} from '../src/field/probeCore.js';

const baseProbe: ProbeSpec = { center: { x: 0, y: 0, z: 0 }, axis: 'z', size: 2, n: 80 };
const mk = (over: Partial<ProbeSpec> = {}): ProbeSpec => ({ ...baseProbe, ...over });

function flushMicro(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

test('实时请求：同步返回低分辨率结果且不进入缓存', () => {
  const ctrl = new SamplingController();
  let phase = '';
  let gotN = 0;
  let kind = '';
  ctrl.request(
    { mode: 'dipole', strength: 1.6, probe: mk({ n: 160 }), live: true },
    {
      onPhase: (p) => (phase = p),
      onResult: (r, _s, k) => {
        gotN = r.n;
        kind = k;
      },
      onInvalid: () => assert.fail('不应无效'),
    },
  );
  assert.equal(phase, 'live');
  assert.equal(kind, 'live');
  assert.equal(gotN, Math.min(160, LIVE_DENSITY));
  assert.equal(ctrl.cacheHits(), 0);
});

test('高密度采样分块完成后返回最终结果并写入缓存；相同规格第二次命中缓存', async () => {
  const ctrl = new SamplingController({ yieldEvery: 8 });
  const phases: string[] = [];
  let resultN = 0;
  let fromCache = true;
  ctrl.request(
    { mode: 'coil', strength: 1, probe: mk(), live: false },
    {
      onPhase: (p) => phases.push(p),
      onResult: (r, _s, _k, cached) => {
        resultN = r.n;
        fromCache = cached;
      },
      onInvalid: () => assert.fail('不应无效'),
    },
  );
  assert.equal(phases[0], 'sampling');
  // 让出足够多的微任务让 80 行的分块循环跑完（80/8≈10 个让出点）
  for (let i = 0; i < 30; i++) await flushMicro();
  assert.equal(resultN, 80);
  assert.equal(fromCache, false);
  assert.equal(ctrl.cacheHits(), 1);

  // 第二次同规格 → 同步缓存命中
  let hitCache = false;
  ctrl.request(
    { mode: 'coil', strength: 1, probe: mk(), live: false },
    {
      onPhase: (p) => assert.equal(p, 'cached'),
      onResult: (_r, _s, _k, cached) => (hitCache = cached),
      onInvalid: () => assert.fail('不应无效'),
    },
  );
  assert.equal(hitCache, true);
});

test('中断恢复：高密度任务可在分块边界取消，取消后无回调；再次请求正常完成', async () => {
  const sched = createManualScheduler();
  const ctrl = new SamplingController({ yieldEvery: 4, scheduler: sched });
  let finished = 0;
  const cancel = ctrl.request(
    { mode: 'dipole', strength: 1, probe: mk({ n: 40 }), live: false },
    {
      onPhase: () => undefined,
      onResult: () => finished++,
      onInvalid: () => assert.fail('取消不应触发 invalid'),
    },
  );
  // request 同步启动分块循环，任务停在第一个让出点（j=4 行处理前）
  assert.equal(sched.pending(), true, '任务应停在第一个分块边界');
  assert.equal(ctrl.isRunning(), true);

  // 在边界处取消：遗留门控被放行，被中断任务的续体在随后微任务中终止
  cancel();
  assert.equal(ctrl.isRunning(), false);
  assert.equal(sched.pending(), false, '取消应放行遗留门控');
  await flushMicro(); // 让被中断续体走完（生产环境中微任务自然发生）
  assert.equal(finished, 0, '被取消的任务不回调');

  // 中断恢复：重新发起，逐边界放行直到完整跑完
  ctrl.request(
    { mode: 'dipole', strength: 1, probe: mk({ n: 40 }), live: false },
    {
      onPhase: () => undefined,
      onResult: () => finished++,
      onInvalid: () => assert.fail('不应无效'),
    },
  );
  assert.equal(sched.pending(), true);
  // n=40、每 4 行让出一次：共 9 个边界。每次 tick 放行一个边界，随后
  // flush 微任务让续体跑到下一个边界（生产环境由事件循环自然完成）。
  for (let i = 0; i < 40; i++) {
    sched.tick();
    await flushMicro();
  }
  assert.equal(finished, 1, '中断后重新采样可完成');
  assert.equal(sched.pending(), false);
});

test('过期结果丢弃：旧任务晚完成不得覆盖新请求的结果', async () => {
  const sched = createManualScheduler();
  const ctrl = new SamplingController({ yieldEvery: 4, scheduler: sched });
  let oldFinished = 0;

  ctrl.request(
    { mode: 'capacitor', strength: 1, probe: mk({ n: 40 }), live: false },
    {
      onPhase: () => undefined,
      onResult: () => oldFinished++,
      onInvalid: () => undefined,
    },
  );
  assert.equal(sched.pending(), true);

  // 旧任务停在第一个边界时，立即发起第二个不同强度的请求 → 第一个任务代数作废
  let secondResult: number | null = null;
  ctrl.request(
    { mode: 'capacitor', strength: 2.8, probe: mk({ n: 40 }), live: false },
    {
      onPhase: () => undefined,
      onResult: (r) => (secondResult = r.mean),
      onInvalid: () => undefined,
    },
  );
  // 旧任务遗留的门控已打开，先 flush 其续体（代数不符 → 立即终止）
  await flushMicro();
  // 此后只有新任务停在边界
  assert.equal(sched.pending(), true);
  // 放行所有边界：旧任务即使“本可跑完”也不能回调，只有新任务产出
  for (let i = 0; i < 60; i++) {
    sched.tick();
    await flushMicro();
  }
  assert.equal(oldFinished, 0, '旧（过期）任务的结果被丢弃');
  assert.notEqual(secondResult, null, '新请求正常产出');
  // 平行板场强 ≈ strength*(0.9±0.12)，确认拿到的是新强度而非旧的
  assert.ok(Math.abs(secondResult! - 2.8 * 0.9) < 0.6);
});

test('无效位置：final 请求进入 invalid 且不留缓存', () => {
  const ctrl = new SamplingController();
  let phase = '';
  let reason = '';
  ctrl.request(
    { mode: 'dipole', strength: 1, probe: { ...mk(), center: { x: NaN, y: 0, z: 0 } }, live: false },
    {
      onPhase: (p) => (phase = p),
      onResult: () => assert.fail('无效位置不应有结果'),
      onInvalid: (m) => (reason = m),
    },
  );
  assert.equal(phase, 'invalid');
  assert.match(reason, /位置/);
  assert.equal(ctrl.cacheHits(), 0);
});

test('尺寸变化：缓存键包含 size，改尺寸不复用旧结果', () => {
  const a = cacheKey('dipole', 1, mk({ size: 2 }));
  const b = cacheKey('dipole', 1, mk({ size: 3.5 }));
  assert.notEqual(a, b);
  const c = cacheKey('dipole', 1, mk({ size: 2, center: { x: 0.1, y: 0, z: 0 } }));
  assert.notEqual(a, c, '位置变化同样区分缓存');
  const d = cacheKey('coil', 1, mk({ size: 2 }));
  assert.notEqual(a, d, '场型变化区分缓存');
});

test('LRU：超出容量时最旧条目被淘汰，命中会提升顺序', async () => {
  const ctrl = new SamplingController({ cacheSize: 3 });
  const run = (x: number) =>
    new Promise<void>((resolve) => {
      ctrl.request(
        { mode: 'dipole', strength: 1, probe: mk({ n: 4, center: { x, y: 0, z: 0 } }), live: false },
        {
          onPhase: () => undefined,
          onResult: () => resolve(),
          onInvalid: () => resolve(),
        },
      );
    });
  await run(0.1);
  await run(0.2);
  await run(0.3);
  assert.equal(ctrl.cacheHits(), 3);
  // 命中第一个 → 提升为最近使用
  let hit = false;
  ctrl.request(
    { mode: 'dipole', strength: 1, probe: mk({ n: 4, center: { x: 0.1, y: 0, z: 0 } }), live: false },
    { onPhase: () => undefined, onResult: (_r, _s, _k, c) => (hit = c), onInvalid: () => undefined },
  );
  assert.ok(hit);
  // 插入第四个 → 应淘汰 0.2（当前最旧），0.1 因刚命中而保留
  await run(0.4);
  assert.equal(ctrl.cacheHits(), 3);
  let hit01 = false;
  ctrl.request(
    { mode: 'dipole', strength: 1, probe: mk({ n: 4, center: { x: 0.1, y: 0, z: 0 } }), live: false },
    { onPhase: () => undefined, onResult: (_r, _s, _k, c) => (hit01 = c), onInvalid: () => undefined },
  );
  assert.ok(hit01, '最近被命中的条目未被淘汰');
});

test('卸载场景：取消函数对在途任务生效，新请求不受其影响', async () => {
  const sched = createManualScheduler();
  const ctrl = new SamplingController({ yieldEvery: 4, scheduler: sched });
  let done = 0;
  const cancel = ctrl.request(
    { mode: 'coil', strength: 1, probe: mk({ n: 32 }), live: false },
    { onPhase: () => undefined, onResult: () => done++, onInvalid: () => undefined },
  );
  assert.equal(sched.pending(), true);
  cancel(); // 组件卸载：在边界取消并放行遗留门控
  await flushMicro();
  // 之后的新请求不应被旧 cancel 误伤
  ctrl.request(
    { mode: 'coil', strength: 1, probe: mk({ n: 8 }), live: false },
    { onPhase: () => undefined, onResult: () => done++, onInvalid: () => undefined },
  );
  for (let i = 0; i < 30; i++) {
    sched.tick();
    await flushMicro();
  }
  assert.equal(done, 1, '仅新请求完成');
});
