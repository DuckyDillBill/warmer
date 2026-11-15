import { ConvexClient } from 'convex/browser';
import { anyApi } from 'convex/server';

// "Bun & Done" — a fake fast-food self-order kiosk for the Warmer demo (iPad, portrait).
// Deliberately a screen that doesn't talk: no speech, no screen-reader hints.
type Item = { id: string; name: string; emoji: string; price: number; desc: string; meal?: boolean };
type Category = { id: string; name: string; emoji: string; items: Item[] };
type Line = { name: string; price: number };

const MENU: Category[] = [
  {
    id: 'burgers', name: 'Burgers', emoji: '🍔', items: [
      { id: 'cheeseburger', name: 'Cheeseburger', emoji: '🍔', price: 5.49, desc: 'Beef patty, American cheese, pickles, onions.', meal: true },
      { id: 'double', name: 'Double Stack', emoji: '🍔', price: 7.29, desc: 'Two patties, two slices of cheese, house sauce.', meal: true },
      { id: 'chicken', name: 'Crispy Chicken', emoji: '🍗', price: 6.49, desc: 'Fried chicken breast, lettuce, mayo.', meal: true },
      { id: 'veggie', name: 'Veggie Burger', emoji: '🥬', price: 6.19, desc: 'Plant patty, tomato, lettuce, pickles.', meal: true },
    ],
  },
  {
    id: 'sides', name: 'Sides', emoji: '🍟', items: [
      { id: 'fries', name: 'Fries', emoji: '🍟', price: 2.99, desc: 'Golden, salted, crispy.' },
      { id: 'rings', name: 'Onion Rings', emoji: '🧅', price: 3.49, desc: 'Beer-battered onion rings.' },
      { id: 'nuggets', name: 'Nuggets', emoji: '🍗', price: 4.29, desc: '6 chicken nuggets with sauce.' },
      { id: 'salad', name: 'Side Salad', emoji: '🥗', price: 3.29, desc: 'Greens, tomato, ranch.' },
    ],
  },
  {
    id: 'drinks', name: 'Drinks', emoji: '🥤', items: [
      { id: 'cola', name: 'Cola', emoji: '🥤', price: 1.99, desc: 'Ice cold, medium.' },
      { id: 'lemonade', name: 'Lemonade', emoji: '🍋', price: 2.49, desc: 'Fresh squeezed.' },
      { id: 'water', name: 'Water', emoji: '💧', price: 1.29, desc: 'Bottled water.' },
      { id: 'shake', name: 'Milkshake', emoji: '🥛', price: 3.99, desc: 'Vanilla, chocolate or strawberry.' },
    ],
  },
  {
    id: 'desserts', name: 'Desserts', emoji: '🍦', items: [
      { id: 'cone', name: 'Ice Cream', emoji: '🍦', price: 1.79, desc: 'Soft-serve vanilla cone.' },
      { id: 'cookie', name: 'Cookie', emoji: '🍪', price: 1.49, desc: 'Warm chocolate chip.' },
      { id: 'pie', name: 'Apple Pie', emoji: '🥧', price: 1.99, desc: 'Hot baked apple pie.' },
      { id: 'brownie', name: 'Brownie', emoji: '🍫', price: 2.29, desc: 'Fudge brownie.' },
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

function go(s: KScreen) {
  screen = s;
  render();
}

function header(): string {
  const n = cart.length;
  return `<header><div class="logo" data-logo>Bun <span>&amp;</span> Done</div>
    <div class="cartpill">${n === 0 ? 'Your order is empty' : `${n} item${n > 1 ? 's' : ''} · ${money(total())}`}</div></header>`;
}

function render() {
  window.clearTimeout(doneTimer);
  const s = screen;
  let html = '';
  switch (s.name) {
    case 'start':
      html = `<button class="start" data-act="begin">
        <div class="big">🍔</div>
        <div class="title" data-logo>Bun <span>&amp;</span> Done</div>
        <div class="cta">Tap to start your order</div>
      </button>`;
      break;

    case 'categories':
      html = `${header()}<main>
        <h1>What are you craving?</h1>
        <div class="grid">${MENU.map((c) => `
          <button class="tile" data-cat="${c.id}"><div class="emoji">${c.emoji}</div><div class="name">${c.name}</div></button>`).join('')}
        </div>
        <div class="spacer"></div>
        <div class="bottombar">
          <button class="btn ghost small" data-act="restart">Start over</button>
          <button class="btn" data-act="checkout" ${cart.length ? '' : 'style="opacity:.35"'}>Checkout</button>
        </div>
      </main>`;
      break;

    case 'items':
      html = `${header()}<main>
        <h1>${s.cat.name}</h1>
        <div class="grid">${s.cat.items.map((it) => `
          <button class="tile" data-item="${it.id}"><div class="emoji">${it.emoji}</div><div class="name">${it.name}</div><div class="price">${money(it.price)}</div></button>`).join('')}
        </div>
        <div class="spacer"></div>
        <div class="bottombar"><button class="btn ghost small" data-act="back-cats">Back</button></div>
      </main>`;
      break;

    case 'detail':
      html = `${header()}<main>
        <div class="detail">
          <div class="emoji">${s.item.emoji}</div>
          <div class="name">${s.item.name}</div>
          <div class="desc">${s.item.desc}</div>
          <div class="price">${money(s.item.price)}</div>
        </div>
        <div class="row">
          <button class="btn ghost" data-act="back-items">Back</button>
          <button class="btn" data-act="add">Add to order</button>
        </div>
      </main>`;
      break;

    case 'meal':
      html = `${header()}<main>
        <div class="detail">
          <div class="emoji">🍔🍟🥤</div>
          <div class="name">Make it a meal?</div>
          <div class="desc">Add medium fries and a drink to your ${s.item.name}.</div>
          <div class="price">+ $3.49</div>
        </div>
        <button class="btn" data-act="meal-yes">Yes, make it a meal</button>
        <div class="row"><div class="spacer"></div><button class="btn ghost small" data-act="meal-no">No thanks</button></div>
      </main>`;
      break;

    case 'cart':
      html = `${header()}<main>
        <h1>Your order</h1>
        <div class="cart">
          ${cart.map((l) => `<div class="line"><span>${l.name}</span><span>${money(l.price)}</span></div>`).join('')}
          <div class="total"><span>Total</span><span>${money(total())}</span></div>
        </div>
        <div class="spacer"></div>
        <div class="row">
          <button class="btn ghost" data-act="back-cats">Add more</button>
          <button class="btn" data-act="pay">Pay</button>
        </div>
      </main>`;
      break;

    case 'roundup': {
      const t = cart.reduce((sum, l) => sum + l.price, 0);
      const r = Math.ceil(t) - t || 1;
      html = `${header()}<main>
        <div class="detail">
          <div class="emoji">💛</div>
          <div class="name">Round up for charity?</div>
          <div class="desc">Round up your total and help feed families in your community.</div>
          <div class="price">+ ${money(r)}</div>
        </div>
        <button class="btn" data-act="round-yes">Round up</button>
        <div class="row"><div class="spacer"></div><button class="btn ghost small" data-act="round-no">No thanks</button></div>
      </main>`;
      break;
    }

    case 'pin':
      html = `${header()}<main>
        <h1>Enter your PIN</h1>
        <h2>Card inserted · Total ${money(total())}</h2>
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
        <div class="emoji" style="font-size:120px">✅</div>
        <div class="msg">Thank you!</div>
        <div class="num">Order #${orderNumber}</div>
        <div class="msg">Please wait for your number.</div>
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
  const titleEl = app.querySelector('h1, .done .num, .detail .name, .start .title') as HTMLElement | null;
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
