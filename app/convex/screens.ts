import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';

export const recent = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query('screens').order('desc').take(300),
});

export const get = internalQuery({
  args: { id: v.id('screens') },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const insert = internalMutation({
  args: {
    hash: v.string(),
    summary: v.string(),
    buttons: v.array(v.object({ label: v.string(), box: v.array(v.number()), kind: v.string() })),
  },
  handler: async (ctx, args) => ctx.db.insert('screens', { ...args, createdAt: Date.now() }),
});
