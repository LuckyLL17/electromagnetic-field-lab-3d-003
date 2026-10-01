import type { SampleResult } from './probeCore';

// 深蓝 → 青 → 黄 → 品红，与深色 UI 搭配
const STOPS: Array<[number, [number, number, number]]> = [
  [0, [28, 24, 68]],
  [0.35, [58, 116, 220]],
  [0.62, [104, 215, 242]],
  [0.82, [246, 200, 111]],
  [1, [242, 127, 214]],
];

function colorFor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  for (let k = 1; k < STOPS.length; k++) {
    if (x <= STOPS[k][0]) {
      const [t0, c0] = STOPS[k - 1];
      const [t1, c1] = STOPS[k];
      const f = (x - t0) / (t1 - t0 || 1);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

/**
 * 把采样场强网格绘制到 canvas。
 * 采样约定 j=0 对应平面 v=-1（底边），canvas 0 行在顶，因此按行翻转，
 * 使面板上的二维图与三维平面（u 向右、v 向上）方向一致。
 */
export function drawHeatmap(
  canvas: HTMLCanvasElement,
  result: SampleResult,
  opts?: { picked?: { u: number; v: number } | null; crosshair?: boolean },
): void {
  const { n, grid, min, max } = result;
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // 用 n×n 离屏画布承载原始数据，再最近邻放大到主画布
  const off = document.createElement('canvas');
  off.width = n;
  off.height = n;
  const offCtx = off.getContext('2d');
  if (!offCtx) return;
  const img = offCtx.createImageData(n, n);
  const range = max - min;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const val = grid[j * n + i];
      const t = range > 1e-12 ? (val - min) / range : 0.5;
      const [r, g, b] = colorFor(t);
      // 垂直翻转：j=0（v=-1）画在底部
      const row = n - 1 - j;
      const off2 = (row * n + i) * 4;
      img.data[off2] = r;
      img.data[off2 + 1] = g;
      img.data[off2 + 2] = b;
      img.data[off2 + 3] = 255;
    }
  }
  offCtx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(off, 0, 0, n, n, 0, 0, W, H);

  if (opts?.picked) {
    const px = ((opts.picked.u + 1) / 2) * W;
    const py = ((1 - opts.picked.v) / 2) * H; // 翻转
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    if (opts.crosshair) {
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
      ctx.moveTo(0, py);
      ctx.lineTo(W, py);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(px, py, 5.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#111027';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px, py, 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/** 绘制色标（供面板 legend 复用） */
export function drawLegend(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const img = ctx.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const [r, g, b] = colorFor(x / (w - 1));
    for (let y = 0; y < h; y++) {
      const off = (y * w + x) * 4;
      img.data[off] = r;
      img.data[off + 1] = g;
      img.data[off + 2] = b;
      img.data[off + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
