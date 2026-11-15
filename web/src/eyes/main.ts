// Warmer "eyes": rear camera + MediaPipe hand tracking.
// Runs inside the Expo app's WebView (or standalone in a browser with ?debug=1).
// All coordinates are normalized 0–1 of the camera frame, top-left origin (see CLAUDE.md §4).
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { ScreenWatcher } from './screenWatcher';
import { Broadcaster } from './broadcast';
import { ShiftTracker } from './tracker';
import { BoxRefiner } from './refine';
import { HoverCorrector } from './parallax';

type Box = [number, number, number, number];
type InMsg =
  | { type: 'captureFrame'; id: string; crop?: Box }
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
const tracker = new ShiftTracker(); // keeps the box on its button when the phone moves
const refiner = new BoxRefiner(); // snaps the AI's rough box to the button's real edges
const refineOn = params.get('refine') !== '0'; // ?refine=0 turns snapping off for comparison
const hover = new HoverCorrector(); // fixes the offset when the finger hovers off the screen
hover.enabled = params.get('hover') !== '0'; // ?hover=0 turns the correction off for comparison
let handBox: Box | null = null;
let lastMovedSent: Box | null = null;
/** The target as it sits in the current frame (target + scene shift since Gemini saw it). */
const liveTarget = (): Box | null => (target ? tracker.apply(target) : null);
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
      tracker.snapshot(video);
      refiner.snapshot(video);
      const jpeg = captureJpeg(msg.crop);
      send({ type: 'frame', id: msg.id, jpeg, hash: watcher.hash() });
      break;
    }
    case 'setTarget':
      // Snap to the button's real edges first. lastMovedSent stays the app's box, so if snapping
      // changed it, the loop below immediately tells the app the corrected box.
      target = msg.box ? (refineOn ? refiner.refine(msg.box, video) : msg.box) : null;
      if (target) tracker.reset(video);
      else tracker.clear();
      lastMovedSent = msg.box;
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
    // Lower than default: a hand reaching toward a bright screen is often partly cut off or backlit,
    // and missing the hand is worse for a blind user than a slightly noisy fingertip.
    minHandDetectionConfidence: 0.3,
    minHandPresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
  });
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

// ---------- capture ----------
const captureCanvas = document.createElement('canvas');
/** JPEG of the camera frame, or of just `crop` (normalized region, e.g. the kiosk screen) at full detail. */
function captureJpeg(crop?: Box): string {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const [cx0, cy0, cx1, cy1] = crop ?? [0, 0, 1, 1];
  const sx = Math.max(0, cx0 * vw);
  const sy = Math.max(0, cy0 * vh);
  const sw = Math.min(vw - sx, (cx1 - cx0) * vw);
  const sh = Math.min(vh - sy, (cy1 - cy0) * vh);
  // 1024 px wide max: sharper image = more accurate button boxes. Cropping to the kiosk means those
  // pixels are spent on the buttons instead of the room around them.
  const scale = Math.min(1, 1024 / sw);
  captureCanvas.width = Math.round(sw * scale);
  captureCanvas.height = Math.round(sh * scale);
  captureCanvas.getContext('2d')!.drawImage(video, sx, sy, sw, sh, 0, 0, captureCanvas.width, captureCanvas.height);
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
  // Draw the camera picture on the same canvas, with the same mapping as the box and fingertip.
  // (Leaving it to the <video> element's CSS scaling made the box look offset on some phones,
  // even though the coordinates were right.)
  if (video.readyState >= 2) ctx.drawImage(video, r.x, r.y, r.w, r.h);
  const t = liveTarget();
  if (t) {
    const [x0, y0, x1, y1] = t;
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
      const tip = hover.correct(hand, now); // estimated touch point, not the raw hovering fingertip
      fingertip = { x: tip.x, y: tip.y };
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (const p of hand) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      handBox = [minX, minY, maxX, maxY];
      watcher.setHand(handBox);
      if (now - lastSent > 30) {
        send({ type: 'fingertip', x: tip.x, y: tip.y, t: Date.now() });
        lastSent = now;
      }
    } else {
      if (fingertip) send({ type: 'nohand', t: Date.now() });
      fingertip = null;
      handBox = null;
      watcher.setHand(null);
    }
    // Follow the scene every other frame and tell the app when the box has moved.
    // Box tracking every 4th frame only: hand detection needs the frame rate more.
    if (target && frames % 4 === 0) {
      tracker.update(video, handBox);
      const t = liveTarget()!;
      if (!lastMovedSent || Math.abs(t[0] - lastMovedSent[0]) + Math.abs(t[1] - lastMovedSent[1]) > 0.004) {
        lastMovedSent = t;
        send({ type: 'targetMoved', box: t });
      }
    }
    if (targetPrivate) broadcaster.hide(now);
    else broadcaster.tick(now, video, fingertip, liveTarget(), targetLabel);
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
  // The canvas shows the picture now; keep the video element playing but invisible.
  video.style.opacity = '0';
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
