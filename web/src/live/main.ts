// Projector board for the demo: what Warmer is doing right now, and orders landing from the kiosk.
// Polls Convex once a second over plain HTTP (no extra npm package).
import { convexQuery } from '../kiosk/convexHttp';

type Order = { _id: string; number: number; items: { name: string; price: number }[]; total: number; createdAt: number };
type Session = { _id: string; goal: string; history: string[]; status: string; createdAt: number };

const app = document.getElementById('app')!;
const seen = new Set<string>();
let first = true;

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const STATUS: Record<string, string> = {
  planning: 'Reading the screen…',
  guiding: 'Guiding the finger…',
  done: 'Done ✓',
  error: 'Retrying…',
};

async function refresh() {
  let orders: Order[] = [];
  let sessions: Session[] = [];
  try {
    [orders, sessions] = await Promise.all([
      convexQuery<Order[]>('orders:recent'),
      convexQuery<Session[]>('sessions:recent'),
    ]);
  } catch (err) {
    console.warn('live refresh failed', err);
    return;
  }

  const s = sessions[0];
  const sessionHtml = s
    ? `<div class="goal">“${esc(s.goal)}”</div>
       <div class="status">${esc(STATUS[s.status] ?? s.status)}</div>
       <ul class="steps">${s.history.slice(-6).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`
    : `<div class="empty">Waiting for someone to say what they want…</div>`;

  const ordersHtml = orders.length
    ? orders
        .map((o) => {
          const isNew = !first && !seen.has(o._id);
          seen.add(o._id);
          return `<div class="order ${isNew ? 'new' : ''}">
            <div class="num">#${o.number}</div>
            <div class="items">${o.items.map((i) => esc(i.name)).join(' · ')}</div>
            <div class="total">$${o.total.toFixed(2)}</div>
          </div>`;
        })
        .join('')
    : `<div class="empty">No orders yet.</div>`;
  first = false;

  app.innerHTML = `
    <section class="panel"><h1>Warmer is guiding</h1>${sessionHtml}</section>
    <section class="panel"><h1>Orders from the kiosk</h1>${ordersHtml}</section>`;
}

refresh();
setInterval(refresh, 1000);
