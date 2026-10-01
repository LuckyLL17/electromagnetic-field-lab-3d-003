import * as THREE from 'three';

/**
 * 场模型与采样工具始终工作在「物理世界坐标」中：
 * 相机轨道旋转、场型 / 强度切换都不会改变坐标含义，
 * 因此同一个剖面对象 (axis, offset) 永远指向同一个物理位置。
 */
export type Mode = 'dipole' | 'coil' | 'capacitor';

export const MODES: Mode[] = ['dipole', 'coil', 'capacitor'];

export const MODE_LABEL: Record<Mode, string> = {
  dipole: '电偶极子',
  coil: '螺线管',
  capacitor: '平行板电容器',
};

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** 返回物理坐标 (x, y, z) 处的场矢量（E 或 B，教学级解析模型）。 */
export function fieldAt(
  x: number,
  y: number,
  z: number,
  mode: Mode,
  strength: number,
): THREE.Vector3 {
  if (mode === 'capacitor') {
    return V(0, strength * (0.9 + 0.12 * Math.cos(x * 1.7)), 0);
  }
  if (mode === 'coil') {
    return V(-z * 0.35 * strength, 0.15 * strength, x * 0.35 * strength);
  }
  const r2 = x * x + y * y + z * z + 0.18;
  const scale = strength / Math.pow(r2, 2.1);
  return V(3 * x * z * scale, (3 * y * y - r2) * scale, 3 * z * x * scale);
}

/** 场强（矢量模长）。任一方向分量为非有限值时返回 NaN，由采样层计入无效点。 */
export function fieldMagnitudeAt(
  x: number,
  y: number,
  z: number,
  mode: Mode,
  strength: number,
): number {
  const v = fieldAt(x, y, z, mode, strength);
  if (![v.x, v.y, v.z].every(Number.isFinite)) return NaN;
  return v.length();
}
