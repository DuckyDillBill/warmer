// Projector view: shows the room what Warmer sees and does, live.
// Reads Convex: live.state (fingertip + target, ~10/s), live.frame (camera ~2/s),
// sessions.recent (goal + taps) and orders.recent (the finished order).
import { ConvexClient } from 'convex/browser';
import { anyApi } from 'convex/server';

type Box = [number, number, number, number];
type Pt = { x: number; y: number };
type LiveState = { finger: Pt | null; target: Box | null; label: string; updatedAt: number } | null;
type Session = { _id: string; goal: string; history: string[]; status: string; createdAt: number };
type Order = { _id: string; number: number; items: { name: string }[]; total: number; createdAt: number };

const $ = (id: string) => document.getElementById(id)!;
const img = $('img') as HTMLImageElement;
const ov = $('ov') as HTMLCanvasElement;
const ctx = ov.getContext('2d')!;

let state: LiveState = null;
let frameAt = 0;
let shown: Pt | null = null; // smoothed fingertip for drawing
const trail: Pt[] = [];
let lastLabel = '';
let currentSession = '';
let pageStart = Date.now();

// Same feel as the app (app/src/guidance.ts): distance to the target center, center 60% = "on".
function warmth(p: Pt | null, b: Box | null): { pct: number; text: string; on: boolean } {
  if (!b) return { pct: 0, text: 'Reading the screen…', on: false };
  if (!p) return { pct: 0, text: 'Waiting for a finger…', on: false };
  const [x0, y0, x1, y1] = b;
  const mx = 0.2 * (x1 - x0), my = 0.2 * (y1 - y0);
  if (p.x >= x0 + mx && p.x <= x1 - mx && p.y >= y0 + my && p.y <= y1 - my) return { pct: 100, text: 'ON IT — TAP!', on: true };
  const d = Math.min(1, Math.hypot(p.x - (x0 + x1) / 2, p.y - (y0 + y1) / 2) / Math.SQRT2);
  const pct = Math.round(100 * (1 - Math.pow(d, 0.6)));
  const text = d < 0.06 ? 'Hot! Almost there' : d < 0.12 ? 'Warmer…' : d < 0.3 ? 'Warm' : 'Cold';
  return { pct, text, on: false };
}

function rect() {
  const cw = ov.clientWidth, ch = ov.clientHeight;
  const vw = img.naturalWidth || 16, vh = img.naturalHeight || 9;
  const s = Math.min(cw / vw, ch / vh);
  return { x: (cw - vw * s) / 2, y: (ch - vh * s) / 2, w: vw * s, h: vh * s };
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  if (ov.width !== ov.clientWidth * dpr) {
    ov.width = ov.clientWidth * dpr;
    ov.height = ov.clientHeight * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, ov.clientWidth, ov.clientHeight);
  const r = rect();
  const target = state?.target ?? null;
  const finger = state?.finger ?? null;

  // Ease the drawn fingertip toward the latest position so it glides between updates.
  if (finger) {
    shown = shown ? { x: shown.x + (finger.x - shown.x) * 0.35, y: shown.y + (finger.y - shown.y) * 0.35 } : { ...finger };
    trail.push({ ...shown });
    if (trail.length > 14) trail.shift();
  } else {
    shown = null;
    trail.length = 0;
  }
  const w = warmth(shown, target);

  if (target) {
    const [x0, y0, x1, y1] = target;
    const t = w.pct / 100;
    const color = w.on ? '#33d17a' : `hsl(${Math.round(210 - 205 * t)}, 95%, 58%)`;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 10 + 40 * t + (w.on ? 20 * Math.sin(Date.now() / 90) : 0);
    ctx.lineWidth = 5;
    ctx.strokeStyle = color;
    ctx.strokeRect(r.x + x0 * r.w, r.y + y0 * r.h, (x1 - x0) * r.w, (y1 - y0) * r.h);
    ctx.restore();
  }
  trail.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(r.x + p.x * r.w, r.y + p.y * r.h, 4 + i, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(90,200,255,${(i + 1) / trail.length / 3})`;
    ctx.fill();
  });
  if (shown) {
    ctx.beginPath();
    ctx.arc(r.x + shown.x * r.w, r.y + shown.y * r.h, 16, 0, Math.PI * 2);
    ctx.fillStyle = '#5ac8ff';
    ctx.shadowColor = '#5ac8ff';
    ctx.shadowBlur = 25;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }

  ($('fill') as HTMLElement).style.width = `${w.pct}%`;
  const heat = $('heat');
  heat.textContent = w.text;
  heat.classList.toggle('on', w.on);

  const fresh = state && Date.now() - state.updatedAt < 4000;
  $('conn').classList.toggle('on', !!fresh);
  $('offline').classList.toggle('show', !fresh || Date.now() - frameAt > 6000);
  $('hidden').classList.toggle('show', !!state?.label.startsWith('🔒'));
  requestAnimationFrame(draw);
}

function renderSession(s: Session | undefined) {
  if (!s || s.createdAt < pageStart - 10 * 60_000) return;
  $('goal').textContent = s.goal || '—';
  const steps = $('steps');
  if (s._id !== currentSession) {
    currentSession = s._id;
    steps.innerHTML = '';
    $('order').classList.remove('show');
  }
  const have = steps.children.length;
  s.history.slice(have).forEach((h) => {
    const li = document.createElement('li');
    const m = h.match(/^Tapped "(.*)"$/);
    li.innerHTML = m ? `✅ Tapped <b></b>` : `• <b></b>`;
    (li.querySelector('b') as HTMLElement).textContent = m ? m[1] : h;
    steps.appendChild(li);
  });
}

function renderOrder(orders: Order[]) {
  const o = orders[0];
  if (!o || o.createdAt < pageStart) return; // only celebrate orders placed while this page is open
  const el = $('order');
  const names = o.items.map((i) => i.name).join(', ');
  el.innerHTML = `🎉 Order #${o.number} placed<small></small>`;
  (el.querySelector('small') as HTMLElement).textContent = names;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  $('label').textContent = 'Done!';
}

const url = import.meta.env.VITE_CONVEX_URL;
if (!url) {
  $('offline').textContent = 'VITE_CONVEX_URL is not set';
} else {
  const client = new ConvexClient(url);
  client.onUpdate(anyApi.live.state, {}, (s: LiveState) => {
    state = s;
    if (s && s.label !== lastLabel) {
      lastLabel = s.label;
      if (s.label && !s.label.startsWith('🔒')) $('label').textContent = s.label;
    }
  });
  client.onUpdate(anyApi.live.frame, {}, (f: { jpeg: string; updatedAt: number } | null) => {
    if (!f) return;
    frameAt = f.updatedAt;
    img.src = `data:image/jpeg;base64,${f.jpeg}`;
  });
  client.onUpdate(anyApi.sessions.recent, {}, (rows: Session[]) => renderSession(rows[0]));
  client.onUpdate(anyApi.orders.recent, {}, (rows: Order[]) => renderOrder(rows));
}
pageStart = Date.now();
requestAnimationFrame(draw);
