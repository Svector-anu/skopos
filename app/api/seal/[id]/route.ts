import { NextRequest } from "next/server";
import { getSeal, getInstantiationCount } from "@/lib/sealStore";

export const dynamic = "force-dynamic";

// Public read. No wallet, no auth, no quote — a Seal is a document until
// somebody chooses to act on it, and knowing the id is the only access control
// there is, which is appropriate for an object that grants nothing and holds
// nothing.
//
// The response is an explicit allowlist rather than the stored record, copying
// what headlessHandoffFields (lib/cardToText.ts) does for advanced orders: if a
// future field on SealPolicy ever carries something quote-shaped, it cannot
// reach a caller through this route by accident.

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const read = await getSeal(id);

  if (!read.ok) {
    return read.reason === "unavailable"
      ? Response.json({ error: "Couldn't load this Seal right now." }, { status: 503 })
      : Response.json({ error: "No Seal with that id." }, { status: 404 });
  }

  const p = read.policy;
  return Response.json({
    id:        p.id,
    version:   p.version,
    title:     p.title,
    creator:   p.creator,
    createdAt: p.createdAt,
    retired:   p.retired === true,
    side:      p.side,
    orderType: p.orderType,
    token:     p.token,
    chain:     p.chain,
    ...(p.priceLevel      !== undefined ? { priceLevel:      p.priceLevel } : {}),
    ...(p.triggerType     !== undefined ? { triggerType:     p.triggerType } : {}),
    ...(p.durationSeconds !== undefined ? { durationSeconds: p.durationSeconds } : {}),
    ...(p.twapBucketCount !== undefined ? { twapBucketCount: p.twapBucketCount } : {}),
    ...(p.bracket         !== undefined ? { bracket:         p.bracket } : {}),
    sizing:         p.sizing,
    instantiations: await getInstantiationCount(p.id),
  });
}
