import { NextRequest } from "next/server";
import { HTTPFacilitatorClient, decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { getDefaultAsset } from "@x402/evm";
import { grantSub } from "@/lib/subscription";

export const dynamic = "force-dynamic";

// x402 merchant endpoint for the Smart subscription. The browser drives this via
// wrapFetchWithPayment (see the paywall Subscribe CTA): a request with no payment
// gets a 402 + requirements, the wallet signs an EIP-3009 USDC authorization, and
// the retry carries it in X-PAYMENT. We verify + settle through a remote
// facilitator (no Skopos hot wallet, no Skopos gas) and grant the verified payer a
// time-boxed pass. Settlement moves USDC payer -> SUB_PAYTO directly.
//
// COMPILE-VERIFIED ONLY: the 402 envelope and requirements shape are round-trip
// checked against the real @x402 client parser, but live verify/settle on Base
// mainnet cannot be exercised without a funded wallet + a mainnet-capable
// facilitator. Expect the facilitator URL / auth to need tuning on first real run.

const BASE_NETWORK = "eip155:8453";
const SUB_PERIOD_DAYS = 30;

const FALLBACK_PAYTO = "0xFbFBDf4E84e691cAE80cb4424cc6d39734da2800"; // svector.eth

function subEnv() {
  const facilitatorUrl = process.env.X402_FACILITATOR_URL;
  const payTo = process.env.SUB_PAYTO ?? FALLBACK_PAYTO;
  const price = Number(process.env.SUB_PRICE_USDC ?? "5");
  return { facilitatorUrl, payTo, price };
}

function isSubscribeEnabled(): boolean {
  return Boolean(process.env.X402_FACILITATOR_URL);
}

let facilitator: HTTPFacilitatorClient | null = null;
function getFacilitator(url: string): HTTPFacilitatorClient {
  const authHeader = process.env.X402_FACILITATOR_AUTH_HEADER;
  const authValue = process.env.X402_FACILITATOR_AUTH_VALUE;
  if (!facilitator) {
    facilitator = new HTTPFacilitatorClient(
      authHeader && authValue
        ? {
            url,
            createAuthHeaders: async () => {
              const h = { [authHeader]: authValue };
              return { verify: h, settle: h, supported: h };
            },
          }
        : { url },
    );
  }
  return facilitator;
}

function buildRequirements(resource: string, payTo: string, priceUsdc: number): PaymentRequirements {
  const asset = getDefaultAsset(BASE_NETWORK);
  const atomic = BigInt(Math.round(priceUsdc * 10 ** asset.decimals)).toString();
  return {
    scheme: "exact",
    network: BASE_NETWORK,
    amount: atomic,
    resource,
    description: "Skopos Smart — 30-day subscription",
    mimeType: "application/json",
    payTo,
    maxTimeoutSeconds: 300,
    asset: asset.address,
    outputSchema: {},
    extra: { name: asset.name, version: asset.version },
  } as PaymentRequirements;
}

function paymentRequired(requirements: PaymentRequirements, error?: string): Response {
  return Response.json(
    { x402Version: 1, accepts: [requirements], ...(error && { error }) },
    { status: 402 },
  );
}

export async function POST(req: NextRequest) {
  if (!isSubscribeEnabled()) {
    return Response.json({ error: "Subscriptions are not enabled yet." }, { status: 503 });
  }

  const { facilitatorUrl, payTo, price } = subEnv();
  const resource = new URL(req.url).toString();
  const requirements = buildRequirements(resource, payTo, price);

  const paymentHeader = req.headers.get("x-payment") ?? req.headers.get("payment-signature");
  if (!paymentHeader) {
    return paymentRequired(requirements);
  }

  let payload;
  try {
    payload = decodePaymentSignatureHeader(paymentHeader);
  } catch {
    return paymentRequired(requirements, "Malformed payment header.");
  }

  const client = getFacilitator(facilitatorUrl!);

  let verification;
  try {
    verification = await client.verify(payload, requirements);
  } catch (err) {
    console.error("[subscribe] verify threw:", err instanceof Error ? err.message : err);
    return Response.json({ error: "Payment verification unavailable." }, { status: 502 });
  }
  if (!verification.isValid) {
    return paymentRequired(requirements, verification.invalidReason ?? "Payment invalid.");
  }

  let settlement;
  try {
    settlement = await client.settle(payload, requirements);
  } catch (err) {
    console.error("[subscribe] settle threw:", err instanceof Error ? err.message : err);
    return Response.json({ error: "Payment settlement unavailable." }, { status: 502 });
  }
  if (!settlement.success) {
    return paymentRequired(requirements, settlement.errorReason ?? "Settlement failed.");
  }

  const payer = settlement.payer ?? verification.payer;
  if (!payer) {
    console.error("[subscribe] settled but no payer address — not granting");
    return Response.json({ error: "Could not identify payer." }, { status: 500 });
  }

  const expiry = await grantSub(payer, SUB_PERIOD_DAYS);
  console.log(`[subscribe] granted ${payer} until ${new Date(expiry * 1000).toISOString()} (tx ${settlement.transaction})`);

  return Response.json(
    { ok: true, expiry, transaction: settlement.transaction },
    { status: 200, headers: { "X-PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement) } },
  );
}
