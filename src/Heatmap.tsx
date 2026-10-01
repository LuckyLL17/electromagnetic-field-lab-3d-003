import { useEffect, useRef } from 'react';
import type { SampleResult } from './sampler';

/**
 * 右侧二维采样剖面：n×n 的场强热图。
 * 内部绘制缓冲固定为 n×n，CSS 拉伸到显示尺寸；
 * 尺寸变化（显示区域）只需重绘 DOM，不触发任何重算。
 */

const DISPLAY_PX = 232;

// 深蓝 → 青 → 黄 的场强色带
const RAMP: [number, number, number][] = [
  [16, 14, 48],
  [44, 62, 140],
  [46, 150, 200],
  [104, 215, 242],
  [246, 200, 111],
  [242, 127, 115],
];

function colorize(t: number, out: Uint8ClampedArray, offset: number): void {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = RAMP[i];
  const b = RAMP[Math.min(RAMP.length - 1, i + 1)];
  out[offset] = a[0] + (b[0] - a[0]) * f;
  out[offset + 1] = a[1] + (b[1] - a[1]) * f;
  out[offset + 2] = a[2] + (b[2] - a[2]) * f;
  out[offset + 3] = 255;
}

interface Props {
  result: SampleResult | null;
  fineN: number;
  probeUV: { u: number; v: number } | null;
  onPick: (uv: { u: number; v: number }) => void;
}

export function Heatmap({ result, fineN, probeUV, onPick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!result) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const n = result.spec.n;
    canvas.width = n;
    canvas.height = n;
    const img = ctx.createImageData(n, n);
    const max = result.stats.max || 1;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const m = result.values[row * n + col];
        // 与 sampler 行序一致：row 对应 v（+v 在热图顶部）
        const topRow = n - 1 - row;
        colorize(Number.isFinite(m) ? m / max : -1, img.data, (topRow * n + col) * 4);
        if (!Number.isFinite(m)) {
          img.data[(topRow * n + col) * 4] = 60;
          img.data[(topRow * n + col) * 4 + 1] = 56;
          img.data[(topRow * n + col) * 4 + 2] = 80;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [result]);

  const isFine = result?.spec.n === fineN;

  return (
    <div
      className="heatmap"
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const u = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const v = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
        onPick({ u, v });
      }}
    >
      <canvas ref={canvasRef} style={{ width: DISPLAY_PX, height: DISPLAY_PX }} />
      <span className="heat-axis ha-u">+u</span>
      <span className="heat-axis ha-umin">−u</span>
      <span className="heat-axis ha-v">+v</span>
      <span className="heat-axis ha-vmin">−v</span>
      {probeUV && (
        <span
          className="heat-cross"
          style={{
            left: `${((probeUV.u + 1) / 2) * 100}%`,
            top: `${((1 - probeUV.v) / 2) * 100}%`,
          }}
        />
      )}
      <span className={`heat-badge ${isFine ? 'fine' : 'coarse'}`}>
        {result ? `${result.spec.n}×${result.spec.n} · ${isFine ? '精细缓存' : '实时粗采样'}` : '无数据'}
      </span>
    </div>
  );
}
