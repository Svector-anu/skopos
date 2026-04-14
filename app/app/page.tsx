"use client";

import { useRef, useEffect, useState } from "react";
import Link from "next/link";
import { usePrivy, useFundWallet } from "@privy-io/react-auth";
import { mainnet } from "viem/chains";
import {
  useAccount,
  useChainId,
  useSwitchChain,
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
    from: { chain: string; chainId: number; token: string; amount: string };
    to: { chain: string; chainId: number; token: string };
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
type AssistantResult = QuoteResult | TextResult | ErrorResult;

type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; result: AssistantResult };

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
  const bottomRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const { address } = useAccount();
  const { login, logout, authenticated, ready } = usePrivy();
  const { fundWallet } = useFundWallet();

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function submit() {
    const msg = value.trim();
    if (!msg || loading) return;

    setMessages((prev) => [...prev, { role: "user", text: msg }]);
    setValue("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, senderAddress: address }),
      });
      const data: AssistantResult = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", result: data }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", result: { type: "error", text: "Network error. Is the server running?" } },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="h-screen bg-black flex flex-col">
      {/* Top bar */}
      <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <Link
          href="/"
          className="text-white/30 hover:text-white/60 transition-colors text-xs tracking-widest uppercase"
          style={MONO}
        >
          ← back
        </Link>

        <span style={{ ...BEBAS, fontSize: "1.25rem", letterSpacing: "0.05em", color: "white" }}>
          Delora <span style={{ color: "#F5B800" }}>Copilot</span>
        </span>

        <div className="flex items-center gap-2">
          {ready && authenticated && address && (
            <button
              onClick={() => fundWallet({ address, options: { chain: mainnet } })}
              className="text-xs tracking-widest uppercase border px-3 py-1.5 transition-colors"
              style={{ ...MONO, borderColor: "rgba(245,184,0,0.3)", color: "rgba(245,184,0,0.7)", background: "transparent", cursor: "pointer" }}
            >
              fund
            </button>
          )}
          {ready && (
            authenticated ? (
              <button
                onClick={logout}
                className="text-xs tracking-widest uppercase border px-3 py-1.5 transition-colors"
                style={{ ...MONO, borderColor: "rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.4)", background: "transparent", cursor: "pointer" }}
              >
                {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "disconnect"}
              </button>
            ) : (
              <button
                onClick={login}
                className="text-xs tracking-widest uppercase border px-3 py-1.5 transition-colors"
                style={{ ...MONO, borderColor: "rgba(245,184,0,0.5)", color: "#F5B800", background: "transparent", cursor: "pointer" }}
              >
                connect →
              </button>
            )
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-4">
        {messages.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
            <p className="text-white/20 text-xs tracking-widest uppercase" style={MONO}>
              What do you want to do?
            </p>
            <div className="flex flex-col gap-1">
              {[
                "move 1 ETH from ethereum to base",
                "swap 100 USDC to ETH on arbitrum",
                "bridge 0.5 ETH from optimism to polygon",
              ].map((example) => (
                <button
                  key={example}
                  onClick={() => { setValue(example); inputRef.current?.focus(); }}
                  className="text-xs px-3 py-1.5 transition-colors text-left"
                  style={{ ...MONO, color: "rgba(255,255,255,0.25)", background: "transparent" }}
                >
                  {"> "}{example}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "user" ? (
              <div
                className="max-w-xs px-4 py-2 text-sm"
                style={{ ...MONO, background: "#0A0A0A", border: "1px solid rgba(245,184,0,0.2)", color: "rgba(255,255,255,0.8)" }}
              >
                <span style={{ color: "#F5B800" }}>&gt; </span>{msg.text}
              </div>
            ) : (
              <div className="max-w-sm w-full" style={{ background: "#0A0A0A", border: "1px solid rgba(255,255,255,0.08)" }}>
                {msg.result.type === "quote" && <QuoteDisplay result={msg.result} />}
                {(msg.result.type === "text" || msg.result.type === "error") && (
                  <div className="px-4 py-3">
                    <p
                      className="text-sm"
                      style={{ ...MONO, color: msg.result.type === "error" ? "#ff4444" : "rgba(255,255,255,0.6)" }}
                    >
                      {msg.result.text}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="px-4 py-3" style={{ background: "#0A0A0A", border: "1px solid rgba(255,255,255,0.08)" }}>
              <span className="text-xs text-white/30 animate-pulse" style={MONO}>routing…</span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-4 pb-4 pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="flex items-center gap-3 px-4 py-3" style={{ background: "#0A0A0A", border: "1px solid rgba(255,255,255,0.12)" }}>
          <span className="text-sm shrink-0" style={{ color: "#F5B800", ...MONO }}>{">"}</span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="move 1 ETH from ethereum to base…"
            className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-white/20"
            style={MONO}
          />
          <button
            type="submit"
            disabled={!value.trim() || loading}
            className="text-xs tracking-widest uppercase shrink-0 px-3 py-1 border transition-colors"
            style={{
              ...MONO,
              background: "transparent",
              borderColor: value.trim() && !loading ? "rgba(245,184,0,0.5)" : "rgba(255,255,255,0.08)",
              color: value.trim() && !loading ? "#F5B800" : "rgba(255,255,255,0.2)",
              cursor: value.trim() && !loading ? "pointer" : "not-allowed",
            }}
          >
            send
          </button>
        </form>
      </div>
    </main>
  );
}

function QuoteDisplay({ result }: { result: QuoteResult }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { login, authenticated } = usePrivy();
  const { intent, route, calldata, approval } = result;

  const originChainId = intent.from.chainId;
  const onCorrectChain = chainId === originChainId;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: approval?.tokenAddress as `0x${string}` | undefined,
    abi: ERC20_ABI,
    functionName: "allowance",
    chainId: originChainId,
    args:
      address && approval
        ? [address, approval.spender as `0x${string}`]
        : undefined,
    query: { enabled: !!address && !!approval },
  });

  const needsApproval =
    !!approval &&
    (allowance === undefined || BigInt(allowance as bigint) < BigInt(approval.amount));

  const { writeContract, data: approvalHash, isPending: isApproving } = useWriteContract();

  const { isSuccess: approvalConfirmed } = useWaitForTransactionReceipt({ hash: approvalHash });

  useEffect(() => {
    if (approvalConfirmed) refetchAllowance();
  }, [approvalConfirmed, refetchAllowance]);

  const { sendTransaction, data: txHash, isPending: isSending } = useSendTransaction();

  const rows: [string, string][] = [
    ["route", `${intent.from.chain} → ${route.tool} → ${intent.to.chain}`],
    ["send", `${intent.from.amount} ${intent.from.token}`],
    ["receive", `~${route.outputAmount} ${intent.to.token}`],
    ...(route.feesUSD ? [["fees", `~$${Number(route.feesUSD).toFixed(4)}`] as [string, string]] : []),
    ...(route.gasUSD ? [["gas", `~$${Number(route.gasUSD).toFixed(4)}`] as [string, string]] : []),
  ];

  async function approve() {
    if (!approval) return;
    if (!onCorrectChain) await switchChainAsync({ chainId: originChainId });
    writeContract({
      address: approval.tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [approval.spender as `0x${string}`, BigInt(approval.amount)],
      chainId: originChainId,
    });
  }

  async function execute() {
    if (!calldata) return;
    if (!onCorrectChain) await switchChainAsync({ chainId: originChainId });
    sendTransaction({
      to: calldata.to as `0x${string}`,
      value: BigInt(calldata.value || "0x0"),
      data: calldata.data as `0x${string}`,
      chainId: originChainId,
    });
  }

  const explorerBase: Record<string, string> = {
    Ethereum: "https://etherscan.io/tx/",
    Optimism: "https://optimistic.etherscan.io/tx/",
    Cronos: "https://explorer.cronos.org/tx/",
    BSC: "https://bscscan.com/tx/",
    Gnosis: "https://gnosis.blockscout.com/tx/",
    Unichain: "https://uniscan.xyz/tx/",
    Polygon: "https://polygonscan.com/tx/",
    Monad: "https://monadscan.com/tx/",
    Sonic: "https://explorer.soniclabs.com/tx/",
    "World Chain": "https://worldscan.org/tx/",
    HyperEVM: "https://hyperevmscan.io/tx/",
    Metis: "https://andromeda-explorer.metis.io/tx/",
    Soneium: "https://soneium.blockscout.com/tx/",
    Mantle: "https://mantlescan.xyz/tx/",
    Base: "https://basescan.org/tx/",
    Plasma: "https://plasmascan.to/tx/",
    Arbitrum: "https://arbiscan.io/tx/",
    Celo: "https://celoscan.io/tx/",
    Avalanche: "https://snowtrace.io/tx/",
    Ink: "https://explorer.inkonchain.com/tx/",
    Linea: "https://lineascan.build/tx/",
    Berachain: "https://berascan.com/tx/",
    Blast: "https://blastscan.io/tx/",
    Scroll: "https://scrollscan.com/tx/",
  };

  const explorerUrl = txHash
    ? `${explorerBase[intent.from.chain] ?? "https://etherscan.io/tx/"}${txHash}`
    : null;

  return (
    <div className="px-4 py-3 flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {rows.map(([label, val]) => (
          <div key={label} className="flex items-start gap-3">
            <span className="text-xs w-16 shrink-0" style={{ ...MONO, color: "#F5B800" }}>{label}</span>
            <span className="text-xs text-white/70" style={MONO}>{val}</span>
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
            style={{ ...MONO, background: "transparent", borderColor: "rgba(245,184,0,0.4)", color: "#F5B800" }}
          >
            view tx →
          </a>
        ) : !authenticated ? (
          <button
            onClick={login}
            className="w-full py-2.5 text-xs tracking-widest uppercase border transition-colors"
            style={{ ...MONO, background: "transparent", borderColor: "rgba(245,184,0,0.5)", color: "#F5B800", cursor: "pointer" }}
          >
            connect to execute →
          </button>
        ) : needsApproval ? (
          <button
            onClick={approve}
            disabled={isApproving || (!!approvalHash && !approvalConfirmed)}
            className="w-full py-2.5 text-xs tracking-widest uppercase border transition-colors"
            style={{ ...MONO, background: "transparent", borderColor: "rgba(245,184,0,0.5)", color: "#F5B800", cursor: isApproving ? "wait" : "pointer" }}
          >
            {isApproving ? "approving…" : approvalHash && !approvalConfirmed ? "waiting for confirmation…" : `approve ${intent.from.token} →`}
          </button>
        ) : (
          <button
            onClick={execute}
            disabled={!calldata || isSending}
            className="w-full py-2.5 text-xs tracking-widest uppercase border transition-colors"
            style={{ ...MONO, background: "transparent", borderColor: calldata ? "rgba(245,184,0,0.5)" : "rgba(255,255,255,0.1)", color: calldata ? "#F5B800" : "rgba(255,255,255,0.2)", cursor: calldata && !isSending ? "pointer" : "not-allowed" }}
          >
            {isSending ? "confirm in wallet…" : "execute →"}
          </button>
        )}
      </div>
    </div>
  );
}
