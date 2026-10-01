import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planeBasis,
  planePointToWorld,
  worldPointToPlane,
  pickOnPlane,
  resolveProbe,
  sampleProbe,
  slideAlongAxis,
  worldToField,
  fieldToWorld,
  FIELD_BOUNDS,
  MIN_SIZE,
  MAX_SIZE,
  LIVE_DENSITY,
  type AxisName,
  type Triple,
} from '../src/field/probeCore.js';

test('平面基向量：右手正交且 u×v=n', () => {
  for (const axis of ['x', 'y', 'z'] as AxisName[]) {
    const { u, v, n } = planeBasis(axis);
    assert.ok(Math.abs(u.x * v.x + u.y * v.y + u.z * v.z) < 1e-12, 'u⊥v');
    const cx = u.y * v.z - u.z * v.y;
    const cy = u.z * v.x - u.x * v.z;
    const cz = u.x * v.y - u.y * v.x;
    // 用近似比较，避免 -0 与 0 的严格相等差异
    assert.ok(Math.abs(cx - n.x) < 1e-12 && Math.abs(cy - n.y) < 1e-12 && Math.abs(cz - n.z) < 1e-12);
  }
});

test('剖面世界坐标不依赖场型/强度：同一物理位置只改变场值，几何不变', () => {
  const probe = { center: { x: 0.4, y: -0.6, z: 0.9 }, axis: 'z' as AxisName, size: 2, n: 20 };
  for (const mode of ['dipole', 'coil', 'capacitor'] as const) {
    const r = sampleProbe(probe, mode, 1.6);
    // 四角的物理（世界）位置在任何场型下都相同
    const corners: Array<[number, number]> = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (const [u, v] of corners) {
      const w = planePointToWorld({ ...probe, n: r.n }, u, v);
      const expected = {
        x: probe.center.x + (planeBasis('z').u.x * u + planeBasis('z').v.x * v) * 1,
        y: probe.center.y + (planeBasis('z').u.y * u + planeBasis('z').v.y * v) * 1,
        z: probe.center.z + (planeBasis('z').u.z * u + planeBasis('z').v.z * v) * 1,
      };
      assert.ok(Math.abs(w.x - expected.x) < 1e-12);
      assert.ok(Math.abs(w.y - expected.y) < 1e-12);
      assert.ok(Math.abs(w.z - expected.z) < 1e-12);
    }
  }
});

test('强度线性缩放场型时采样值相应缩放（位置不变）', () => {
  const probe = { center: { x: 0, y: 0, z: 0 }, axis: 'x' as AxisName, size: 2, n: 12 };
  const a = sampleProbe(probe, 'capacitor', 1);
  const b = sampleProbe(probe, 'capacitor', 2.5);
  assert.ok(Math.abs(b.max / a.max - 2.5) < 1e-9);
  assert.ok(Math.abs(b.mean / a.mean - 2.5) < 1e-9);
});

test('无效位置：NaN/Infinity 抛 RangeError；极大有限值不溢出，超界位置被钳制', () => {
  assert.throws(
    () => resolveProbe({ center: { x: NaN, y: 0, z: 0 }, axis: 'z', size: 2, n: 10 }),
    RangeError,
  );
  assert.throws(
    () => resolveProbe({ center: { x: 0, y: Infinity, z: 0 }, axis: 'z', size: 2, n: 10 }),
    RangeError,
  );
  assert.throws(
    () => resolveProbe({ center: { x: -Infinity, y: 0, z: 0 }, axis: 'z', size: 2, n: 10 }),
    RangeError,
  );
  // 1e308 是有限数，但直接做矩阵乘法会溢出为 NaN；先钳制可安全处理
  const huge = resolveProbe({ center: { x: 0, y: 1e308, z: 0 }, axis: 'z', size: 2, n: 10 });
  assert.ok(Number.isFinite(huge.center.x) && Number.isFinite(huge.center.y) && Number.isFinite(huge.center.z));
  const localHuge = worldToField(huge.center);
  assert.ok(Math.abs(localHuge.y) <= FIELD_BOUNDS + 1e-9);

  const far = resolveProbe({ center: { x: 50, y: 0, z: 0 }, axis: 'z', size: 2, n: 10 });
  const local = worldToField(far.center);
  assert.ok(Math.abs(local.x) <= FIELD_BOUNDS + 1e-9);

  assert.throws(
    () => resolveProbe({ center: { x: 0, y: 0, z: 0 }, axis: 'z', size: -3, n: 10 }),
    RangeError,
  );
  assert.throws(
    () => resolveProbe({ center: { x: 0, y: 0, z: 0 }, axis: 'z', size: NaN, n: 10 }),
    RangeError,
  );
  // 合法但超出范围的正尺寸：钳制而非报错
  const big = resolveProbe({ center: { x: 0, y: 0, z: 0 }, axis: 'z', size: 100, n: 10 });
  assert.equal(big.size, MAX_SIZE);
  const small = resolveProbe({ center: { x: 0, y: 0, z: 0 }, axis: 'z', size: 0.01, n: 10 });
  assert.equal(small.size, MIN_SIZE);
});

test('slideAlongAxis：视线平行于滑动轴时拖拽平面退化返回 null', () => {
  const center = { x: 0, y: 0, z: 0 };
  // 从 (0,0,5) 沿 -Z 正视 z 法向平面：视线平行于滑动轴 → 无法构造含轴拖拽平面
  const none = slideAlongAxis({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: -1 }, center, 'z');
  assert.equal(none, null);
});

test('slideAlongAxis：斜视角下严格沿世界轴平移，不产生侧向漂移', () => {
  const center = { x: 0, y: 0, z: 0 };
  // 斜视：射线不穿过中心，而是瞄准中心前方 z=+1 处一点，
  // 在“含 z 轴的拖拽平面”上截出非零的轴向位移
  const target = { x: 0, y: 0, z: 1 };
  const o = { x: 4, y: 3, z: 5 };
  const v0 = { x: target.x - o.x, y: target.y - o.y, z: target.z - o.z };
  const l = Math.hypot(v0.x, v0.y, v0.z);
  const d = { x: v0.x / l, y: v0.y / l, z: v0.z / l };
  const hit = slideAlongAxis(o, d, center, 'z');
  assert.ok(hit, '斜视应当相交');
  // z 轴拖拽：结果只能改变 z，且位移非零
  assert.ok(Math.abs(hit!.x) < 1e-9, `x 漂移 ${hit!.x}`);
  assert.ok(Math.abs(hit!.y) < 1e-9, `y 漂移 ${hit!.y}`);
  assert.ok(Math.abs(hit!.z) > 1e-6, `应当产生沿 z 的位移，实际 ${hit!.z}`);

  // 从正上方 (0,5,0.01) 几乎沿 -Y 看，仍能沿 z 滑
  const d2v = { x: 0, y: -5, z: -0.01 };
  const l2 = Math.hypot(d2v.x, d2v.y, d2v.z);
  const hit2 = slideAlongAxis({ x: 0, y: 5, z: 0.01 }, { x: 0, y: d2v.y / l2, z: d2v.z / l2 }, center, 'z');
  assert.ok(hit2);
  assert.ok(Math.abs(hit2!.x) < 1e-9);
  assert.ok(Math.abs(hit2!.y) < 1e-9);
});

test('slideAlongAxis：对 x/y 法向同样只沿对应世界轴移动', () => {
  const center = { x: 0.2, y: -0.3, z: 0.4 };
  const o = { x: 4, y: -2, z: 6 };
  const v = { x: center.x - o.x, y: center.y - o.y, z: center.z - o.z };
  const l = Math.hypot(v.x, v.y, v.z);
  const d = { x: v.x / l, y: v.y / l, z: v.z / l };
  const hx = slideAlongAxis(o, d, center, 'x')!;
  assert.ok(Math.abs(hx.y - center.y) < 1e-9 && Math.abs(hx.z - center.z) < 1e-9);
  const hy = slideAlongAxis(o, d, center, 'y')!;
  assert.ok(Math.abs(hy.x - center.x) < 1e-9 && Math.abs(hy.z - center.z) < 1e-9);
});

test('slideAlongAxis：无效输入（NaN/反向射线）返回 null 而非崩溃', () => {
  assert.equal(slideAlongAxis({ x: NaN, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 0 }, 'z'), null);
  assert.equal(slideAlongAxis({ x: 0, y: 0, z: -5 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 0 }, 'z'), null);
});

test('pickOnPlane：射线与剖面求交并映射到 [-1,1]', () => {
  const probe = { center: { x: 0, y: 0, z: 0 }, axis: 'z' as AxisName, size: 2, n: 8 };
  const o = { x: 0.5, y: 0.5, z: 5 };
  const d = { x: -0.1, y: -0.1, z: -1 };
  const l = Math.hypot(d.x, d.y, d.z);
  const hit = pickOnPlane(o, { x: d.x / l, y: d.y / l, z: d.z / l }, probe);
  assert.ok(hit);
  assert.ok(Math.abs(hit!.u) <= 1 && Math.abs(hit!.v) <= 1);
  // 世界反算：z=0 平面上
  const w = planePointToWorld(probe, hit!.u, hit!.v);
  assert.ok(Math.abs(w.z) < 1e-9);
  // 射线平行平面
  assert.equal(pickOnPlane({ x: 0, y: 0, z: 0.2 }, { x: 1, y: 0, z: 0 }, probe), null);
});

test('世界↔场坐标往返一致（旋转与相机无关）', () => {
  const p = { x: 1.7, y: -2.1, z: 0.4 };
  const rt = fieldToWorld(worldToField(p));
  assert.ok(Math.hypot(rt.x - p.x, rt.y - p.y, rt.z - p.z) < 1e-12);
});

test('实时密度上限被尊重（拖动同步采样的分辨率约束）', () => {
  const r = sampleProbe({ center: { x: 0, y: 0, z: 0 }, axis: 'y', size: 2, n: LIVE_DENSITY }, 'coil', 1);
  assert.equal(r.n, LIVE_DENSITY);
  assert.equal(r.grid.length, LIVE_DENSITY * LIVE_DENSITY);
});

test('场型/强度/相机变化后剖面对应同一物理位置：采样网格点世界坐标恒定', () => {
  // “相机变化”等价于改变观察方式——这里验证采样求值所用的世界采样点
  // 只由 probe（世界坐标）决定，与 mode/strength 无关。
  const probe = { center: { x: 0.5, y: -0.4, z: 0.2 }, axis: 'x' as AxisName, size: 2.4, n: 10 };
  const reference: Triple[] = [];
  for (const mode of ['dipole', 'coil', 'capacitor'] as const) {
    for (const strength of [0.5, 1.6, 3]) {
      const r = sampleProbe(probe, mode, strength);
      // 抽样校验若干网格单元的世界位置
      for (const idx of [0, 23, 55, 99]) {
        const j = Math.floor(idx / r.n);
        const i = idx % r.n;
        const u = (i / (r.n - 1)) * 2 - 1;
        const v = (j / (r.n - 1)) * 2 - 1;
        const w = planePointToWorld({ ...probe, n: r.n }, u, v);
        if (mode === 'dipole' && strength === 0.5) reference.push(w);
        else {
          const ref = reference[idx === 0 ? 0 : idx === 23 ? 1 : idx === 55 ? 2 : 3];
          assert.ok(Math.hypot(w.x - ref.x, w.y - ref.y, w.z - ref.z) < 1e-12);
        }
      }
    }
  }
});

test('选点持久性：拖动后同一世界物理点映射到新 (u,v)；移出平面则清除', () => {
  const probe = { center: { x: 0, y: 0, z: 0 }, axis: 'z' as AxisName, size: 2, n: 8 };
  // 选在世界坐标 (0.3, 0.3, 0)（归一化 0.3,0.3，半边长=1）
  const picked = { u: 0.3, v: 0.3 };
  const w = planePointToWorld(probe, picked.u, picked.v);
  assert.deepEqual([w.x, w.y, w.z], [0.3, 0.3, 0]);

  // 剖面沿 z 平移到 z=0.5：选点所在的平面变成 z=0.5，旧点不在新平面 → null
  assert.equal(worldPointToPlane({ ...probe, center: { x: 0, y: 0, z: 0.5 } }, w), null);

  // 拖动只沿法向、且保持物理点：模拟“选点跟着平面走”的语义——
  // 新中心沿 z 移动后，取同 (u,v) 处的新世界点，再反算应得到相同 (u,v)
  const moved = { ...probe, center: { x: 0, y: 0, z: 0.5 } };
  const w2 = planePointToWorld(moved, 0.3, 0.3);
  assert.deepEqual(worldPointToPlane(moved, w2), { u: 0.3, v: 0.3 });

  // 缩小尺寸到 0.4（半边长 0.2）：原世界点 (0.3,0.3) 落在平面外 → null
  assert.equal(worldPointToPlane({ ...probe, size: 0.4 }, w), null);

  // 缩小但仍包含该点（size=1，半边长 0.5）：归一化坐标放大到 0.6
  const inside = worldPointToPlane({ ...probe, size: 1 }, w);
  assert.ok(inside && Math.abs(inside.u - 0.6) < 1e-9 && Math.abs(inside.v - 0.6) < 1e-9);

  // 放大尺寸后该点仍在，归一化坐标相应缩小
  const back = worldPointToPlane({ ...probe, size: 4 }, w);
  assert.ok(back && Math.abs(back.u - 0.15) < 1e-9 && Math.abs(back.v - 0.15) < 1e-9);

  // 非平面点（带法向偏移）返回 null
  assert.equal(worldPointToPlane(probe, { x: 0.3, y: 0.3, z: 0.01 }), null);
});
