import { useEffect, useMemo, useRef } from 'react';
import { ThreeEvent } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import {
  planeBasis,
  planePointToWorld,
  slideAlongAxis,
  pickOnPlane,
  nearestCell,
  type ProbeSpec,
  type SampleResult,
  type Triple,
} from './probeCore';
import { drawHeatmap } from './heatmap';

const HEAT_SIZE = 256;
const DRAG_THRESHOLD_PX = 4;

function toTriple(v: THREE.Vector3): Triple {
  return { x: v.x, y: v.y, z: v.z };
}

interface Probe3DProps {
  probe: ProbeSpec;
  result: SampleResult | null;
  picked: { u: number; v: number } | null;
  onDragMove(center: Triple): void;
  onDragStart(): void;
  onDragEnd(): void;
  onPick(p: { u: number; v: number } | null): void;
}

const UP = new THREE.Vector3(0, 1, 0);

export default function Probe3D({
  probe,
  result,
  picked,
  onDragMove,
  onDragStart,
  onDragEnd,
  onPick,
}: Probe3DProps) {
  const meshRef = useRef<THREE.Mesh>(null);

  // 由世界坐标基向量构造姿态矩阵（相机变化不影响：这是纯世界变换）
  const quaternion = useMemo(() => {
    const b = planeBasis(probe.axis);
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(b.u.x, b.u.y, b.u.z),
      new THREE.Vector3(b.v.x, b.v.y, b.v.z),
      new THREE.Vector3(b.n.x, b.n.y, b.n.z),
    );
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }, [probe.axis]);

  // 纹理：离屏 canvas + CanvasTexture，采样结果更新后刷新
  const { heatCanvas, heatTexture } = useMemo(() => {
    if (typeof document === 'undefined') return { heatCanvas: null, heatTexture: null };
    const c = document.createElement('canvas');
    c.width = HEAT_SIZE;
    c.height = HEAT_SIZE;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return { heatCanvas: c, heatTexture: tex };
  }, []);

  useEffect(() => {
    if (!heatCanvas) return;
    if (result) {
      drawHeatmap(heatCanvas, result, { picked, crosshair: false });
    } else {
      const ctx = heatCanvas.getContext('2d');
      ctx?.clearRect(0, 0, HEAT_SIZE, HEAT_SIZE);
    }
    if (heatTexture) heatTexture.needsUpdate = true;
  }, [result, picked, heatCanvas, heatTexture]);

  useEffect(() => {
    return () => heatTexture?.dispose();
  }, [heatTexture]);

  // 拖拽状态：按下后记录像素位置，移动超过阈值才判定为拖动并禁用 OrbitControls
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);

  const updateFromRay = (e: ThreeEvent<PointerEvent>): boolean => {
    const origin = e.ray.origin;
    const dir = e.ray.direction;
    const next = slideAlongAxis(toTriple(origin), toTriple(dir), probe.center, probe.axis);
    if (!next) return false; // 无效（视线平行等）→ 忽略本帧
    onDragMove(next);
    return true;
  };

  const handleDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    downRef.current = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    draggingRef.current = false;
    // R3F 在事件对象上挂载了指针捕获（把后续 pointermove/up 持续路由给该 mesh）
    (e.target as unknown as { setPointerCapture(id: number): void }).setPointerCapture(e.nativeEvent.pointerId);
  };

  const handleMove = (e: ThreeEvent<PointerEvent>) => {
    if (!downRef.current) return;
    e.stopPropagation();
    const dx = e.nativeEvent.offsetX - downRef.current.x;
    const dy = e.nativeEvent.offsetY - downRef.current.y;
    if (!draggingRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!draggingRef.current) {
      draggingRef.current = true;
      onDragStart();
    }
    updateFromRay(e);
  };

  const handleUp = (e: ThreeEvent<PointerEvent>) => {
    if (!downRef.current) return;
    e.stopPropagation();
    if (draggingRef.current) {
      onDragEnd();
    } else {
      // 未超过位移阈值 → 视为点击选点
      const hit = pickOnPlane(toTriple(e.ray.origin), toTriple(e.ray.direction), probe);
      onPick(hit);
    }
    downRef.current = null;
    draggingRef.current = false;
  };

  // 边框四角（世界坐标）
  const border = useMemo(() => {
    const pts = [
      planePointToWorld(probe, -1, -1),
      planePointToWorld(probe, 1, -1),
      planePointToWorld(probe, 1, 1),
      planePointToWorld(probe, -1, 1),
      planePointToWorld(probe, -1, -1),
    ];
    return pts.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  }, [probe]);

  // 法向指示箭头（位于平面 +u+v 角，沿世界法向）
  const normalArrow = useMemo(() => {
    const corner = planePointToWorld(probe, 1, 1);
    const b = planeBasis(probe.axis);
    const start = new THREE.Vector3(corner.x, corner.y, corner.z);
    const end = start
      .clone()
      .add(new THREE.Vector3(b.n.x, b.n.y, b.n.z).multiplyScalar(0.55));
    return { start, end };
  }, [probe]);

  // 选点标记：点位于平面上，箭头沿该点【世界坐标】场矢量方向
  const marker = useMemo(() => {
    if (!picked || !result) return null;
    const wp = planePointToWorld(probe, picked.u, picked.v);
    const cell = nearestCell(result, picked.u, picked.v);
    const v = new THREE.Vector3(
      result.vectors[cell.index * 3],
      result.vectors[cell.index * 3 + 1],
      result.vectors[cell.index * 3 + 2],
    );
    const mag = v.length();
    if (mag < 1e-9) return { point: new THREE.Vector3(wp.x, wp.y, wp.z), arrow: null as null | { from: THREE.Vector3; to: THREE.Vector3 } };
    const from = new THREE.Vector3(wp.x, wp.y, wp.z);
    const to = from.clone().add(v.normalize().multiplyScalar(0.9));
    return { point: from, arrow: { from, to } };
  }, [picked, result, probe]);

  return (
    <group>
      <mesh
        ref={meshRef}
        position={[probe.center.x, probe.center.y, probe.center.z]}
        quaternion={quaternion}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
      >
        <planeGeometry args={[probe.size, probe.size]} />
        <meshBasicMaterial
          transparent
          opacity={0.5}
          side={THREE.DoubleSide}
          depthWrite={false}
          map={heatTexture}
        />
      </mesh>

      <Line points={border} color="#d6a9ff" lineWidth={1.8} transparent opacity={0.9} />
      <Line points={[normalArrow.start, normalArrow.end]} color="#f6c86f" lineWidth={2} />
      <mesh position={normalArrow.end}>
        <sphereGeometry args={[0.06, 12, 10]} />
        <meshBasicMaterial color="#f6c86f" />
      </mesh>

      {marker && (
        <group>
          <mesh position={marker.point}>
            <sphereGeometry args={[0.075, 14, 12]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
          {marker.arrow && (
            (() => {
              // coneGeometry 的轴为 +Y、几何中心在锥高中点；把它平移半高，
              // 使锥尖恰好落在线段终点
              const dir = marker.arrow!.to.clone().sub(marker.arrow!.from).normalize();
              const coneH = 0.18;
              const conePos = marker.arrow!.to.clone().addScaledVector(dir, coneH / 2);
              const coneQuat = new THREE.Quaternion().setFromUnitVectors(UP, dir);
              return (
                <>
                  <Line points={[marker.arrow!.from, marker.arrow!.to]} color="#ffffff" lineWidth={2.2} />
                  <mesh position={conePos} quaternion={coneQuat}>
                    <coneGeometry args={[0.07, coneH, 12]} />
                    <meshBasicMaterial color="#ffffff" />
                  </mesh>
                </>
              );
            })()
          )}
        </group>
      )}
    </group>
  );
}
