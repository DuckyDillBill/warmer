import { mutation, query } from './_generated/server';
import { v } from 'convex/values';

// Called by the demo kiosk when an order is completed.
export const place = mutation({
  args: { items: v.array(v.object({ name: v.string(), price: v.number() })), total: v.number() },
  handler: async (ctx, { items, total }) => {
    const last = await ctx.db.query('orders').order('desc').first();
    const number = last ? last.number + 1 : 42;
    await ctx.db.insert('orders', { items, total, number, createdAt: Date.now() });
    return number;
  },
});

// Live dashboard for the projector.
export const recent = query({
  args: {},
  handler: async (ctx) => ctx.db.query('orders').order('desc').take(8),
});
