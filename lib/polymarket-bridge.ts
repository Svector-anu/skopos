const BRIDGE_BASE = "https://bridge.polymarket.com";
const TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export interface DepositAddresses {
  evm: string | null;
  svm: string | null;
  btc: string | null;
}

export async function generateDepositAddress(walletAddress: string): Promise<DepositAddresses | null> {
  try {
    const res = await fetchWithTimeout(`${BRIDGE_BASE}/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: walletAddress }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      evm: data.evm ?? null,
      svm: data.svm ?? null,
      btc: data.btc ?? null,
    };
  } catch {
    return null;
  }
}

export type DepositStatus =
  | "pending"
  | "processing"
  | "complete"
  | "failed"
  | "refunded"
  | "expired";

export interface DepositStatusResult {
  status: DepositStatus;
  amount?: string;
}

export async function getDepositStatus(depositAddress: string): Promise<DepositStatusResult | null> {
  try {
    const res = await fetchWithTimeout(
      `${BRIDGE_BASE}/deposit/status?address=${encodeURIComponent(depositAddress)}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      status: data.status as DepositStatus,
      amount: data.amount ?? undefined,
    };
  } catch {
    return null;
  }
}
