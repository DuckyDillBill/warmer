// Spectator view for the projector (/watch). The phone's camera page writes small, frequent
// updates here; the watch page subscribes. One row per table, overwritten each time.
import { mutation, query } from './_generated/server';
import { v } from 'convex/values';

const box = v.array(v.number());

export const setState = mutation({
  args: {
    finger: v.union(v.object({ x: v.number(), y: v.number() }), v.null()),
    target: v.union(box, v.null()),
    label: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.query('liveState').first();
    const data = { ...args, updatedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, data);
    else await ctx.db.insert('liveState', data);
  },
});

export const setFrame = mutation({
  args: { jpeg: v.string() },
  handler: async (ctx, { jpeg }) => {
    if (jpeg.length > 400_000) return; // keep it small
    const row = await ctx.db.query('liveFrame').first();
    const data = { jpeg, updatedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, data);
    else await ctx.db.insert('liveFrame', data);
  },
});

export const state = query({ args: {}, handler: async (ctx) => ctx.db.query('liveState').first() });
export const frame = query({ args: {}, handler: async (ctx) => ctx.db.query('liveFrame').first() });
