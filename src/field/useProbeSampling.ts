import { useEffect, useRef, useState } from 'react';
import {
  SamplingController,
  type Mode,
  type ProbeSpec,
  type RunPhase,
  type SampleResult,
} from './probeCore';

export interface ProbeSamplingState {
  /** 当前展示的数据（拖动时为低分辨率实时结果，静止后切换为高密度最终结果） */
  result: SampleResult | null;
  /** 当前 result 对应的规格（分辨率可能与目标 density 不同） */
  resultSpec: ProbeSpec | null;
  /** 状态标记，供 UI 明确区分实时/重算/缓存/无效 */
  phase: RunPhase | 'idle';
  /** 是否为实时（未完成的高分辨率结果） */
  live: boolean;
  /** 当前展示结果是否来自缓存 */
  fromCache: boolean;
  /** 高密度重算进行中（此时可能同时展示着上一版实时/缓存数据） */
  recomputing: boolean;
  invalid: boolean;
  invalidReason: string;
}

const INITIAL: ProbeSamplingState = {
  result: null,
  resultSpec: null,
  phase: 'idle',
  live: false,
  fromCache: false,
  recomputing: false,
  invalid: false,
  invalidReason: '',
};

/**
 * 采样编排策略（实时重算 vs 缓存的明确取舍）：
 *
 * 1. dragging=true（用户正在拖剖面）→ 立即同步算一版低分辨率（≤28²）结果，
 *    不写缓存、不启动高密度任务，保证画面始终跟手；
 * 2. dragging=false（松手 / 参数改变）→ 先 debounce 140ms（合并 strength
 *    滑块等高频输入），再发起高密度异步分块采样；任务可被后续输入取消
 *    （generation 过期丢弃），完成或命中缓存后替换展示数据。
 * 3. 组件卸载或禁用剖面时取消在途任务，避免无意义 CPU 占用与卸载后回调。
 */
export function useProbeSampling(
  mode: Mode,
  strength: number,
  probe: ProbeSpec,
  dragging: boolean,
  enabled: boolean,
  debounceMs = 140,
): ProbeSamplingState {
  const ctrlRef = useRef<SamplingController | null>(null);
  if (!ctrlRef.current) ctrlRef.current = new SamplingController({ yieldEvery: 8 });

  const [state, setState] = useState<ProbeSamplingState>(INITIAL);
  // 记录最后一次发起的 final 任务取消函数，卸载时兜底取消
  const cancelFinalRef = useRef<(() => void) | null>(null);
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;

  useEffect(() => {
    const ctrl = ctrlRef.current!;
    if (!enabled) {
      cancelFinalRef.current?.();
      cancelFinalRef.current = null;
      setState(INITIAL);
      return;
    }

    // 输入变化（开始拖动、场型/强度/尺寸改变等）：
    // 若上一轮已发起高密度任务，取消它，避免拖动期间继续占用 CPU。
    // （同一控制器内新的 live request 也会令其代数过期，这里显式取消
    //  以立即停止计算；旧任务的任何迟到结果都不会回调。）
    cancelFinalRef.current?.();
    cancelFinalRef.current = null;

    // —— 实时低分辨率：同步发起，回调在本 effect 内同步发生 ——
    const liveCancel = ctrl.request(
      { mode, strength, probe, live: true },
      {
        onPhase: () => undefined,
        onResult: (result, spec) => {
          setState((prev) => ({
            ...prev,
            result,
            resultSpec: spec,
            phase: 'live',
            live: true,
            fromCache: false,
            recomputing: !draggingRef.current,
            invalid: false,
            invalidReason: '',
          }));
        },
        onInvalid: (reason) => {
          setState((prev) => ({ ...prev, invalid: true, invalidReason: reason, phase: 'invalid' }));
        },
      },
    );

    // —— 高密度最终结果：拖动中不发起；静止后 debounce ——
    if (!dragging) {
      const timer = window.setTimeout(() => {
        cancelFinalRef.current = ctrl.request(
          { mode, strength, probe, live: false },
          {
            onPhase: (phase) => {
              if (phase === 'sampling') {
                setState((prev) =>
                  prev.phase === 'live'
                    ? { ...prev, recomputing: true, invalid: false, invalidReason: '' }
                    : { ...prev, recomputing: true, phase, invalid: false, invalidReason: '' },
                );
              }
            },
            onResult: (result, spec, _kind, fromCache) => {
              cancelFinalRef.current = null;
              setState((prev) => ({
                ...prev,
                result,
                resultSpec: spec,
                phase: 'cached',
                live: false,
                fromCache,
                recomputing: false,
                invalid: false,
                invalidReason: '',
              }));
            },
            onInvalid: (reason) => {
              cancelFinalRef.current = null;
              setState((prev) => ({ ...prev, invalid: true, invalidReason: reason, phase: 'invalid' }));
            },
          },
        );
      }, debounceMs);

      return () => {
        liveCancel();
        window.clearTimeout(timer);
        // 在途的 final 任务由 effect 顶部的统一取消逻辑在下一轮处理；
        // 若本 effect 就是因卸载而清理，则下面的卸载兜底也会取消它。
        cancelFinalRef.current?.();
        cancelFinalRef.current = null;
      };
    }

    return () => {
      liveCancel();
    };
  }, [mode, strength, probe, dragging, enabled, debounceMs]);

  // 卸载兜底：取消仍在运行的高密度分块任务（中断恢复的资源侧）
  useEffect(() => {
    return () => {
      cancelFinalRef.current?.();
      cancelFinalRef.current = null;
    };
  }, []);

  return state;
}
