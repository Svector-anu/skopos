import { NextRequest } from "next/server";
import {
  updateFlashOrder, FlashUpdateError, validateFlashUpdateBody, flashUpdateErrorMessage,
  type FlashUpdateRequest, type FlashPriceTrigger, type FlashUpdateBodyIssue,
} from "@/lib/flash";

export const dynamic = "force-dynamic";

// Third of the Flash trio that follows the same non-custodial shape as
// app/api/flash/submit and app/api/flash/cancel: the browser signs with the
// funder wallet (only it holds the key), this route makes the call, because
// Flash's PATCH /orders/{orderId} needs Skopos's own x-definitive-api-key
// header, which the browser never receives.
//
// The message is built and signed client-side rather than here on purpose.
// It carries an "Issued At" stamp that must be within a minute of Flash's
// clock, and it is what the wallet shows the user before they approve — so
// the bytes they read have to be the exact bytes that get sent. Rebuilding
// them server-side would let the two diverge silently.
//
// Validation and status-to-copy mapping live in lib/flashUpdate so they can
// be tested without standing up a handler; this file stays thin on purpose.
interface UpdateBody {
  orderId?: string;
  updateMessage?: string;
  userSignature?: string;
  limitNotionalPrice?: string;
  limitCrossPrice?: string;
  trigger?: FlashPriceTrigger;
}

function badRequest(issue: FlashUpdateBodyIssue): Response {
  const text =
    issue.code === "missing_fields" ? `Missing required fields: ${issue.fields.join(", ")}.`
    : issue.code === "no_price" ? "No new price supplied."
    : issue.code === "both_limit_bases" ? "Send exactly one limit price basis."
    : "Send exactly one trigger price basis.";
  return Response.json({ error: text }, { status: 400 });
}

export async function POST(req: NextRequest) {
  let body: UpdateBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const issue = validateFlashUpdateBody(body);
  if (issue) return badRequest(issue);

  const { orderId, updateMessage, userSignature, limitNotionalPrice, limitCrossPrice, trigger } = body;
  const payload: FlashUpdateRequest = {
    updateMessage: updateMessage!,
    userSignature: userSignature!,
    ...(limitNotionalPrice ? { limitNotionalPrice } : {}),
    ...(limitCrossPrice ? { limitCrossPrice } : {}),
    ...(trigger ? { trigger } : {}),
  };

  try {
    const result = await updateFlashOrder(orderId!, payload);
    return Response.json(result);
  } catch (err) {
    if (err instanceof FlashUpdateError) {
      console.error(`[flash-update] ${err.status}: ${err.detail.slice(0, 300)}`);
      // Mirror Flash's own status so the client can branch, rather than
      // flattening every rejection into a 502 the way cancel does.
      return Response.json({ error: flashUpdateErrorMessage(err.status) }, { status: err.status });
    }
    const msg = err instanceof Error ? err.message : "Order update failed.";
    console.error("[flash-update]", msg);
    return Response.json({ error: flashUpdateErrorMessage(0) }, { status: 502 });
  }
}
