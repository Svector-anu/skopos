"use client";

import { useRef, useEffect, useState } from "react";
import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  useAccount,
  useSendTransaction,
  useWriteContract,
  useReadContract,
  useWaitForTransactionReceipt,
} from "wagmi";

type ApprovalInfo = {
  tokenAddress: string;
  spender: string;
  amount: string;
} | null;

type QuoteResult = {
  type: "quote";
  intent: {
    from: { chain: string; token: string; amount: string };
    to: { chain: string; token: string };
  };
  route: {
    tool: string;
    outputAmount: string;
    feesUSD: string | null;
    gasUSD: string | null;
  };
  approval: ApprovalInfo;
  calldata: { to: string; value: string; data: string } | null;
};

type TextResult = { type: "text"; text: string };
type ErrorResult = { type: "error"; text: string };
type Result = QuoteResult | TextResult | ErrorResult;

const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
const BEBAS: React.CSSProperties = { fontFamily: "var(--font-bebas-neue), sans-serif" };

const ERC20_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export default function AppPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const { address } = useAccount();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function submit() {
    const msg = value.trim();
    if (!msg || loading) return;
    setLoading(true);
    setResult(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, senderAddress: address }),
      });
      const data: Result = await res.json();
      setResult(data);
    } catch {
      setResult({ type: "error", text: "Network error. Is the server running?" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-black flex flex-col items-center justify-center px-4">
      <Link
        href="/"
        className="absolute top-6 left-6 text-white/30 hover:text-white/60 transition-colors text-xs tracking-widest uppercase"
        style={MONO}
      >
        ← back
      </Link>

      <div className="absolute top-5 right-6">
        <ConnectButton
          showBalance={false}
          chainStatus="none"
          accountStatus="address"
        />
      </div>

      <div className="flex flex-col items-center gap-6 w-full max-w-lg">
        <h1
          className="text-white text-center leading-none"
          style={{ ...BEBAS, fontSize: "clamp(2.5rem, 6vw, 3.5rem)", letterSpacing: "0.02em" }}
        >
          What do you want to do?
        </h1>

        <form
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          className="w-full flex flex-col gap-3"
        >
          <div
            className="w-full flex items-center gap-3 px-4 py-3"
            style={{ background: "#0A0A0A", border: "1px solid rgba(255,255,255,0.12)" }}
          >
            <span className="text-sm shrink-0" style={{ color: "#F5B800", ...MONO }}>{">"}</span>
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="move 1 eth from ethereum to base"
              className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-white/20"
              style={MONO}
            />
            {loading && (
              <span className="text-white/30 text-xs shrink-0 animate-pulse" style={MONO}>routing…</span>
            )}
          </div>

          <button
            type="submit"
            disabled={!value.trim() || loading}
            className="w-full py-2.5 text-xs tracking-widest uppercase border transition-colors"
            style={{
              ...MONO,
              background: "transparent",
              borderColor: value.trim() && !loading ? "rgba(245,184,0,0.5)" : "rgba(255,255,255,0.1)",
              color: value.trim() && !loading ? "#F5B800" : "rgba(255,255,255,0.2)",
              cursor: value.trim() && !loading ? "pointer" : "not-allowed",
            }}
          >
            {loading ? "routing…" : "get quote →"}
          </button>
        </form>

        {result && (
          <div
            className="w-full"
            style={{ background: "#0A0A0A", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            {result.type === "quote" && <QuoteDisplay result={result} />}
            {(result.type === "text" || result.type === "error") && (
              <div className="px-4 py-3">
                <p
                  className="text-sm"
                  style={{ ...MONO, color: result.type === "error" ? "#ff4444" : "rgba(255,255,255,0.6)" }}
                >
                  {result.text}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function QuoteDisplay({ result }: { result: QuoteResult }) {
  const { address, isConnected } = useAccount();
  const { intent, route, calldata, approval } = result;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: approval?.tokenAddress as `0x${string}` | undefined,
    abi: ERC20_ABI,
    functionName: "allowance",
    args:
      address && approval
        ? [address, approval.spender as `0x${string}`]
        : undefined,
    query: { enabled: !!address && !!approval },
  });

  const needsApproval =
    !!approval &&
    (allowance === undefined || BigInt(allowance as bigint) < BigInt(approval.amount));

  const {
    writeContract,
    data: approvalHash,
    isPending: isApproving,
  } = useWriteContract();

  const { isSuccess: approvalConfirmed } = useWaitForTransactionReceipt({
    hash: approvalHash,
  });

  useEffect(() => {
    if (approvalConfirmed) refetchAllowance();
  }, [approvalConfirmed, refetchAllowance]);

  const {
    sendTransaction,
    data: txHash,
    isPending: isSending,
  } = useSendTransaction();

  const rows: [string, string][] = [
    ["route", `${intent.from.chain} → ${route.tool} → ${intent.to.chain}`],
    ["send", `${intent.from.amount} ${intent.from.token}`],
    ["receive", `~${route.outputAmount} ${intent.to.token}`],
    ...(route.feesUSD ? [["fees", `~$${Number(route.feesUSD).toFixed(4)}`] as [string, string]] : []),
    ...(route.gasUSD ? [["gas", `~$${Number(route.gasUSD).toFixed(4)}`] as [string, string]] : []),
  ];

  function approve() {
    if (!approval) return;
    writeContract({
      address: approval.tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [approval.spender as `0x${string}`, BigInt(approval.amount)],
    });
  }

  function execute() {
    if (!calldata) return;
    sendTransaction({
      to: calldata.to as `0x${string}`,
      value: BigInt(calldata.value || "0x0"),
      data: calldata.data as `0x${string}`,
    });
  }

  const explorerBase: Record<string, string> = {
    Ethereum: "https://etherscan.io/tx/",
    Base: "https://basescan.org/tx/",
    Arbitrum: "https://arbiscan.io/tx/",
    Optimism: "https://optimistic.etherscan.io/tx/",
    Polygon: "https://polygonscan.com/tx/",
    Avalanche: "https://snowtrace.io/tx/",
    BSC: "https://bscscan.com/tx/",
  };
  const explorerUrl = txHash
    ? `${explorerBase[intent.from.chain] ?? "https://etherscan.io/tx/"}${txHash}`
    : null;

  return (
    <div className="px-4 py-3 flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {rows.map(([label, val]) => (
          <div key={label} className="flex items-start gap-3">
            <span className="text-xs w-16 shrink-0" style={{ ...MONO, color: "#F5B800" }}>
              {label}
            </span>
            <span className="text-xs text-white/70" style={MONO}>
              {val}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 pt-1">
        {txHash ? (
          <a
            href={explorerUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full py-2.5 text-xs tracking-widest uppercase border text-center transition-colors"
            style={{
              ...MONO,
              background: "transparent",
              borderColor: "rgba(245,184,0,0.4)",
              color: "#F5B800",
            }}
          >
            view tx →
          </a>
        ) : !isConnected ? (
          <div className="w-full flex justify-center py-1">
            <ConnectButton label="connect wallet to execute" showBalance={false} chainStatus="none" />
          </div>
        ) : needsApproval ? (
          <button
            onClick={approve}
            disabled={isApproving || (!!approvalHash && !approvalConfirmed)}
            className="w-full py-2.5 text-xs tracking-widest uppercase border transition-colors"
            style={{
              ...MONO,
              background: "transparent",
              borderColor: "rgba(245,184,0,0.5)",
              color: "#F5B800",
              cursor: isApproving ? "wait" : "pointer",
            }}
          >
            {isApproving
              ? "approving…"
              : approvalHash && !approvalConfirmed
              ? "waiting for confirmation…"
              : `approve ${intent.from.token} →`}
          </button>
        ) : (
          <button
            onClick={execute}
            disabled={!calldata || isSending}
            className="w-full py-2.5 text-xs tracking-widest uppercase border transition-colors"
            style={{
              ...MONO,
              background: "transparent",
              borderColor: calldata ? "rgba(245,184,0,0.5)" : "rgba(255,255,255,0.1)",
              color: calldata ? "#F5B800" : "rgba(255,255,255,0.2)",
              cursor: calldata && !isSending ? "pointer" : "not-allowed",
            }}
          >
            {isSending ? "confirm in wallet…" : "execute →"}
          </button>
        )}
      </div>
    </div>
  );
}
