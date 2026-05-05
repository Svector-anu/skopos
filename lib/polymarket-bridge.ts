const BRIDGE_BASE = "https://bridge.polymarket.com";
const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"; // Polygon mainnet
const PUSD_DECIMALS = 6;
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

// Queries pUSD balance on Polygon by wallet address — no deposit address needed.
// Returns balance in USD, or null on failure.
export async function getPolymarketBalance(walletAddress: string): Promise<number | null> {
  const key = process.env.ALCHEMY_API_KEY ?? "";
  const rpc = `https://polygon-mainnet.g.alchemy.com/v2/${key}`;
  // balanceOf(address) selector: 0x70a08231
  const data = "0x70a08231" + walletAddress.slice(2).padStart(64, "0");
  try {
    const res = await fetchWithTimeout(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: PUSD_ADDRESS, data }, "latest"],
      }),
    });
    if (!res.ok) return null;
    const { result } = await res.json();
    if (!result || result === "0x" || result === "0x0") return 0;
    return Number(BigInt(result)) / 10 ** PUSD_DECIMALS;
  } catch {
    return null;
  }
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
