import { ConvexClient } from 'convex/browser';
import { anyApi } from 'convex/server';

// "Bun & Done" — a fake fast-food self-order kiosk for the Warmer demo (iPad, portrait).
// Deliberately a screen that doesn't talk: no speech, no screen-reader hints.
type Item = { id: string; name: string; photo: number; price: number; cal: number; desc: string; meal?: boolean };
type Category = { id: string; name: string; photo: number; tone: string; items: Item[] };
type Line = { name: string; price: number };

// Food photos are free Pexels images, loaded from their CDN. If one can't load, the tile keeps a
// clean colored background, so the kiosk still looks finished offline.
const MENU: Category[] = [
  {
    id: 'burgers', name: 'Burgers', photo: 1639562, tone: '#5a2a17', items: [
      { id: 'cheeseburger', name: 'Cheeseburger', photo: 1639562, price: 5.49, cal: 540, desc: 'Flame-grilled beef, American cheese, pickles, onions, house sauce.', meal: true },
      { id: 'double', name: 'Double Stack', photo: 3915908, price: 7.29, cal: 780, desc: 'Two beef patties, two slices of cheese, lettuce, tomato.', meal: true },
    ],
  },
  {
    id: 'sides', name: 'Sides', photo: 1586942, tone: '#7a5410', items: [
      { id: 'fries', name: 'Fries', photo: 1586942, price: 2.99, cal: 320, desc: 'Golden, crispy, lightly salted.' },
      { id: 'large-fries', name: 'Large Fries', photo: 2235832, price: 3.79, cal: 490, desc: 'A bigger box of our golden fries.' },
    ],
  },
  {
    id: 'drinks', name: 'Drinks', photo: 4113656, tone: '#3b1d14', items: [
      { id: 'cola', name: 'Cola', photo: 4113656, price: 1.99, cal: 210, desc: 'Ice cold, medium.' },
      { id: 'soda', name: 'Lemon-Lime Soda', photo: 8880742, price: 1.99, cal: 190, desc: 'Crisp and bubbly, medium.' },
    ],
  },
  {
    id: 'desserts', name: 'Desserts', photo: 1294943, tone: '#6b4a3a', items: [
      { id: 'cone', name: 'Ice Cream Cone', photo: 1294943, price: 1.79, cal: 200, desc: 'Soft-serve vanilla.' },
      { id: 'sundae', name: 'Chocolate Sundae', photo: 5796721, price: 2.99, cal: 330, desc: 'Vanilla soft-serve, hot fudge, sprinkles.' },
    ],
  },
];

type KScreen =
  | { name: 'start' }
  | { name: 'categories' }
  | { name: 'items'; cat: Category }
  | { name: 'detail'; item: Item; cat: Category }
  | { name: 'meal'; item: Item }
  | { name: 'cart' }
  | { name: 'roundup' }
  | { name: 'pin'; digits: number }
  | { name: 'done' };

let screen: KScreen = { name: 'start' };
let cart: Line[] = [];
let roundedUp = 0;
let doneTimer: number | undefined;
let orderNumber = 42;
let placing = false;

const convexUrl = import.meta.env.VITE_CONVEX_URL;
const convex = convexUrl ? new ConvexClient(convexUrl) : null;

// The Warmer app's Reset button restarts this kiosk remotely (Convex `demo.state`).
const loadedAt = Date.now();
let lastReset = 0;
convex?.onUpdate(anyApi.demo.state, {}, (row: { resetAt: number } | null) => {
  if (!row || row.resetAt <= loadedAt || row.resetAt === lastReset) return;
  lastReset = row.resetAt;
  restart();
});

const app = document.getElementById('app')!;
const money = (n: number) => '$' + n.toFixed(2);
const total = () => cart.reduce((s, l) => s + l.price, 0) + roundedUp;
const photo = (id: number, w = 900) =>
  `<img class="ph" src="https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${w}" alt="" onerror="this.remove()">`;

function go(s: KScreen) {
  screen = s;
  render();
}

function header(title = ''): string {
  const n = cart.length;
  return `<header><div class="logo" data-logo>BUN<span>&amp;</span>DONE</div>
    <div class="htitle">${title}</div>
    <div class="cartpill">${n === 0 ? 'Bag empty' : `Bag · ${n} · ${money(total())}`}</div></header>`;
}

function render() {
  window.clearTimeout(doneTimer);
  const s = screen;
  let html = '';
  switch (s.name) {
    case 'start':
      html = `<div class="start">
        ${photo(1639562, 1400)}
        <div class="shade"></div>
        <div class="startbody">
          <div class="title" data-logo>BUN<span>&amp;</span>DONE</div>
          <div class="headline">Order here</div>
          <button class="cta" data-act="begin">Touch to start</button>
        </div>
      </div>`;
      break;

    case 'categories':
      html = `${header('Menu')}<main>
        <h1>What would you like?</h1>
        <div class="grid">${MENU.map((c) => `
          <button class="tile" data-cat="${c.id}" style="--tone:${c.tone}">${photo(c.photo)}<div class="label"><div class="name">${c.name}</div></div></button>`).join('')}
        </div>
        <div class="bottombar">
          <button class="btn ghost" data-act="restart">Start over</button>
          <button class="btn" data-act="checkout" ${cart.length ? '' : 'disabled'}>Checkout</button>
        </div>
      </main>`;
      break;

    case 'items':
      html = `${header(s.cat.name)}<main>
        <h1>${s.cat.name}</h1>
        <div class="grid one">${s.cat.items.map((it) => `
          <button class="tile wide" data-item="${it.id}" style="--tone:${s.cat.tone}">${photo(it.photo)}<div class="label"><div class="name">${it.name}</div><div class="price">${money(it.price)} · ${it.cal} Cal</div></div></button>`).join('')}
        </div>
        <div class="bottombar"><button class="btn ghost" data-act="back-cats">Back to menu</button></div>
      </main>`;
      break;

    case 'detail':
      html = `${header(s.cat.name)}<main>
        <div class="hero" style="--tone:${s.cat.tone}">${photo(s.item.photo, 1200)}</div>
        <div class="info">
          <div class="name">${s.item.name}</div>
          <div class="desc">${s.item.desc}</div>
          <div class="meta"><span class="price">${money(s.item.price)}</span><span class="cal">${s.item.cal} Cal</span></div>
        </div>
        <div class="row">
          <button class="btn ghost" data-act="back-items">Back</button>
          <button class="btn" data-act="add">Add to order</button>
        </div>
      </main>`;
      break;

    case 'meal':
      html = `${header('Make it a meal')}<main>
        <div class="mealpics">
          <div class="mp" style="--tone:#5a2a17">${photo(s.item.photo, 600)}</div>
          <div class="mp" style="--tone:#7a5410">${photo(1586942, 600)}</div>
          <div class="mp" style="--tone:#3b1d14">${photo(4113656, 600)}</div>
        </div>
        <div class="info">
          <div class="name">Make it a meal?</div>
          <div class="desc">Add medium fries and a medium drink to your ${s.item.name}.</div>
          <div class="meta"><span class="price">+ $3.49</span></div>
        </div>
        <div class="row">
          <button class="btn ghost" data-act="meal-no">No thanks</button>
          <button class="btn" data-act="meal-yes">Yes, make it a meal</button>
        </div>
      </main>`;
      break;

    case 'cart':
      html = `${header('Your order')}<main>
        <h1>Review your order</h1>
        <div class="cart">
          ${cart.map((l) => `<div class="line"><span>${l.name}</span><span>${money(l.price)}</span></div>`).join('')}
          <div class="total"><span>Total</span><span>${money(total())}</span></div>
        </div>
        <div class="row">
          <button class="btn ghost" data-act="back-cats">Add more</button>
          <button class="btn" data-act="pay">Pay ${money(total())}</button>
        </div>
      </main>`;
      break;

    case 'roundup': {
      const t = cart.reduce((sum, l) => sum + l.price, 0);
      const r = Math.ceil(t) - t || 1;
      html = `${header()}<main>
        <div class="info"><div class="name">Round up for charity?</div><div class="meta"><span class="price">+ ${money(r)}</span></div></div>
        <div class="row"><button class="btn ghost" data-act="round-no">No thanks</button><button class="btn" data-act="round-yes">Round up</button></div>
      </main>`;
      break;
    }

    case 'pin':
      html = `${header('Payment')}<main>
        <h1>Enter your PIN</h1>
        <div class="dots">${[0, 1, 2, 3].map((i) => `<div class="dot ${i < s.digits ? 'on' : ''}"></div>`).join('')}</div>
        <div class="keypad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button class="key" data-key="${d}">${d}</button>`).join('')}
          <button class="key cancel" data-act="pin-cancel">Cancel</button>
          <button class="key" data-key="0">0</button>
          <button class="key ok" data-act="pin-ok">OK</button>
        </div>
      </main>`;
      break;

    case 'done':
      html = `<div class="done">
        <div class="check">✓</div>
        <div class="msg">Thank you</div>
        <div class="numlabel">Your order number</div>
        <div class="num">${orderNumber}</div>
        <div class="sub">Please wait for your number to be called.</div>
      </div>`;
      doneTimer = window.setTimeout(() => restart(), 30000);
      break;
  }
  app.innerHTML = html;
  requestAnimationFrame(publishLayout);
}

async function placeOrder() {
  if (placing) return;
  placing = true;
  orderNumber = 42;
  try {
    if (convex) {
      const order = convex.mutation(anyApi.orders.place, { items: cart, total: Math.round(total() * 100) / 100 });
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000));
      orderNumber = await Promise.race([order, timeout]);
    }
  } catch (err) {
    console.error('orders:place failed, using #42', err);
  } finally {
    placing = false;
  }
  go({ name: 'done' });
}

// Partner kiosk mode: publish this screen and where every button is (0–1 of the display), so a
// Warmer phone in "Partner kiosk" mode can guide to exact positions and know the instant a tap lands.
function publishLayout() {
  if (!convex) return;
  const W = document.documentElement.clientWidth || window.innerWidth;
  const H = document.documentElement.clientHeight || window.innerHeight;
  const els = Array.from(app.querySelectorAll<HTMLElement>('[data-act],[data-cat],[data-item],[data-key]'));
  const buttons = els
    .map((el) => {
      const r = el.getBoundingClientRect();
      const name = el.querySelector('.name, .cta') as HTMLElement | null;
      const label = (name?.innerText || el.innerText || '').replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}$.,'&+ -]/gu, '').trim();
      return {
        label: label || el.dataset.act || '',
        rect: [r.left / W, r.top / H, r.right / W, r.bottom / H].map((n) => Math.round(n * 1000) / 1000),
        kind: el.dataset.key ? 'digit' : 'button',
      };
    })
    .filter((b) => b.rect[2] > b.rect[0] && b.rect[3] > b.rect[1]);
  const titleEl = app.querySelector('h1, .done .num, .info .name, .start .headline') as HTMLElement | null;
  const title = (titleEl?.innerText || screen.name).replace(/\s+/g, ' ').trim();
  const dots = screen.name === 'pin' ? ` (${(screen as { digits: number }).digits} of 4 digits entered)` : '';
  convex.mutation(anyApi.partner.publish, { screen: screen.name, title: title + dots, buttons }).catch(() => {});
}

function restart() {
  cart = [];
  roundedUp = 0;
  go({ name: 'start' });
}

app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-act],[data-cat],[data-item],[data-key]') as HTMLElement | null;
  if (!el || placing) return;
  const s = screen;
  if (el.dataset.cat) {
    const cat = MENU.find((c) => c.id === el.dataset.cat)!;
    return go({ name: 'items', cat });
  }
  if (el.dataset.item && s.name === 'items') {
    const item = s.cat.items.find((i) => i.id === el.dataset.item)!;
    return go({ name: 'detail', item, cat: s.cat });
  }
  if (el.dataset.key && s.name === 'pin') {
    return go({ name: 'pin', digits: Math.min(4, s.digits + 1) });
  }
  switch (el.dataset.act) {
    case 'begin': return go({ name: 'categories' });
    case 'restart': return restart();
    case 'back-cats': return go({ name: 'categories' });
    case 'back-items': if (s.name === 'detail') go({ name: 'items', cat: s.cat }); return;
    case 'add':
      if (s.name === 'detail') {
        cart.push({ name: s.item.name, price: s.item.price });
        if (s.item.meal) go({ name: 'meal', item: s.item });
        else go({ name: 'categories' });
      }
      return;
    case 'meal-yes':
      cart.push({ name: 'Meal upgrade (fries + drink)', price: 3.49 });
      return go({ name: 'categories' });
    case 'meal-no': return go({ name: 'categories' });
    case 'checkout': if (cart.length) go({ name: 'cart' }); return;
    case 'pay': return void placeOrder(); // demo flow ends at Pay: no round-up, no PIN
    case 'round-yes': {
      const t = cart.reduce((sum, l) => sum + l.price, 0);
      roundedUp = Math.ceil(t) - t || 1;
      return go({ name: 'pin', digits: 0 });
    }
    case 'round-no': return go({ name: 'pin', digits: 0 });
    case 'pin-cancel': return go({ name: 'cart' });
    case 'pin-ok': if (s.name === 'pin' && s.digits === 4) void placeOrder(); return;
  }
});

// Hidden reset for demos: long-press the logo for 1.5 s.
let pressTimer: number | undefined;
app.addEventListener('pointerdown', (e) => {
  if (!placing && (e.target as HTMLElement).closest('[data-logo]')) pressTimer = window.setTimeout(restart, 1500);
});
app.addEventListener('pointerup', () => window.clearTimeout(pressTimer));
app.addEventListener('pointercancel', () => window.clearTimeout(pressTimer));

render();
