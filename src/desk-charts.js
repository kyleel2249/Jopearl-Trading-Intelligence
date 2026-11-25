// Canvas drawing helpers for Agent Desk Live. Pure functions of (canvas, data); safe to call on resize.
const UP = '#35d49a', DOWN = '#ff6b7a', LINE = '#53c5d5';
function prepare(canvas) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const ratio = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const w = Math.max(40, canvas.clientWidth || 300), h = Math.max(40, canvas.clientHeight || 120);
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio); }
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.setTransform(ratio, 0, 0, ratio, 0, 0); g.clearRect(0, 0, w, h);
  return { g, w, h };
}
export function drawLine(canvas, values) {
  const ctx = prepare(canvas), xs = (values || []).filter(Number.isFinite);
  if (!ctx || xs.length < 2) return false;
  const { g, w, h } = ctx, lo = Math.min(...xs), hi = Math.max(...xs), span = hi - lo || Math.abs(hi) * 0.01 || 1;
  const y = (v) => h - 6 - ((v - lo) / span) * (h - 12);
  g.beginPath(); xs.forEach((v, i) => { const x = (i / (xs.length - 1)) * w; if (i) g.lineTo(x, y(v)); else g.moveTo(x, y(v)); });
  g.strokeStyle = LINE; g.lineWidth = 2; g.stroke();
  g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fillStyle = 'rgba(83,197,213,.12)'; g.fill();
  return true;
}
export function drawCandles(canvas, rows, maxBars = 60) {
  const ctx = prepare(canvas), cs = (rows || []).slice(-maxBars);
  if (!ctx || !cs.length) return false;
  const { g, w, h } = ctx, lo = Math.min(...cs.map((r) => r[3])), hi = Math.max(...cs.map((r) => r[2])), span = hi - lo || 1;
  const y = (v) => h - 6 - ((v - lo) / span) * (h - 12), bw = w / maxBars;
  cs.forEach((r, i) => {
    const x = w - (cs.length - i) * bw + bw / 2, up = r[4] >= r[1];
    g.strokeStyle = g.fillStyle = up ? UP : DOWN; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y(r[2])); g.lineTo(x, y(r[3])); g.stroke();
    g.fillRect(x - bw * 0.32, Math.min(y(r[1]), y(r[4])), bw * 0.64, Math.max(1, Math.abs(y(r[1]) - y(r[4]))));
  });
  return true;
}
