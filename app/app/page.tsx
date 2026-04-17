"use client";

import { useRef, useEffect, useState, useCallback, Component } from "react";
import Link from "next/link";
import type { TxData, AddressData } from "@/lib/alchemy-types";
import { usePrivy, useFundWallet } from "@privy-io/react-auth";
import {
  useConnection, useBalance, useChainId, useSwitchChain,
  useSendTransaction, useWriteContract, useReadContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import {
  useWallet as useSolanaWallet,
  useConnection as useSolanaConnection,
} from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import { VersionedTransaction } from "@solana/web3.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type ApprovalInfo = { tokenAddress: string; spender: string; amount: string } | null;

type QuoteResult = {
  type: "quote";
  mode: "preview";
  originMessage?: string;
  quotedAt?: number;
  intent: {
    from: { chain: string; chainId: number; token: string; amount: string };
    to: { chain: string; chainId: number; token: string };
  };
  route: { tool: string; outputAmount: string; feesUSD: string | null; gasUSD: string | null };
  approval: ApprovalInfo;
  calldata: { to: string; value: string; data: string } | null;
};

type TextResult      = { type: "text";      text: string };
type ErrorResult     = { type: "error";     text: string };
type RebalanceResult = { type: "rebalance"; mode: "preview"; legs: Array<QuoteResult | ErrorResult> };
type TxResult        = { type: "tx";        tx: TxData;      summary: string };
type AddressResult   = { type: "address";   data: AddressData; summary: string; ensName?: string };

type TokenRiskResult = {
  type: "token_risk";
  risk: {
    symbol: string; name: string; priceUsd: string | null;
    score: 1 | 2 | 3 | 4; label: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    totalLiquidityUsd: number; volume24h: number;
    marketCap: number | null; fdv: number | null;
    priceChange24h: number | null; pairCount: number; dexCount: number;
    flags: string[]; topPair: { url: string; dexId: string; chainId: string } | null;
  };
};

type YieldPool = {
  pool: string; chain: string; project: string; symbol: string;
  tvlUsd: number; apy: number; apyBase: number | null; apyReward: number | null;
  apyMean30d: number | null; rewardTokens: string[] | null;
};
type YieldPoolsResult = { type: "yield_pools"; symbol: string; pools: YieldPool[] };

type PolymarketMarket = {
  id: string; question: string; outcomes: string[]; outcomePrices: string[];
  volume: number; endDate: string | null;
};
type PolymarketEventItem = {
  title: string; slug: string; volume: number; image: string | null; url: string;
  markets: PolymarketMarket[];
};
type PolymarketResult = { type: "polymarket"; topic: string | null; markets: PolymarketEventItem[] };

type SuggestionsResult = { type: "suggestions"; prompts: { label: string; command: string }[] };

type AssistantResult = QuoteResult | TextResult | ErrorResult | RebalanceResult | TxResult | AddressResult | TokenRiskResult | YieldPoolsResult | PolymarketResult | SuggestionsResult;
type Message = { role: "user"; text: string } | { role: "assistant"; result: AssistantResult };
type Session = { id: string; title: string; messages: Message[] };
type TxRecord = { hash: string; chainId: number; chain: string; label: string; timestamp: number; explorerUrl: string };

// ─── Style tokens ─────────────────────────────────────────────────────────────

const MONO: React.CSSProperties  = { fontFamily: "var(--font-jetbrains-mono), monospace" };
const BEBAS: React.CSSProperties = { fontFamily: "var(--font-display), serif" };

// ─── ABIs & data constants ────────────────────────────────────────────────────

const ERC20_ABI = [
  { name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
] as const;

const USDC_ADDRESSES: Partial<Record<number, `0x${string}`>> = {
  1:     "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  10:    "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  137:   "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  8453:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  56:    "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  43114: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
};

const EXPLORER_URLS: Record<string, string> = {
  Ethereum: "https://etherscan.io/tx/",   Optimism: "https://optimistic.etherscan.io/tx/",
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

const BRIDGE_ACTIONS = [
  { label: "ETH → Base",     prompt: "bridge 0.1 ETH from ethereum to base" },
  { label: "ETH → Arbitrum", prompt: "bridge 0.1 ETH from ethereum to arbitrum" },
  { label: "USDC → Polygon", prompt: "bridge 100 USDC from base to polygon" },
  { label: "ETH → Optimism", prompt: "bridge 0.1 ETH from ethereum to optimism" },
];

const SWAP_ACTIONS = [
  { label: "ETH → USDC · Base", prompt: "swap 0.1 ETH to USDC on base" },
  { label: "ETH → USDC · Arb",  prompt: "swap 0.1 ETH to USDC on arbitrum" },
  { label: "USDC → ETH · Base", prompt: "swap 100 USDC to ETH on base" },
];

const SLIPPAGE_OPTIONS = [
  { value: 0.003, label: "0.3%" },
  { value: 0.005, label: "0.5%" },
  { value: 0.01,  label: "1%" },
];

const EXAMPLE_PROMPTS = [
  "bridge 0.1 ETH from ethereum to base",
  "swap 100 USDC to ETH on arbitrum",
  "show my portfolio",
  "what chains do you support?",
];

const HORIZON_PILLS: { label: string; prompt: string }[] = [
  { label: "agent mode",       prompt: "set up an agent to DCA $20 into ETH every week on base" },
  { label: "limit orders",     prompt: "buy 0.05 ETH when price drops to $2800 on arbitrum" },
  { label: "polymarket",       prompt: "what are the current odds ETH hits $5k this year?" },
  { label: "offramp to card",  prompt: "cash out 200 USDC to my debit card" },
  { label: "yield scanner",    prompt: "find the highest yield for my USDC across all chains" },
  { label: "deep research",    prompt: "compare gas costs across all supported bridges for 1 ETH" },
  { label: "on-chain MCP",     prompt: "connect skopos to my claude desktop via MCP" },
  { label: "whale signals",    prompt: "show me what top wallets are bridging this week" },
];

// ─── Feature carousel ─────────────────────────────────────────────────────────

const IcBridge  = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M4 12a8 8 0 0 1 16 0"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="6" y1="12" x2="6" y2="19"/><line x1="18" y1="12" x2="18" y2="19"/><line x1="2" y1="19" x2="22" y2="19"/></svg>;
const IcZap     = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>;
const IcSwap    = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M7 16V4m0 0L3 8m4-4l4 4"/><path d="M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>;
const IcChat    = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>;
const IcNet     = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7l-5 10M12 7l5 10M7 19h10"/></svg>;
const IcChart   = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
const IcClock   = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>;
const IcWallet  = () => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M16 14h2"/><path d="M2 10h20"/></svg>;


type FeatureCard = { label: string; sub: string; icon: React.ReactNode };
const FEATURE_SLIDES: FeatureCard[][] = [
  [
    { label: "Bridge",      sub: "25+ chains supported",   icon: <IcBridge /> },
    { label: "Best Route",  sub: "AI finds cheapest path",  icon: <IcZap /> },
    { label: "Swap",        sub: "Any token, any chain",    icon: <IcSwap /> },
  ],
  [
    { label: "Plain Language", sub: "Just describe what you want", icon: <IcChat /> },
    { label: "5 Bridges",      sub: "Relay, Across, Mayan & more", icon: <IcNet /> },
    { label: "Live Quotes",    sub: "Real-time Delora pricing",    icon: <IcChart /> },
  ],
  [
    { label: "Tx History",  sub: "Track all your moves",    icon: <IcClock /> },
    { label: "Portfolio",   sub: "Balances across chains",  icon: <IcWallet /> },
  ],
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortAddr(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}`; }
function addrColor(addr: string) { return `hsl(${parseInt(addr.slice(2, 8), 16) % 360}, 70%, 55%)`; }
function loadJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
}

// ─── ErrorBoundary ────────────────────────────────────────────────────────────

class ErrorBoundary extends Component<
  { children: React.ReactNode; label?: string },
  { error: Error | null }
> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <p style={{ fontFamily: "var(--font-jetbrains-mono), monospace", fontSize: "0.72rem", color: "#ff6b6b", padding: "12px 16px", background: "rgba(255,107,107,0.05)", border: "1px solid rgba(255,107,107,0.12)", borderRadius: 12, margin: 0 }}>
          {this.props.label ?? "Failed to render result."}
        </p>
      );
    }
    return this.props.children;
  }
}

// ─── AppPage ──────────────────────────────────────────────────────────────────

export default function AppPage() {
  const inputRef     = useRef<HTMLInputElement>(null);
  const bottomRef    = useRef<HTMLDivElement>(null);
  const abortRef     = useRef<AbortController | null>(null);
  const dripRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef<string>("");

  const [value, setValue]              = useState("");
  const [loading, setLoading]          = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [inputFocused, setInputFocused]= useState(false);
  const [messages, setMessages]        = useState<Message[]>([]);
  const [sessions, setSessions]        = useState<Session[]>([]);
  const [txHistory, setTxHistory]      = useState<TxRecord[]>([]);
  const [activeSessionId, setActiveId] = useState<string>("");
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [featureSlide, setFeatureSlide]= useState(0);
  const [isMobile, setIsMobile]        = useState(false);
  const [slippage, setSlippage]        = useState(0.005);
  const [horizonToast, setHorizonToast] = useState<string | null>(null);
  const [theme, setTheme]              = useState<"dark" | "light">("dark");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { address }                            = useConnection();
  const currentChainId                         = useChainId();
  const { login, logout, authenticated, ready }= usePrivy();
  const { fundWallet }                         = useFundWallet();
  const { data: nativeBal, isLoading: nativeLoading } = useBalance({ address });
  const usdcAddress                            = USDC_ADDRESSES[currentChainId];
  const { data: usdcRaw, isLoading: usdcLoading } = useReadContract({
    address: usdcAddress, abi: ERC20_ABI, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId: currentChainId,
    query: { enabled: !!address && !!usdcAddress },
  });
  const balanceLoading = nativeLoading || usdcLoading;

  const nativeDisplay = nativeBal
    ? `${(Number(nativeBal.value) / 10 ** nativeBal.decimals).toFixed(4)} ${nativeBal.symbol}`
    : null;
  const usdcDisplay = usdcRaw != null
    ? `${(Number(usdcRaw as bigint) / 1e6).toFixed(2)} USDC`
    : null;

  useEffect(() => {
    const id = crypto.randomUUID();
    sessionIdRef.current = id;
    setActiveId(id);
    setSessions(loadJson("skopos-sessions", []));
    setTxHistory(loadJson("skopos-tx-history", []));
    const stored = localStorage.getItem("skopos-theme");
    if (stored === "light" || stored === "dark") setTheme(stored);
    setTimeout(() => inputRef.current?.focus(), 100);

    const checkMobile = () => setIsMobile(window.innerWidth < 600);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("skopos-theme", theme);
  }, [theme]);

  function handleDisconnectClick() {
    if (confirmDisconnect) {
      if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
      setConfirmDisconnect(false);
      logout();
    } else {
      setConfirmDisconnect(true);
      disconnectTimerRef.current = setTimeout(() => setConfirmDisconnect(false), 3000);
    }
  }

  useEffect(() => {
    if (messages.length === 0) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    const firstUser = messages.find((m): m is { role: "user"; text: string } => m.role === "user");
    const title = (firstUser?.text ?? "Chat").slice(0, 38);
    const stored = loadJson<Session[]>("skopos-sessions", []);
    const updated = [...stored.filter(s => s.id !== sid), { id: sid, title, messages }].slice(-10);
    localStorage.setItem("skopos-sessions", JSON.stringify(updated));
    setSessions(updated);
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, streamingText]);

  const saveTx = useCallback((record: TxRecord) => {
    setTxHistory(prev => {
      const updated = [record, ...prev.filter(t => t.hash !== record.hash)].slice(0, 15);
      localStorage.setItem("skopos-tx-history", JSON.stringify(updated));
      return updated;
    });
  }, []);

  function newChat() {
    const id = crypto.randomUUID();
    sessionIdRef.current = id;
    setActiveId(id);
    setMessages([]);
    setSessions(loadJson("skopos-sessions", []));
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function openSession(s: Session) {
    sessionIdRef.current = s.id;
    setActiveId(s.id);
    setMessages(s.messages);
    setSidebarExpanded(false);
  }

  async function submit(msg?: string) {
    const text = (msg ?? value).trim();
    if (!text) return;

    // Interrupt any in-flight stream + drip
    if (abortRef.current) abortRef.current.abort();
    if (dripRef.current)  { clearInterval(dripRef.current); dripRef.current = null; }
    setLoading(false);
    setStreamingText(null);

    setSidebarExpanded(false);

    // Build history snapshot before state update (last 6 turns)
    const history = messages.slice(-6).flatMap((m): { role: "user" | "assistant"; content: string }[] => {
      if (m.role === "user") return [{ role: "user", content: m.text }];
      if (m.result.type === "text")  return [{ role: "assistant", content: m.result.text }];
      if (m.result.type === "error") return [{ role: "assistant", content: m.result.text }];
      if (m.result.type === "quote") {
        const { intent, route } = m.result;
        const fees = route.feesUSD ? `, fees ~$${Number(route.feesUSD).toFixed(4)}` : "";
        return [{ role: "assistant", content: `[Real Delora quote] ${intent.from.amount} ${intent.from.token} from ${intent.from.chain} → ${intent.to.chain} via ${route.tool}. Output: ~${route.outputAmount} ${intent.to.token}${fees}. This is live data from the Delora API — the amounts are real.` }];
      }
      if (m.result.type === "rebalance") {
        const legs = m.result.legs.filter(l => l.type === "quote") as QuoteResult[];
        const summary = legs.map(l => `${l.intent.from.amount} ${l.intent.from.token} from ${l.intent.from.chain} → ~${l.route.outputAmount} ${l.intent.to.token} via ${l.route.tool}`).join("; ");
        return [{ role: "assistant", content: `[Real Delora rebalance] ${summary}` }];
      }
      if (m.result.type === "address") {
        const native = m.result.data.balances.map(b => `${b.native} ${b.nativeSymbol} on ${b.chainName}`).join(", ");
        const tokens = m.result.data.tokenBalances.slice(0, 5).map(t => `${t.balance} ${t.symbol} on ${t.chainName}`).join(", ");
        return [{ role: "assistant", content: `[Live wallet data] Native: ${native || "none"}. Tokens: ${tokens || "none"}.` }];
      }
      return [];
    });

    setMessages(prev => [...prev, { role: "user", text }]);
    setValue("");
    setLoading(true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, senderAddress: address, history, slippage }),
        signal: abort.signal,
      });

      const contentType = res.headers.get("content-type") ?? "";

      if (contentType.includes("text/plain")) {
        // Streaming text response — word-by-word typewriter
        setLoading(false);
        setStreamingText("");

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let displayed = "";
        const buf = { text: "" };

        // Drip one word unit (word + trailing whitespace) every 90ms
        const drip = setInterval(() => {
          if (abort.signal.aborted) { clearInterval(drip); dripRef.current = null; return; }
          if (!buf.text) return;
          // Match a word with trailing whitespace, or flush pure whitespace
          const match = buf.text.match(/^(\S+\s*|\s+)/);
          if (!match) return;
          buf.text = buf.text.slice(match[1].length);
          displayed += match[1];
          setStreamingText(displayed);
        }, 90);
        dripRef.current = drip;

        while (true) {
          if (abort.signal.aborted) break;
          const { done, value: chunk } = await reader.read();
          if (done) break;
          const text = decoder.decode(chunk, { stream: true });
          accumulated += text;
          buf.text  += text;
        }

        if (!abort.signal.aborted) {
          // Drain remaining buffer before finalising
          await new Promise<void>(resolve => {
            const check = setInterval(() => {
              if (!buf.text || abort.signal.aborted) {
                clearInterval(check);
                clearInterval(drip);
                dripRef.current = null;
                resolve();
              }
            }, 20);
          });

          // Flush any trailing partial word (e.g. last word with no trailing space)
          if (!abort.signal.aborted && displayed !== accumulated) setStreamingText(accumulated);

          if (!abort.signal.aborted) {
            setMessages(prev => [...prev, { role: "assistant", result: { type: "text", text: accumulated } }]);
            setStreamingText(null);
          }
        }
      } else {
        // JSON response (quote, rebalance, address, tx, error)
        const data: AssistantResult = await res.json();
        if (data.type === "quote") data.originMessage = text;
        setMessages(prev => [...prev, { role: "assistant", result: data }]);
        setLoading(false);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setMessages(prev => [...prev, { role: "assistant", result: { type: "error", text: "Network error. Is the server running?" } }]);
      setLoading(false);
    }
  }

  const isDark = theme === "dark";
  const T = isDark ? {
    bg:          "#000000",
    sidebar:     "#080808",
    border:      "rgba(255,255,255,0.05)",
    borderStrong:"rgba(255,255,255,0.09)",
    textPrimary: "#ffffff",
    textMuted:   "rgba(255,255,255,0.65)",
    textDim:     "rgba(255,255,255,0.28)",
    textFaint:   "rgba(255,255,255,0.15)",
    surface:     "rgba(255,255,255,0.04)",
    msgBubble:   "rgba(255,255,255,0.05)",
    inputBg:     "rgba(255,255,255,0.02)",
    fadeMask:    "linear-gradient(to right, transparent, rgba(0,0,0,0.85))",
  } : {
    bg:          "#F0F0EC",
    sidebar:     "#E6E6E2",
    border:      "rgba(0,0,0,0.08)",
    borderStrong:"rgba(0,0,0,0.13)",
    textPrimary: "#111111",
    textMuted:   "rgba(0,0,0,0.65)",
    textDim:     "rgba(0,0,0,0.38)",
    textFaint:   "rgba(0,0,0,0.22)",
    surface:     "rgba(0,0,0,0.04)",
    msgBubble:   "rgba(0,0,0,0.05)",
    inputBg:     "rgba(0,0,0,0.03)",
    fadeMask:    "linear-gradient(to right, transparent, rgba(240,240,236,0.95))",
  };

  const recentSessions = [...sessions].reverse().slice(0, 6);
  const hasMessages = messages.length > 0;

  return (
    <main style={{ position: "relative", height: "100vh", width: "100vw", background: T.bg, display: "flex", overflow: "hidden" }}>

      {/* Mobile sidebar overlay backdrop */}
      {isMobile && sidebarExpanded && (
        <div
          onClick={() => setSidebarExpanded(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9 }}
        />
      )}

      {/* Collapsible nav rail */}
      <aside className={`sidebar-rail${sidebarExpanded ? " sidebar-open" : ""}`} style={{
        width: isMobile ? (sidebarExpanded ? 240 : 0) : (sidebarExpanded ? 240 : 52),
        minWidth: isMobile ? (sidebarExpanded ? 240 : 0) : (sidebarExpanded ? 240 : 52),
        height: "100%", zIndex: 10, flexShrink: 0,
        background: T.sidebar,
        borderRight: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column",
        transition: "width 0.22s cubic-bezier(0.16,1,0.3,1), min-width 0.22s cubic-bezier(0.16,1,0.3,1)",
        overflow: "hidden",
        position: isMobile ? "fixed" : "relative",
        top: isMobile ? 0 : undefined,
        left: isMobile ? 0 : undefined,
      }}>

        {/* Header: back arrow + logo */}
        <div style={{ height: 52, display: "flex", alignItems: "center", paddingLeft: 8, paddingRight: 8, flexShrink: 0, gap: 2 }}>
          <Link href="/" title="Home" style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--drawer-action)", textDecoration: "none" }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3L5 8l5 5"/></svg>
          </Link>
          <span style={{ ...BEBAS, fontSize: "1rem", letterSpacing: "0.06em", color: T.textPrimary, whiteSpace: "nowrap", paddingLeft: 6, flex: 1, opacity: sidebarExpanded ? 1 : 0, transition: "opacity 0.12s" }}>
            SKOP<span style={{ color: "#F5B800" }}>OS</span>
          </span>
        </div>

        {/* New chat */}
        <div style={{ paddingLeft: 8, paddingRight: 8, paddingBottom: 8, flexShrink: 0 }}>
          <button onClick={newChat} style={{ width: "100%", height: 36, borderRadius: 8, display: "flex", alignItems: "center", paddingLeft: 10, gap: 10, border: "none", background: "none", color: "var(--drawer-action)", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden" }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0 }}><path d="M8 3v10M3 8h10"/></svg>
            <span style={{ ...MONO, fontSize: "0.72rem", opacity: sidebarExpanded ? 1 : 0, transition: "opacity 0.12s" }}>New chat</span>
          </button>
        </div>

        {/* Nav sections — fade in when expanded */}
        <div style={{ flex: 1, overflowY: "auto", scrollbarWidth: "none", opacity: sidebarExpanded ? 1 : 0, transition: "opacity 0.1s", pointerEvents: sidebarExpanded ? "auto" : "none" }}>
          {recentSessions.length > 0 && (
            <DrawerSection label="RECENTS">
              {recentSessions.map(s => (
                <button key={s.id} onClick={() => { openSession(s); if (isMobile) setSidebarExpanded(false); }} style={{
                  ...MONO, width: "100%", textAlign: "left", padding: "7px 12px", fontSize: "0.72rem",
                  background: s.id === activeSessionId ? "var(--recent-active-bg)" : "none",
                  color: s.id === activeSessionId ? "var(--recent-active)" : "var(--recent-inactive)",
                  border: "none", cursor: "pointer", borderRadius: 6, display: "block",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {s.title}
                </button>
              ))}
            </DrawerSection>
          )}
          {txHistory.length > 0 && (
            <DrawerSection label="HISTORY">
              {txHistory.slice(0, 4).map(tx => (
                <a key={tx.hash} href={tx.explorerUrl} target="_blank" rel="noopener noreferrer" style={{
                  ...MONO, display: "block", padding: "7px 12px", fontSize: "0.72rem",
                  color: "var(--recent-inactive)", textDecoration: "none", borderRadius: 6,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  ↗ {tx.label}
                </a>
              ))}
            </DrawerSection>
          )}
          <DrawerSection label="PORTFOLIO">
            <DrawerAction label="My balances" onClick={() => submit("show my portfolio")} />
          </DrawerSection>
          <DrawerSection label="BRIDGE">
            {BRIDGE_ACTIONS.map(({ label, prompt }) => (
              <DrawerAction key={label} label={label} onClick={() => submit(prompt)} />
            ))}
          </DrawerSection>
          <DrawerSection label="SWAP">
            {SWAP_ACTIONS.map(({ label, prompt }) => (
              <DrawerAction key={label} label={label} onClick={() => submit(prompt)} />
            ))}
          </DrawerSection>
        </div>

        {/* Bottom rail */}
        <div style={{ flexShrink: 0, paddingLeft: 8, paddingRight: 8, paddingBottom: 16, paddingTop: 8, borderTop: `1px solid ${T.border}`, display: "flex", flexDirection: "column", gap: 3 }}>

          {/* ── Fund Wallet card ────────────────────────────────────────────── */}
          {sidebarExpanded && ready && authenticated && address && (
            <div style={{
              marginBottom: 8, borderRadius: 12, padding: "12px 14px",
              background: isDark ? "rgba(245,184,0,0.05)" : "rgba(245,184,0,0.09)",
              border: "1px solid rgba(245,184,0,0.2)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                <div style={{ width: 6, height: 6, borderRadius: 999, background: "#F5B800", flexShrink: 0 }} />
                <span style={{ ...MONO, fontSize: "0.62rem", color: "rgba(245,184,0,0.75)", letterSpacing: "0.08em" }}>WALLET</span>
              </div>
              {balanceLoading ? (
                <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 18, marginBottom: 10 }}>
                  <span className="eq-bar" style={{ height: 10, background: "rgba(245,184,0,0.4)" }} />
                  <span className="eq-bar" style={{ height: 10, background: "rgba(245,184,0,0.4)" }} />
                  <span className="eq-bar" style={{ height: 10, background: "rgba(245,184,0,0.4)" }} />
                </div>
              ) : (
                <>
                  {nativeDisplay && (
                    <p style={{ ...MONO, fontSize: "0.72rem", color: T.textMuted, margin: "0 0 2px", fontWeight: 600 }}>{nativeDisplay}</p>
                  )}
                  {usdcDisplay && (
                    <p style={{ ...MONO, fontSize: "0.68rem", color: T.textDim, margin: "0 0 10px" }}>{usdcDisplay}</p>
                  )}
                  {!nativeDisplay && !usdcDisplay && (
                    <p style={{ ...MONO, fontSize: "0.68rem", color: T.textFaint, margin: "0 0 10px" }}>no assets on this chain</p>
                  )}
                </>
              )}
              <button
                onClick={() => fundWallet({ address })}
                style={{
                  ...MONO, width: "100%", padding: "7px 0", fontSize: "0.72rem",
                  color: "#000", background: "#F5B800", border: "none", cursor: "pointer",
                  borderRadius: 8, fontWeight: 700, letterSpacing: "0.04em",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 1v10M1 6h10"/></svg>
                Fund Wallet
              </button>
            </div>
          )}

          {/* ── Connect Wallet CTA (when disconnected) ─────────────────────── */}
          {ready && !authenticated && sidebarExpanded && (
            <button
              onClick={login}
              style={{
                ...MONO, width: "100%", marginBottom: 8, padding: "10px 0",
                fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.05em",
                color: "#000", background: "#F5B800", border: "none", borderRadius: 10, cursor: "pointer",
              }}
            >
              Connect Wallet
            </button>
          )}

          {/* Collapsed wallet dot */}
          {ready && !sidebarExpanded && (
            <button
              onClick={authenticated ? handleDisconnectClick : login}
              style={{ width: "100%", height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer" }}
              title={authenticated && address ? (confirmDisconnect ? "click again to disconnect" : `${shortAddr(address)} — disconnect`) : "Connect wallet"}
            >
              <div style={{ width: 8, height: 8, borderRadius: 999, background: confirmDisconnect ? "#ff6b6b" : authenticated ? "#F5B800" : T.textFaint }} />
            </button>
          )}

          {/* Expanded address chip */}
          {ready && authenticated && address && sidebarExpanded && (
            <button
              onClick={handleDisconnectClick}
              style={{ width: "100%", height: 32, borderRadius: 8, display: "flex", alignItems: "center", paddingLeft: 10, gap: 8, background: confirmDisconnect ? "rgba(255,107,107,0.06)" : "none", border: confirmDisconnect ? "1px solid rgba(255,107,107,0.2)" : "none", cursor: "pointer", transition: "background 0.2s" }}
              title={confirmDisconnect ? "click again to confirm disconnect" : `${shortAddr(address)} — click to disconnect`}
            >
              <div style={{ width: 7, height: 7, borderRadius: 999, background: confirmDisconnect ? "#ff6b6b" : "#F5B800", flexShrink: 0, transition: "background 0.2s" }} />
              <span style={{ ...MONO, fontSize: "0.68rem", color: confirmDisconnect ? "#ff6b6b" : T.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", transition: "color 0.2s" }}>
                {confirmDisconnect ? "disconnect?" : shortAddr(address)}
              </span>
            </button>
          )}

          {/* GitHub */}
          <a href="https://github.com/deloraprotocol/delora-copilot" target="_blank" rel="noopener noreferrer"
            style={{ width: "100%", height: 36, borderRadius: 8, display: "flex", alignItems: "center", paddingLeft: 10, gap: 10, color: T.textDim, textDecoration: "none", whiteSpace: "nowrap" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            <span style={{ ...MONO, fontSize: "0.72rem", opacity: sidebarExpanded ? 1 : 0, transition: "opacity 0.12s" }}>GitHub</span>
          </a>

          {/* Theme */}
          <button
            onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}
            style={{ width: "100%", height: 36, borderRadius: 8, display: "flex", alignItems: "center", paddingLeft: 10, gap: 10, background: "none", border: "none", color: T.textDim, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden" }}
          >
            {isDark ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" style={{ flexShrink: 0 }}>
                <circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" style={{ flexShrink: 0 }}>
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
            <span style={{ ...MONO, fontSize: "0.72rem", opacity: sidebarExpanded ? 1 : 0, transition: "opacity 0.12s" }}>Theme</span>
          </button>

          {/* Collapse */}
          <button
            onClick={() => setSidebarExpanded(!sidebarExpanded)}
            style={{ width: "100%", height: 36, borderRadius: 8, display: "flex", alignItems: "center", paddingLeft: 10, gap: 10, background: "none", border: "none", color: T.textDim, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden" }}
          >
            <svg width="14" height="12" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0 }}>
              <line x1="1" y1="1" x2="15" y2="1"/><line x1="1" y1="7" x2="15" y2="7"/><line x1="1" y1="13" x2="15" y2="13"/>
            </svg>
            <span style={{ ...MONO, fontSize: "0.72rem", opacity: sidebarExpanded ? 1 : 0, transition: "opacity 0.12s" }}>Collapse</span>
          </button>
        </div>
      </aside>

      {/* Main canvas */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", position: "relative", zIndex: 1 }}>

        {/* Mobile top bar */}
        {isMobile && (
          <div style={{ height: 52, flexShrink: 0, display: "flex", alignItems: "center", paddingLeft: 8, paddingRight: 8, borderBottom: `1px solid ${T.border}`, gap: 4 }}>
            {/* Hamburger */}
            <button onClick={() => setSidebarExpanded(true)} style={{ width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", color: T.textDim, cursor: "pointer", borderRadius: 10, flexShrink: 0 }}>
              <svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="1" y1="1" x2="15" y2="1"/><line x1="1" y1="7" x2="15" y2="7"/><line x1="1" y1="13" x2="15" y2="13"/>
              </svg>
            </button>
            {/* Logo */}
            <span style={{ fontFamily: "var(--font-display), serif", fontSize: "1.05rem", letterSpacing: "0.06em", color: T.textPrimary, flex: 1 }}>
              SKOP<span style={{ color: "#F5B800" }}>OS</span>
            </span>
            {/* Theme toggle */}
            <button
              onClick={() => setTheme(t => t === "dark" ? "light" : "dark")}
              style={{ width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", color: T.textDim, cursor: "pointer", borderRadius: 10, flexShrink: 0 }}
            >
              {isDark ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              )}
            </button>
            {/* Wallet quick-connect / status */}
            {ready && (
              <button
                onClick={authenticated ? handleDisconnectClick : login}
                style={{ height: 32, paddingLeft: 12, paddingRight: 12, display: "flex", alignItems: "center", gap: 6, background: confirmDisconnect ? "rgba(255,107,107,0.08)" : authenticated ? "rgba(245,184,0,0.08)" : "#F5B800", border: confirmDisconnect ? "1px solid rgba(255,107,107,0.25)" : authenticated ? "1px solid rgba(245,184,0,0.2)" : "none", borderRadius: 8, cursor: "pointer", flexShrink: 0, transition: "background 0.2s, border-color 0.2s" }}
              >
                {authenticated && address ? (
                  <>
                    <div style={{ width: 6, height: 6, borderRadius: 999, background: confirmDisconnect ? "#ff6b6b" : "#F5B800", transition: "background 0.2s" }} />
                    <span style={{ ...MONO, fontSize: "0.65rem", color: confirmDisconnect ? "#ff6b6b" : "rgba(245,184,0,0.85)", transition: "color 0.2s" }}>{confirmDisconnect ? "disconnect?" : shortAddr(address)}</span>
                  </>
                ) : (
                  <span style={{ ...MONO, fontSize: "0.68rem", color: "#000", fontWeight: 700 }}>Connect</span>
                )}
              </button>
            )}
          </div>
        )}

        {/* Messages or empty state */}
        {hasMessages ? (
          <div style={{ flex: 1, overflowY: "auto" }}>
            <div style={{ maxWidth: 700, margin: "0 auto", padding: isMobile ? "24px 16px 0" : "40px 28px 0", display: "flex", flexDirection: "column", gap: 32 }}>
              {messages.map((msg, i) =>
                msg.role === "user" ? (
                  <div key={i} style={{ display: "flex", justifyContent: "flex-end" }}>
                    <div style={{ padding: "10px 18px", background: T.msgBubble, borderRadius: 20, maxWidth: isMobile ? "88%" : "70%" }}>
                      <p style={{ ...MONO, fontSize: "0.875rem", color: T.textMuted, margin: 0, wordBreak: "break-word" }}>{msg.text}</p>
                    </div>
                  </div>
                ) : (
                  <div key={i}>
                    {msg.result.type === "quote" && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <p style={{ ...MONO, fontSize: "0.75rem", color: T.textDim, lineHeight: 1.7, margin: 0 }}>
                          <span style={{ color: "#F5B800" }}>{msg.result.route.tool}</span>
                          {"  ·  "}
                          <span style={{ color: T.textMuted, fontSize: "0.82rem" }}>
                            ~{msg.result.route.outputAmount} {msg.result.intent.to.token}
                          </span>
                          {msg.result.route.feesUSD && (
                            <span style={{ color: T.textDim }}>
                              {"  ·  "}${Number(msg.result.route.feesUSD).toFixed(2)} fees
                            </span>
                          )}
                        </p>
                        <ErrorBoundary label="Quote failed to render.">
                          <QuoteDisplay
                            result={msg.result}
                            onTxSubmitted={saveTx}
                            onRefresh={async () => {
                              const origin = (msg.result as QuoteResult).originMessage;
                              if (!origin) return;
                              try {
                                const res = await fetch("/api/chat", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ message: origin, senderAddress: address, history: [], slippage }),
                                });
                                const data: AssistantResult = await res.json();
                                if (data.type === "quote") data.originMessage = origin;
                                setMessages(prev => prev.map((m, j) =>
                                  j === i ? { role: "assistant", result: data } : m
                                ));
                              } catch { /* silent — QuoteDisplay will reset isRefreshing */ }
                            }}
                          />
                        </ErrorBoundary>
                      </div>
                    )}
                    {msg.result.type === "rebalance" && (
                      <ErrorBoundary label="Rebalance failed to render.">
                        <RebalanceDisplay result={msg.result} onTxSubmitted={saveTx} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "tx" && (
                      <ErrorBoundary label="Transaction details failed to render.">
                        <TxDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "address" && (
                      <ErrorBoundary label="Address details failed to render.">
                        <AddressDisplay result={msg.result} onSwap={prompt => submit(prompt)} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "token_risk" && (
                      <ErrorBoundary label="Risk scan failed to render.">
                        <TokenRiskDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "yield_pools" && (
                      <ErrorBoundary label="Yield data failed to render.">
                        <YieldPoolsDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "polymarket" && (
                      <ErrorBoundary label="Polymarket data failed to render.">
                        <PolymarketDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "suggestions" && (
                      <SuggestionsDisplay result={msg.result} onSelect={(cmd: string) => submit(cmd)} />
                    )}
                    {(msg.result.type === "text" || msg.result.type === "error") && (
                      <p style={{ ...MONO, fontSize: "0.875rem", lineHeight: 1.75, color: msg.result.type === "error" ? "#ff5555" : T.textMuted, margin: 0 }}>
                        {msg.result.text}
                      </p>
                    )}
                    {/* Send feedback */}
                    <div style={{ marginTop: 8 }}>
                      <a
                        href="https://github.com/Svector-anu/skopos/issues/new"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ ...MONO, fontSize: "0.62rem", color: T.textFaint, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
                        onMouseEnter={e => (e.currentTarget.style.color = T.textDim)}
                        onMouseLeave={e => (e.currentTarget.style.color = T.textFaint)}
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
                        </svg>
                        Send feedback
                      </a>
                    </div>
                  </div>
                )
              )}
              {loading && (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 26, height: 26, borderRadius: 7, background: "#F5B800", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg viewBox="0 0 32 32" width="14" height="14">
                      <path d="M16 5 L27 16 L16 27 L5 16 Z" fill="none" stroke="#000" strokeWidth="2.5" strokeLinejoin="round"/>
                      <circle cx="16" cy="16" r="2.2" fill="#000"/>
                    </svg>
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 20 }}>
                    <span className="eq-bar" />
                    <span className="eq-bar" />
                    <span className="eq-bar" />
                    <span className="eq-bar" />
                    <span className="eq-bar" />
                  </div>
                </div>
              )}
              {streamingText !== null && (
                <p style={{ ...MONO, fontSize: "0.875rem", lineHeight: 1.75, color: T.textMuted, margin: 0 }}>
                  {streamingText}
                  <span className="cursor-blink" style={{ color: "#F5B800", marginLeft: 1 }}>▌</span>
                </p>
              )}
              <div ref={bottomRef} />
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: isMobile ? "0 20px" : "0 28px", textAlign: "center" }}>
            {isMobile && (
              <>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: "#F5B800", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20 }}>
                  <svg viewBox="0 0 32 32" width="22" height="22">
                    <path d="M16 5 L27 16 L16 27 L5 16 Z" fill="none" stroke="#000" strokeWidth="2" strokeLinejoin="round"/>
                    <circle cx="16" cy="16" r="2.2" fill="#000"/>
                  </svg>
                </div>
                <p style={{ ...MONO, fontSize: "0.95rem", color: T.textMuted, lineHeight: 1.65, margin: 0, maxWidth: 440 }}>
                  Welcome to the Delora protocol. I&apos;m{" "}
                  <span style={{ color: "#F5B800", fontWeight: 600 }}>Skopos</span>
                  , your cross-chain DeFi copilot.
                </p>
                <p style={{ ...MONO, fontSize: "0.82rem", color: T.textDim, marginTop: 10, marginBottom: 0 }}>
                  What can I help you with today?
                </p>
              </>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: isMobile ? 20 : 0, maxWidth: 520 }}>
              {EXAMPLE_PROMPTS.map(p => (
                <button
                  key={p}
                  onClick={() => submit(p)}
                  style={{ ...MONO, padding: "6px 14px", fontSize: "0.7rem", background: T.surface, border: `1px solid ${T.borderStrong}`, borderRadius: 999, color: T.textDim, cursor: "pointer", whiteSpace: "nowrap", transition: "border-color 0.15s, color 0.15s" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(245,184,0,0.3)"; e.currentTarget.style.color = "rgba(245,184,0,0.7)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.color = T.textDim; }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Bottom: feature cards + input */}
        <div style={{ flexShrink: 0, width: "100%", display: "flex", justifyContent: "center", padding: isMobile ? "0 12px max(16px, env(safe-area-inset-bottom))" : "0 28px 32px" }}>
          <div style={{ width: "100%", maxWidth: 700 }}>

            {/* Feature carousel — empty state, desktop only */}
            {!hasMessages && !isMobile && (
              <FeatureCarousel slide={featureSlide} setSlide={setFeatureSlide} />
            )}

            {/* Input box */}
            <form onSubmit={e => { e.preventDefault(); submit(); }}>
              <div style={{
                background: T.inputBg,
                border: `1px solid ${inputFocused ? "rgba(245,184,0,0.38)" : "rgba(245,184,0,0.18)"}`,
                borderRadius: 20,
                padding: "18px 20px 14px",
                boxShadow: inputFocused ? "0 0 32px rgba(245,184,0,0.08)" : "0 0 20px rgba(245,184,0,0.04)",
                transition: "border-color 0.2s ease, box-shadow 0.2s ease",
              }}>
                <input
                  ref={inputRef}
                  type="text"
                  value={value}
                  onChange={e => setValue(e.target.value)}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  placeholder="ask skopos…"
                  className={isDark ? "placeholder:text-white/15" : "placeholder:text-black/20"}
                  style={{ ...MONO, width: "100%", background: "none", border: "none", outline: "none", color: T.textPrimary, caretColor: T.textPrimary, fontSize: "0.95rem" }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 14 }}>
                  {/* Horizon pills — coming soon features */}
                  <div style={{ position: "relative", flex: 1, minWidth: 0, overflow: "hidden" }}>
                    <div style={{ display: "flex", gap: 5, overflowX: "auto", scrollbarWidth: "none", paddingRight: 24 }}>
                      {HORIZON_PILLS.map(pill => (
                        <button
                          key={pill.label}
                          type="button"
                          onClick={() => {
                            setValue(pill.prompt);
                            setHorizonToast(pill.label);
                            setTimeout(() => setHorizonToast(null), 2000);
                            setTimeout(() => inputRef.current?.focus(), 50);
                          }}
                          style={{
                            ...MONO, flexShrink: 0,
                            fontSize: "0.58rem", padding: "2px 8px", borderRadius: 999,
                            border: `1px solid ${T.border}`,
                            background: "transparent",
                            color: T.textFaint,
                            cursor: "pointer", whiteSpace: "nowrap",
                            transition: "border-color 0.15s, color 0.15s",
                          }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(245,184,0,0.25)"; e.currentTarget.style.color = "rgba(245,184,0,0.6)"; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textFaint; }}
                        >
                          ◆ {pill.label}
                        </button>
                      ))}
                    </div>
                    {/* Fade mask on right */}
                    <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 24, background: T.fadeMask, pointerEvents: "none" }} />
                  </div>
                  {/* Toast */}
                  {horizonToast && (
                    <span style={{ ...MONO, fontSize: "0.58rem", color: "rgba(245,184,0,0.5)", whiteSpace: "nowrap", flexShrink: 0 }}>
                      soon ✦
                    </span>
                  )}
                  <span style={{ ...MONO, fontSize: "0.58rem", color: T.textFaint }}>slip</span>
                  {SLIPPAGE_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setSlippage(value)}
                      style={{
                        ...MONO, fontSize: "0.6rem", padding: "2px 6px", borderRadius: 4,
                        border: `1px solid ${slippage === value ? "rgba(245,184,0,0.35)" : "var(--drawer-label)"}`,
                        background: slippage === value ? "rgba(245,184,0,0.06)" : "transparent",
                        color: slippage === value ? "rgba(245,184,0,0.85)" : "var(--drawer-action)",
                        cursor: "pointer",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="submit"
                    disabled={!value.trim() || loading}
                    style={{
                      width: 34, height: 34, borderRadius: 999, border: "none",
                      background: loading ? "rgba(245,184,0,0.12)" : value.trim() ? "#F5B800" : T.surface,
                      cursor: value.trim() && !loading ? "pointer" : "not-allowed",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0, transition: "background 0.15s ease",
                    }}
                  >
                    {loading ? (
                      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 14 }}>
                        <span className="eq-bar" style={{ height: 12 }} />
                        <span className="eq-bar" style={{ height: 12 }} />
                        <span className="eq-bar" style={{ height: 12 }} />
                        <span className="eq-bar" style={{ height: 12 }} />
                        <span className="eq-bar" style={{ height: 12 }} />
                      </div>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M7 12V2M2 7l5-5 5 5"
                          stroke={value.trim() ? "#000" : T.textDim}
                          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </form>
            <p style={{ ...MONO, fontSize: "0.6rem", color: T.textFaint, textAlign: "center", marginTop: 10, lineHeight: 1.5 }}>
              Skopos is AI and can make mistakes. Please double-check responses.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

// ─── FeatureCarousel ──────────────────────────────────────────────────────────

function FeatureCarousel({ slide, setSlide }: { slide: number; setSlide: (i: number) => void }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const cards = FEATURE_SLIDES[slide];

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        {cards.map(card => (
          <div key={card.label} style={{
            flex: 1, background: "var(--recent-active-bg)",
            border: "1px solid var(--drawer-label)",
            borderRadius: 14, padding: "16px",
          }}>
            <div style={{ color: "var(--drawer-action)", marginBottom: 12 }}>{card.icon}</div>
            <p style={{ ...MONO, fontSize: "0.75rem", color: "var(--drawer-action-hover)", margin: 0 }}>{card.label}</p>
            <p style={{ ...MONO, fontSize: "0.63rem", color: "var(--drawer-action)", marginTop: 3 }}>{card.sub}</p>
          </div>
        ))}
      </div>

      {/* Nav dots */}
      <div style={{ display: "flex", justifyContent: "center", gap: 6 }}>
        {FEATURE_SLIDES.map((_, i) => (
          <button
            key={i}
            onClick={() => setSlide(i)}
            style={{
              height: 5, width: i === slide ? 22 : 5, borderRadius: 999, border: "none",
              background: i === slide ? "#F5B800" : "var(--drawer-label)",
              cursor: "pointer", padding: 0,
              transition: "width 0.25s ease, background 0.25s ease",
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Drawer helpers ───────────────────────────────────────────────────────────

function DrawerSection({ label, children }: { label: string; children: React.ReactNode }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  return (
    <div style={{ padding: "4px 8px 12px" }}>
      <p style={{ ...MONO, fontSize: "0.62rem", color: "var(--drawer-label)", letterSpacing: "0.08em", padding: "0 12px 6px" }}>
        {label}
      </p>
      {children}
    </div>
  );
}

function DrawerAction({ label, onClick }: { label: string; onClick: () => void }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  return (
    <button
      onClick={onClick}
      style={{ ...MONO, width: "100%", textAlign: "left", padding: "7px 12px", fontSize: "0.72rem", color: "var(--drawer-action)", background: "none", border: "none", cursor: "pointer", borderRadius: 6, display: "block" }}
      onMouseEnter={e => (e.currentTarget.style.color = "var(--drawer-action-hover)")}
      onMouseLeave={e => (e.currentTarget.style.color = "var(--drawer-action)")}
    >
      {label}
    </button>
  );
}

// ─── QuoteDisplay ─────────────────────────────────────────────────────────────

const QUOTE_TTL = 30;

function QuoteDisplay({ result, onTxSubmitted, onRefresh }: {
  result: QuoteResult;
  onTxSubmitted?: (r: TxRecord) => void;
  onRefresh?: () => Promise<void>;
}) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { address }              = useConnection();
  const chainId                  = useChainId();
  const { mutateAsync: switchChain } = useSwitchChain();
  const { login, authenticated } = usePrivy();
  const { intent, route, calldata, approval } = result;
  const originChainId            = intent.from.chainId;
  const destChainId              = intent.to.chainId;
  const isSolanaRoute            = originChainId === 1000000001 || destChainId === 1000000001;
  const onCorrectChain           = chainId === originChainId;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: approval?.tokenAddress as `0x${string}` | undefined,
    abi: ERC20_ABI, functionName: "allowance", chainId: originChainId,
    args: address && approval ? [address, approval.spender as `0x${string}`] : undefined,
    query: { enabled: !!address && !!approval },
  });

  const needsApproval = !!approval && (allowance === undefined || BigInt(allowance as bigint) < BigInt(approval.amount));

  const { mutateAsync: writeContract, data: approvalHash, isPending: isApproving } = useWriteContract();
  const { isSuccess: approvalConfirmed } = useWaitForTransactionReceipt({ hash: approvalHash });
  useEffect(() => { if (approvalConfirmed) refetchAllowance(); }, [approvalConfirmed, refetchAllowance]);

  const { mutateAsync: sendTransaction, data: txHash, isPending: isSending } = useSendTransaction();
  const { isLoading: isConfirming, isSuccess: txConfirmed } = useWaitForTransactionReceipt({ hash: txHash });

  const [switchErr, setSwitchErr]     = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(QUOTE_TTL);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Reset countdown whenever a fresh quote arrives, accounting for server-to-client latency
  useEffect(() => {
    const elapsed = result.quotedAt ? Math.floor((Date.now() - result.quotedAt) / 1000) : 0;
    setSecondsLeft(Math.max(0, QUOTE_TTL - elapsed));
    setIsRefreshing(false);
  }, [result]);

  // Tick down — pauses once a tx is in flight (no point expiring mid-execution)
  useEffect(() => {
    if (txHash || secondsLeft <= 0) return;
    const id = setTimeout(() => setSecondsLeft(s => s - 1), 1000);
    return () => clearTimeout(id);
  }, [secondsLeft, txHash]);

  const isExpired = secondsLeft <= 0 && !txHash;

  async function handleRefresh() {
    if (!onRefresh) return;
    setIsRefreshing(true);
    try { await onRefresh(); } catch { setIsRefreshing(false); }
  }

  useEffect(() => {
    if (!txHash) return;
    const base = EXPLORER_URLS[intent.from.chain] ?? "https://etherscan.io/tx/";
    onTxSubmitted?.({
      hash: txHash, chainId: originChainId, chain: intent.from.chain,
      label: `${intent.from.amount} ${intent.from.token} → ${intent.to.chain}`,
      timestamp: Date.now(), explorerUrl: `${base}${txHash}`,
    });
  }, [txHash]); // eslint-disable-line react-hooks/exhaustive-deps

  async function approve() {
    if (!approval) return;
    setSwitchErr(null);
    try {
      if (!onCorrectChain) await switchChain({ chainId: originChainId });
      await writeContract({ address: approval.tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "approve", args: [approval.spender as `0x${string}`, BigInt(approval.amount)], chainId: originChainId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSwitchErr(msg.toLowerCase().includes("user rejected") ? "Transaction rejected in wallet." : `Error: ${msg.slice(0, 120)}`);
    }
  }

  async function execute() {
    if (!calldata) return;
    setSwitchErr(null);
    try {
      if (!onCorrectChain) await switchChain({ chainId: originChainId });
      await sendTransaction({ to: calldata.to as `0x${string}`, value: BigInt(calldata.value || "0x0"), data: calldata.data as `0x${string}`, chainId: originChainId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSwitchErr(msg.toLowerCase().includes("user rejected") ? "Transaction rejected in wallet." : `Error: ${msg.slice(0, 120)}`);
    }
  }

  const explorerUrl = txHash ? `${EXPLORER_URLS[intent.from.chain] ?? "https://etherscan.io/tx/"}${txHash}` : null;

  type Row = { label: string; value: React.ReactNode; highlight?: boolean };
  const rows: Row[] = [
    { label: "From", value: address ? <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 999, background: addrColor(address), flexShrink: 0 }} />{shortAddr(address)}</span> : "—" },
    { label: "To",   value: calldata?.to ? <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 999, background: addrColor(calldata.to), flexShrink: 0 }} />{shortAddr(calldata.to)}</span> : "—" },
    { label: "Send",    value: `${intent.from.amount} ${intent.from.token}` },
    { label: "Receive", value: `~${route.outputAmount} ${intent.to.token}`, highlight: true },
    { label: "Network", value: `${intent.from.chain} → ${intent.to.chain}` },
    ...(route.feesUSD ? [{ label: "Fees", value: `~$${Number(route.feesUSD).toFixed(4)}` }] : []),
  ];

  const executionMode = !!txHash;

  return (
    <div style={{ background: "var(--card-container-bg, #0D0D0D)", border: `1px solid ${executionMode ? "rgba(245,184,0,0.18)" : "var(--card-border, rgba(255,255,255,0.09))"}`, borderRadius: 16, overflow: "hidden", width: "100%" }}>
      {/* Header */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <p style={{ ...MONO, fontSize: "0.65rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--card-text-faint, rgba(255,255,255,0.3))", margin: 0 }}>
          {executionMode ? "Transaction" : "Quote Preview"}
        </p>
        {!executionMode && (
          <span style={{
            ...MONO, fontSize: "0.6rem", letterSpacing: "0.06em", padding: "2px 8px", borderRadius: 4,
            background: "var(--card-border-faint, rgba(255,255,255,0.05))",
            color: isExpired ? "#F5B800"
              : secondsLeft <= 10 ? "rgba(245,184,0,0.65)"
              : "var(--card-text-faint, rgba(255,255,255,0.3))",
          }}>
            {isExpired ? "expired" : secondsLeft <= 15 ? `${secondsLeft}s` : "preview"}
          </span>
        )}
      </div>

      {/* Rows */}
      <div style={{ padding: "4px 16px" }}>
        {rows.map(({ label, value, highlight }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--card-border-faint, rgba(255,255,255,0.05))", gap: 8 }}>
            <span style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", letterSpacing: "0.04em", flexShrink: 0 }}>{label}</span>
            <span style={{ ...MONO, fontSize: highlight ? "0.92rem" : "0.73rem", color: highlight ? "var(--card-text, #ffffff)" : "var(--card-text-muted, rgba(255,255,255,0.7))", fontWeight: highlight ? 500 : 400, display: "flex", alignItems: "center", gap: 4, textAlign: "right", wordBreak: "break-all" }}>
              {value}
            </span>
          </div>
        ))}
      </div>

      {/* Action */}
      <div style={{ padding: "14px 16px 18px", display: "flex", flexDirection: "column", gap: 8 }}>
        {switchErr && (
          <p style={{ ...MONO, fontSize: "0.68rem", color: "#ff6b6b", margin: 0, textAlign: "center" }}>
            {switchErr}
          </p>
        )}
        {txHash ? (
          txConfirmed ? (
            <a href={explorerUrl ?? "#"} target="_blank" rel="noopener noreferrer"
              style={{ ...MONO, display: "block", width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", textAlign: "center", background: "rgba(40,200,100,0.07)", border: "1px solid rgba(40,200,100,0.35)", borderRadius: 10, color: "#4ade80", textDecoration: "none" }}>
              confirmed ✓ · view →
            </a>
          ) : (
            <div style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", textAlign: "center", background: "rgba(245,184,0,0.04)", border: "1px solid rgba(245,184,0,0.15)", borderRadius: 10, color: "rgba(245,184,0,0.5)" }}
              className={isConfirming ? "animate-pulse" : ""}>
              {isConfirming ? "confirming on-chain…" : "submitted · waiting…"}
            </div>
          )
        ) : isExpired ? (
          <button onClick={handleRefresh} disabled={isRefreshing || !onRefresh}
            style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", background: "rgba(245,184,0,0.05)", border: "1px solid rgba(245,184,0,0.22)", borderRadius: 10, color: isRefreshing ? "rgba(245,184,0,0.35)" : "rgba(245,184,0,0.75)", cursor: isRefreshing ? "wait" : "pointer" }}
            className={isRefreshing ? "animate-pulse" : ""}>
            {isRefreshing ? "refreshing…" : "quote expired · refresh →"}
          </button>
        ) : isSolanaRoute ? (
          <SolanaExecuteButton result={result} onTxSubmitted={onTxSubmitted} />
        ) : !authenticated ? (
          <button onClick={login} style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", background: "rgba(245,184,0,0.08)", border: "1px solid rgba(245,184,0,0.3)", borderRadius: 10, color: "#F5B800", cursor: "pointer" }}>
            connect to execute →
          </button>
        ) : needsApproval ? (
          <button onClick={approve} disabled={isApproving || (!!approvalHash && !approvalConfirmed)}
            style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", background: "rgba(245,184,0,0.08)", border: "1px solid rgba(245,184,0,0.3)", borderRadius: 10, color: "#F5B800", cursor: isApproving ? "wait" : "pointer" }}>
            {isApproving ? "approving…" : approvalHash && !approvalConfirmed ? "confirming approval…" : `approve ${intent.from.token} →`}
          </button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {approvalConfirmed && (
              <p style={{ ...MONO, fontSize: "0.65rem", color: "#4ade80", textAlign: "center", margin: 0, letterSpacing: "0.06em" }}>
                approval confirmed ✓ — now execute the bridge
              </p>
            )}
            <button onClick={execute} disabled={!calldata || isSending}
              style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", background: calldata ? "rgba(245,184,0,0.08)" : "transparent", border: `1px solid ${calldata ? "rgba(245,184,0,0.3)" : "var(--card-border, rgba(255,255,255,0.09))"}`, borderRadius: 10, color: calldata ? "#F5B800" : "var(--card-text-faint, rgba(255,255,255,0.3))", cursor: calldata && !isSending ? "pointer" : "not-allowed" }}>
              {isSending ? "confirm in wallet…" : "execute transaction →"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SolanaExecuteButton ─────────────────────────────────────────────────────

function SolanaExecuteButton({ result, onTxSubmitted }: {
  result: QuoteResult;
  onTxSubmitted?: (r: TxRecord) => void;
}) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { publicKey, connected, connect, select, wallets, signTransaction, wallet } = useSolanaWallet();
  const { connection } = useSolanaConnection();
  const [sending, setSending] = useState(false);
  const [err, setErr]         = useState<string | null>(null);
  const [sig, setSig]         = useState<string | null>(null);

  async function execute() {
    if (!publicKey || !result.calldata || !signTransaction) return;
    setSending(true);
    setErr(null);
    try {
      // Delora returns base64-encoded VersionedTransaction
      const txBuffer = Uint8Array.from(atob(result.calldata.data), c => c.charCodeAt(0));
      const tx = VersionedTransaction.deserialize(txBuffer);

      const signed = await signTransaction(tx);
      const signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      if (confirmation.value.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);

      setSig(signature);
      onTxSubmitted?.({
        hash: signature,
        label: `${result.intent.from.amount} ${result.intent.from.token} → ${result.intent.to.chain}`,
        explorerUrl: `https://solscan.io/tx/${signature}`,
        chainId: result.intent.from.chainId,
        chain: result.intent.from.chain,
        timestamp: Date.now(),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setSending(false);
    }
  }

  if (sig) {
    return (
      <a href={`https://solscan.io/tx/${sig}`} target="_blank" rel="noopener noreferrer"
        style={{ ...MONO, display: "block", width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", background: "rgba(245,184,0,0.06)", border: "1px solid rgba(245,184,0,0.3)", borderRadius: 10, color: "#F5B800", cursor: "pointer", textAlign: "center", textDecoration: "none" }}>
        view on solscan ↗
      </a>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {err && <p style={{ ...MONO, fontSize: "0.65rem", color: "#ff5555", margin: 0 }}>{err}</p>}
      {!connected ? (
        <button
          onClick={async () => {
            try {
              if (!wallet) {
                // Phantom self-registers as a Standard Wallet — find it by name.
                // autoConnect: true on WalletProvider will call connect() once selected.
                const phantom = wallets.find(w => w.adapter.name === "Phantom");
                if (phantom) select(phantom.adapter.name as WalletName<"Phantom">);
              } else {
                await connect();
              }
            } catch (e) {
              setErr(e instanceof Error ? e.message : "Failed to connect wallet");
            }
          }}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", background: "rgba(245,184,0,0.08)", border: "1px solid rgba(245,184,0,0.3)", borderRadius: 10, color: "#F5B800", cursor: "pointer" }}>
          {wallet ? `connect ${wallet.adapter.name}` : "connect phantom →"}
        </button>
      ) : (
        <button
          onClick={execute}
          disabled={sending || !result.calldata}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", background: result.calldata ? "rgba(245,184,0,0.08)" : "transparent", border: `1px solid ${result.calldata ? "rgba(245,184,0,0.3)" : "var(--card-border, rgba(255,255,255,0.09))"}`, borderRadius: 10, color: result.calldata ? "#F5B800" : "var(--card-text-faint, rgba(255,255,255,0.3))", cursor: sending || !result.calldata ? "not-allowed" : "pointer" }}>
          {sending ? "confirm in phantom…" : "execute via phantom →"}
        </button>
      )}
      <p style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint, rgba(255,255,255,0.3))", margin: 0, textAlign: "center" }}>
        {publicKey ? `${publicKey.toBase58().slice(0, 6)}…${publicKey.toBase58().slice(-4)}` : "phantom · solana"}
      </p>
    </div>
  );
}

// ─── RebalanceDisplay ─────────────────────────────────────────────────────────

function RebalanceDisplay({ result, onTxSubmitted }: { result: RebalanceResult; onTxSubmitted?: (r: TxRecord) => void }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const total     = result.legs.length;
  const okLegs    = result.legs.filter(l => l.type === "quote").length;
  const destChain = result.legs.find(l => l.type === "quote")
    ? (result.legs.find(l => l.type === "quote") as QuoteResult).intent.to.chain
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Summary header */}
      <p style={{ ...MONO, fontSize: "0.72rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", margin: 0 }}>
        <span style={{ color: "#F5B800" }}>{okLegs}</span>
        {` route${okLegs !== 1 ? "s" : ""}`}
        {destChain ? ` · consolidating to ${destChain}` : ""}
        {" · execute in order"}
      </p>

      {/* One card per leg */}
      {result.legs.map((leg, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ ...MONO, fontSize: "0.6rem", letterSpacing: "0.1em", color: "var(--card-text-faint, rgba(255,255,255,0.3))" }}>
            STEP {i + 1} / {total}
          </span>
          {leg.type === "quote" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <p style={{ ...MONO, fontSize: "0.72rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", margin: 0 }}>
                <span style={{ color: "#F5B800" }}>{leg.route.tool}</span>
                {"  ·  "}
                <span style={{ color: "var(--card-text, #ffffff)" }}>
                  ~{leg.route.outputAmount} {leg.intent.to.token}
                </span>
                {leg.route.feesUSD && (
                  <span style={{ color: "var(--card-text-dim, rgba(255,255,255,0.45))" }}>
                    {"  ·  "}${Number(leg.route.feesUSD).toFixed(2)} fees
                  </span>
                )}
              </p>
              <QuoteDisplay result={leg} onTxSubmitted={onTxSubmitted} />
            </div>
          ) : (
            <div style={{ ...MONO, fontSize: "0.78rem", color: "#ff6b6b", padding: "12px 16px", background: "rgba(255,107,107,0.05)", border: "1px solid rgba(255,107,107,0.12)", borderRadius: 12 }}>
              {leg.text}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── TxDisplay ────────────────────────────────────────────────────────────────

function TxDisplay({ result }: { result: TxResult }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { tx, summary } = result;

  const statusColor = tx.status === "success" ? "#4ade80" : tx.status === "failed" ? "#ff6b6b" : "#F5B800";
  const ts = tx.timestamp ? new Date(tx.timestamp * 1000) : null;

  type Row = { label: string; value: React.ReactNode };
  const rows: Row[] = [
    { label: "Hash",    value: <span title={tx.hash}>{tx.hash.slice(0, 12)}…{tx.hash.slice(-8)}</span> },
    { label: "Chain",   value: tx.chainName },
    { label: "Status",  value: <span style={{ color: statusColor }}>{tx.status}</span> },
    { label: "Block",   value: tx.blockNumber ? `#${tx.blockNumber.toLocaleString()}` : "—" },
    { label: "From",    value: <span title={tx.from}>{tx.from.slice(0, 8)}…{tx.from.slice(-6)}</span> },
    ...(tx.to ? [{ label: "To", value: <span title={tx.to}>{tx.to.slice(0, 8)}…{tx.to.slice(-6)}</span> }] : []),
    ...(tx.method ? [{ label: "Method", value: <span style={{ color: "#F5B800" }}>{tx.method}</span> }] : []),
    { label: "Value",   value: `${tx.valueEth} ETH` },
    { label: "Gas",     value: `${tx.gasCostEth} ETH` },
    { label: "Logs",    value: tx.logCount.toString() },
    ...(ts ? [{ label: "Time", value: ts.toLocaleString() }] : []),
  ];

  return (
    <div style={{ background: "var(--card-container-bg, #0D0D0D)", border: "1px solid var(--card-border, rgba(255,255,255,0.09))", borderRadius: 16, overflow: "hidden" }}>
      <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <p style={{ ...MONO, fontSize: "0.65rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--card-text-faint, rgba(255,255,255,0.3))", margin: 0 }}>
          Transaction
        </p>
        <span style={{ ...MONO, fontSize: "0.6rem", letterSpacing: "0.06em", padding: "2px 8px", borderRadius: 4, background: "var(--card-border-faint, rgba(255,255,255,0.05))", color: statusColor }}>
          {tx.chainName}
        </span>
      </div>

      <div style={{ padding: "4px 16px" }}>
        {rows.map(({ label, value }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between", padding: "9px 0", borderBottom: "1px solid var(--card-border-faint, rgba(255,255,255,0.05))" }}>
            <span style={{ ...MONO, fontSize: "0.65rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", letterSpacing: "0.04em", flexShrink: 0 }}>{label}</span>
            <span style={{ ...MONO, fontSize: "0.72rem", color: "var(--card-text-muted, rgba(255,255,255,0.7))", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}>{value}</span>
          </div>
        ))}
      </div>

      {summary && (
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--card-border-faint, rgba(255,255,255,0.05))" }}>
          <p style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", lineHeight: 1.65, margin: 0 }}>{summary}</p>
        </div>
      )}

      <div style={{ padding: "12px 16px 16px" }}>
        <a
          href={tx.explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...MONO, display: "block", width: "100%", padding: "10px 0", fontSize: "0.72rem", letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "center", background: "var(--card-header-bg, rgba(255,255,255,0.04))", border: "1px solid var(--card-border, rgba(255,255,255,0.09))", borderRadius: 10, color: "var(--card-text-muted, rgba(255,255,255,0.7))", textDecoration: "none" }}
        >
          view on explorer →
        </a>
      </div>
    </div>
  );
}

// ─── AddressDisplay ───────────────────────────────────────────────────────────

function AddressDisplay({ result, onSwap }: { result: AddressResult; onSwap?: (prompt: string) => void }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { data, summary, ensName } = result;

  return (
    <div style={{ background: "var(--card-container-bg, #0D0D0D)", border: "1px solid var(--card-border, rgba(255,255,255,0.09))", borderRadius: 16, overflow: "hidden" }}>
      <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <p style={{ ...MONO, fontSize: "0.65rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--card-text-faint, rgba(255,255,255,0.3))", margin: 0 }}>
          {ensName ? <span>{ensName} <span style={{ color: "var(--card-text-dim, rgba(255,255,255,0.45))" }}>· address</span></span> : "Address"}
        </p>
        <span style={{ ...MONO, fontSize: "0.6rem", padding: "2px 8px", borderRadius: 4, background: "var(--card-border-faint, rgba(255,255,255,0.05))", color: "var(--card-text-dim, rgba(255,255,255,0.45))" }}>
          {data.address.slice(0, 8)}…{data.address.slice(-6)}
        </span>
      </div>

      {(data.balances.length > 0 || data.tokenBalances.length > 0) && (
        <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))" }}>
          <p style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.08em", color: "var(--card-text-faint, rgba(255,255,255,0.3))", marginBottom: 10 }}>
            BALANCES
          </p>
          {data.balances.map(b => (
            <div key={b.chainId} style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--card-header-bg, rgba(255,255,255,0.04))" }}>
              <span style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", flexShrink: 0 }}>{b.chainName}</span>
              <span style={{ ...MONO, fontSize: "0.72rem", color: "var(--card-text-muted, rgba(255,255,255,0.7))", textAlign: "right" }}>{b.native} {b.nativeSymbol}</span>
            </div>
          ))}
          {data.tokenBalances.slice(0, 10).map(t => (
            <div key={`${t.chainId}-${t.contractAddress}`} style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--card-header-bg, rgba(255,255,255,0.04))" }}>
              <span style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", flexShrink: 0 }}>
                {t.symbol} <span style={{ color: "var(--card-text-faint, rgba(255,255,255,0.3))" }}>· {t.chainName}</span>
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ ...MONO, fontSize: "0.72rem", color: "var(--card-text-muted, rgba(255,255,255,0.7))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.balance}</span>
                {onSwap && (
                  <button
                    onClick={() => onSwap(`swap ${t.balance} ${t.symbol} to USDC on ${t.chainName.toLowerCase()}`)}
                    style={{ ...MONO, fontSize: "0.58rem", padding: "2px 7px", borderRadius: 4, border: "1px solid rgba(245,184,0,0.2)", background: "rgba(245,184,0,0.04)", color: "rgba(245,184,0,0.55)", cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(245,184,0,0.45)"; e.currentTarget.style.color = "rgba(245,184,0,0.9)"; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(245,184,0,0.2)"; e.currentTarget.style.color = "rgba(245,184,0,0.55)"; }}
                  >
                    swap →
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {data.recentTransfers.length > 0 && (
        <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))" }}>
          <p style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.08em", color: "var(--card-text-faint, rgba(255,255,255,0.3))", marginBottom: 10 }}>
            RECENT TRANSFERS
          </p>
          {data.recentTransfers.slice(0, 8).map((t, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--card-header-bg, rgba(255,255,255,0.04))", minWidth: 0 }}>
              <span style={{ ...MONO, fontSize: "0.6rem", color: t.direction === "in" ? "#4ade80" : "#F5B800", letterSpacing: "0.04em", flexShrink: 0, width: 26 }}>
                {t.direction === "in" ? "IN" : "OUT"}
              </span>
              <span style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-muted, rgba(255,255,255,0.7))", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.value} {t.asset}
              </span>
              <a
                href={`https://etherscan.io/tx/${t.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint, rgba(255,255,255,0.3))", textDecoration: "none", flexShrink: 0 }}
              >
                {t.hash.slice(0, 8)}…
              </a>
            </div>
          ))}
        </div>
      )}

      {summary && (
        <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--card-border-faint, rgba(255,255,255,0.05))" }}>
          <p style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", lineHeight: 1.65, margin: 0 }}>{summary}</p>
        </div>
      )}

      <div style={{ padding: "14px 20px 18px" }}>
        <a
          href={`https://etherscan.io/address/${data.address}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...MONO, display: "block", width: "100%", padding: "10px 0", fontSize: "0.72rem", letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "center", background: "var(--card-header-bg, rgba(255,255,255,0.04))", border: "1px solid var(--card-border, rgba(255,255,255,0.09))", borderRadius: 10, color: "var(--card-text-muted, rgba(255,255,255,0.7))", textDecoration: "none" }}
        >
          view on etherscan →
        </a>
      </div>
    </div>
  );
}

// ─── TokenRiskDisplay ─────────────────────────────────────────────────────────

function TokenRiskDisplay({ result }: { result: TokenRiskResult }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { risk } = result;

  const SCORE_COLOR = { 1: "#22c55e", 2: "#f59e0b", 3: "#f97316", 4: "#ef4444" } as const;
  const color = SCORE_COLOR[risk.score];

  const fmt = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000   ? `$${(n / 1_000).toFixed(1)}K`
    : `$${n.toFixed(2)}`;

  const FLAG_LABELS: Record<string, string> = {
    NO_LIQUIDITY:   "No meaningful liquidity",
    VOLUME_SPIKE:   "Abnormal volume spike",
    SINGLE_POOL:    "Only 1 liquidity pool",
    NEW_TOKEN:      "Token < 7 days old",
    HIGH_VOLATILITY:"Price moved >50% in 24h",
    HEAVY_SELLING:  "Heavy sell pressure",
  };

  return (
    <div style={{ border: `1px solid ${color}30`, borderRadius: 14, overflow: "hidden", maxWidth: 420 }}>
      <div style={{ padding: "14px 18px 12px", borderBottom: `1px solid ${color}20`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <span style={{ ...MONO, fontSize: "1rem", fontWeight: 700, color: "var(--card-text, #ffffff)" }}>{risk.symbol}</span>
          <span style={{ ...MONO, fontSize: "0.65rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", marginLeft: 8 }}>{risk.name}</span>
        </div>
        <span style={{ ...MONO, fontSize: "0.72rem", fontWeight: 700, color, background: `${color}18`, border: `1px solid ${color}40`, borderRadius: 6, padding: "3px 10px" }}>
          {risk.label} RISK
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "var(--card-border-faint, rgba(255,255,255,0.05))" }}>
        {[
          ["Price",       risk.priceUsd ? `$${Number(risk.priceUsd).toPrecision(4)}` : "—"],
          ["24h Change",  risk.priceChange24h != null ? `${risk.priceChange24h > 0 ? "+" : ""}${risk.priceChange24h.toFixed(2)}%` : "—"],
          ["Liquidity",   fmt(risk.totalLiquidityUsd)],
          ["Vol 24h",     fmt(risk.volume24h)],
          ["Market Cap",  risk.marketCap ? fmt(risk.marketCap) : "—"],
          ["Pools",       `${risk.pairCount} on ${risk.dexCount} DEX${risk.dexCount > 1 ? "es" : ""}`],
        ].map(([label, val]) => (
          <div key={label} style={{ padding: "10px 16px", background: "var(--card-container-bg, #0D0D0D)" }}>
            <p style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint, rgba(255,255,255,0.3))", margin: "0 0 3px", letterSpacing: "0.06em" }}>{label!.toUpperCase()}</p>
            <p style={{ ...MONO, fontSize: "0.8rem", color: "var(--card-text, #ffffff)", margin: 0 }}>{val}</p>
          </div>
        ))}
      </div>

      {risk.flags.length > 0 && (
        <div style={{ padding: "12px 18px", borderTop: `1px solid ${color}20` }}>
          <p style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint, rgba(255,255,255,0.3))", marginBottom: 8, letterSpacing: "0.06em" }}>RISK FLAGS</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {risk.flags.map(f => (
              <div key={f} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ color, fontSize: "0.6rem" }}>▲</span>
                <span style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-muted, rgba(255,255,255,0.7))" }}>{FLAG_LABELS[f] ?? f}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {risk.topPair?.url && (
        <div style={{ padding: "10px 18px 14px", borderTop: "1px solid var(--card-border, rgba(255,255,255,0.09))" }}>
          <a href={risk.topPair.url} target="_blank" rel="noopener noreferrer"
            style={{ ...MONO, fontSize: "0.65rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", textDecoration: "none" }}
            onMouseEnter={e => (e.currentTarget.style.color = "var(--card-text-muted, rgba(255,255,255,0.7))")}
            onMouseLeave={e => (e.currentTarget.style.color = "var(--card-text-dim, rgba(255,255,255,0.45))")}
          >
            view on dexscreener · {risk.topPair.dexId} · {risk.topPair.chainId} ↗
          </a>
        </div>
      )}
    </div>
  );
}

// ─── YieldPoolsDisplay ────────────────────────────────────────────────────────

const PROJECT_URLS: Record<string, string> = {
  "aave-v3":        "https://app.aave.com",
  "aave-v2":        "https://app.aave.com",
  "morpho-blue":    "https://app.morpho.org",
  "morpho":         "https://app.morpho.org",
  "compound-v3":    "https://app.compound.finance",
  "compound-v2":    "https://app.compound.finance",
  "moonwell":       "https://moonwell.fi/discover",
  "uniswap-v3":     "https://app.uniswap.org",
  "spark":          "https://app.spark.fi",
  "fluid":          "https://fluid.instadapp.io",
  "yearn-finance":  "https://yearn.fi",
  "convex-finance": "https://www.convexfinance.com/stake",
  "curve-dex":      "https://curve.fi/#/ethereum/pools",
};

function YieldPoolsDisplay({ result }: { result: YieldPoolsResult }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { symbol, pools } = result;

  const PROJECT_LABELS: Record<string, string> = {
    "aave-v3": "Aave v3", "aave-v2": "Aave v2",
    "morpho-blue": "Morpho", "morpho": "Morpho",
    "compound-v3": "Compound v3", "compound-v2": "Compound v2",
    "moonwell": "Moonwell", "uniswap-v3": "Uniswap v3",
    "spark": "Spark", "fluid": "Fluid",
    "yearn-finance": "Yearn", "convex-finance": "Convex",
    "curve-dex": "Curve",
  };

  const fmtTvl = (n: number) =>
    n >= 1_000_000_000 ? `$${(n / 1_000_000_000).toFixed(1)}B`
    : n >= 1_000_000   ? `$${(n / 1_000_000).toFixed(0)}M`
    : `$${(n / 1_000).toFixed(0)}K`;

  return (
    <div style={{ border: "1px solid rgba(245,184,0,0.2)", borderRadius: 14, overflow: "hidden", maxWidth: 480 }}>
      <div style={{ padding: "13px 18px 11px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.1em", color: "var(--card-text-faint, rgba(255,255,255,0.3))" }}>YIELD SCANNER</span>
        <span style={{ ...MONO, fontSize: "0.72rem", color: "#F5B800", fontWeight: 700 }}>{symbol}</span>
        <span style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint, rgba(255,255,255,0.3))", marginLeft: "auto" }}>via DeFiLlama</span>
      </div>

      <div>
        {pools.map((pool, i) => (
          <div key={pool.pool} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 18px", borderBottom: i < pools.length - 1 ? "1px solid var(--card-border-faint, rgba(255,255,255,0.05))" : "none" }}>
            <span style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint, rgba(255,255,255,0.3))", width: 14, flexShrink: 0 }}>{i + 1}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ ...MONO, fontSize: "0.75rem", color: "var(--card-text, #ffffff)", margin: 0 }}>{PROJECT_LABELS[pool.project] ?? pool.project}</p>
              <p style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", margin: "2px 0 0" }}>
                {pool.chain}
                {pool.apyReward != null && pool.apyReward > 0 && (
                  <span style={{ color: "#F5B800", marginLeft: 6 }}>+{pool.apyReward.toFixed(2)}% rewards</span>
                )}
              </p>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <p style={{ ...MONO, fontSize: "0.85rem", color: "#22c55e", fontWeight: 700, margin: 0 }}>{pool.apy.toFixed(2)}%</p>
              <p style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint, rgba(255,255,255,0.3))", margin: "2px 0 0" }}>{fmtTvl(pool.tvlUsd)} TVL</p>
            </div>
            {PROJECT_URLS[pool.project] && (
              <a
                href={PROJECT_URLS[pool.project]}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...MONO, fontSize: "0.6rem", padding: "4px 9px", borderRadius: 6, border: "1px solid rgba(245,184,0,0.25)", background: "rgba(245,184,0,0.05)", color: "rgba(245,184,0,0.6)", textDecoration: "none", flexShrink: 0 }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(245,184,0,0.5)"; e.currentTarget.style.color = "#F5B800"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(245,184,0,0.25)"; e.currentTarget.style.color = "rgba(245,184,0,0.6)"; }}
              >
                deposit ↗
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── PolymarketDisplay ────────────────────────────────────────────────────────

function PolymarketDisplay({ result }: { result: PolymarketResult }) {
  const { topic, markets } = result;

  function fmtVolume(v: number): string {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M vol`;
    if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K vol`;
    return `$${v.toFixed(0)} vol`;
  }

  function fmtPrice(price: string): string {
    const n = parseFloat(price);
    if (isNaN(n)) return "—";
    return `${Math.round(n * 100)}%`;
  }

  return (
    <div style={{ width: "100%" }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", letterSpacing: "0.1em", textTransform: "uppercase" }}>
          PREDICTION MARKETS {topic ? `· ${topic.toUpperCase()}` : "· TRENDING"} · via Polymarket
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {markets.map((event, i) => {
          const topMarket = event.markets[0];
          if (!topMarket) return null;
          const yesPct = parseFloat(topMarket.outcomePrices[0] ?? "0") * 100;

          return (
            <a
              key={event.slug}
              href={event.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "none" }}
            >
              <div
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "10px 12px", borderRadius: 8,
                  border: "1px solid var(--card-border, rgba(255,255,255,0.09))",
                  background: "var(--card-bg, rgba(255,255,255,0.04))",
                  cursor: "pointer", transition: "border-color 0.15s",
                }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = "var(--card-border-faint, rgba(255,255,255,0.05))")}
                onMouseLeave={e => (e.currentTarget.style.borderColor = "var(--card-border, rgba(255,255,255,0.09))")}
              >
                <span style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint, rgba(255,255,255,0.3))", width: 16, flexShrink: 0 }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ ...MONO, fontSize: "0.75rem", color: "var(--card-text, #ffffff)", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {topMarket.question}
                  </p>
                  <p style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint, rgba(255,255,255,0.3))", margin: "3px 0 0" }}>
                    {fmtVolume(event.volume)}
                  </p>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                  {topMarket.outcomes.slice(0, 2).map((outcome, j) => (
                    <div key={j} style={{
                      display: "flex", flexDirection: "column", alignItems: "center",
                      padding: "3px 8px", borderRadius: 5,
                      background: j === 0 ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.08)",
                      border: `1px solid ${j === 0 ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.15)"}`,
                    }}>
                      <span style={{ ...MONO, fontSize: "0.8rem", fontWeight: 700, color: j === 0 ? "#22c55e" : "#ef4444" }}>
                        {fmtPrice(topMarket.outcomePrices[j] ?? "0")}
                      </span>
                      <span style={{ ...MONO, fontSize: "0.5rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", marginTop: 1 }}>{outcome}</span>
                    </div>
                  ))}
                </div>
                {yesPct > 0 && (
                  <div style={{ width: 60, height: 4, borderRadius: 2, background: "var(--card-border, rgba(255,255,255,0.09))", flexShrink: 0, overflow: "hidden" }}>
                    <div style={{ width: `${yesPct}%`, height: "100%", background: "#22c55e", borderRadius: 2 }} />
                  </div>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

// ─── SuggestionsDisplay ───────────────────────────────────────────────────────

function SuggestionsDisplay({ result, onSelect }: { result: SuggestionsResult; onSelect: (cmd: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-dim, rgba(255,255,255,0.45))", letterSpacing: "0.1em", textTransform: "uppercase" }}>
        Try one of these
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {result.prompts.map((p, i) => (
          <button
            key={i}
            onClick={() => onSelect(p.command)}
            style={{
              ...MONO, textAlign: "left", padding: "11px 16px", borderRadius: 8,
              border: "1px solid var(--card-border, rgba(255,255,255,0.09))",
              background: "var(--card-bg, rgba(255,255,255,0.04))",
              color: "var(--card-text, #ffffff)",
              cursor: "pointer", fontSize: "0.8rem",
              transition: "border-color 0.15s, background 0.15s",
              display: "flex", alignItems: "center", gap: 10,
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = "rgba(245,184,0,0.4)";
              e.currentTarget.style.background  = "rgba(245,184,0,0.04)";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = "var(--card-border, rgba(255,255,255,0.09))";
              e.currentTarget.style.background  = "var(--card-bg, rgba(255,255,255,0.04))";
            }}
          >
            <span style={{ color: "#F5B800", flexShrink: 0 }}>→</span>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {p.command}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
