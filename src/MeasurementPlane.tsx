import { useEffect, useMemo, useRef } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import type { Axis, PlaneSpec } from './sampler';

/**
 * 可拖动的三维测量剖面。
 * - 平面 / 手柄 / 选点标记全部挂在场源同一个父 group 内，
 *   通过 parent.worldToLocal 换算，因此父级的演示旋转对物理坐标透明；
 * - 拖动沿「世界坐标法向」进行：拖动平面包含整条法向轴，射线交点投影到
 *   物理法向即得 offset。相机轨道、缩放只改变射线方向，同一 offset
 *   永远表示同一个物理位置。
 */

const PLANE_COLOR = '#7ee0ff';
const HANDLE_COLOR = '#ffd166';
const GRID_DIV = 8;
const DRAG_THRESHOLD_PX = 5;
export const SECTION_OFFSET_LIMIT = 3;

interface Props {
  spec: PlaneSpec;
  size: number;
  parentRef: React.RefObject<THREE.Group | null>;
  visible: boolean;
  dragging: boolean;
  probeUV: { u: number; v: number } | null;
  onDraggingChange: (dragging: boolean) => void;
  onOffsetChange: (offset: number) => void;
  onProbe: (uv: { u: number; v: number }) => void;
}

const U0 = new THREE.Vector3(1, 0, 0);
const V0 = new THREE.Vector3(0, 1, 0);
const N0 = new THREE.Vector3(0, 0, 1);

/** 与 sampler / usePlaneSampler 完全一致的循环右手系 (u, v, normal)。 */
function basis(axis: Axis): [THREE.Vector3, THREE.Vector3, THREE.Vector3] {
  if (axis === 'x') return [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)];
  if (axis === 'y') return [U0, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)];
  return [U0, V0, N0];
}

export function MeasurementPlane({
  spec,
  size,
  parentRef,
  visible,
  dragging,
  probeUV,
  onDraggingChange,
  onOffsetChange,
  onProbe,
}: Props) {
  const handleRef = useRef<THREE.Mesh>(null);
  const raycaster = useThree((s) => s.raycaster);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;

  const half = size / 2;
  const [, , bn] = useMemo(() => basis(spec.axis), [spec.axis]);

  // 局部 (u,v,n) 定向：内部 mesh 的局部 XY 即采样 u/v，局部 Z 即法向
  const quat = useMemo(() => {
    const [u, v, n] = basis(spec.axis);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n));
  }, [spec.axis]);

  const gridSegments = useMemo(() => {
    const pts: number[] = [];
    for (let i = 0; i <= GRID_DIV; i++) {
      const t = -half + (i / GRID_DIV) * size;
      pts.push(-half, t, 0, half, t, 0);
      pts.push(t, -half, 0, t, half, 0);
    }
    return new Float32Array(pts);
  }, [half, size]);

  const borderSegments = useMemo(() => {
    const h = half + 0.001;
    return new Float32Array([-h, -h, 0, h, -h, 0, h, -h, 0, h, h, 0, h, h, 0, -h, h, 0, -h, h, 0, -h, -h, 0]);
  }, [half]);

  const dragState = useRef<{
    pointerId: number;
    axis: Axis;
    startX: number;
    startY: number;
    moved: boolean;
    plane: THREE.Plane;
    hit: THREE.Vector3;
    onMove: (ev: PointerEvent) => void;
    onUp: (ev: PointerEvent) => void;
  } | null>(null);

  // 尺寸 / 场型 / 可见性等变化导致卸载时，若仍在拖动：清理监听并恢复相机控制
  useEffect(() => {
    return () => {
      const st = dragState.current;
      if (st) {
        window.removeEventListener('pointermove', st.onMove);
        window.removeEventListener('pointerup', st.onUp);
        dragState.current = null;
      }
      if (controls) controls.enabled = true;
    };
  }, [controls]);

  const beginDrag = (e: ThreeEvent<PointerEvent>) => {
    if (!visible || !parentRef.current) return;
    e.stopPropagation();
    const parent = parentRef.current;
    parent.updateWorldMatrix(true, false);

    const worldAxis = bn.clone().transformDirection(parent.matrixWorld).normalize();
    const camForward = new THREE.Vector3();
    camera.getWorldDirection(camForward);
    // 包含法向轴、朝向相机的平面（视线与轴平行时退化为用相机上方向）
    const planeNormal = new THREE.Vector3().crossVectors(camForward, worldAxis);
    if (planeNormal.lengthSq() < 1e-6) planeNormal.crossVectors(camera.up, worldAxis);
    planeNormal.normalize();

    const origin = new THREE.Vector3();
    handleRef.current?.getWorldPosition(origin);

    if (controls) controls.enabled = false;
    onDraggingChange(true);

    const onMove = (ev: PointerEvent) => {
      const st = dragState.current;
      if (!st || st.pointerId !== ev.pointerId) return;
      if (Math.hypot(ev.clientX - st.startX, ev.clientY - st.startY) > DRAG_THRESHOLD_PX) {
        st.moved = true;
      }
      if (!st.moved) return;
      const rect = gl.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      // 拖动平面包含整条法向轴，交点投影到局部法向即得物理 offset
      if (raycaster.ray.intersectPlane(st.plane, st.hit) && parentRef.current) {
        const local = parentRef.current.worldToLocal(st.hit.clone());
        const next = local.dot(basis(st.axis)[2]);
        if (Number.isFinite(next)) {
          onOffsetChange(THREE.MathUtils.clamp(next, -SECTION_OFFSET_LIMIT, SECTION_OFFSET_LIMIT));
        }
      }
    };
    const onUp = (ev: PointerEvent) => {
      const st = dragState.current;
      if (!st || st.pointerId !== ev.pointerId) return;
      window.removeEventListener('pointermove', st.onMove);
      window.removeEventListener('pointerup', st.onUp);
      dragState.current = null;
      if (controls) controls.enabled = true;
      // 中断恢复：拖动结束后 hook 的去抖 effect 自动重启 fine
      onDraggingChange(false);
    };

    dragState.current = {
      pointerId: e.pointerId,
      axis: spec.axis,
      startX: e.nativeEvent.clientX,
      startY: e.nativeEvent.clientY,
      moved: false,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, origin),
      hit: new THREE.Vector3(),
      onMove,
      onUp,
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // 点击平面选点（位移超过阈值视为旋转 / 拖动，忽略）
  const pickStart = useRef<{ x: number; y: number } | null>(null);
  const onPlanePointerDown = (e: ThreeEvent<PointerEvent>) => {
    pickStart.current = { x: e.nativeEvent.clientX, y: e.nativeEvent.clientY };
  };
  const onPlaneClick = (e: ThreeEvent<PointerEvent>) => {
    if (!visible || !parentRef.current) return;
    const start = pickStart.current;
    if (start && Math.hypot(e.nativeEvent.clientX - start.x, e.nativeEvent.clientY - start.y) > DRAG_THRESHOLD_PX) {
      return;
    }
    e.stopPropagation();
    const local = parentRef.current.worldToLocal(e.point.clone());
    const [cbu, cbv, cbn] = basis(spec.axis);
    if (Math.abs(local.dot(cbn) - spec.offset) > 0.15) return; // 无效位置：不在当前剖面上
    const u = local.dot(cbu);
    const v = local.dot(cbv);
    if (Math.abs(u) > half || Math.abs(v) > half) return;
    onProbe({ u: u / half, v: v / half });
  };

  if (!visible) return null;

  return (
    <group quaternion={quat}>
      <group position={bn.clone().multiplyScalar(spec.offset)}>
        {/* 剖面薄片（可点选） */}
        <mesh onPointerDown={onPlanePointerDown} onClick={onPlaneClick}>
          <planeGeometry args={[size, size]} />
          <meshBasicMaterial
            color={PLANE_COLOR}
            transparent
            opacity={dragging ? 0.16 : 0.09}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>

        {/* 网格与边框（局部坐标即采样 u/v） */}
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[gridSegments, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={PLANE_COLOR} transparent opacity={0.35} />
        </lineSegments>
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[borderSegments, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={PLANE_COLOR} transparent opacity={0.9} />
        </lineSegments>

        {/* 法向指示箭头（+axis 方向） */}
        <arrowHelper args={[new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0), 0.85, '#9af0ff', 0.22, 0.12]} />

        {/* 拖动手柄：夹住两侧边缘，沿法向拖动 */}
        {[1, -1].map((side) => (
          <mesh
            key={side}
            ref={side === 1 ? handleRef : undefined}
            position={[0, side * (half + 0.22), 0]}
            onPointerDown={beginDrag}
          >
            <boxGeometry args={[size * 0.42, 0.12, 0.12]} />
            <meshStandardMaterial
              color={HANDLE_COLOR}
              emissive={HANDLE_COLOR}
              emissiveIntensity={dragging ? 0.9 : 0.45}
            />
          </mesh>
        ))}

        {/* 选点标记：位置即 (u, v) 采样坐标 */}
        {probeUV && (
          <group position={[probeUV.u * half, probeUV.v * half, 0]}>
            <mesh>
              <sphereGeometry args={[0.09, 18, 14]} />
              <meshStandardMaterial color={HANDLE_COLOR} emissive={HANDLE_COLOR} emissiveIntensity={0.8} />
            </mesh>
            <mesh>
              <ringGeometry args={[0.16, 0.2, 32]} />
              <meshBasicMaterial color={HANDLE_COLOR} transparent opacity={0.8} side={THREE.DoubleSide} />
            </mesh>
          </group>
        )}
      </group>
    </group>
  );
}
