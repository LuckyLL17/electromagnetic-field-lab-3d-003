import type { Mode } from './field';
import type { Axis, PlaneSpec } from './sampler';
import type { FineStatus, ProbeInfo } from './usePlaneSampler';
import type { SampleResult } from './sampler';
import { Heatmap } from './Heatmap';

interface Props {
  spec: PlaneSpec;
  size: number;
  mode: Mode;
  visible: boolean;
  fineN: number;
  dragging: boolean;
  status: FineStatus;
  progress: number;
  result: SampleResult | null;
  probeUV: { u: number; v: number } | null;
  probe: ProbeInfo | null;
  onToggleVisible: (v: boolean) => void;
  onAxis: (a: Axis) => void;
  onOffset: (o: number) => void;
  onSize: (s: number) => void;
  onFineN: (n: number) => void;
  onPick: (uv: { u: number; v: number }) => void;
  onClearProbe: () => void;
}

const AXIS_META: Record<Axis, { label: string; plane: string; normal: string }> = {
  x: { label: '法向 X', plane: 'Y–Z 平面', normal: 'x =' },
  y: { label: '法向 Y', plane: 'X–Z 平面', normal: 'y =' },
  z: { label: '法向 Z', plane: 'X–Y 平面', normal: 'z =' },
};

const STATUS_META: Record<FineStatus, { text: string; cls: string }> = {
  idle: { text: '待机', cls: 'idle' },
  computing: { text: '精细采样计算中…', cls: 'busy' },
  cached: { text: '精细结果已缓存', cls: 'cached' },
  dragging: { text: '拖动中 · 实时粗采样，精细任务已暂停', cls: 'interrupted' },
  interrupted: { text: '已中断 · 松手后自动恢复', cls: 'interrupted' },
  invalid: { text: '位置无效', cls: 'invalid' },
};

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

function fmtAngle(rad: number): string {
  const deg = (rad * 180) / Math.PI;
  return `${deg >= 0 ? '+' : ''}${deg.toFixed(0)}°`;
}

export function ProfilePanel(p: Props) {
  const meta = AXIS_META[p.spec.axis];
  const st = STATUS_META[p.status];
  const stats = p.result?.stats;

  return (
    <section className={`panel profile-panel ${p.visible ? '' : 'is-off'}`}>
      <div className="panel-title profile-head">
        <div>
          <span className="eyebrow">3D MEASUREMENT SECTION</span>
          <h3>可拖动测量剖面</h3>
        </div>
        <button
          className={p.visible ? 'active' : ''}
          onClick={() => p.onToggleVisible(!p.visible)}
          title="在三维场景中显示 / 隐藏剖面"
        >
          {p.visible ? '已挂载' : '已隐藏'}
        </button>
      </div>

      {p.visible && (
        <>
          <div className="axis-switch">
            {(['x', 'y', 'z'] as Axis[]).map((a) => (
              <button key={a} className={p.spec.axis === a ? 'active' : ''} onClick={() => p.onAxis(a)}>
                {AXIS_META[a].label}
              </button>
            ))}
          </div>

          <label className="control">
            <span>
              剖面位置（世界坐标） <b>{meta.normal} {p.spec.offset.toFixed(2)}</b>
            </span>
            <input
              type="range"
              min={-3}
              max={3}
              step={0.05}
              value={p.spec.offset}
              onChange={(e) => p.onOffset(Number(e.target.value))}
            />
          </label>

          <div className="profile-row">
            <label className="control compact">
              <span>采样边长 <b>{p.size.toFixed(1)}</b></span>
              <input
                type="range"
                min={2}
                max={6}
                step={0.2}
                value={p.size}
                onChange={(e) => p.onSize(Number(e.target.value))}
              />
            </label>
            <label className="control compact">
              <span>精细密度 <b>{p.fineN}²</b></span>
              <select value={p.fineN} onChange={(e) => p.onFineN(Number(e.target.value))}>
                {[48, 72, 96, 128].map((n) => (
                  <option key={n} value={n}>
                    {n} × {n}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <Heatmap result={p.result} fineN={p.fineN} probeUV={p.probeUV} onPick={p.onPick} />

          <div className={`sample-status ${st.cls}`}>
            <i />
            {st.text}
            {p.status === 'computing' && !p.dragging && (
              <em className="progress"> {Math.round(p.progress * 100)}%</em>
            )}
          </div>

          <div className="metrics profile-metrics">
            <div className="metric">
              <span>最大场强 |F|</span>
              <strong>{stats ? fmt(stats.max) : '—'}</strong>
              <small>剖面内峰值</small>
            </div>
            <div className="metric">
              <span>平均场强</span>
              <strong>{stats ? fmt(stats.mean) : '—'}</strong>
              <small>有效点均值</small>
            </div>
            <div className="metric">
              <span>无效采样</span>
              <strong>{stats ? stats.invalid : '—'}</strong>
              <small>{p.result ? `${p.result.spec.n * p.result.spec.n} 点` : ''}</small>
            </div>
          </div>

          <div className="probe-box">
            <div className="probe-head">
              <span className="eyebrow">PROBE / 选点方向</span>
              {p.probeUV && (
                <button className="link-btn" onClick={p.onClearProbe}>
                  清除选点
                </button>
              )}
            </div>
            {p.probe ? (
              <div className="probe-grid">
                <div>
                  <span>位置 (x, y, z)</span>
                  <b>
                    {fmt(p.probe.x)}, {fmt(p.probe.y)}, {fmt(p.probe.z)}
                  </b>
                </div>
                <div>
                  <span>场强 |F|</span>
                  <b>{fmt(p.probe.magnitude)}</b>
                </div>
                <div>
                  <span>单位场矢量</span>
                  <b>
                    ({fmt(p.probe.dx)}, {fmt(p.probe.dy)}, {fmt(p.probe.dz)})
                  </b>
                </div>
                <div>
                  <span>面内方向 / 穿出角</span>
                  <b>
                    {fmtAngle(p.probe.planeAngle)} · {fmtAngle(p.probe.planeElevation)}
                  </b>
                </div>
              </div>
            ) : (
              <p className="probe-empty">
                点击三维剖面（{meta.plane}）或右侧热图选取采样点。方向按世界坐标计算，旋转相机不改变读数。
              </p>
            )}
          </div>

          <p className="profile-note">
            实时策略：拖动时同步重算 {28}² 粗采样（绝不显示过期结果）；停止 140ms 后分块异步计算 {p.fineN}²
            精细采样并缓存，再次拖回该物理位置直接命中；新拖动会取消在途精细任务。
          </p>
        </>
      )}
    </section>
  );
}
