// 纯逻辑层：三维测量剖面的数学模型与采样调度。
// 本文件不依赖 React / three，可在 Node 下直接单元测试。
//
// 关键约定：
// - 剖面（ProbeSpec）的中心、法向、平面基向量全部使用【世界坐标】。
//   场源模型被放在一个带固定欧拉旋转的 group 中，采样时通过 group 的
//   旋转矩阵把世界坐标变换到“场坐标（模型局部坐标）”再求值；因此无论
//   相机如何旋转、场型/强度如何切换，剖面对应的都是同一个物理位置。

export type Mode = 'dipole' | 'coil' | 'capacitor';
export type AxisName = 'x' | 'y' | 'z';

export interface Triple {
  x: number;
  y: number;
  z: number;
}

/** 测量剖面：世界坐标下的正方形切片 */
export interface ProbeSpec {
  /** 剖面中心（世界坐标） */
  center: Triple;
  /** 剖面法向（世界坐标轴），平面与该轴垂直 */
  axis: AxisName;
  /** 正方形边长（世界单位） */
  size: number;
  /** 每边采样点数 n×n（高密度采样时可调大） */
  n: number;
}

export interface SampleResult {
  n: number;
  /** n*n 场强（模长），j*n+i 索引，i 沿 u 方向(-1→1)，j 沿 v 方向(-1→1) */
  grid: Float64Array;
  /** n*n*3 场矢量分量，世界坐标系 */
  vectors: Float64Array;
  max: number;
  mean: number;
  min: number;
}

/** 场景中场源 group 的固定旋转（与 App.tsx 中 group rotation 保持一致），欧拉序 XYZ */
export const FIELD_GROUP_EULER: Triple = { x: 0.18, y: -0.24, z: 0 };
/** 场坐标（模型空间）中允许的剖面中心范围，超出即钳制/判为无效 */
export const FIELD_BOUNDS = 3;
export const MIN_SIZE = 0.4;
export const MAX_SIZE = 8;
export const MAX_DENSITY = 256;
/** 实时（拖动中）使用的最高每边采样数：同步计算，保证跟手 */
export const LIVE_DENSITY = 28;

// ---------------------------------------------------------------------------
// 小型三维数学（列向量约定，与 three.js Matrix4 makeBasis 一致）
// ---------------------------------------------------------------------------

type Mat3 = number[]; // 行优先 3x3

function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] =
        a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

function apply3(m: Mat3, v: Triple): Triple {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

function transpose3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

function rotX(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
function rotY(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
function rotZ(a: number): Mat3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

// R = Rx * Ry * Rz（对应 three.js Euler 顺序 'XYZ'）
const FIELD_ROT: Mat3 = mul3(mul3(rotX(FIELD_GROUP_EULER.x), rotY(FIELD_GROUP_EULER.y)), rotZ(FIELD_GROUP_EULER.z));
const FIELD_ROT_T: Mat3 = transpose3(FIELD_ROT);

/** 世界坐标 → 场（模型局部）坐标 */
export function worldToField(p: Triple): Triple {
  return apply3(FIELD_ROT_T, p);
}

/** 场（模型局部）坐标 → 世界坐标 */
export function fieldToWorld(p: Triple): Triple {
  return apply3(FIELD_ROT, p);
}

// ---------------------------------------------------------------------------
// 场模型（与 App 原有 fieldAt 完全一致，改为纯 Triple，便于测试）
// ---------------------------------------------------------------------------

export function fieldVectorTriple(x: number, y: number, z: number, mode: Mode, strength: number): Triple {
  if (mode === 'capacitor') {
    return { x: 0, y: strength * (0.9 + 0.12 * Math.cos(x * 1.7)), z: 0 };
  }
  if (mode === 'coil') {
    return { x: -z * 0.35 * strength, y: 0.15 * strength, z: x * 0.35 * strength };
  }
  const r2 = x * x + y * y + z * z + 0.18;
  const scale = strength / Math.pow(r2, 2.1);
  return { x: 3 * x * z * scale, y: (3 * y * y - r2) * scale, z: 3 * z * x * scale };
}

// ---------------------------------------------------------------------------
// 剖面基向量（世界坐标，右手正交系；n = u × v）
// ---------------------------------------------------------------------------

export interface PlaneBasis {
  u: Triple;
  v: Triple;
  n: Triple;
}

const AXIS_VECTORS: Record<AxisName, Triple> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
};

export function planeBasis(axis: AxisName): PlaneBasis {
  if (axis === 'z') {
    // XY 平面：u=+X，v=+Y，n=+Z（u×v=Z）
    return { u: { ...AXIS_VECTORS.x }, v: { ...AXIS_VECTORS.y }, n: { ...AXIS_VECTORS.z } };
  }
  if (axis === 'y') {
    // XZ 平面：u=+X，v=-Z，n=+Y（X × -Z = Y）
    return { u: { ...AXIS_VECTORS.x }, v: { x: 0, y: 0, z: -1 }, n: { ...AXIS_VECTORS.y } };
  }
  // YZ 平面：u=+Y，v=+Z，n=+X（Y × Z = X）
  return { u: { ...AXIS_VECTORS.y }, v: { ...AXIS_VECTORS.z }, n: { ...AXIS_VECTORS.x } };
}

export function axisVector(axis: AxisName): Triple {
  return { ...AXIS_VECTORS[axis] };
}

export function isFiniteTriple(p: Triple): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 校验并归一化剖面：
 * - 中心含 NaN/Infinity（无效位置）→ 抛 RangeError；
 * - 中心先变换到场坐标并逐分量钳制到 [-BOUNDS, BOUNDS]，再旋回世界坐标。
 *   这样即便输入是 1e308 这类有限但极大、坐标变换中会溢出为 NaN 的值，
 *   也在变换前就被钳住（世界坐标下表现为斜向钳制），保证采样始终落在
 *   有物理意义的区域；
 * - size/n 钳制到合法范围。
 */
export function resolveProbe(probe: ProbeSpec): ProbeSpec {
  if (!probe || !isFiniteTriple(probe.center)) {
    throw new RangeError('无效的剖面位置（坐标不是有限数）');
  }
  if (!Number.isFinite(probe.size) || probe.size <= 0) {
    throw new RangeError('无效的剖面尺寸（必须为正数）');
  }
  // 先钳制世界分量，防止极大有限数在矩阵乘法中溢出成 NaN/Infinity
  const safeWorld: Triple = {
    x: clamp(probe.center.x, -FIELD_BOUNDS * 2, FIELD_BOUNDS * 2),
    y: clamp(probe.center.y, -FIELD_BOUNDS * 2, FIELD_BOUNDS * 2),
    z: clamp(probe.center.z, -FIELD_BOUNDS * 2, FIELD_BOUNDS * 2),
  };
  const local = worldToField(safeWorld);
  const clampedLocal: Triple = {
    x: clamp(local.x, -FIELD_BOUNDS, FIELD_BOUNDS),
    y: clamp(local.y, -FIELD_BOUNDS, FIELD_BOUNDS),
    z: clamp(local.z, -FIELD_BOUNDS, FIELD_BOUNDS),
  };
  const n = Math.round(clamp(probe.n, 1, MAX_DENSITY));
  return {
    center: fieldToWorld(clampedLocal),
    axis: probe.axis,
    size: clamp(probe.size, MIN_SIZE, MAX_SIZE),
    n,
  };
}

/**
 * 在 n×n 网格上同步采样（世界坐标剖面 → 场坐标求值 → 场矢量变换回世界坐标）。
 */
export function sampleProbe(probe: ProbeSpec, mode: Mode, strength: number): SampleResult {
  const spec = resolveProbe(probe);
  const { n, size, axis } = spec;
  const basis = planeBasis(axis);
  // 平面基向量变换到场坐标：采样点在“场空间”中求值
  const uLocal = apply3(FIELD_ROT_T, basis.u);
  const vLocal = apply3(FIELD_ROT_T, basis.v);
  const nWorld = basis.n;
  const cLocal = worldToField(spec.center);
  const half = size / 2;

  const grid = new Float64Array(n * n);
  const vectors = new Float64Array(n * n * 3);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;

  for (let j = 0; j < n; j++) {
    const tv = n === 1 ? 0 : (j / (n - 1)) * 2 - 1; // -1..1 沿 v
    for (let i = 0; i < n; i++) {
      const tu = n === 1 ? 0 : (i / (n - 1)) * 2 - 1; // -1..1 沿 u
      const px = cLocal.x + (uLocal.x * tu + vLocal.x * tv) * half;
      const py = cLocal.y + (uLocal.y * tu + vLocal.y * tv) * half;
      const pz = cLocal.z + (uLocal.z * tu + vLocal.z * tv) * half;
      const fLocal = fieldVectorTriple(px, py, pz, mode, strength);
      // 场矢量旋回世界坐标存储（方向始终相对世界轴表达）
      const fw = apply3(FIELD_ROT, fLocal);
      const mag = Math.sqrt(fw.x * fw.x + fw.y * fw.y + fw.z * fw.z);
      const idx = j * n + i;
      grid[idx] = mag;
      vectors[idx * 3] = fw.x;
      vectors[idx * 3 + 1] = fw.y;
      vectors[idx * 3 + 2] = fw.z;
      if (mag < min) min = mag;
      if (mag > max) max = mag;
      sum += mag;
    }
  }
  if (n === 1) min = max;
  return { n, grid, vectors, max, min, mean: sum / (n * n) };
}

/**
 * 沿世界轴滑动剖面中心 —— 拖拽交互的纯数学部分。
 *
 * 拖拽平面的构造方式（与 three.js DragControls 的轴拖拽一致）：
 * 取相机→中心的视线向量，剔除其沿滑动轴的分量，得到平面法向 N；
 * 该平面经过当前中心【且包含滑动轴】。射线与平面交于 P，再把
 * (P − center) 投影到滑动轴上。这样无论相机从什么角度照射，拖动都
 * 严格沿剖面法向（世界轴）平移：相机正对平面（视线平行于轴）时
 * N≈0 无法构造平面，本帧忽略，不会产生景深漂移。
 *
 * @param rayOrigin 射线原点（世界坐标）
 * @param rayDir 射线方向（单位向量，世界坐标）
 * @param center 当前剖面中心（世界坐标）
 * @param axis 滑动轴（剖面法向）
 * @returns 新的中心；拖拽平面退化（视线与轴近乎平行）时返回 null
 */
export function slideAlongAxis(
  rayOrigin: Triple,
  rayDir: Triple,
  center: Triple,
  axis: AxisName,
): Triple | null {
  if (!isFiniteTriple(rayOrigin) || !isFiniteTriple(rayDir) || !isFiniteTriple(center)) return null;
  const a = AXIS_VECTORS[axis];
  // 从射线原点指向中心的视线（注意用中心−原点，方向朝“物体”）
  let vx = center.x - rayOrigin.x;
  let vy = center.y - rayOrigin.y;
  let vz = center.z - rayOrigin.z;
  const vl = Math.hypot(vx, vy, vz);
  if (vl < 1e-9) return null;
  vx /= vl;
  vy /= vl;
  vz /= vl;
  // N = v − (v·a)a：平面法向 = 视线垂直于滑动轴的分量
  const dot = vx * a.x + vy * a.y + vz * a.z;
  let nx = vx - dot * a.x;
  let ny = vy - dot * a.y;
  let nz = vz - dot * a.z;
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-4) return null; // 视线几乎平行于轴 → 拖拽平面退化，本帧无效
  nx /= nl;
  ny /= nl;
  nz /= nl;

  const denom = rayDir.x * nx + rayDir.y * ny + rayDir.z * nz;
  if (Math.abs(denom) < 1e-6) return null;
  const cx = center.x - rayOrigin.x;
  const cy = center.y - rayOrigin.y;
  const cz = center.z - rayOrigin.z;
  const t = (cx * nx + cy * ny + cz * nz) / denom;
  if (!Number.isFinite(t) || t < 0) return null;
  const px = rayOrigin.x + rayDir.x * t;
  const py = rayOrigin.y + rayDir.y * t;
  const pz = rayOrigin.z + rayDir.z * t;
  // 位移投影到滑动轴
  const along = (px - center.x) * a.x + (py - center.y) * a.y + (pz - center.z) * a.z;
  if (!Number.isFinite(along)) return null;
  const candidate: Triple = {
    x: center.x + a.x * along,
    y: center.y + a.y * along,
    z: center.z + a.z * along,
  };
  if (!isFiniteTriple(candidate)) return null;
  // 交给 resolveProbe 在场空间做范围钳制
  return resolveProbe({ center: candidate, axis, size: 1, n: 1 }).center;
}

/**
 * 射线与剖面平面求交（点击选点用）。
 * @returns 平面上相对中心的归一化坐标 {u,v} ∈ [-1,1]（以半边长为单位），无效返回 null
 */
export function pickOnPlane(
  rayOrigin: Triple,
  rayDir: Triple,
  probe: ProbeSpec,
): { u: number; v: number } | null {
  if (!isFiniteTriple(rayOrigin) || !isFiniteTriple(rayDir)) return null;
  const basis = planeBasis(probe.axis);
  const denom = rayDir.x * basis.n.x + rayDir.y * basis.n.y + rayDir.z * basis.n.z;
  if (Math.abs(denom) < 1e-6) return null;
  const cx = probe.center.x - rayOrigin.x;
  const cy = probe.center.y - rayOrigin.y;
  const cz = probe.center.z - rayOrigin.z;
  const t = (cx * basis.n.x + cy * basis.n.y + cz * basis.n.z) / denom;
  if (!Number.isFinite(t) || t < 0) return null;
  const hx = rayOrigin.x + rayDir.x * t - probe.center.x;
  const hy = rayOrigin.y + rayDir.y * t - probe.center.y;
  const hz = rayOrigin.z + rayDir.z * t - probe.center.z;
  const half = probe.size / 2;
  const u = (hx * basis.u.x + hy * basis.u.y + hz * basis.u.z) / half;
  const v = (hx * basis.v.x + hy * basis.v.y + hz * basis.v.z) / half;
  if (Math.abs(u) > 1.001 || Math.abs(v) > 1.001) return null;
  return { u: clamp(u, -1, 1), v: clamp(v, -1, 1) };
}

/** 归一化平面坐标 (u,v) → 该点的世界坐标 */
export function planePointToWorld(probe: ProbeSpec, u: number, v: number): Triple {
  const basis = planeBasis(probe.axis);
  const half = probe.size / 2;
  return {
    x: probe.center.x + (basis.u.x * u + basis.v.x * v) * half,
    y: probe.center.y + (basis.u.y * u + basis.v.y * v) * half,
    z: probe.center.z + (basis.u.z * u + basis.v.z * v) * half,
  };
}

/**
 * 世界点 → 相对新剖面的归一化坐标 (u,v)。
 * 用于拖动后保持“同一物理选点”：若该点不在新剖面的法向平面上（距离
 * 超过容差），或落在平面范围外，返回 null。
 */
export function worldPointToPlane(probe: ProbeSpec, p: Triple): { u: number; v: number } | null {
  const basis = planeBasis(probe.axis);
  const hx = p.x - probe.center.x;
  const hy = p.y - probe.center.y;
  const hz = p.z - probe.center.z;
  // 与法向的距离必须近似为 0（拖动仅沿法向，选点本就在平面上）
  const normalDist = hx * basis.n.x + hy * basis.n.y + hz * basis.n.z;
  if (Math.abs(normalDist) > 1e-6) return null;
  const half = probe.size / 2;
  const u = (hx * basis.u.x + hy * basis.u.y + hz * basis.u.z) / half;
  const v = (hx * basis.v.x + hy * basis.v.y + hz * basis.v.z) / half;
  if (!Number.isFinite(u) || !Number.isFinite(v) || Math.abs(u) > 1 || Math.abs(v) > 1) return null;
  return { u, v };
}

export function nearestCell(result: SampleResult, u: number, v: number): { i: number; j: number; index: number } {
  const i = clamp(Math.round(((u + 1) / 2) * (result.n - 1)), 0, result.n - 1);
  const j = clamp(Math.round(((v + 1) / 2) * (result.n - 1)), 0, result.n - 1);
  return { i, j, index: j * result.n + i };
}

/** 把选点归一化坐标钳到 [-1,1]；输入非法时返回 null */
export function clampPicked(p: { u: number; v: number } | null): { u: number; v: number } | null {
  if (!p) return null;
  if (!Number.isFinite(p.u) || !Number.isFinite(p.v)) return null;
  return { u: clamp(p.u, -1, 1), v: clamp(p.v, -1, 1) };
}

// ---------------------------------------------------------------------------
// 采样调度：高密度分块异步、generation 取消、过期结果丢弃、LRU 缓存
// ---------------------------------------------------------------------------

export type Scheduler = () => Promise<void>;

/** 默认在每块之间让出一次微任务，使中断信号有机会生效 */
const microScheduler: Scheduler = () => Promise.resolve();

export interface ManualScheduler extends Scheduler {
  /** 放行一个在让出点等待的分块任务 */
  tick(): void;
  /** 是否有任务正停在让出点（任务抵达边界的同一时刻同步可见） */
  pending(): boolean;
  /**
   * 若有任务停在让出点，立即放行它（任务取消/被新请求取代时调用）。
   * 已失效的任务续体会在随后微任务的中断/代数检查处自行结束。
   */
  release(): void;
}

/**
 * 测试用“门控”调度器：分块任务每到一个让出边界就同步登记一个等待者并
 * 停住，测试用 tick() 精确放行一个边界，从而确定性地模拟高密度采样的
 * 分块推进、中途取消与中断恢复，不依赖微任务调度时序。
 */
export function createManualScheduler(): ManualScheduler {
  let open: (() => void) | null = null;

  const fn: ManualScheduler = () =>
    new Promise<void>((resolve) => {
      // executor 同步执行：任务一到边界，pending() 立刻为 true
      open = resolve;
    });
  fn.tick = () => {
    const g = open;
    open = null;
    g?.();
  };
  fn.release = () => {
    open?.();
    open = null;
  };
  fn.pending = () => open !== null;
  return fn;
}

export type RunPhase = 'sampling' | 'live' | 'cached' | 'invalid';

export interface SampleInput {
  mode: Mode;
  strength: number;
  probe: ProbeSpec;
  /** true=实时低分辨率（同步、不缓存）；false=高密度最终结果（分块异步、走缓存） */
  live: boolean;
}

export interface SamplingCallbacks {
  onPhase(phase: RunPhase): void;
  onResult(result: SampleResult, spec: ProbeSpec, kind: 'live' | 'final', fromCache: boolean): void;
  onInvalid(reason: string): void;
}

export function cacheKey(mode: Mode, strength: number, spec: ProbeSpec): string {
  return [
    mode,
    strength.toFixed(4),
    spec.axis,
    spec.size.toFixed(4),
    spec.n,
    spec.center.x.toFixed(4),
    spec.center.y.toFixed(4),
    spec.center.z.toFixed(4),
  ].join('|');
}

interface Running {
  aborted: boolean;
  gen: number;
}

export class SamplingController {
  private cache = new Map<string, SampleResult>();
  private gen = 0;
  private running: Running | null = null;
  private readonly yieldEvery: number;
  private readonly scheduler: Scheduler;
  private readonly cacheSize: number;

  constructor(opts?: { yieldEvery?: number; scheduler?: Scheduler; cacheSize?: number }) {
    this.yieldEvery = opts?.yieldEvery ?? 8;
    this.scheduler = opts?.scheduler ?? microScheduler;
    this.cacheSize = opts?.cacheSize ?? 64;
  }

  /** 当前是否有高密度分块任务在跑（测试用） */
  isRunning(): boolean {
    return !!this.running && !this.running.aborted;
  }

  cacheHits(): number {
    return this.cache.size;
  }

  /**
   * 发起一次采样。任何新请求都会令上一个分块任务作废（generation 递增），
   * 过期任务即使晚些算完也不会回调。返回取消函数：仅当本次请求仍是最新
   * 请求且任务在跑时生效（组件卸载/输入变化时调用）。
   */
  request(input: SampleInput, cb: SamplingCallbacks): () => void {
    this.cancelRunning();
    const gen = ++this.gen;

    let spec: ProbeSpec;
    try {
      spec = resolveProbe(input.probe);
    } catch (err) {
      cb.onPhase('invalid');
      cb.onInvalid(err instanceof Error ? err.message : String(err));
      return () => undefined;
    }

    if (input.live) {
      // 实时：降分辨率 + 同步计算，拖动期间永远跟手；结果不写入缓存
      const liveSpec: ProbeSpec = { ...spec, n: Math.min(spec.n, LIVE_DENSITY) };
      cb.onPhase('live');
      const result = sampleProbe(liveSpec, input.mode, input.strength);
      if (gen === this.gen) cb.onResult(result, liveSpec, 'live', false);
      return () => undefined;
    }

    // 最终高密度：先查缓存
    const key = cacheKey(input.mode, input.strength, spec);
    const hit = this.cache.get(key);
    if (hit) {
      // LRU 命中：提升为最近使用
      this.cache.delete(key);
      this.cache.set(key, hit);
      cb.onPhase('cached');
      cb.onResult(hit, spec, 'final', true);
      return () => undefined;
    }

    cb.onPhase('sampling');
    const run: Running = { aborted: false, gen };
    this.running = run;
    this.runChunks(spec, input.mode, input.strength, run, gen)
      .then((result) => {
        if (run.aborted || gen !== this.gen || !result) return; // 取消/过期结果丢弃
        this.running = null;
        this.cacheSet(key, result);
        if (gen !== this.gen) return;
        cb.onPhase('cached');
        cb.onResult(result, spec, 'final', false);
      })
      .catch((err) => {
        if (run.aborted || gen !== this.gen) return;
        this.running = null;
        cb.onPhase('invalid');
        cb.onInvalid(err instanceof Error ? err.message : String(err));
      });

    return () => {
      // 只能取消“自己且仍最新”的任务；已被后续请求取代时是空操作
      if (this.running === run && gen === this.gen) {
        run.aborted = true;
        this.running = null;
        this.gen++; // 代数作废：续体恢复后在边界检查处自行结束
        // 放行手动门控上的续体（默认调度器下为空操作），随后微任务即终止
        this.releaseParked();
      }
    };
  }

  /** 清空缓存（尺寸/场型规则变化等场景可手动调用） */
  invalidate(): void {
    this.cache.clear();
  }

  private cancelRunning(): void {
    if (this.running) {
      this.running.aborted = true;
      this.running = null;
    }
  }

  /**
   * 放行可能停在手动门控上的当前任务（仅显式取消时使用）。
   * 不能在“被新请求取代”的路径上同步调用：新任务会先同步登记门控，
   * 旧续体随后的微任务会误开新门控。
   */
  private releaseParked(): void {
    (this.scheduler as Partial<ManualScheduler>).release?.();
  }

  private cacheSet(key: string, result: SampleResult): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, result);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async runChunks(spec: ProbeSpec, mode: Mode, strength: number, run: Running, gen: number): Promise<SampleResult | null> {
    const { n, size, axis } = spec;
    const basis = planeBasis(axis);
    const uLocal = apply3(FIELD_ROT_T, basis.u);
    const vLocal = apply3(FIELD_ROT_T, basis.v);
    const cLocal = worldToField(spec.center);
    const half = size / 2;

    const grid = new Float64Array(n * n);
    const vectors = new Float64Array(n * n * 3);
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;

    for (let j = 0; j < n; j++) {
      // 分块边界：让出事件循环并检查中断，高密度任务可被及时取消
      if (j > 0 && j % this.yieldEvery === 0) {
        await this.scheduler();
        // 手动取消或被更新请求取代（代数过期）→ 立即结束，不继续占 CPU
        if (run.aborted || gen !== this.gen) return null;
      }
      const tv = n === 1 ? 0 : (j / (n - 1)) * 2 - 1;
      for (let i = 0; i < n; i++) {
        const tu = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
        const px = cLocal.x + (uLocal.x * tu + vLocal.x * tv) * half;
        const py = cLocal.y + (uLocal.y * tu + vLocal.y * tv) * half;
        const pz = cLocal.z + (uLocal.z * tu + vLocal.z * tv) * half;
        const fLocal = fieldVectorTriple(px, py, pz, mode, strength);
        const fw = apply3(FIELD_ROT, fLocal);
        const mag = Math.sqrt(fw.x * fw.x + fw.y * fw.y + fw.z * fw.z);
        const idx = j * n + i;
        grid[idx] = mag;
        vectors[idx * 3] = fw.x;
        vectors[idx * 3 + 1] = fw.y;
        vectors[idx * 3 + 2] = fw.z;
        if (mag < min) min = mag;
        if (mag > max) max = mag;
        sum += mag;
      }
    }
    if (n === 1) min = max;
    return { n, grid, vectors, max, min, mean: sum / (n * n) };
  }
}
