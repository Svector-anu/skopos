const BASE        = "https://api.bankr.bot";
const PARTNER_KEY = process.env.BANKR_PARTNER_KEY ?? "";
const TIMEOUT_MS  = 8000;

export function isBankrEnabled(): boolean {
  return PARTNER_KEY.length > 0;
}

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = new Headers(init?.headers);
  if (PARTNER_KEY) headers.set("X-Partner-Key", PARTNER_KEY);
  headers.set("Content-Type", "application/json");
  try {
    return await fetch(input, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export interface LaunchTokenParams {
  name: string;
  symbol: string;
  feeRecipient: string;
  image?: string;
  website?: string;
}

export interface LaunchedToken {
  tokenAddress: string;
  symbol?: string;
  name?: string;
  poolAddress?: string;
  txHash?: string;
  [key: string]: unknown;
}

export async function launchToken(params: LaunchTokenParams): Promise<LaunchedToken> {
  if (!PARTNER_KEY) throw new Error("Token launching is not enabled.");

  const body = {
    tokenName: params.name,
    tokenSymbol: params.symbol,
    feeRecipient: { type: "wallet", value: params.feeRecipient },
    ...(params.image && { image: params.image }),
    ...(params.website && { website: params.website }),
  };

  const res = await fetchWithTimeout(`${BASE}/token-launches/deploy`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[bankr] launch error ${res.status}:`, text.slice(0, 500));
    if (res.status === 403) throw new Error("Token launching isn't available on this account yet.");
    if (res.status === 429) throw new Error("Launch rate limit reached — try again shortly.");
    throw new Error(`Could not launch the token (status ${res.status}).`);
  }

  const data = await res.json();
  return (data.token ?? data) as LaunchedToken;
}
