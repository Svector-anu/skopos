import { NextRequest } from "next/server";
import { z } from "zod";
import { checkRateLimit, trustedIp } from "@/lib/rateLimit";
import { getSeal, putPendingOrder } from "@/lib/sealStore";
import { compileSeal, validateSize, typedDataMismatch, impactRejection } from "@/lib/seal";
import { toFlashBracketWire } from "@/lib/flashBracket";
import { resolveFlashOrderLeg } from "@/app/api/chat/route";

export const dynamic = "force-dynamic";

// Instantiating a Seal: policy + one number → a fresh Flash quote for THIS
// wallet. Nothing is cached and nothing is shared. Two wallets opening the same
// Seal a second apart get two different quotes, and that is the correct
// behaviour rather than a limitation — the Seal stores intent, never a price.
//
// The response is byte-compatible with the quote card app/api/chat/route.ts
// already returns for an advanced order, which is what lets the existing
// QuoteDisplay and FlashExecuteButton render and sign a Seal with no new card
// component and no change to the proven signing ladder. The `seal` block is
// additive, the way `analysis` already is.

const bodySchema = z.object({
  size:          z.string().min(1).max(32),
  senderAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!checkRateLimit("seal-quote", trustedIp(req), 20)) {
    return Response.json({ type: "error", text: "Too many quotes. Wait a minute." }, { status: 429 });
  }

  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ type: "error", text: "Invalid request body." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ type: "error", text: "A size and a connected wallet are both required." }, { status: 400 });
  }

  const read = await getSeal(id);
  if (!read.ok) {
    return read.reason === "unavailable"
      ? Response.json({ type: "error", text: "Couldn't load this Seal right now." }, { status: 503 })
      : Response.json({ type: "error", text: "No Seal with that id." }, { status: 404 });
  }
  const policy = read.policy;
  if (policy.retired) {
    return Response.json({ type: "error", text: "This Seal was retired by its creator." }, { status: 410 });
  }

  const sizeIssue = validateSize(policy, parsed.data.size);
  if (sizeIssue) {
    return Response.json({ type: "error", text: sizeIssue.message, code: sizeIssue.code }, { status: 422 });
  }

  // The consumer supplies a size. Every other field comes from the stored
  // record, so there is no field a browser could name.
  const intent = compileSeal(policy, parsed.data.size);
  const result = await resolveFlashOrderLeg(intent, parsed.data.senderAddress);
  if (!result.ok) {
    return Response.json({ type: result.ask ? "text" : "error", text: result.text }, { status: 422 });
  }

  // Sending maxPriceImpact is necessary and not sufficient — Flash's spec says
  // the estimate it returns can exceed the cap the request asked for. A Seal is
  // sized by someone who did not write it, so a size the author never imagined
  // must be refused here rather than signed.
  const impact = impactRejection(result.route.priceImpact, policy.maxImpact);
  if (impact) {
    return Response.json({ type: "error", text: impact.message, code: impact.code }, { status: 422 });
  }

  // Checked before the payload is handed to a wallet, not after. A Seal is
  // authored by someone the signer has never met, so "the thing on screen is
  // the thing being signed" cannot rest on the two having been produced by the
  // same person.
  const mismatch = typedDataMismatch(result.flash.orderTypedData, { fromToken: result.flash.contraAsset });
  if (mismatch) {
    console.error("[seal-quote] typed data disagreed with the compiled intent:", policy.id, mismatch);
    return Response.json({ type: "error", text: mismatch }, { status: 502 });
  }

  // The order body is assembled HERE, once, from the policy — not by the
  // browser at submit time. The field mapping mirrors FlashExecuteButton's
  // exactly, including the trap it documents: /order validates independently of
  // /quote, and a bracketed limit entry must carry limitCrossPrice where a bare
  // one carries limitNotionalPrice. Sending the wrong basis fails after the user
  // has signed, which is the most expensive place to find out.
  const f = result.flash;
  const stored = await putPendingOrder(f.quoteId, {
    sealId:        policy.id,
    size:          parsed.data.size,
    funderAddress: f.funderAddress,
    submit: {
      targetChain: f.targetChain, contraChain: f.contraChain,
      targetAsset: f.targetAsset, contraAsset: f.contraAsset,
      side: f.side, qty: f.qty, orderType: f.orderType,
      funderAddress: f.funderAddress, quoteId: f.quoteId,
      flashIntegratorFeeBps: f.flashIntegratorFeeBps,
      evmOrderTypedData: f.orderTypedData,
      ...(f.orderType === "limit" && f.triggerPrice
        ? (f.bracket ? { limitCrossPrice: f.triggerPrice } : { limitNotionalPrice: f.triggerPrice })
        : {}),
      ...(f.triggerType && f.triggerPrice
        ? { triggers: [{ notionalPrice: f.triggerPrice, triggerType: f.triggerType }] }
        : {}),
      ...(f.twapBucketCount ? { twapBucketCount: f.twapBucketCount } : {}),
    },
    bracket: f.bracket
      ? {
          wire:                toFlashBracketWire({ takeProfit: f.bracket.takeProfit, stopLoss: f.bracket.stopLoss }),
          deadline:            f.bracket.deadline,
          signedMaxFromAmount: f.bracket.signedMaxFromAmount,
          salt:                f.bracket.salt,
        }
      : null,
  });
  if (!stored) {
    // Without the parked order there is nothing to submit against later, and
    // falling through would hand the user a card whose button cannot work.
    return Response.json({ type: "error", text: "Couldn't prepare this order right now. Try again shortly." }, { status: 503 });
  }

  return Response.json({
    type: "quote", mode: "preview", quotedAt: Date.now(),
    intent: result.intent, route: result.route,
    approval: null, calldata: null, flash: result.flash, raw: null,
    seal: { id: policy.id, title: policy.title, creator: policy.creator, size: parsed.data.size },
  });
}
