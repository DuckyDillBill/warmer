// Warmer "eyes": rear camera + MediaPipe hand tracking.
// Runs inside the Expo app's WebView (or standalone in a browser with ?debug=1).
// All coordinates are normalized 0–1 of the camera frame, top-left origin (see CLAUDE.md §4).
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { ScreenWatcher } from './screenWatcher';
import { Broadcaster } from './broadcast';

type Box = [number, number, number, number];
type InMsg =
  | { type: 'captureFrame'; id: string }
  | { type: 'setTarget'; box: Box | null; label?: string; private?: boolean }
  | { type: 'debug'; on: boolean }
  | { type: 'sensitivity'; value: 'normal' | 'high' };

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const video = document.getElementById('video') as HTMLVideoElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const startBtn = document.getElementById('start') as HTMLButtonElement;
const ctx = overlay.getContext('2d')!;

const params = new URLSearchParams(location.search);
let debug = params.get('debug') === '1';
let target: Box | null = null;
let targetLabel = '';
let targetPrivate = false; // PIN entry: nothing is broadcast to the projector
let fingertip: { x: number; y: number } | null = null;
let landmarker: HandLandmarker | null = null;
const watcher = new ScreenWatcher();
// Broadcast to the projector's /watch page when running in the app (or with ?broadcast=1).

// ---------- bridge ----------
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (s: string) => void };
    warmerReceive?: (msg: InMsg) => void;
  }
}
const inApp = !!window.ReactNativeWebView;
const broadcaster = new Broadcaster(inApp || params.get('broadcast') === '1' ? import.meta.env.VITE_CONVEX_URL : undefined);
function send(msg: Record<string, unknown>) {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  else if (debug && msg.type !== 'fingertip') console.log('[eyes →]', msg);
}
function receive(msg: InMsg) {
  switch (msg.type) {
    case 'captureFrame': {
      const jpeg = captureJpeg();
      send({ type: 'frame', id: msg.id, jpeg, hash: watcher.hash() });
      break;
    }
    case 'setTarget':
      target = msg.box;
      targetLabel = msg.label ?? '';
      targetPrivate = !!msg.private;
      break;
    case 'debug':
      debug = msg.on;
      statusEl.style.display = debug ? 'block' : 'none';
      break;
    case 'sensitivity':
      watcher.setSensitivity(msg.value);
      break;
  }
}
window.warmerReceive = receive;
const onMessage = (e: MessageEvent) => {
  try {
    const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    if (msg && typeof msg.type === 'string') receive(msg);
  } catch {
    /* ignore non-JSON */
  }
};
window.addEventListener('message', onMessage);
document.addEventListener('message', onMessage as EventListener);

// ---------- camera ----------
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = stream;
  await video.play();
}

async function startTracking() {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const opts = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO' as const,
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

// ---------- capture ----------
const captureCanvas = document.createElement('canvas');
function captureJpeg(): string {
  const w = video.videoWidth;
  const h = video.videoHeight;
  const scale = Math.min(1, 1024 / w);
  captureCanvas.width = Math.round(w * scale);
  captureCanvas.height = Math.round(h * scale);
  captureCanvas.getContext('2d')!.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
  return captureCanvas.toDataURL('image/jpeg', 0.8).split(',')[1];
}

// ---------- drawing ----------
// The video uses object-fit: contain, so compute where the frame actually sits on screen.
function videoRect() {
  const cw = overlay.clientWidth;
  const ch = overlay.clientHeight;
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const s = Math.min(cw / vw, ch / vh);
  const w = vw * s;
  const h = vh * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  if (overlay.width !== overlay.clientWidth * dpr) {
    overlay.width = overlay.clientWidth * dpr;
    overlay.height = overlay.clientHeight * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
  const r = videoRect();
  if (target) {
    const [x0, y0, x1, y1] = target;
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ff9a3c';
    ctx.strokeRect(r.x + x0 * r.w, r.y + y0 * r.h, (x1 - x0) * r.w, (y1 - y0) * r.h);
    if (debug) {
      // center 60% = the "on" zone
      const cx0 = x0 + (x1 - x0) * 0.2, cy0 = y0 + (y1 - y0) * 0.2;
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + cx0 * r.w, r.y + cy0 * r.h, (x1 - x0) * 0.6 * r.w, (y1 - y0) * 0.6 * r.h);
      ctx.setLineDash([]);
    }
  }
  if (fingertip && debug) {
    ctx.beginPath();
    ctx.arc(r.x + fingertip.x * r.w, r.y + fingertip.y * r.h, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#3cf0ff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.stroke();
  }
}

// ---------- main loop ----------
let lastVideoTime = -1;
let lastSent = 0;
let frames = 0;
let fpsT = performance.now();
let fps = 0;

function loop() {
  const now = performance.now();
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, now);
    const hand = res.landmarks?.[0];
    if (hand) {
      const tip = hand[8];
      fingertip = { x: tip.x, y: tip.y };
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (const p of hand) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      watcher.setHand([minX, minY, maxX, maxY]);
      if (now - lastSent > 30) {
        send({ type: 'fingertip', x: tip.x, y: tip.y, t: Date.now() });
        lastSent = now;
      }
    } else {
      if (fingertip) send({ type: 'nohand', t: Date.now() });
      fingertip = null;
      watcher.setHand(null);
    }
    if (targetPrivate) broadcaster.hide(now);
    else broadcaster.tick(now, video, fingertip, target, targetLabel);
    const changed = watcher.update(video, now);
    if (changed) send({ type: 'screenChanged', hash: watcher.hash() });
    frames++;
  }
  if (now - fpsT > 1000) {
    fps = frames;
    frames = 0;
    fpsT = now;
    if (debug) statusEl.textContent = `${fps} fps · ${fingertip ? 'hand' : 'no hand'} · ${inApp ? 'in app' : 'browser'}`;
  }
  draw();
  requestAnimationFrame(loop);
}

async function boot() {
  statusEl.style.display = debug || !inApp ? 'block' : 'none';
  try {
    await startCamera();
  } catch (e) {
    // Some browsers need a tap before the camera can start.
    statusEl.textContent = 'Tap to start the camera';
    startBtn.style.display = 'block';
    await new Promise<void>((res) => startBtn.addEventListener('click', () => res(), { once: true }));
    startBtn.style.display = 'none';
    try {
      await startCamera();
    } catch (err) {
      statusEl.textContent = 'Camera error: ' + (err as Error).message;
      send({ type: 'error', message: 'camera: ' + (err as Error).message });
      return;
    }
  }
  statusEl.textContent = 'Loading hand tracking…';
  try {
    await startTracking();
  } catch (err) {
    statusEl.textContent = 'Hand tracking error: ' + (err as Error).message;
    send({ type: 'error', message: 'tracking: ' + (err as Error).message });
    return;
  }
  statusEl.textContent = 'Ready';
  send({ type: 'ready' });
  requestAnimationFrame(loop);
}

// Standalone test: tap anywhere to set a fake target box around the tap.
if (!inApp && debug) {
  overlay.style.pointerEvents = 'auto';
  overlay.addEventListener('click', (e) => {
    const r = videoRect();
    const x = (e.clientX - r.x) / r.w, y = (e.clientY - r.y) / r.h;
    target = [x - 0.08, y - 0.05, x + 0.08, y + 0.05];
  });
}

boot();
