export {};
// "Thermia" - a fake touch-panel microwave (landscape). A screen that doesn't talk.
type Mode = 'Ready' | 'Cook' | 'Popcorn' | 'Defrost' | 'Reheat' | 'Power' | 'Cooking' | 'Paused' | 'Done';

let entry = '';
let seconds = 0;
let power = 10;
let mode: Mode = 'Ready';
let preset: Mode | null = null;
let tick: number | undefined;
const app = document.getElementById('app')!;
const PRESETS: Record<string, number> = { Popcorn: 150, Defrost: 300, Reheat: 90 };

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const fromEntry = (d: string) => {
  const n = d.padStart(4, '0');
  return Number(n.slice(0, 2)) * 60 + Number(n.slice(2));
};

function render() {
  const running = mode === 'Cooking';
  const time = mode === 'Power' ? `PL${power}` : mode === 'Done' ? 'End' : mode === 'Ready' && !seconds ? fmt(0) : fmt(seconds);
  const btn = (act: string, label: string, cls = '') =>
    `<button class="b ${cls} ${preset === act || (act === 'Power' && mode === 'Power') ? 'on' : ''}" data-act="${act}">${label}</button>`;
  app.innerHTML = `
    <div class="left">
      <div class="logo" data-logo>THERMIA</div>
      <div class="display ${running ? 'running' : ''} ${mode === 'Done' ? 'done' : ''}">
        <div class="time">${time}</div>
        <div class="mode">${mode === 'Cooking' ? 'Cooking' + (preset ? ' · ' + preset : '') : mode}</div>
        <div class="power">Power ${power * 10}%</div>
      </div>
    </div>
    <div class="right">
      ${btn('Popcorn', 'Popcorn')}${btn('Defrost', 'Defrost')}${btn('Reheat', 'Reheat')}${btn('Power', 'Power')}
      ${[1, 2, 3].map((d) => `<button class="b num" data-num="${d}">${d}</button>`).join('')}${btn('add30', '+30 sec', 'tall')}
      ${[4, 5, 6].map((d) => `<button class="b num" data-num="${d}">${d}</button>`).join('')}
      ${[7, 8, 9, 0].map((d) => `<button class="b num" data-num="${d}">${d}</button>`).join('')}
      ${btn('stop', 'Stop / Clear', 'stop')}${btn('start', 'Start', 'start')}
    </div>`;
}

function stopTick() {
  window.clearInterval(tick);
  tick = undefined;
}

function clearAll() {
  stopTick();
  entry = '';
  seconds = 0;
  power = 10;
  preset = null;
  mode = 'Ready';
  render();
}

function start() {
  if (!seconds) return;
  mode = 'Cooking';
  stopTick();
  tick = window.setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      seconds = 0;
      stopTick();
      mode = 'Done';
      preset = null;
    }
    render();
  }, 1000);
  render();
}

app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-act],[data-num]') as HTMLElement | null;
  if (!el) return;
  const num = el.dataset.num;
  if (num !== undefined) {
    if (mode === 'Cooking') return;
    if (mode === 'Power') {
      power = num === '0' ? 10 : Number(num);
      mode = seconds ? 'Cook' : 'Ready';
      return render();
    }
    if (mode === 'Done' || preset) { entry = ''; preset = null; }
    entry = (entry + num).replace(/^0+/, '').slice(-4);
    seconds = fromEntry(entry);
    mode = 'Cook';
    return render();
  }
  const act = el.dataset.act!;
  if (act in PRESETS) {
    if (mode === 'Cooking') return;
    preset = act as Mode;
    entry = '';
    seconds = PRESETS[act];
    mode = act as Mode;
    return render();
  }
  switch (act) {
    case 'Power':
      if (mode === 'Cooking') return;
      mode = mode === 'Power' ? (seconds ? 'Cook' : 'Ready') : 'Power';
      return render();
    case 'add30':
      if (mode === 'Done' || mode === 'Power') mode = 'Ready';
      seconds = Math.min(seconds + 30, 99 * 60 + 59);
      entry = '';
      if (mode === 'Cooking') return render();
      return start();
    case 'start':
      if (mode === 'Power') mode = 'Cook';
      return start();
    case 'stop':
      if (mode === 'Cooking') {
        stopTick();
        mode = 'Paused';
        return render();
      }
      return clearAll();
  }
});

let pressTimer: number | undefined;
app.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement).closest('[data-logo]')) pressTimer = window.setTimeout(clearAll, 1500);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) app.addEventListener(ev, () => window.clearTimeout(pressTimer));

render();
