import { useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Line, OrbitControls, Text } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { fieldVectorTriple, planePointToWorld, worldPointToPlane, type AxisName, type Mode, type ProbeSpec, type SampleResult, type Triple } from './field/probeCore';
import { useProbeSampling } from './field/useProbeSampling';
import Probe3D from './field/Probe3D';
import ProbePanel from './field/ProbePanel';

const colors={field:'#68d7f2',vector:'#f6c86f',positive:'#f27f73',negative:'#6a9fff',coil:'#d995f2'};
function fieldAt(x:number,y:number,z:number,mode:Mode,strength:number){ const t=fieldVectorTriple(x,y,z,mode,strength); return new THREE.Vector3(t.x,t.y,t.z); }
function FieldLines({mode,strength}:{mode:Mode;strength:number}){const lines=useMemo(()=>{if(mode==='capacitor')return Array.from({length:10},(_,i)=>{const x=-2.6+i*.58;return [new THREE.Vector3(x,-2,0),new THREE.Vector3(x,2,0)]});if(mode==='coil')return Array.from({length:12},(_,i)=>{const a=i/12*Math.PI*2;return Array.from({length:32},(_,j)=>{const t=j/31*Math.PI*2;const r=1.15+.65*Math.sin(a*2)**2;return new THREE.Vector3(Math.cos(t)*r,Math.sin(t)*r*.55,Math.sin(a)*.3)});});return Array.from({length:14},(_,i)=>{const a=i/14*Math.PI*2;return Array.from({length:34},(_,j)=>{const t=j/33*Math.PI*2;const r=1.05+.23*Math.sin(t*2+a);return new THREE.Vector3(Math.cos(a)*r*Math.cos(t),Math.sin(t)*r,Math.sin(a)*r*Math.cos(t))})});},[mode]);return <group>{lines.map((line,i)=><Line key={i} points={line} color={mode==='coil'?colors.coil:colors.field} lineWidth={1.6} transparent opacity={.78}/>)}</group>}
function Vectors({mode,strength,showVectors}:{mode:Mode;strength:number;showVectors:boolean}){const vectors=useMemo(()=>Array.from({length:25},(_,i)=>{const x=-2.4+(i%5)*1.2,y=-2.4+Math.floor(i/5)*1.2;const v=fieldAt(x,y,0,mode,strength);const start=new THREE.Vector3(x,y,mode==='capacitor'?.15:0);const end=start.clone().add(v.normalize().multiplyScalar(.35));return [start,end] as [THREE.Vector3,THREE.Vector3]}),[mode,strength]);return <group>{showVectors&&vectors.map((v,i)=><Line key={i} points={v} color={colors.vector} lineWidth={1.3}/>)}</group>}
function Source({mode,strength}:{mode:Mode;strength:number}){if(mode==='capacitor')return <group><mesh position={[-3,0,0]}><boxGeometry args={[.16,5.2,.55]}/><meshStandardMaterial color={colors.positive}/></mesh><mesh position={[3,0,0]}><boxGeometry args={[.16,5.2,.55]}/><meshStandardMaterial color={colors.negative}/></mesh><Text position={[-2.82,2.75,.2]} fontSize={.2} color={colors.positive}>+Q</Text><Text position={[2.82,2.75,.2]} fontSize={.2} color={colors.negative}>−Q</Text></group>;if(mode==='coil')return <group>{Array.from({length:7},(_,i)=><mesh key={i} position={[0,0,(i-3)*.34]} rotation={[Math.PI/2,0,0]}><torusGeometry args={[1.55,.07,10,48]}/><meshStandardMaterial color={colors.coil} emissive={colors.coil} emissiveIntensity={strength*.12}/></mesh>)}</group>;return <group><mesh position={[-.8,0,0]}><sphereGeometry args={[.28,20,16]}/><meshStandardMaterial color={colors.positive} emissive={colors.positive} emissiveIntensity={.4}/></mesh><mesh position={[.8,0,0]}><sphereGeometry args={[.28,20,16]}/><meshStandardMaterial color={colors.negative} emissive={colors.negative} emissiveIntensity={.4}/></mesh><Line points={[new THREE.Vector3(-.8,0,0),new THREE.Vector3(.8,0,0)]} color="#d8e4ef" lineWidth={2}/></group>}

interface SceneProps {
  mode: Mode;
  strength: number;
  showVectors: boolean;
  probeEnabled: boolean;
  probe: ProbeSpec;
  probeResult: SampleResult | null;
  picked: { u: number; v: number } | null;
  onPick(p: { u: number; v: number } | null): void;
  onDragMove(center: Triple): void;
  onDragStart(): void;
  onDragEnd(): void;
}

function EMScene({mode,strength,showVectors,probeEnabled,probe,probeResult,picked,onPick,onDragMove,onDragStart,onDragEnd}:SceneProps){
  // OrbitControls 引用：拖动剖面期间临时禁用，避免相机同时旋转
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  return <Canvas camera={{position:[6,4.5,8],fov:42}}><color attach="background" args={['#0b0b1c']}/><ambientLight intensity={1.2}/><pointLight position={[3,4,5]} color="#9a8cff" intensity={18}/><pointLight position={[-4,-2,2]} color="#49d5e7" intensity={12}/><group rotation={[.18,-.24,0]}><Source mode={mode} strength={strength}/><FieldLines mode={mode} strength={strength}/><Vectors mode={mode} strength={strength} showVectors={showVectors}/><mesh position={[0,0,-.45]}><planeGeometry args={[7,6]}/><meshBasicMaterial color="#25234b" transparent opacity={.12} side={THREE.DoubleSide}/></mesh></group>{/* 测量剖面放在旋转 group 之外：位置/姿态全部是世界坐标 */}{probeEnabled && <Probe3D probe={probe} result={probeResult} picked={picked} onPick={onPick} onDragMove={onDragMove} onDragStart={()=>{if(controlsRef.current)controlsRef.current.enabled=false;onDragStart();}} onDragEnd={()=>{if(controlsRef.current)controlsRef.current.enabled=true;onDragEnd();}}/>}<OrbitControls ref={controlsRef} makeDefault minDistance={5} maxDistance={14}/></Canvas>}
function Metric({label,value,note}:{label:string;value:string;note:string}){return <div className="metric"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>}
export default function App(){
  const [mode,setMode]=useState<Mode>('dipole');
  const [strength,setStrength]=useState(1.6);
  const [showVectors,setShowVectors]=useState(true);

  // —— 三维测量剖面状态（世界坐标中心 + 世界法向轴，不随相机变化）——
  const [probeEnabled,setProbeEnabled]=useState(true);
  const [probeCenter,setProbeCenter]=useState<Triple>({x:0,y:0,z:0});
  const [probeAxis,setProbeAxis]=useState<AxisName>('z');
  const [probeSize,setProbeSize]=useState(2.4);
  const [probeDensity,setProbeDensity]=useState(64);
  const [dragging,setDragging]=useState(false);
  const [picked,setPicked]=useState<{u:number;v:number}|null>(null);

  const probe=useMemo(()=>({center:probeCenter,axis:probeAxis,size:probeSize,n:probeDensity}),[probeCenter,probeAxis,probeSize,probeDensity]);
  const sampling=useProbeSampling(mode,strength,probe,dragging,probeEnabled);

  // 拖动剖面时：选点是世界坐标下的物理位置——若它仍落在新平面范围内，
  // 保持指向同一物理点；移出范围则清除。这样拖动不丢失已选点。
  const handleDragMove = (newCenter: Triple) => {
    setPicked((prev) => {
      if (!prev) return prev;
      const oldWorld = planePointToWorld(probe, prev.u, prev.v);
      return worldPointToPlane({ ...probe, center: newCenter }, oldWorld);
    });
    setProbeCenter(newCenter);
  };

  const modeLabel={dipole:'电偶极子',coil:'螺线管',capacitor:'平行板电容器'}[mode];
  return <div className="app"><header className="topbar"><div className="brand"><div className="brand-icon">✦</div><div><span className="eyebrow">ELECTROMAGNETISM / FIELD EXPLORER</span><h1>ElectroMag Lab <span>·</span> 电磁场与磁力线</h1></div></div><div className="header-meta"><span className="dataset">MODEL 03 / {modeLabel}</span><button onClick={()=>setShowVectors(v=>!v)}>{showVectors?'隐藏场矢量':'显示场矢量'}</button></div></header><main className="layout"><section className="model-card"><div className="model-head"><div><span className="eyebrow">3D FIELD MAPPING</span><h2>{modeLabel} · Field Line Tracer</h2></div><div className="mode-switch">{(['dipole','coil','capacitor'] as Mode[]).map(item=><button key={item} className={mode===item?'active':''} onClick={()=>setMode(item)}>{item==='dipole'?'电偶极子':item==='coil'?'螺线管':'平行板'}</button>)}</div></div><div className="canvas-wrap"><EMScene mode={mode} strength={strength} showVectors={showVectors} probeEnabled={probeEnabled} probe={probe} probeResult={sampling.result} picked={picked} onPick={setPicked} onDragMove={handleDragMove} onDragStart={()=>setDragging(true)} onDragEnd={()=>setDragging(false)}/><div className="viewer-legend"><span><i className="dot protein"/>场线</span><span><i className="dot ligand"/>场源</span><span><i className="dot interaction"/>矢量采样</span><span><i className="dot probe-dot"/>测量剖面</span></div><div className="viewer-hint">左键旋转 · 滚轮缩放 · {probeEnabled?'拖动紫色剖面沿法向平移、点击选点':'切换场源模型'}</div></div></section><aside className="sidebar"><section className="panel intro-panel"><span className="eyebrow">FIELD EXPERIMENT</span><h3>三维场线实验台</h3><p>在电偶极子、螺线管与平行板电容器之间切换，观察电场/磁场的空间拓扑和方向分布。</p><div className="metrics"><Metric label="场强系数" value={strength.toFixed(1)} note="归一化"/><Metric label="场线束" value={mode==='capacitor'?'10':'14'} note="采样轨迹"/><Metric label="采样矢量" value={showVectors?'25':'关闭'} note="网格采样"/></div></section><ProbePanel mode={mode} probe={probe} sampling={sampling} picked={picked} dragging={dragging} enabled={probeEnabled} onAxis={(a)=>{setProbeAxis(a);setPicked(null);}} onSize={(s)=>{setPicked(prev=>{if(!prev)return prev;const w=planePointToWorld(probe,prev.u,prev.v);return worldPointToPlane({...probe,size:s},w);});setProbeSize(s);}} onDensity={setProbeDensity} onToggle={()=>setProbeEnabled(v=>!v)} onCenter={()=>{setProbeCenter({x:0,y:0,z:0});setPicked(null);}} onPick={setPicked}/><section className="panel"><span className="eyebrow">FIELD READOUT</span><div className="readout"><div><span>当前场型</span><b>{mode==='coil'?'近似磁场':'静电场'}</b></div><div><span>方向约定</span><b>{mode==='coil'?'右手螺旋定则':'+ → −'}</b></div><div><span>剖面坐标系</span><b>世界坐标锁定</b></div></div></section></aside></main></div>}
