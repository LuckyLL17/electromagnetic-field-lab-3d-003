import { useEffect, useMemo, useRef } from 'react';
import {
  MAX_DENSITY,
  MAX_SIZE,
  MIN_SIZE,
  nearestCell,
  planeBasis,
  planePointToWorld,
  worldToField,
  type AxisName,
  type Mode,
  type ProbeSpec,
  type SampleResult,
  type Triple,
} from './probeCore';
import type { ProbeSamplingState } from './useProbeSampling';
import { drawHeatmap, drawLegend } from './heatmap';

const AXIS_LABEL: Record<AxisName, string> = { x: '法向 X · YZ 切片', y: '法向 Y · XZ 切片', z: '法向 Z · XY 切片' };

function fmt(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—';
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

/** 用世界坐标轴描述矢量方向，例如「+X、偏 −Y」 */
function describeDirection(v: Triple): string {
  const m = Math.hypot(v.x, v.y, v.z);
  if (m < 1e-9) return '近零矢量';
  const ax: Array<[AxisName, number]> = [
    ['x', v.x / m],
    ['y', v.y / m],
    ['z', v.z / m],
  ];
  ax.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const main = ax[0];
  const parts = [`${main[1] >= 0 ? '+' : '−'}${main[0].toUpperCase()}`];
  const sec = ax[1];
  if (Math.abs(sec[1]) >= 0.28) parts.push(`偏 ${sec[1] >= 0 ? '+' : '−'}${sec[0].toUpperCase()}`);
  return parts.join(' ');
}

interface ProbePanelProps {
  mode: Mode;
  probe: ProbeSpec;
  sampling: ProbeSamplingState;
  picked: { u: number; v: number } | null;
  dragging: boolean;
  enabled: boolean;
  onAxis(axis: AxisName): void;
  onSize(size: number): void;
  onDensity(n: number): void;
  onToggle(): void;
  onCenter(): void;
  onPick(p: { u: number; v: number } | null): void;
}

export default function ProbePanel({
  mode,
  probe,
  sampling,
  picked,
  dragging,
  enabled,
  onAxis,
  onSize,
  onDensity,
  onToggle,
  onCenter,
  onPick,
}: ProbePanelProps) {
  const heatRef = useRef<HTMLCanvasElement>(null);
  const legendRef = useRef<HTMLCanvasElement>(null);
  const { result, resultSpec } = sampling;

  useEffect(() => {
    if (legendRef.current) drawLegend(legendRef.current);
  }, []);

  useEffect(() => {
    if (heatRef.current && result) {
      drawHeatmap(heatRef.current, result, { picked, crosshair: true });
    }
  }, [result, picked]);

  // 选点信息：以当前展示的网格（实时或最终）为准
  const pickedInfo = useMemo(() => {
    if (!result || !resultSpec || !picked) return null;
    const cell = nearestCell(result, picked.u, picked.v);
    const vx = result.vectors[cell.index * 3];
    const vy = result.vectors[cell.index * 3 + 1];
    const vz = result.vectors[cell.index * 3 + 2];
    const v: Triple = { x: vx, y: vy, z: vz };
    const mag = Math.hypot(vx, vy, vz);
    const basis = planeBasis(resultSpec.axis);
    // 相对剖面的入射角（场方向与平面法向的夹角）
    const cosA = mag > 1e-9 ? (vx * basis.n.x + vy * basis.n.y + vz * basis.n.z) / mag : 1;
    const angleToNormal = (Math.acos(Math.max(-1, Math.min(1, cosA))) * 180) / Math.PI;
    const worldPos = planePointToWorld(resultSpec, picked.u, picked.v);
    return { v, mag, angleToNormal, worldPos };
  }, [result, resultSpec, picked]);

  const centerField = worldToField(probe.center);
  const resolution = result?.n ?? 0;

  const status = !enabled
    ? { text: '已关闭', cls: 'off' }
    : sampling.invalid
      ? { text: '位置无效', cls: 'bad' }
      : sampling.recomputing || sampling.phase === 'sampling'
        ? { text: '高密度重算中…', cls: 'work' }
        : sampling.live || dragging
          ? { text: '实时低分辨率', cls: 'live' }
          : sampling.phase === 'cached'
            ? sampling.fromCache
              ? { text: '缓存命中', cls: 'cached' }
              : { text: '高密度完成', cls: 'done' }
            : { text: '已完成', cls: 'done' };

  return (
    <section className="panel probe-panel">
      <div className="panel-title">
        <div>
          <span className="eyebrow">3D MEASUREMENT PROBE</span>
          <h3>三维测量剖面</h3>
        </div>
        <button className={`probe-toggle ${enabled ? 'on' : ''}`} onClick={onToggle}>
          {enabled ? '停用' : '启用'}
        </button>
      </div>

      {enabled && (
        <>
          <div className="probe-axis-row">
            {(['z', 'y', 'x'] as AxisName[]).map((a) => (
              <button key={a} className={probe.axis === a ? 'active' : ''} onClick={() => onAxis(a)}>
                {a.toUpperCase()}
              </button>
            ))}
            <span className="probe-axis-label">{AXIS_LABEL[probe.axis]}</span>
          </div>

          <div className="probe-status">
            <span className={`probe-badge ${status.cls}`}>{status.text}</span>
            <span className="probe-res">{resolution > 0 ? `${resolution}×${resolution} 采样` : '—'}</span>
          </div>

          <div className="probe-heat-wrap">
            <canvas ref={heatRef} width={288} height={200} className="probe-heat"
              onClick={(e) => {
                if (!result) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const u = ((e.clientX - rect.left) / rect.width) * 2 - 1;
                const v = 1 - ((e.clientY - rect.top) / rect.height) * 2;
                onPick({ u: Math.max(-1, Math.min(1, u)), v: Math.max(-1, Math.min(1, v)) });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onPick(null);
              }}
            />
            {!result && <div className="probe-heat-empty">等待采样…</div>}
            <div className="probe-heat-hint">点击选点 · 右键清除 · 横轴 u / 纵轴 v（平面基向量）</div>
            <canvas ref={legendRef} width={288} height={8} className="probe-legend" />
            <div className="probe-legend-scale">
              <small>{result ? result.min.toExponential(1) : '—'}</small>
              <span>场强 |E| / |B|（本切片归一化着色）</span>
              <small>{result ? result.max.toExponential(1) : '—'}</small>
            </div>
          </div>

          <div className="metrics probe-metrics">
            <div className="metric">
              <span>最大场强</span>
              <strong>{result ? result.max.toFixed(3) : '—'}</strong>
              <small>切片网格峰值</small>
            </div>
            <div className="metric">
              <span>平均场强</span>
              <strong>{result ? result.mean.toFixed(3) : '—'}</strong>
              <small>全部采样点</small>
            </div>
          </div>

          <label className="control">
            <span>
              剖面尺寸
              <b>{probe.size.toFixed(1)} 单位</b>
            </span>
            <input
              type="range"
              min={MIN_SIZE}
              max={MAX_SIZE}
              step={0.1}
              value={probe.size}
              onChange={(e) => onSize(Number(e.target.value))}
            />
          </label>
          <label className="control">
            <span>
              高密度采样
              <b>{probe.n}×{probe.n}</b>
            </span>
            <input
              type="range"
              min={12}
              max={Math.min(MAX_DENSITY, 160)}
              step={4}
              value={probe.n}
              onChange={(e) => onDensity(Number(e.target.value))}
            />
          </label>

          <div className="probe-pick">
            <div className="probe-pick-head">
              <span className="eyebrow">SELECTED POINT · 选点方向</span>
              {picked && <button onClick={() => onPick(null)}>清除</button>}
            </div>
            {pickedInfo ? (
              <div className="probe-pick-body">
                <div className="pick-line"><span>世界坐标</span><b>({fmt(pickedInfo.worldPos.x)}, {fmt(pickedInfo.worldPos.y)}, {fmt(pickedInfo.worldPos.z)})</b></div>
                <div className="pick-line"><span>场矢量 (世界)</span><b>({fmt(pickedInfo.v.x)}, {fmt(pickedInfo.v.y)}, {fmt(pickedInfo.v.z)})</b></div>
                <div className="pick-line"><span>方向</span><b>{describeDirection(pickedInfo.v)}</b></div>
                <div className="pick-line"><span>与法向夹角</span><b>{pickedInfo.angleToNormal.toFixed(1)}°</b></div>
                <div className="pick-line"><span>该点场强</span><b>{pickedInfo.mag.toFixed(3)}</b></div>
              </div>
            ) : (
              <p>在二维图或三维平面上点击选点；方向以世界坐标轴表达，切换场型后仍指向同一物理位置。</p>
            )}
          </div>

          <div className="probe-footer">
            <div className="probe-center-readout">
              世界中心 ({fmt(probe.center.x)}, {fmt(probe.center.y)}, {fmt(probe.center.z)})
              <small>场坐标 ({fmt(centerField.x)}, {fmt(centerField.y)}, {fmt(centerField.z)})</small>
            </div>
            <button onClick={onCenter}>回到原点</button>
          </div>
          <p className="probe-note">
            剖面锚定世界坐标：切换 {mode === 'coil' ? '磁场' : '电场'} 模型、调节强度或旋转相机都不会移动它。
            拖动时同步计算低分辨率以保证跟手；停止后异步重算高密度网格并写入 LRU 缓存，再次访问同一规格即时命中。
          </p>
        </>
      )}
    </section>
  );
}
