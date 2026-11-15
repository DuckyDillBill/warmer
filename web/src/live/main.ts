import { ConvexClient } from 'convex/browser';
import { anyApi } from 'convex/server';

type Order = { _id: string; number: number; items: { name: string; price: number }[]; total: number; createdAt: number };

const list = document.getElementById('orders')!;
const status = document.getElementById('status')!;
const money = (n: number) => '$' + n.toFixed(2);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function itemSummary(items: Order['items']): string {
  const counts = new Map<string, number>();
  for (const { name } of items) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${n}× ${name}` : name)).join(', ');
}

let seen: Set<string> | null = null;

function render(orders: Order[]) {
  status.textContent = 'Live';
  status.classList.add('live');
  if (!orders.length) {
    list.innerHTML = '<div class="empty">Waiting for the first order…</div>';
    seen = new Set();
    return;
  }
  list.innerHTML = orders
    .map((o) => {
      const isNew = seen !== null && !seen.has(o._id);
      return `<div class="order${isNew ? ' new' : ''}">
        <div class="num">#${o.number}</div>
        <div class="items">${esc(itemSummary(o.items))}</div>
        <div class="total">${money(o.total)}</div>
      </div>`;
    })
    .join('');
  seen = new Set(orders.map((o) => o._id));
}

const url = import.meta.env.VITE_CONVEX_URL;
if (!url) {
  status.textContent = 'Not configured';
  list.innerHTML = '<div class="empty">VITE_CONVEX_URL is not set.</div>';
} else {
  const client = new ConvexClient(url);
  client.onUpdate(anyApi.orders.recent, {}, (orders: Order[]) => render(orders), (err) => {
    status.textContent = 'Reconnecting…';
    status.classList.remove('live');
    console.error(err);
  });
}
