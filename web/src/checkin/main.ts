export {};
// "Skylark Air" - a fake airport self check-in kiosk (portrait). A screen that doesn't talk.
type Screen = 'start' | 'code' | 'found' | 'seat' | 'review' | 'printing' | 'done';

const KEYS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
let screen: Screen = 'start';
let code = '';
let seat: { type: 'Window' | 'Aisle'; id: string } | null = null;
let timer: number | undefined;
const app = document.getElementById('app')!;

function go(s: Screen) {
  screen = s;
  render();
}

const head = (step: string) => `<header><div class="logo" data-logo>Skylark <span>Air</span></div><div class="step">${step}</div></header>`;
const flight = () => `<div class="route"><div>SFO<small>San Francisco</small></div><div class="arrow">✈</div><div style="text-align:right">JFK<small>New York</small></div></div>
  <div class="facts"><div>Flight<b>SK 482</b></div><div>Departs<b>7:45 AM</b></div><div>Gate<b>B12</b></div></div>`;

function render() {
  window.clearTimeout(timer);
  let html = '';
  switch (screen) {
    case 'start':
      html = `<button class="start" data-act="begin"><div class="plane">✈</div><div class="brand" data-logo>Skylark <span>Air</span></div><div class="cta">Touch to check in</div></button>`;
      break;
    case 'code':
      html = `${head('Step 1 of 4')}<main>
        <h1>Enter your confirmation code</h1><h2>6 letters or numbers, found on your booking email</h2>
        <div class="boxes">${[0, 1, 2, 3, 4, 5].map((i) => `<div class="box ${i === code.length ? 'cur' : ''}">${code[i] ?? ''}</div>`).join('')}</div>
        <div class="spacer"></div>
        <div class="kb">
          ${KEYS.map((row) => row.split('').map((k) => `<button class="k" data-key="${k}">${k}</button>`).join('') + (row.length < 10 && row !== KEYS[3] ? '<div></div>' : '')).join('')}
          <button class="k wide" data-act="del">⌫ Delete</button>
        </div>
        <div class="row"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="find" ${code.length === 6 ? '' : 'disabled'}>Continue</button></div>
      </main>`;
      break;
    case 'found':
      html = `${head('Step 2 of 4')}<main>
        <h1>Passenger found</h1><h2>Confirmation ${code}</h2>
        <div class="card"><div class="name">MAYA CHEN</div>${flight()}</div>
        <div class="spacer"></div>
        <div class="row"><button class="btn" data-act="back-code">Not me</button><button class="btn primary" data-act="to-seat">Continue</button></div>
      </main>`;
      break;
    case 'seat':
      html = `${head('Step 3 of 4')}<main>
        <h1>Choose your seat</h1><h2>Economy · Row 14</h2>
        <div class="seats">
          <button class="seat" data-seat="Window"><div class="ico">🪟</div><div class="t">Window</div><div class="s">Seat 14A</div></button>
          <button class="seat" data-seat="Aisle"><div class="ico">🚶</div><div class="t">Aisle</div><div class="s">Seat 14C</div></button>
        </div>
        <div class="spacer"></div>
        <div class="row"><button class="btn" data-act="back-found">Back</button><div></div></div>
      </main>`;
      break;
    case 'review':
      html = `${head('Step 4 of 4')}<main>
        <h1>You're checked in</h1><h2>${seat!.type} seat ${seat!.id} · Boarding 7:10 AM</h2>
        <div class="card"><div class="name">MAYA CHEN · ${seat!.id}</div>${flight()}</div>
        <div class="spacer"></div>
        <button class="btn primary" data-act="print">Print boarding pass</button>
        <button class="btn" data-act="to-seat">Change seat</button>
      </main>`;
      break;
    case 'printing':
      html = `${head('Printing')}<main><div class="center">
        <h1>Printing your boarding pass…</h1><div><div class="printer"></div><div class="paper"></div></div><h2>Take it from the slot below</h2>
      </div></main>`;
      timer = window.setTimeout(() => go('done'), 2200);
      break;
    case 'done':
      html = `${head('Complete')}<main><div class="center">
        <div class="ok">✓</div><h1>Have a great flight!</h1><h2>SK 482 · Gate B12 · Seat ${seat!.id}</h2>
      </div><button class="btn primary" data-act="restart">Done</button></main>`;
      timer = window.setTimeout(reset, 30000);
      break;
  }
  app.innerHTML = html;
}

function reset() {
  code = '';
  seat = null;
  go('start');
}

app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-act],[data-key],[data-seat]') as HTMLElement | null;
  if (!el) return;
  if (el.dataset.key && screen === 'code') {
    if (code.length < 6) code += el.dataset.key;
    return render();
  }
  if (el.dataset.seat) {
    seat = el.dataset.seat === 'Window' ? { type: 'Window', id: '14A' } : { type: 'Aisle', id: '14C' };
    return go('review');
  }
  switch (el.dataset.act) {
    case 'begin': return go('code');
    case 'del': code = code.slice(0, -1); return render();
    case 'cancel':
    case 'restart': return reset();
    case 'find': if (code.length === 6) go('found'); return;
    case 'back-code': code = ''; return go('code');
    case 'to-seat': return go('seat');
    case 'back-found': return go('found');
    case 'print': return go('printing');
  }
});

let pressTimer: number | undefined;
app.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement).closest('[data-logo]')) pressTimer = window.setTimeout(reset, 1500);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) app.addEventListener(ev, () => window.clearTimeout(pressTimer));

render();
