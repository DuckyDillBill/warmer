import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

const box = v.array(v.number()); // [x0, y0, x1, y1], normalized 0–1, top-left origin

export default defineSchema({
  // Shared screen memory: once any user's phone maps a screen, it's instant for everyone.
  screens: defineTable({
    hash: v.string(), // 64-bit dHash, 16 hex chars
    summary: v.string(),
    buttons: v.array(v.object({ label: v.string(), box, kind: v.string() })),
    createdAt: v.number(),
  }).index('by_hash', ['hash']),

  // Orders placed on the demo kiosk, shown live on /live.
  orders: defineTable({
    items: v.array(v.object({ name: v.string(), price: v.number() })),
    total: v.number(),
    number: v.number(),
    createdAt: v.number(),
  }),
});
