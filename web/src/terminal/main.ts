export {};
// "PayPoint" - a fake countertop card terminal (portrait). A screen that doesn't talk.
type Screen = 'total' | 'present' | 'pin' | 'processing' | 'approved' | 'cancelled';

const TOTAL = '$12.48';
let screen: Screen = 'total';
let digits = 0;
let timer: number | undefined;
const app = document.getElementById('app')!;

function go(s: Screen) {
  screen = s;
  render();
}

function render() {
  window.clearTimeout(timer);
  const top = `<div class="top"><div class="logo" data-logo>PAY<span>POINT</span></div><div>Terminal 03</div></div>`;
  let body = '';
  switch (screen) {
    case 'total':
      body = `<div class="screen"><div class="label">Total</div><div class="amount">${TOTAL}</div><div class="sub">Purchase · Lane 3</div></div>
        <div class="row"><button class="btn red" data-act="cancel">Cancel</button><button class="btn green" data-act="pay">Pay</button></div>`;
      break;
    case 'present':
      body = `<div class="screen"><div class="title">Tap, insert<br>or swipe</div><div class="sub">${TOTAL}</div>
        <button class="tapzone" data-act="card"><div class="waves">)))</div>Tap card here</button></div>
        <div class="row"><button class="btn" data-act="card">Insert chip</button><button class="btn" data-act="card">Swipe</button></div>
        <button class="btn red" data-act="cancel">Cancel</button>`;
      break;
    case 'pin':
      body = `<div class="screen" style="flex:0 0 auto"><div class="title">Enter PIN</div><div class="sub">${TOTAL}</div>
        <div class="dots">${[0, 1, 2, 3].map((i) => `<div class="dot ${i < digits ? 'on' : ''}"></div>`).join('')}</div></div>
        <div class="keypad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button class="key" data-key="${d}">${d}</button>`).join('')}
          <button class="key fn btn yellow" data-act="clear">Clear</button>
          <button class="key" data-key="0">0</button>
          <button class="key fn btn green" data-act="enter">Enter</button>
        </div>
        <button class="btn red" data-act="cancel">Cancel</button>`;
      break;
    case 'processing':
      body = `<div class="screen"><div class="processing"></div><div class="title">Processing</div><div class="sub">Do not remove card</div></div>`;
      timer = window.setTimeout(() => go('approved'), 1500);
      break;
    case 'approved':
      body = `<div class="screen approved"><div class="check">✓</div><div class="title">Approved</div><div class="sub">${TOTAL} · Auth 482913</div><div class="sub">Please remove card</div></div>
        <button class="btn green" data-act="done">Done</button>`;
      timer = window.setTimeout(reset, 30000);
      break;
    case 'cancelled':
      body = `<div class="screen"><div class="title">Transaction<br>cancelled</div></div>
        <button class="btn" data-act="restart">Start again</button>`;
      break;
  }
  app.innerHTML = top + body;
}

function reset() {
  digits = 0;
  go('total');
}

app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-act],[data-key]') as HTMLElement | null;
  if (!el) return;
  if (el.dataset.key && screen === 'pin') {
    digits = Math.min(4, digits + 1);
    return render();
  }
  switch (el.dataset.act) {
    case 'pay': return go('present');
    case 'card': digits = 0; return go('pin');
    case 'clear': digits = 0; return render();
    case 'enter': if (digits === 4) go('processing'); return;
    case 'cancel': digits = 0; return go('cancelled');
    case 'done':
    case 'restart': return reset();
  }
});

let pressTimer: number | undefined;
app.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement).closest('[data-logo]')) pressTimer = window.setTimeout(reset, 1500);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) app.addEventListener(ev, () => window.clearTimeout(pressTimer));

render();
