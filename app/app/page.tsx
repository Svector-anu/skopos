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

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function addrColor(addr: string) {
  const hue = parseInt(addr.slice(2, 8), 16) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

const EXAMPLES = [
  "move 1 ETH from ethereum to base",
  "swap 100 USDC to ETH on arbitrum",
  "bridge 0.5 ETH from optimism to polygon",
];

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

  async function submit(msg?: string) {
    const text = (msg ?? value).trim();
    if (!text || loading) return;
    setMessages((prev) => [...prev, { role: "user", text }]);
    setValue("");
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, senderAddress: address }),
      });
      const data: AssistantResult = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", result: data }]);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", result: { type: "error", text: "Network error. Is the server running?" } }]);
    } finally {
      setLoading(false);
    }
  }

  const QUICK_ACTIONS = [
    { label: "Bridge ETH", prompt: "bridge 0.1 ETH from ethereum to base" },
    { label: "Swap USDC", prompt: "swap 100 USDC to ETH on arbitrum" },
    { label: "Move to Polygon", prompt: "move 50 USDC from base to polygon" },
    { label: "Send to Optimism", prompt: "bridge 0.05 ETH from ethereum to optimism" },
    { label: "Swap on Base", prompt: "swap 10 USDC to ETH on base" },
  ];

  return (
    <main className="h-screen bg-black flex items-center justify-center">
      <div className="flex overflow-hidden" style={{ width: "min(900px, 100vw)", height: "min(700px, 100vh)", border: "1px solid rgba(255,255,255,0.08)" }}>

        {/* Sidebar */}
        <div className="flex flex-col shrink-0 border-r" style={{ width: 200, background: "#060606", borderColor: "rgba(255,255,255,0.06)" }}>
          {/* Logo */}
          <div className="px-4 h-11 flex items-center border-b shrink-0" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
            <Link href="/">
              <span style={{ ...BEBAS, fontSize: "1rem", letterSpacing: "0.06em", color: "white" }}>
                DELORA <span style={{ color: "#F5B800" }}>COPILOT</span>
              </span>
            </Link>
          </div>

          {/* New chat */}
          <div className="px-3 pt-3 pb-2 shrink-0">
            <button
              onClick={() => setMessages([])}
              className="w-full py-2 text-xs tracking-widest uppercase transition-colors text-left px-3"
              style={{ ...MONO, background: "rgba(245,184,0,0.06)", border: "1px solid rgba(245,184,0,0.15)", color: "#F5B800", cursor: "pointer" }}
            >
              + new chat
            </button>
          </div>

          {/* Quick actions */}
          <div className="px-3 pt-2 flex flex-col gap-1 shrink-0">
            <p className="text-xs px-1 pb-1" style={{ ...MONO, color: "rgba(255,255,255,0.2)", letterSpacing: "0.08em" }}>QUICK ACTIONS</p>
            {QUICK_ACTIONS.map(({ label, prompt }) => (
              <button
                key={label}
                onClick={() => submit(prompt)}
                className="w-full text-left px-3 py-2 text-xs transition-colors"
                style={{ ...MONO, color: "rgba(255,255,255,0.4)", background: "transparent", cursor: "pointer" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.75)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.4)")}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Wallet section at bottom */}
          <div className="mt-auto border-t px-3 py-3 flex flex-col gap-2" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
            {ready && authenticated && address ? (
              <>
                <p className="text-xs px-1" style={{ ...MONO, color: "rgba(255,255,255,0.2)", letterSpacing: "0.08em" }}>WALLET</p>
                <button
                  onClick={() => fundWallet({ address, options: { chain: mainnet } })}
                  className="w-full text-left px-3 py-2 text-xs transition-colors"
                  style={{ ...MONO, color: "rgba(245,184,0,0.6)", background: "transparent", cursor: "pointer" }}
                >
                  fund wallet
                </button>
                <button
                  onClick={logout}
                  className="w-full text-left px-3 py-2 text-xs transition-colors"
                  style={{ ...MONO, color: "rgba(255,255,255,0.3)", background: "transparent", cursor: "pointer" }}
                >
                  {shortAddr(address)}
                </button>
              </>
            ) : ready ? (
              <button
                onClick={login}
                className="w-full text-left px-3 py-2 text-xs transition-colors"
                style={{ ...MONO, color: "#F5B800", background: "transparent", cursor: "pointer" }}
              >
                connect wallet →
              </button>
            ) : null}
          </div>
        </div>

        {/* Chat panel */}
        <div className="flex-1 flex flex-col overflow-hidden" style={{ background: "#080808" }}>
        {/* Top bar */}
        <div className="shrink-0 flex items-center justify-end px-4 h-11 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <div className="flex items-center gap-2">
          {ready && (
            authenticated ? (
              <span className="text-xs" style={{ ...MONO, color: "rgba(255,255,255,0.2)" }}>
                {address ? shortAddr(address) : ""}
              </span>
            ) : (
              <button onClick={login} className="text-xs tracking-widest uppercase transition-colors" style={{ ...MONO, color: "#F5B800", background: "transparent", cursor: "pointer" }}>
                connect →
              </button>
            )
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-6">
        {messages.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-6">
            <p style={{ ...BEBAS, fontSize: "2rem", letterSpacing: "0.04em", color: "rgba(255,255,255,0.08)" }}>
              WHAT DO YOU WANT TO DO?
            </p>
            <div className="flex flex-col gap-2 w-full max-w-sm">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => submit(ex)}
                  className="text-left px-4 py-2.5 text-xs transition-colors"
                  style={{ ...MONO, color: "rgba(255,255,255,0.3)", background: "#0A0A0A", border: "1px solid rgba(255,255,255,0.06)" }}
                >
                  <span style={{ color: "#F5B800" }}>&gt; </span>{ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) =>
          msg.role === "user" ? (
            <div key={i} className="flex justify-end">
              <p className="text-sm max-w-xs" style={{ ...MONO, color: "rgba(255,255,255,0.75)" }}>
                {msg.text}
              </p>
            </div>
          ) : (
            <div key={i} className="flex justify-start">
              <div className="w-full max-w-sm flex flex-col gap-3">
                {msg.result.type === "quote" && (
                  <>
                    <p className="text-sm" style={{ ...MONO, color: "rgba(255,255,255,0.55)" }}>
                      {"Route found via "}
                      <span style={{ color: "#F5B800" }}>{msg.result.route.tool}</span>
                      {". Review and execute below."}
                    </p>
                    <QuoteDisplay result={msg.result} />
                  </>
                )}
                {(msg.result.type === "text" || msg.result.type === "error") && (
                  <p className="text-sm" style={{ ...MONO, color: msg.result.type === "error" ? "#ff4444" : "rgba(255,255,255,0.55)" }}>
                    {msg.result.text}
                  </p>
                )}
              </div>
            </div>
          )
        )}

        {loading && (
          <div className="flex justify-start">
            <p className="text-xs animate-pulse" style={{ ...MONO, color: "rgba(255,255,255,0.25)" }}>
              routing…
            </p>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-4 pb-5 pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <form
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          className="flex items-center gap-3 px-4 py-3"
          style={{ background: "#0A0A0A", border: "1px solid rgba(255,255,255,0.1)" }}
        >
          <span className="text-sm shrink-0" style={{ color: "#F5B800", ...MONO }}>{">"}</span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="ask delora…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-white/15"
            style={{ ...MONO, color: "rgba(255,255,255,0.8)" }}
          />
          <button
            type="submit"
            disabled={!value.trim() || loading}
            style={{
              ...MONO,
              fontSize: "0.65rem",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              background: "transparent",
              color: value.trim() && !loading ? "#F5B800" : "rgba(255,255,255,0.15)",
              cursor: value.trim() && !loading ? "pointer" : "not-allowed",
              border: "none",
              padding: 0,
            }}
          >
            ↵
          </button>
        </form>
      </div>
      </div>{/* end chat panel */}
      </div>{/* end outer wrapper */}
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
    args: address && approval ? [address, approval.spender as `0x${string}`] : undefined,
    query: { enabled: !!address && !!approval },
  });

  const needsApproval =
    !!approval && (allowance === undefined || BigInt(allowance as bigint) < BigInt(approval.amount));

  const { writeContract, data: approvalHash, isPending: isApproving } = useWriteContract();
  const { isSuccess: approvalConfirmed } = useWaitForTransactionReceipt({ hash: approvalHash });
  useEffect(() => { if (approvalConfirmed) refetchAllowance(); }, [approvalConfirmed, refetchAllowance]);

  const { sendTransaction, data: txHash, isPending: isSending } = useSendTransaction();

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
    Ethereum: "https://etherscan.io/tx/", Optimism: "https://optimistic.etherscan.io/tx/",
    Cronos: "https://explorer.cronos.org/tx/", BSC: "https://bscscan.com/tx/",
    Gnosis: "https://gnosis.blockscout.com/tx/", Unichain: "https://uniscan.xyz/tx/",
    Polygon: "https://polygonscan.com/tx/", Monad: "https://monadscan.com/tx/",
    Sonic: "https://explorer.soniclabs.com/tx/", "World Chain": "https://worldscan.org/tx/",
    HyperEVM: "https://hyperevmscan.io/tx/", Metis: "https://andromeda-explorer.metis.io/tx/",
    Soneium: "https://soneium.blockscout.com/tx/", Mantle: "https://mantlescan.xyz/tx/",
    Base: "https://basescan.org/tx/", Plasma: "https://plasmascan.to/tx/",
    Arbitrum: "https://arbiscan.io/tx/", Celo: "https://celoscan.io/tx/",
    Avalanche: "https://snowtrace.io/tx/", Ink: "https://explorer.inkonchain.com/tx/",
    Linea: "https://lineascan.build/tx/", Berachain: "https://berascan.com/tx/",
    Blast: "https://blastscan.io/tx/", Scroll: "https://scrollscan.com/tx/",
  };
  const explorerUrl = txHash ? `${explorerBase[intent.from.chain] ?? "https://etherscan.io/tx/"}${txHash}` : null;

  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: "From",
      value: address ? (
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ background: addrColor(address) }} />
          <span>{shortAddr(address)}</span>
        </span>
      ) : "—",
    },
    {
      label: "To",
      value: calldata?.to ? (
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full shrink-0" style={{ background: addrColor(calldata.to) }} />
          <span>{shortAddr(calldata.to)}</span>
        </span>
      ) : "—",
    },
    { label: "Send", value: `${intent.from.amount} ${intent.from.token}` },
    { label: "Receive", value: `~${route.outputAmount} ${intent.to.token}` },
    { label: "Network", value: intent.from.chain },
    ...(route.feesUSD ? [{ label: "Fees", value: `~$${Number(route.feesUSD).toFixed(4)}` }] : []),
  ];

  return (
    <div style={{ background: "#0D0D0D", border: "1px solid rgba(255,255,255,0.08)" }}>
      {/* Header */}
      <div className="px-4 py-2.5 border-b" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <p className="text-xs tracking-widest uppercase" style={{ ...MONO, color: "rgba(255,255,255,0.3)" }}>
          Transaction
        </p>
      </div>

      {/* Rows */}
      <div className="px-4 py-3 flex flex-col">
        {rows.map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between py-2">
            <span className="text-xs" style={{ ...MONO, color: "rgba(255,255,255,0.35)" }}>{label}</span>
            <span className="text-xs flex items-center gap-1" style={{ ...MONO, color: "rgba(255,255,255,0.75)" }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Action */}
      <div className="px-4 pb-4">
        {txHash ? (
          <a
            href={explorerUrl ?? "#"} target="_blank" rel="noopener noreferrer"
            className="block w-full py-2.5 text-xs tracking-widest uppercase text-center transition-colors"
            style={{ ...MONO, background: "rgba(245,184,0,0.08)", border: "1px solid rgba(245,184,0,0.3)", color: "#F5B800" }}
          >
            view transaction →
          </a>
        ) : !authenticated ? (
          <button onClick={login} className="w-full py-2.5 text-xs tracking-widest uppercase transition-colors"
            style={{ ...MONO, background: "rgba(245,184,0,0.08)", border: "1px solid rgba(245,184,0,0.3)", color: "#F5B800", cursor: "pointer" }}>
            connect to execute →
          </button>
        ) : needsApproval ? (
          <button onClick={approve} disabled={isApproving || (!!approvalHash && !approvalConfirmed)}
            className="w-full py-2.5 text-xs tracking-widest uppercase transition-colors"
            style={{ ...MONO, background: "rgba(245,184,0,0.08)", border: "1px solid rgba(245,184,0,0.3)", color: "#F5B800", cursor: isApproving ? "wait" : "pointer" }}>
            {isApproving ? "approving…" : approvalHash && !approvalConfirmed ? "confirming…" : `approve ${intent.from.token} →`}
          </button>
        ) : (
          <button onClick={execute} disabled={!calldata || isSending}
            className="w-full py-2.5 text-xs tracking-widest uppercase transition-colors"
            style={{ ...MONO, background: calldata ? "rgba(245,184,0,0.08)" : "transparent", border: `1px solid ${calldata ? "rgba(245,184,0,0.3)" : "rgba(255,255,255,0.08)"}`, color: calldata ? "#F5B800" : "rgba(255,255,255,0.2)", cursor: calldata && !isSending ? "pointer" : "not-allowed" }}>
            {isSending ? "confirm in wallet…" : "execute transaction →"}
          </button>
        )}
      </div>
    </div>
  );
}
