import { NextRequest } from "next/server";
import { z } from "zod";
import { submitFlashOrder } from "@/lib/flash";
import { getPendingOrder, clearPendingOrder, bumpInstantiations } from "@/lib/sealStore";

export const dynamic = "force-dynamic";

// The integrity boundary of the whole product.
//
// /api/flash/submit forwards whatever the browser sends — chains, assets, side,
// qty, prices, bracket — and never compares any of it to the quote it issued
// (issue #83). That is survivable on the typed-order path, where the person
// supplying the fields is the person who typed the order. A Seal removes that
// assumption: the policy was written by a stranger, so the browser must not be
// able to name a single field of it.
//
// So it doesn't. This route accepts a quoteId and a signature. Everything else
// is read back from the order that was derived at quote time from the stored
// policy. A tampered client cannot change the token, the chain, the price, the
// direction or the size, because it is never asked for them — and the fields it
// DOES send are the two only its own wallet could have produced.

const bodySchema = z.object({
  quoteId:           z.string().min(1).max(200),
  userSignature:     z.string().regex(/^0x[0-9a-fA-F]+$/),
  bracketSignature:  z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "A quote id and a signature are both required." }, { status: 400 });
  }
  const { quoteId, userSignature, bracketSignature } = parsed.data;

  const pending = await getPendingOrder(quoteId);
  if (!pending) {
    // Either the 180s window elapsed or this quote was already submitted. Both
    // mean the same thing to the user, and re-quoting is the fix for both —
    // this is also the quote-expiry enforcement the chat path has never had.
    return Response.json(
      { error: "That quote has expired. Get a fresh one and sign again." },
      { status: 409 },
    );
  }

  // The Seal in the URL must be the Seal the order was derived from. Without
  // this, a quote taken from a permissive Seal could be submitted against a
  // different one's page and be counted there.
  if (pending.sealId !== id) {
    return Response.json({ error: "That quote belongs to a different Seal." }, { status: 409 });
  }

  if (pending.bracket && !bracketSignature) {
    // A protected entry needs both signatures. Submitting the entry alone would
    // place a completely unprotected order for someone who chose protection.
    return Response.json({ error: "This Seal is protected — both signatures are required." }, { status: 400 });
  }

  try {
    const result = await submitFlashOrder({
      ...pending.submit,
      userSignature,
      ...(pending.bracket && bracketSignature
        ? {
            attachedBracket: {
              ...pending.bracket.wire,
              userSignature:       bracketSignature,
              deadline:            pending.bracket.deadline,
              signedMaxFromAmount: pending.bracket.signedMaxFromAmount,
              ...(pending.bracket.salt ? { salt: pending.bracket.salt } : {}),
            },
          }
        : {}),
    });

    // Cleared only now: a failed submit keeps its record so the signature the
    // user already gave can be retried.
    await clearPendingOrder(quoteId);
    // Counted at submit, never at quote — a quote is a look, an order is a use.
    await bumpInstantiations(id);

    return Response.json({ orderId: result.orderId, sealId: id, size: pending.size });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Order submission failed.";
    console.error("[seal-submit]", id, msg);
    return Response.json({ error: msg }, { status: 502 });
  }
}
