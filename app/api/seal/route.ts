import { NextRequest } from "next/server";
import { z } from "zod";
import { verifyMessage } from "viem";
import { checkRateLimit, trustedIp } from "@/lib/rateLimit";
import { putSeal } from "@/lib/sealStore";
import { sealPublishMessage, validateSealPolicy, type SealDraft } from "@/lib/seal";
import { FLASH_ADVANCED_ORDER_CHAINS } from "@/app/api/chat/route";

export const dynamic = "force-dynamic";

const SITE = "https://www.tryskopos.xyz";

// Publishes a Seal — a reusable trading policy anyone can instantiate with
// their own wallet and their own size. zod here rather than the hand-rolled
// checks the other free routes use: this body is the ONLY place a Seal's fields
// are ever set, so a shape mistake here is permanent (records are immutable),
// and the paid routes already establish zod as the convention for structured
// input.
//
// The creator signs the policy before it is stored. Not for authorization —
// anyone may publish — but because the page shows a creator address to
// strangers, and an address nobody proved is an invitation to publish under
// someone else's name.

const SUPPORTED_CHAIN_IDS = new Set(Object.keys(FLASH_ADVANCED_ORDER_CHAINS).map(Number));

const bracketLeg = z.object({
  price:      z.string().min(1).max(32),
  basis:      z.enum(["notional", "cross"]),
  limitPrice: z.string().min(1).max(32).optional(),
});

const bodySchema = z.object({
  title:           z.string().min(1).max(120),
  creator:         z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  signature:       z.string().regex(/^0x[0-9a-fA-F]+$/),
  side:            z.enum(["buy", "sell"]),
  orderType:       z.enum(["limit", "stop-loss", "take-profit", "twap"]),
  token:           z.string().min(1).max(20),
  chain:           z.string().min(1).max(32),
  priceLevel:      z.string().min(1).max(32).optional(),
  triggerType:     z.enum(["upper", "lower"]).optional(),
  durationSeconds: z.number().int().positive().optional(),
  twapBucketCount: z.number().int().positive().optional(),
  bracket:         z.object({ takeProfit: bracketLeg, stopLoss: bracketLeg }).optional(),
  maxImpact:       z.string().min(1).max(16).optional(),
  sizing: z.object({
    min:       z.string().min(1).max(32),
    max:       z.string().min(1).max(32),
    suggested: z.string().min(1).max(32),
  }),
});

export async function POST(req: NextRequest) {
  if (!checkRateLimit("seal-publish", trustedIp(req), 10)) {
    return Response.json({ error: "Too many Seals published. Wait a minute." }, { status: 429 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid Seal." }, { status: 400 });
  }

  const { signature, ...draft } = parsed.data as z.infer<typeof bodySchema> & SealDraft;

  // Validated BEFORE the signature is checked: a malformed policy should tell
  // the creator what is wrong with it, not hand back a signature error that
  // says nothing about the take-profit sitting under the stop-loss.
  const issue = validateSealPolicy(draft, SUPPORTED_CHAIN_IDS);
  if (issue) return Response.json({ error: issue.message, code: issue.code }, { status: 422 });

  let signer = false;
  try {
    signer = await verifyMessage({
      address:   draft.creator as `0x${string}`,
      message:   sealPublishMessage(draft),
      signature: signature as `0x${string}`,
    });
  } catch {
    signer = false;
  }
  if (!signer) {
    return Response.json({ error: "That signature doesn't match this policy." }, { status: 401 });
  }

  const written = await putSeal(draft);
  if (!written.ok) {
    // Fails closed. A Seal the creator believes is live but which was never
    // stored is worse than an error they can retry.
    return Response.json({ error: "Couldn't save this Seal. Try again shortly." }, { status: 503 });
  }

  return Response.json({
    id:  written.policy.id,
    url: `${SITE}/s/${written.policy.id}`,
    policy: written.policy,
  }, { status: 201 });
}
