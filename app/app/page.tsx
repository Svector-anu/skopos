"use client";

import { useRef, useEffect, useState, useCallback, Component, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import type { TxData, AddressData } from "@/lib/alchemy-types";
import { usePrivy, useFundWallet, useWallets, useConnectWallet, useSignMessage } from "@privy-io/react-auth";
import {
useAccount, useBalance, useChainId,
  useSendTransaction, useWriteContract, useReadContract,
  useWaitForTransactionReceipt, useWalletClient, useSignTypedData,
} from "wagmi";
import { fetchSmartMoney } from "@/lib/smartMoneyClient";
import { callX402Endpoint } from "@/lib/x402GenericClient";
import { subscribe } from "@/lib/subscribeClient";
// Pure module deliberately, never @/lib/flash — that one imports @upstash/redis
// and would land the server module graph in the client bundle.
import {
  buildFlashUpdate, buildFlashCancelMessage, normalizeFlashPrice, flashUpdateAxis,
  isFlashOrderUpdatable, limitPriceOf, triggerPriceOf, FLASH_CANCELLABLE_STATUSES,
} from "@/lib/flashUpdate";
import { toFlashBracketWire } from "@/lib/flashBracket";
import { pushSseChunk, toQuoteRevision } from "@/lib/flashQuoteStream";
import {
  useWallet as useSolanaWallet,
  useConnection as useSolanaConnection,
} from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import { VersionedTransaction } from "@solana/web3.js";
import { WhatsNewToast } from "@/components/shared/WhatsNewToast";

// ─── Types ───────────────────────────────────────────────────────────────────

type ApprovalInfo = { tokenAddress: string; spender: string; amount: string } | null;

// Flash (Robinhood Chain) leg — populated instead of approval/calldata when
// intent.from.chainId === ROBINHOOD_CHAIN_ID. Delora's calldata is a raw tx
// to broadcast directly; Flash instead needs EIP-712 typed-data signing plus
// a submit round-trip (FlashExecuteButton), so it can't share that field.
type FlashLegInfo = {
  quoteId: string;
  targetChain: string;
  contraChain: string;
  targetAsset: string;
  contraAsset: string;
  // "sell" since advanced orders shipped — stop-loss/take-profit are always
  // sells, limit and twap can be either side. Market stock buys stay "buy".
  side: "buy" | "sell";
  qty: string;
  orderType: string;
  funderAddress: string;
  flashIntegratorFeeBps: string;
  // Must be sent and confirmed BEFORE approveTx/orderTypedData mean
  // anything — spending the native-ETH sentinel actually pulls WETH under
  // the hood, so the funder needs real WETH first. See route.ts's
  // resolveFlashLeg() comment for how this was discovered.
  wrapTx: { to: string; data: string; value: string } | null;
  approveTx: { to: string; data: string } | null;
  permitTypedData: string;
  orderTypedData: string;
  // Set client-side (via onResultUpdate) once submitFlashOrder() succeeds —
  // persisted into the chat message itself, not just FlashExecuteButton's
  // local state, so the success view survives a reload instead of resetting
  // to a fresh, already-stale quote card.
  completedOrderId?: string;
  // Present only for orderType limit/stop-loss/take-profit (the USD level)
  // and twap (the spend schedule) — route.ts's resolveFlashOrderLeg(). Purely
  // for card display; FlashExecuteButton's sign/submit ladder is unchanged
  // and identical for market and advanced orders alike.
  triggerPrice?: string;
  triggerType?: "upper" | "lower";
  durationSeconds?: number;
  twapBucketCount?: number;
  // Attached take-profit / stop-loss pair. Unlike the display-only fields
  // above, this DOES change the sign/submit ladder: the pair signs its own
  // typed data and sells the asset the entry receives, so it can need its
  // own approval on that asset before submit — a second approve and a second
  // signature, both required before the entry is placed.
  //
  // Present only when Flash returned a signable payload for it, never merely
  // because one was requested (route.ts gates on quote.attachedBracket.evm).
  bracket?: {
    takeProfit: { price: string; basis: "notional" | "cross"; limitPrice?: string };
    stopLoss: { price: string; basis: "notional" | "cross"; limitPrice?: string };
    approveTx: { to: string; data: string } | null;
    permitTypedData: string | null;
    orderTypedData: string;
    salt: string | null;
    deadline: string;
    // The most of the received asset the pair's signature authorizes selling.
    // Protection is capped here — an entry that fills above it leaves the
    // excess unprotected — so the card states it rather than just carrying it.
    signedMaxFromAmount: string;
  };
};

// Relay leg — populated instead of approval/calldata when the intent moves
// funds onto or off Robinhood Chain (exactly one side is chainId 4663,
// unlike Flash's same-chain-only case). Unlike Flash, every step observed so
// far is a plain raw transaction — no EIP-712 signing — but there can be 1-2
// steps in sequence (approve, then deposit, for an ERC-20 source), which
// neither Delora's single-calldata shape nor Flash's single-order shape
// models, hence its own field.
type RelayStepInfo = {
  id: string;
  action: string;
  description: string;
  tx: { from: string; to: string; data: string; value: string; chainId: number };
  checkEndpoint: string | null;
};
type RelayLegInfo = {
  steps: RelayStepInfo[];
  timeEstimateSec: number | null;
  // Same reasoning as FlashLegInfo.completedOrderId — set once the final
  // step's tx confirms, persisted into the message so the success view
  // survives a reload.
  completedTxHash?: string;
};

type QuoteResult = {
  type: "quote";
  mode: "preview";
  originMessage?: string;
  quotedAt?: number;
  intent: {
    from: { chain: string; chainId: number; token: string; amount: string };
    to: { chain: string; chainId: number; token: string; receiver?: string };
  };
  route: { tool: string; outputAmount: string; feesUSD: string | null; gasUSD: string | null; etaSec?: number | null };
  approval: ApprovalInfo;
  calldata: { to: string; value: string; data: string } | null;
  flash?: FlashLegInfo;
  relay?: RelayLegInfo;
  analysis?: string;
};

type TextResult      = { type: "text";      text: string; suggestions?: { label: string; command: string }[] };
type ErrorResult     = { type: "error";     text: string };
type PriceResult     = { type: "price"; symbol: string; name: string | null; image: string | null; price: number; change24h: number | null; sparkline: number[]; marketCap: number | null; volume24h: number | null; circulatingSupply: number | null; maxSupply: number | null };
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
    sparkline?: number[];
    top10HolderPct?: number | null;
  };
  analysis?: string;
  pick?: boolean;
  stockPaired?: StockPairedItemT;
};

type YieldPool = {
  pool: string; chain: string; project: string; symbol: string;
  tvlUsd: number; apy: number; apyBase: number | null; apyReward: number | null;
  apyMean30d: number | null; rewardTokens: string[] | null;
};
type YieldPoolsResult = { type: "yield_pools"; symbol: string; pools: YieldPool[]; analysis?: string };

type PolymarketMarket = {
  id: string; question: string; outcomes: string[]; outcomePrices: string[];
  volume: number; endDate: string | null;
};
type PolymarketEventItem = {
  title: string; slug: string; volume: number; image: string | null; url: string;
  markets: PolymarketMarket[];
};
type PolymarketDeposit = { evm: string | null; svm: string | null; btc: string | null; amount?: string } | null;
type PolymarketResult = { type: "polymarket"; topic: string | null; markets: PolymarketEventItem[]; deposit?: PolymarketDeposit };

type SuggestionsResult = { type: "suggestions"; prompts: { label: string; command: string }[] };

type IntelResult = {
  type: "intel";
  read?: "smart-money" | "holders" | "flows" | "flow-intel" | "screener";
  direction?: "BUY" | "SELL";
  timeframe?: string | null;
  screenChain?: string | null;
  context?: { url: string; sourceHost: string; title: string; excerpt: string };
  token?: { symbol: string | null; address: string | null; chain?: string | null };
  premium?: { available: boolean; mode?: "user" | "agent"; label: string; price: string; note: string };
};

type PaywallResult = { type: "paywall"; reason: "connect" | "daily_cap"; used: number; cap: number };

type PayResult = { type: "pay"; token: string; tokenSymbol: string; decimals: number; to: string; amountWei: string; amountDisplay: string; memo: string; memoText: string; memoHashed: boolean; method: "transferWithMemo" | "transfer"; isB20: boolean; memoApplied: boolean; chainId: number; chainName: string };

type MemoPaymentItem = { chainId: number; chainName: string; token: string; tokenSymbol: string; amount: string; from: string; memo: string; memoText: string; txHash: string; timestamp: number | null };
type PaymentsResult = { type: "payments"; address: string; payments: MemoPaymentItem[] };

type AeonResult = { type: "aeon"; kind: "narrative" | "defi" | "onchain" | "trending" | "protocols" | "fear" | "x402" | "tokenpick" | "pickstracker"; title: string; subtitle: string; premium?: { available: boolean; label: string; note: string } };

type X402Discovery = { ok: boolean; description?: string; network?: string; priceUsd?: string; asset?: string; payTo?: string; error?: string };
type X402CheckResult = { type: "x402check"; url: string; method: "GET" | "POST"; discovery: X402Discovery };

type PrebuyResult = {
  type: "prebuy";
  query: string;
  risk: TokenRiskResult["risk"];
  smartMoney: { buyerCount: number; totalBoughtUsd: number } | null;
  quote: QuoteResult | null;
  quoteUnavailable: string | null;
  analysis?: string;
  stockPaired?: StockPairedItemT;
};

type RobinhoodLaunchCard = {
  symbol: string;
  name: string;
  address: string;
  ageMinutes: number;
  marketCapUsd: number;
  volume24hUsd: number;
  volumeToMcapRatio: number | null;
  hot: boolean;
  creator: { xUsername: string | null; repeatLaunchCount: number; profileUrl: string };
  risk: { score: 1 | 2 | 3 | 4; label: string; flags: string[]; totalLiquidityUsd: number } | null;
  links: { bankr: string; dexscreener: string | null; geckoterminal: string | null; noxa: string };
};
type RobinhoodLaunchesResult = {
  type: "robinhood_launches";
  heading: string;
  subtitle: string;
  launches: RobinhoodLaunchCard[];
  omittedCount: number;
};
type StockPairedItemT = {
  tokenSymbol: string; tokenAddress: string;
  stockSymbol: string; stockTokenAddress: string | null; stockVerified: boolean;
  tokenImpersonatesTicker?: boolean;
  priceInStockTerms: string | null; tokenPriceUsd: string | null;
  pairAddress: string; pairLiquidityUsd: number; pairVolume24hUsd: number;
  pairCreatedAt: number | null; pairUrl: string;
  stockPriceUsd: number | null; stockPriceStale: boolean;
  dailyStockValueEstimate: number | null; dailyStockTokensEstimate: number | null;
  totalAccumulatedEstimate: number | null; daysOld: number | null;
  isEstimate: true;
};
type StockPairedResult = { type: "stock_paired"; mode: "single" | "list"; heading: string; note: string; items: StockPairedItemT[] };

type ApprovalRow = {
  chainId: number;
  chainName: string;
  tokenAddress: string;
  tokenSymbol: string;
  spender: string;
  allowanceRaw: string;
  unlimited: boolean;
  allowanceDisplay: string;
};
type ApprovalScanResult = { type: "approval_scan"; address: string; rows: ApprovalRow[]; windowDays: number };
type FlashOrder = {
  orderId: string;
  orderType: "market" | "limit" | "twap" | "stop" | "stop-loss" | "take-profit" | "bracket";
  side: "buy" | "sell";
  status: "ORDER_STATUS_UNSPECIFIED" | "ORDER_STATUS_PENDING" | "ORDER_STATUS_ACCEPTED" | "ORDER_STATUS_PARTIALLY_FILLED" | "ORDER_STATUS_FILLED" | "ORDER_STATUS_CANCELLED" | "ORDER_STATUS_REJECTED" | "ORDER_STATUS_TERMINATED";
  closeReason: string | null;
  // The wallet that signed the order. Cancel and update signatures are only
  // accepted from this address, so it has to travel to the client rather
  // than being inferred from whichever wallet happens to be connected.
  funderAddress: string;
  targetAsset: { ticker: string };
  contraAsset: { ticker: string };
  qty: string;
  filled: { targetAmount: string | null; contraAmount: string | null } | null;
  limitNotionalPrice: string | null;
  limitCrossPrice: string | null;
  // Exactly one price is set. Cross basis only appears on orders placed
  // through another Flash client on the same funder wallet, but those are
  // listed here too — see lib/flash.ts's FlashPriceTrigger.
  trigger: { notionalPrice?: string; crossPrice?: string; triggerType: "upper" | "lower" } | null;
  twapBucketCount: number | null;
  // The attached pair's state, reported on the ENTRY order. A GET for the
  // pair itself 404s until it activates on the entry's first fill, so this is
  // the only way to see it during that window.
  attachedBracket: {
    status: "pending_activation" | "active" | "never_activated";
    bracketOrderId: string | null;
    takeProfit: { notionalPrice?: string; crossPrice?: string; limitPrice?: string };
    stopLoss: { notionalPrice?: string; crossPrice?: string; limitPrice?: string };
    signedMaxFromAmount: string;
  } | null;
  // Set on the PAIR itself once active — the entry it protects. Its row is a
  // plain "sell bracket" otherwise, which reads as a mystery order.
  sourceEntryOrderId: string | null;
  placedAt: string;
};
type FlashOrdersResult = { type: "flash_orders"; address: string; orders: FlashOrder[] };

type AssistantResult = QuoteResult | TextResult | PriceResult | ErrorResult | RebalanceResult | TxResult | AddressResult | TokenRiskResult | YieldPoolsResult | PolymarketResult | SuggestionsResult | IntelResult | PaywallResult | PayResult | PaymentsResult | AeonResult | X402CheckResult | PrebuyResult | RobinhoodLaunchesResult | ApprovalScanResult | FlashOrdersResult | StockPairedResult;
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

const PAY_ABI = [
  { name: "transfer", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }] },
  { name: "transferWithMemo", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "memo", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }] },
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
  Base: "https://basescan.org/tx/", "Base Sepolia": "https://sepolia.basescan.org/tx/", Plasma: "https://plasmascan.to/tx/",
  Arbitrum: "https://arbiscan.io/tx/", Celo: "https://celoscan.io/tx/",
  Avalanche: "https://snowtrace.io/tx/", Ink: "https://explorer.inkonchain.com/tx/",
  Linea: "https://lineascan.build/tx/", Berachain: "https://berascan.com/tx/",
  Blast: "https://blastscan.io/tx/", Scroll: "https://scrollscan.com/tx/",
  MegaETH: "https://mega.etherscan.io/tx/",
  "Robinhood Chain": "https://robinhoodchain.blockscout.com/tx/",
};

// Matches lib/chains.ts's CHAIN_IDS "robinhood" entry — Flash (Definitive)
// trades happen here instead of through Delora, which doesn't support this
// chain. See resolveFlashLeg() in app/api/chat/route.ts.
const ROBINHOOD_CHAIN_ID = 4663;

// `label` is the translated display text (looked up via t() at the render
// site); `prompt` is sent verbatim to the backend's English-only regex intent
// parser and must never be translated — a zh/vi prompt would fail to parse.
const BRIDGE_ACTIONS = [
  { key: "ethToBase",      label: "ETH → Base",     prompt: "bridge 0.1 ETH from ethereum to base" },
  { key: "ethToArbitrum",  label: "ETH → Arbitrum", prompt: "bridge 0.1 ETH from ethereum to arbitrum" },
  { key: "usdcToPolygon",  label: "USDC → Polygon", prompt: "bridge 100 USDC from base to polygon" },
  { key: "ethToOptimism",  label: "ETH → Optimism", prompt: "bridge 0.1 ETH from ethereum to optimism" },
];

const SWAP_ACTIONS = [
  { key: "ethToUsdcBase", label: "ETH → USDC · Base", prompt: "swap 0.1 ETH to USDC on base" },
  { key: "ethToUsdcArb",  label: "ETH → USDC · Arb",  prompt: "swap 0.1 ETH to USDC on arbitrum" },
  { key: "usdcToEthBase", label: "USDC → ETH · Base", prompt: "swap 100 USDC to ETH on base" },
];

// Percentages — identical in every locale, no translation needed.
const SLIPPAGE_OPTIONS = [
  { value: 0.003, label: "0.3%" },
  { value: 0.005, label: "0.5%" },
  { value: 0.01,  label: "1%" },
];

const TIER_OPTIONS = [
  { id: "smart" as const, key: "smart", label: "✦ Smart", desc: "frontier models · depth" },
  { id: "fast"  as const, key: "fast",  label: "⚡ Fast",  desc: "quick & free" },
];

// label is the translated display text; prompt is the literal English command
// submitted on click (see EXAMPLE_PROMPTS.map below) — same non-translation
// rule as BRIDGE_ACTIONS/SWAP_ACTIONS above.
const EXAMPLE_PROMPTS = [
  { key: "bridgeEthBase",  prompt: "bridge 0.1 ETH from ethereum to base" },
  { key: "swapUsdcEth",    prompt: "swap 100 USDC to ETH on arbitrum" },
  { key: "showPortfolio",  prompt: "show my portfolio" },
  { key: "whatChains",     prompt: "what chains do you support?" },
];

// `soon` features aren't live yet — shown as roadmap, visually tagged, and the
// backend answers them honestly if triggered. Live ones (no `soon`) fill the
// composer with a working prompt the user can send.
const HORIZON_PILLS: { key: string; label: string; prompt: string; soon?: boolean }[] = [
  { key: "robinhoodLaunches", label: "robinhood launches", prompt: "what's launching on robinhood chain" },
  { key: "polymarket",        label: "polymarket",       prompt: "what are the current odds ETH hits $5k this year?" },
  { key: "yieldScanner",      label: "yield scanner",    prompt: "find the highest yield for USDC on base" },
  { key: "limitOrders",       label: "limit orders",     prompt: "buy $500 of ETH at $1800 on arbitrum" },
  { key: "onchainMcp",        label: "on-chain MCP",     prompt: "connect skopos to my claude desktop via MCP" },
  { key: "agentMode",         label: "agent mode",       prompt: "set up an agent to DCA $20 into ETH every week on base", soon: true },
  { key: "offrampCard",       label: "offramp to card",  prompt: "cash out 200 USDC to my debit card",                     soon: true },
  { key: "deepResearch",      label: "deep research",    prompt: "compare gas costs across all supported bridges for 1 ETH", soon: true },
  { key: "whaleSignals",      label: "whale signals",    prompt: "show me what top wallets are bridging this week",         soon: true },
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


type FeatureCard = { key: string; label: string; sub: string; icon: React.ReactNode };
const FEATURE_SLIDES: FeatureCard[][] = [
  [
    { key: "bridge",    label: "Bridge",      sub: "25+ chains supported",   icon: <IcBridge /> },
    { key: "bestRoute", label: "Best Route",  sub: "AI finds cheapest path",  icon: <IcZap /> },
    { key: "swap",      label: "Swap",        sub: "Any token, any chain",    icon: <IcSwap /> },
  ],
  [
    { key: "plainLanguage", label: "Plain Language", sub: "Just describe what you want", icon: <IcChat /> },
    { key: "fiveBridges",   label: "5 Bridges",      sub: "Relay, Across, Mayan & more", icon: <IcNet /> },
    { key: "liveQuotes",    label: "Live Quotes",    sub: "Real-time cross-chain pricing", icon: <IcChart /> },
  ],
  [
    { key: "txHistory", label: "Tx History",  sub: "Track all your moves",    icon: <IcClock /> },
    { key: "portfolio", label: "Portfolio",   sub: "Balances across chains",  icon: <IcWallet /> },
  ],
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortAddr(addr: string) { return `${addr.slice(0, 6)}…${addr.slice(-4)}`; }

function formatDuration(seconds: number): string {
  if (seconds >= 604800 && seconds % 604800 === 0) { const n = seconds / 604800; return `${n} week${n === 1 ? "" : "s"}`; }
  if (seconds >= 86400 && seconds % 86400 === 0)   { const n = seconds / 86400;  return `${n} day${n === 1 ? "" : "s"}`; }
  if (seconds >= 3600 && seconds % 3600 === 0)     { const n = seconds / 3600;   return `${n} hour${n === 1 ? "" : "s"}`; }
  return `${Math.round(seconds / 60)} min`;
}

// Web Push wants the VAPID key as a Uint8Array, browsers hand it out as base64url.
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
function loadJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; }
}
// setItem throws QuotaExceededError once ~5MB fills up (long sessions persist
// full card payloads) — and these writes run inside effects, where an uncaught
// throw takes down the whole component tree on every render until the user
// manually clears storage. Persisting is best-effort: report failure, never throw.
function persistJson(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

// Persists the last wallet-blocked query so it can auto-retry after connect even
// if the connect flow triggers a full page reload (common on mobile/in-app
// browsers) — a pure in-memory ref can't survive that, since React state resets.
const PENDING_WALLET_RETRY_KEY = "skopos-pending-wallet-query";
const PENDING_WALLET_RETRY_TTL_MS = 10 * 60 * 1000;

function savePendingWalletRetry(text: string) {
  try { localStorage.setItem(PENDING_WALLET_RETRY_KEY, JSON.stringify({ text, ts: Date.now() })); } catch {}
}
function readPendingWalletRetry(): string | null {
  try {
    const raw = localStorage.getItem(PENDING_WALLET_RETRY_KEY);
    if (!raw) return null;
    const { text, ts } = JSON.parse(raw);
    if (Date.now() - ts > PENDING_WALLET_RETRY_TTL_MS) { localStorage.removeItem(PENDING_WALLET_RETRY_KEY); return null; }
    return typeof text === "string" ? text : null;
  } catch { return null; }
}
function clearPendingWalletRetry() {
  try { localStorage.removeItem(PENDING_WALLET_RETRY_KEY); } catch {}
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
  const t = useTranslations("app");
  const inputRef     = useRef<HTMLInputElement>(null);
  const bottomRef    = useRef<HTMLDivElement>(null);
  const abortRef     = useRef<AbortController | null>(null);
  const dripRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef<string>("");
  const submitRef    = useRef<((msg?: string) => Promise<void>) | null>(null);

  const [value, setValue]              = useState("");
  const [loading, setLoading]          = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [inputFocused, setInputFocused]= useState(false);
  const [messages, setMessages]        = useState<Message[]>([]);
  const messagesRef                    = useRef<Message[]>([]);
  messagesRef.current                  = messages;
  const [sessions, setSessions]        = useState<Session[]>([]);
  const [txHistory, setTxHistory]      = useState<TxRecord[]>([]);
  const [activeSessionId, setActiveId] = useState<string>("");
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [featureSlide, setFeatureSlide]= useState(0);
  const [isMobile, setIsMobile]        = useState(false);
  const [slippage, setSlippage]        = useState(0.005);
  const [llmTier, setLlmTier]          = useState<"fast" | "smart">(() => {
    if (typeof window === "undefined") return "fast";
    return localStorage.getItem("skopos-llm-tier") === "smart" ? "smart" : "fast";
  });
  const [tierMenuOpen, setTierMenuOpen] = useState(false);
  const [anonId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    let id = localStorage.getItem("skopos-anon-id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("skopos-anon-id", id);
    }
    return id;
  });
  const [horizonToast, setHorizonToast] = useState<string | null>(null);
  const [theme, setTheme]              = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    return (localStorage.getItem("skopos-theme") as "dark" | "light") ?? "dark";
  });
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isOnline, setIsOnline]               = useState(true);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const messagesLenRef = useRef(0);
  // Mirrors the composer's draft text into a ref so the version-poll effect
  // below (a stable [] effect) can read its latest value without re-running
  // on every keystroke — same pattern as messagesLenRef.
  const valueRef = useRef("");
  const { address }                            = useAccount();
  const currentChainId                         = useChainId();
  const { login, logout, authenticated, ready }= usePrivy();
  const { connectWallet }                      = useConnectWallet();
  const { fundWallet }                         = useFundWallet();
  const { wallets, ready: walletsReady }       = useWallets();
  const privyEvmWallet                         = wallets.find(w => w.address?.startsWith("0x"));
  const connectedAddress                       = address ?? privyEvmWallet?.address ?? null;
  const walletLoading                          = authenticated && !walletsReady && !connectedAddress;
  const prevConnectedAddressRef                = useRef<string | null>(connectedAddress);
  // Ghost session: authenticated but no wallet → clear stale session, re-open full login modal
  const handleWalletAction                     = authenticated
    ? async () => {
        try { await logout(); } catch (e) { console.error("[ghost session] logout failed:", e); }
        login();
      }
    : login;
  const [pushLoading, setPushLoading]          = useState(false);
  // Privy's own useSignMessage, not wagmi's — Privy's docs are explicit that
  // wagmi's version (and its other hooks in general) can bind to the
  // embedded wallet rather than whichever wallet the user actually has
  // active when both are connected; Privy's own hook takes an explicit
  // `address` to sign with the SPECIFIC wallet whose identity is on the line
  // here. Same root issue already found and fixed for chain-switching.
  const { signMessage: signMessageWithWallet } = useSignMessage();
  // Web Push subscription, keyed by the SAME identity /api/chat uses for the
  // sender (wallet if connected, else the persisted anonId) — a watcher
  // registered under that identity looks up this same key to alert. A wallet
  // identity must sign a server-issued challenge first (see
  // /api/notifications/challenge) to prove ownership before the subscribe
  // endpoint accepts it — anonId identities skip this, nothing sensitive to
  // prove there.
  const subscribeToPush = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) return false;
    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!vapidKey) return false;
    setPushLoading(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return false;

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // lib.dom's PushSubscriptionOptionsInit wants Uint8Array<ArrayBuffer> specifically;
        // Uint8Array's own constructor is typed Uint8Array<ArrayBufferLike> as of TS 5.7's
        // stricter BufferSource types. The value is a plain heap-allocated ArrayBuffer at
        // runtime (never SharedArrayBuffer) — this narrows the type, not the behavior.
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as Uint8Array<ArrayBuffer>,
      });

      const identity = (connectedAddress ?? anonId).toLowerCase();
      let signature: string | undefined;
      if (connectedAddress) {
        const challengeUrl = `/api/notifications/challenge?identity=${identity}&endpoint=${encodeURIComponent(subscription.endpoint)}`;
        const challengeRes = await fetch(challengeUrl);
        if (!challengeRes.ok) return false;
        const { message } = await challengeRes.json() as { message: string };
        ({ signature } = await signMessageWithWallet({ message }, { address: connectedAddress }));
      }

      const res = await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity, subscription: subscription.toJSON(), signature }),
      });
      const data = await res.json();
      return !!data.ok;
    } catch (e) {
      // Covers a rejected signature prompt the same as any other subscribe
      // failure — no push subscription without proof of ownership.
      console.error("[push] subscribe failed:", e);
      return false;
    } finally {
      setPushLoading(false);
    }
  }, [connectedAddress, anonId, signMessageWithWallet]);
  const { publicKey: solanaPublicKey }         = useSolanaWallet();
  const solanaAddress                          = solanaPublicKey?.toBase58() ?? null;
  const { data: nativeBal, isLoading: nativeLoading } = useBalance({ address });
  // Clear stale quotes when wallet changes
  useEffect(() => {
    setMessages(prev => prev.filter(m => m.role !== "assistant" || !m.result || m.result.type !== "quote"));
  }, [connectedAddress]);

  // Keep disconnect confirm button in sync with auth state — if Privy logs the
  // user out (e.g. failed SIWE), reset the confirm UI so it doesn't stay red.
  useEffect(() => {
    if (!authenticated) {
      setConfirmDisconnect(false);
      if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
    }
  }, [authenticated]);

  // Auto-retry the last wallet-blocked command when the wallet connects.
  // Reads messages via ref (not state) to avoid side-effects inside updaters.
  useEffect(() => {
    const prev = prevConnectedAddressRef.current;
    prevConnectedAddressRef.current = connectedAddress;
    if (!prev && connectedAddress) {
      const msgs       = messagesRef.current;
      const last       = msgs.at(-1);
      const secondLast = msgs.at(-2);
      if (
        last?.role === "assistant" &&
        last.result?.type === "error" &&
        /wallet|reconnect/i.test(last.result.text) &&
        secondLast?.role === "user"
      ) {
        clearPendingWalletRetry();
        submitRef.current?.(secondLast.text);
      }
    }
  }, [connectedAddress]);

  // Independent recovery path for the case above: if the wallet-connect flow
  // reloaded the page (Privy already reports connected on the very first
  // render), prevConnectedAddressRef initializes to that same value, so the
  // transition-detection effect above never fires. Fall back to the persisted
  // query — runs once per pending entry regardless of any transition.
  const pendingRetryDoneRef = useRef(false);
  useEffect(() => {
    if (pendingRetryDoneRef.current || !connectedAddress) return;
    const pending = readPendingWalletRetry();
    if (pending) {
      pendingRetryDoneRef.current = true;
      clearPendingWalletRetry();
      submitRef.current?.(pending);
    }
  }, [connectedAddress]);
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
  const hasNoFunds = !!address && !balanceLoading &&
    (!nativeBal || nativeBal.value === BigInt(0)) &&
    (!usdcRaw || (usdcRaw as bigint) === BigInt(0));

  useEffect(() => {
    const stored = loadJson<Session[]>("skopos-sessions", []);
    const lastId = localStorage.getItem("skopos-active-session");
    const last   = lastId ? stored.find(s => s.id === lastId) : null;

    if (last) {
      sessionIdRef.current = last.id;
      setActiveId(last.id);
      setMessages(last.messages);
      localStorage.setItem("skopos-active-session", last.id);
    } else {
      const id = crypto.randomUUID();
      sessionIdRef.current = id;
      setActiveId(id);
    }

    setSessions(stored);
    setTxHistory(loadJson("skopos-tx-history", []));
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

  useEffect(() => {
    localStorage.setItem("skopos-llm-tier", llmTier);
  }, [llmTier]);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    const up   = () => setIsOnline(true);
    const down = () => setIsOnline(false);
    window.addEventListener("online",  up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  useEffect(() => {
    let buildId: string | null = null;
    async function check() {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { buildId: id } = await res.json() as { buildId: string };
        if (id === "dev") return;
        if (buildId === null) { buildId = id; return; }
        if (id !== buildId) {
          if (messagesLenRef.current === 0 && !valueRef.current.trim()) { window.location.reload(); return; }
          setUpdateAvailable(true);
        }
      } catch { /* network error — ignore */ }
    }
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, []);

  async function handleDisconnectClick() {
    if (confirmDisconnect) {
      if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
      setConfirmDisconnect(false);
      // Per Privy: injected wallets (MetaMask/Phantom) can't be programmatically
      // disconnected. logout() ends the Privy session — that's "disconnect" here.
      logout().catch(e => console.error("[disconnect] logout failed:", e));
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
    if (!persistJson("skopos-sessions", updated)) {
      persistJson("skopos-sessions", [{ id: sid, title, messages }]);
    }
    try { localStorage.setItem("skopos-active-session", sid); } catch { /* quota — session stays in memory */ }
    setSessions(updated);
  }, [messages]);

  useEffect(() => {
    messagesLenRef.current = messages.length;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, streamingText]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const saveTx = useCallback((record: TxRecord) => {
    setTxHistory(prev => {
      const updated = [record, ...prev.filter(t => t.hash !== record.hash)].slice(0, 15);
      if (!persistJson("skopos-tx-history", updated)) {
        persistJson("skopos-tx-history", updated.slice(0, 5));
      }
      return updated;
    });
  }, []);

  function newChat() {
    const id = crypto.randomUUID();
    sessionIdRef.current = id;
    setActiveId(id);
    setMessages([]);
    localStorage.setItem("skopos-active-session", id);
    setSessions(loadJson("skopos-sessions", []));
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function openSession(s: Session) {
    sessionIdRef.current = s.id;
    setActiveId(s.id);
    setMessages(s.messages);
    localStorage.setItem("skopos-active-session", s.id);
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
    const history = messages.slice(-4).flatMap((m): { role: "user" | "assistant"; content: string }[] => {
      if (m.role === "user") return [{ role: "user", content: m.text }];
      if (m.result.type === "text")  return [{ role: "assistant", content: m.result.text }];
      if (m.result.type === "error") return [{ role: "assistant", content: m.result.text }];
      if (m.result.type === "price") {
        const ch = m.result.change24h != null ? ` (${m.result.change24h >= 0 ? "+" : ""}${m.result.change24h.toFixed(2)}% 24h)` : "";
        return [{ role: "assistant", content: `${m.result.symbol} is $${m.result.price}${ch}.` }];
      }
      if (m.result.type === "quote") {
        const { intent, route } = m.result;
        const fees = route.feesUSD ? `, fees ~$${Number(route.feesUSD).toFixed(4)}` : "";
        return [{ role: "assistant", content: `Quote: ${intent.from.amount} ${intent.from.token} from ${intent.from.chain} → ${intent.to.chain} via ${route.tool}. Output: ~${route.outputAmount} ${intent.to.token}${fees}.` }];
      }
      if (m.result.type === "rebalance") {
        const legs = m.result.legs.filter(l => l.type === "quote") as QuoteResult[];
        const summary = legs.map(l => `${l.intent.from.amount} ${l.intent.from.token} from ${l.intent.from.chain} → ~${l.route.outputAmount} ${l.intent.to.token} via ${l.route.tool}`).join("; ");
        return [{ role: "assistant", content: `Rebalance: ${summary}` }];
      }
      if (m.result.type === "address") {
        return [{ role: "assistant", content: "[Wallet portfolio was shown]" }];
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
        body: JSON.stringify({ message: text, senderAddress: connectedAddress, solanaAddress, history, slippage, llmTier, anonId }),
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

        // Drip one word unit (word + trailing whitespace) every 40ms
        const drip = setInterval(() => {
          if (abort.signal.aborted) { clearInterval(drip); dripRef.current = null; return; }
          if (!buf.text) return;
          // Match a word with trailing whitespace, or flush pure whitespace
          const match = buf.text.match(/^(\S+\s*|\s+)/);
          if (!match) return;
          buf.text = buf.text.slice(match[1].length);
          displayed += match[1];
          setStreamingText(displayed);
        }, 40);
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
        if (data.type === "error" && /wallet|reconnect/i.test(data.text)) {
          savePendingWalletRetry(text);
        } else {
          clearPendingWalletRetry();
        }
        setMessages(prev => [...prev, { role: "assistant", result: data }]);
        setLoading(false);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setMessages(prev => [...prev, { role: "assistant", result: { type: "error", text: "Network error — check your internet connection." } }]);
      setLoading(false);
    }
  }
  // Keep submitRef current every render so the auto-retry effect always calls the latest closure
  submitRef.current = submit;

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
    <>
    <Suspense>
      <AutoSubmit onSubmit={submit} />
    </Suspense>
    <main style={{ position: "relative", height: "100vh", width: "100vw", background: T.bg, display: "flex", overflow: "hidden" }}>

      {/* ── Offline banner ─────────────────────────────────────────────────── */}
      {!isOnline && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
          background: "#ef4444", color: "#fff", textAlign: "center",
          padding: "8px 16px", fontSize: "0.8rem", fontFamily: "var(--font-jetbrains-mono), monospace",
          letterSpacing: "0.04em",
        }}>
          ● {t("banners.offline")}
        </div>
      )}

      {/* ── Update available banner ─────────────────────────────────────────── */}
      {updateAvailable && (
        <div style={{
          position: "fixed", bottom: 80, left: "50%", transform: "translateX(-50%)",
          zIndex: 9999, background: "rgba(245,184,0,0.12)", backdropFilter: "blur(12px)",
          border: "1px solid rgba(245,184,0,0.35)", borderRadius: 10,
          display: "flex", alignItems: "center", gap: 12,
          padding: "10px 16px", fontSize: "0.78rem",
          fontFamily: "var(--font-jetbrains-mono), monospace",
          color: "rgba(245,184,0,0.9)", whiteSpace: "nowrap",
        }}>
          <span>{t("banners.updateAvailable")}</span>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "#F5B800", color: "#000", border: "none", borderRadius: 6,
              padding: "4px 12px", fontSize: "0.75rem", cursor: "pointer",
              fontFamily: "var(--font-jetbrains-mono), monospace", fontWeight: 600,
            }}
          >
            {t("banners.refresh")}
          </button>
          <button
            onClick={() => setUpdateAvailable(false)}
            style={{ background: "none", border: "none", color: "rgba(245,184,0,0.5)", cursor: "pointer", fontSize: "1rem", lineHeight: 1, padding: 0 }}
          >
            ×
          </button>
        </div>
      )}

      {/* Mobile sidebar overlay backdrop */}
      {isMobile && sidebarExpanded && (
        <div
          onClick={() => setSidebarExpanded(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 9 }}
        />
      )}

      {/* Collapsible nav rail */}
      <aside className={`sidebar-rail${sidebarExpanded ? " sidebar-open" : ""}`} style={{
        width: isMobile ? (sidebarExpanded ? "min(300px, 88vw)" : 0) : (sidebarExpanded ? 240 : 52),
        minWidth: isMobile ? (sidebarExpanded ? "min(300px, 88vw)" : 0) : (sidebarExpanded ? 240 : 52),
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

        {/* Header: toggle + logo */}
        <div style={{ height: 52, display: "flex", alignItems: "center", paddingLeft: 8, paddingRight: 8, flexShrink: 0, gap: 2 }}>
          {/* Collapse / expand toggle — always visible at top left */}
          <button
            onClick={() => setSidebarExpanded(v => !v)}
            title={sidebarExpanded ? "Collapse" : "Expand"}
            style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", color: "var(--drawer-action)", cursor: "pointer" }}
          >
            <svg width="15" height="12" viewBox="0 0 15 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="0.5" y1="1" x2="14.5" y2="1"/>
              <line x1="0.5" y1="6" x2="14.5" y2="6"/>
              <line x1="0.5" y1="11" x2="14.5" y2="11"/>
            </svg>
          </button>
          <span style={{ ...BEBAS, fontSize: "1rem", letterSpacing: "0.06em", color: T.textPrimary, whiteSpace: "nowrap", paddingLeft: 6, flex: 1, opacity: sidebarExpanded ? 1 : 0, transition: "opacity 0.12s" }}>
            SKOP<span style={{ color: "#F5B800" }}>OS</span>
          </span>
        </div>

        {/* New chat */}
        <div style={{ paddingLeft: 8, paddingRight: 8, paddingBottom: 8, flexShrink: 0 }}>
          <button onClick={newChat} style={{ width: "100%", height: 36, borderRadius: 8, display: "flex", alignItems: "center", paddingLeft: 10, gap: 10, border: "none", background: "none", color: "var(--drawer-action)", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden" }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0 }}><path d="M8 3v10M3 8h10"/></svg>
            <span style={{ ...MONO, fontSize: "0.72rem", opacity: sidebarExpanded ? 1 : 0, transition: "opacity 0.12s" }}>{t("sidebar.newChat")}</span>
          </button>
        </div>

        {/* Nav sections — fade in when expanded */}
        <div style={{ flex: 1, overflowY: "auto", scrollbarWidth: "none", opacity: sidebarExpanded ? 1 : 0, transition: "opacity 0.1s", pointerEvents: sidebarExpanded ? "auto" : "none" }}>
          {recentSessions.length > 0 && (
            <DrawerSection label={t("sidebar.recents")}>
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
            <DrawerSection label={t("sidebar.history")}>
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
          <DrawerSection label={t("sidebar.portfolio")}>
            <DrawerAction label={t("sidebar.myBalances")} onClick={() => submit("show my portfolio")} />
          </DrawerSection>
          <DrawerSection label={t("sidebar.bridge")}>
            {BRIDGE_ACTIONS.map(({ key, prompt }) => (
              <DrawerAction key={key} label={t(`bridgeActions.${key}`)} onClick={() => submit(prompt)} />
            ))}
          </DrawerSection>
          <DrawerSection label={t("sidebar.swap")}>
            {SWAP_ACTIONS.map(({ key, prompt }) => (
              <DrawerAction key={key} label={t(`swapActions.${key}`)} onClick={() => submit(prompt)} />
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
                <span style={{ ...MONO, fontSize: "0.62rem", color: "rgba(245,184,0,0.75)", letterSpacing: "0.08em" }}>{t("wallet.eyebrow")}</span>
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
                    <p style={{ ...MONO, fontSize: "0.68rem", color: T.textFaint, margin: "0 0 10px" }}>{t("wallet.noAssets")}</p>
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
                {t("wallet.fundWallet")}
              </button>
            </div>
          )}

          {/* ── Connect Wallet CTA (no address: unauthenticated OR authenticated but wallet not ready) ── */}
          {ready && !connectedAddress && sidebarExpanded && (
            <button
              onClick={walletLoading ? undefined : handleWalletAction}
              style={{
                ...MONO, width: "100%", marginBottom: 8, padding: "10px 0",
                fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.05em",
                color: "#000", background: walletLoading ? "rgba(245,184,0,0.55)" : "#F5B800",
                border: "none", borderRadius: 10, cursor: walletLoading ? "wait" : "pointer",
              }}
            >
              {walletLoading ? t("wallet.connecting") : t("wallet.connect")}
            </button>
          )}

          {/* Collapsed wallet dot */}
          {ready && !sidebarExpanded && (
            <button
              onClick={walletLoading ? undefined : (authenticated && connectedAddress ? handleDisconnectClick : handleWalletAction)}
              style={{ width: "100%", height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: walletLoading ? "wait" : "pointer" }}
              title={authenticated && connectedAddress ? (confirmDisconnect ? t("wallet.clickAgainDisconnect") : t("wallet.addressDisconnect", { address: shortAddr(connectedAddress) })) : walletLoading ? t("wallet.connecting") : t("wallet.connectLower")}
            >
              <div style={{ width: 8, height: 8, borderRadius: 999, background: confirmDisconnect ? "#ff6b6b" : (authenticated && connectedAddress) ? "#F5B800" : walletLoading ? "rgba(245,184,0,0.4)" : T.textFaint }} className={walletLoading ? "animate-pulse" : undefined} />
            </button>
          )}

          {/* Expanded address chip */}
          {ready && connectedAddress && sidebarExpanded && (
            <button
              onClick={handleDisconnectClick}
              style={{ width: "100%", height: 32, borderRadius: 8, display: "flex", alignItems: "center", paddingLeft: 10, gap: 8, background: confirmDisconnect ? "rgba(255,107,107,0.06)" : "none", border: confirmDisconnect ? "1px solid rgba(255,107,107,0.2)" : "none", cursor: "pointer", transition: "background 0.2s" }}
              title={confirmDisconnect ? t("wallet.clickAgainConfirm") : t("wallet.addressClickDisconnect", { address: shortAddr(connectedAddress) })}
            >
              <div style={{ width: 7, height: 7, borderRadius: 999, background: confirmDisconnect ? "#ff6b6b" : "#F5B800", flexShrink: 0, transition: "background 0.2s" }} />
              <span style={{ ...MONO, fontSize: "0.68rem", color: confirmDisconnect ? "#ff6b6b" : T.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", transition: "color 0.2s" }}>
                {confirmDisconnect ? t("wallet.disconnectConfirm") : shortAddr(connectedAddress)}
              </span>
            </button>
          )}

          {/* Connect a different wallet — opt-in escape hatch from the embedded-first default */}
          {ready && connectedAddress && sidebarExpanded && (
            <button
              onClick={() => connectWallet()}
              title={t("wallet.connectDifferent")}
              style={{
                ...MONO, width: "100%", height: 28, marginBottom: 2, borderRadius: 8,
                display: "flex", alignItems: "center", paddingLeft: 10, gap: 8,
                background: "none", border: "none", cursor: "pointer", color: T.textFaint,
                fontSize: "0.64rem", whiteSpace: "nowrap",
              }}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0 }}><path d="M6 1v10M1 6h10"/></svg>
              {t("wallet.connectAnother")}
            </button>
          )}

          {/* GitHub */}
          <a href="https://github.com/Svector-anu/skopos" target="_blank" rel="noopener noreferrer"
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
            <span style={{ ...MONO, fontSize: "0.72rem", opacity: sidebarExpanded ? 1 : 0, transition: "opacity 0.12s" }}>{t("theme")}</span>
          </button>

        </div>
      </aside>

      {/* Main canvas */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", position: "relative", zIndex: 1 }}>

        {/* Mobile top bar */}
        {isMobile && (
          <div style={{ height: 56, flexShrink: 0, display: "flex", alignItems: "center", paddingLeft: 12, paddingRight: 12, gap: 8 }}>
            {/* Circular hamburger */}
            <button onClick={() => setSidebarExpanded(true)} style={{
              width: 40, height: 40, borderRadius: 999, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: `1.5px solid ${T.borderStrong}`,
              color: T.textMuted, cursor: "pointer",
            }}>
              <svg width="15" height="11" viewBox="0 0 15 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <line x1="0.5" y1="1" x2="14.5" y2="1"/>
                <line x1="0.5" y1="5.5" x2="14.5" y2="5.5"/>
                <line x1="0.5" y1="10" x2="14.5" y2="10"/>
              </svg>
            </button>

            {/* Centered title + subtitle */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
              <span style={{ fontFamily: "var(--font-display), serif", fontSize: "1.1rem", fontWeight: 700, letterSpacing: "0.07em", color: T.textPrimary, lineHeight: 1 }}>
                SKOP<span style={{ color: "#F5B800" }}>OS</span>
              </span>
              <span style={{ ...MONO, fontSize: "0.58rem", color: T.textDim, letterSpacing: "0.04em" }}>{t("mobileSubtitle")}</span>
            </div>

            {/* Circular wallet / connect button */}
            {ready && (
              <button
                onClick={walletLoading ? undefined : (authenticated && connectedAddress ? handleDisconnectClick : handleWalletAction)}
                style={{
                  width: 40, height: 40, borderRadius: 999, flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: confirmDisconnect ? "rgba(255,107,107,0.08)" : (authenticated && connectedAddress) ? "rgba(245,184,0,0.08)" : "none",
                  border: confirmDisconnect ? "1.5px solid rgba(255,107,107,0.35)" : (authenticated && connectedAddress) ? "1.5px solid rgba(245,184,0,0.35)" : `1.5px solid ${T.borderStrong}`,
                  cursor: walletLoading ? "wait" : "pointer", transition: "background 0.2s, border-color 0.2s",
                }}
              >
                {walletLoading ? (
                  <div style={{ width: 9, height: 9, borderRadius: 999, background: "rgba(245,184,0,0.4)" }} className="animate-pulse" />
                ) : authenticated && connectedAddress ? (
                  <div style={{ width: 9, height: 9, borderRadius: 999, background: confirmDisconnect ? "#ff6b6b" : "#F5B800" }} />
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={T.textMuted} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 12V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2"/>
                    <path d="M16 8h6v8h-6a3 3 0 0 1 0-6Z"/>
                  </svg>
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
                        {hasNoFunds && (
                          <div style={{ background: "rgba(245,184,0,0.06)", border: "1px solid rgba(245,184,0,0.2)", borderRadius: 10, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                            <span style={{ ...MONO, fontSize: "0.74rem", color: T.textMuted }}>{t("noFundsDetected")}</span>
                            <button
                              onClick={() => fundWallet({ address })}
                              style={{ ...MONO, fontSize: "0.7rem", fontWeight: 700, background: "#F5B800", color: "#000", border: "none", borderRadius: 7, padding: "6px 14px", cursor: "pointer", whiteSpace: "nowrap" }}
                            >
                              {t("fundWalletArrow")}
                            </button>
                          </div>
                        )}
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
                        {msg.result.analysis && (
                          <p style={{ ...MONO, fontSize: "0.68rem", color: T.textMuted, lineHeight: 1.7, margin: "8px 0 0" }}>
                            {msg.result.analysis}
                          </p>
                        )}
                        <ErrorBoundary label={t("errorBoundary.quote")}>
                          <QuoteDisplay
                            result={msg.result} connectedAddress={connectedAddress} onTxSubmitted={saveTx} slippage={slippage}
                            onSlippageChange={setSlippage}
                            onResultUpdate={(patch) => setMessages(prev => prev.map((m, j) =>
                              j === i && m.role === "assistant" ? { role: "assistant", result: { ...m.result, ...patch } as AssistantResult } : m
                            ))}
                            onRefresh={async (slippageOverride?: number) => {
                              const origin = (msg.result as QuoteResult).originMessage;
                              if (!origin) return;
                              try {
                                const res = await fetch("/api/chat", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                 body: JSON.stringify({ message: origin, senderAddress: connectedAddress, solanaAddress, history: [], slippage: slippageOverride ?? slippage, llmTier, anonId }),                                });
                                const data: AssistantResult = await res.json();
                                if (data.type === "quote") data.originMessage = origin;
                                setMessages(prev => prev.map((m, j) =>
                                  j === i ? { role: "assistant", result: data } : m
                                ));
                              } catch { /* silent — QuoteDisplay will reset isRefreshing */ }
                            }}
                            onRevalidate={async () => {
                              const origin = (msg.result as QuoteResult).originMessage;
                              if (!origin) return msg.result as QuoteResult;
                              try {
                                const res = await fetch("/api/chat", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ message: origin, senderAddress: connectedAddress, solanaAddress, history: [], slippage, llmTier, anonId }),
                                });
                                const data: AssistantResult = await res.json();
                                if (data.type === "quote") {
                                  data.originMessage = origin;
                                  setMessages(prev => prev.map((m, j) => j === i ? { role: "assistant", result: data } : m));
                                  return data as QuoteResult;
                                }
                                // Guard fired (REVERTED) or any non-quote → swap the card for it, signal abort.
                                setMessages(prev => prev.map((m, j) => j === i ? { role: "assistant", result: data } : m));
                                return null;
                              } catch {
                                // Network error re-checking — don't block a quote the user already holds.
                                return msg.result as QuoteResult;
                              }
                            }}
                          />
                        </ErrorBoundary>
                      </div>
                    )}
                    {msg.result.type === "rebalance" && (
                      <ErrorBoundary label={t("errorBoundary.rebalance")}>
                        {hasNoFunds && (
                          <div style={{ background: "rgba(245,184,0,0.06)", border: "1px solid rgba(245,184,0,0.2)", borderRadius: 10, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
                            <span style={{ ...MONO, fontSize: "0.74rem", color: T.textMuted }}>{t("noFundsDetected")}</span>
                            <button
                              onClick={() => fundWallet({ address })}
                              style={{ ...MONO, fontSize: "0.7rem", fontWeight: 700, background: "#F5B800", color: "#000", border: "none", borderRadius: 7, padding: "6px 14px", cursor: "pointer", whiteSpace: "nowrap" }}
                            >
                              {t("fundWalletArrow")}
                            </button>
                          </div>
                        )}
                  <RebalanceDisplay
                    result={msg.result} connectedAddress={connectedAddress} onTxSubmitted={saveTx} slippage={slippage}
                    onSlippageChange={setSlippage}
                    onLegRefresh={async (legIndex: number, slippageOverride?: number) => {
                      const leg = (msg.result as RebalanceResult).legs[legIndex];
                      if (leg.type !== "quote" || !leg.originMessage) return;
                      const origin = leg.originMessage;
                      try {
                        const res = await fetch("/api/chat", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ message: origin, senderAddress: connectedAddress, solanaAddress, history: [], slippage: slippageOverride ?? slippage, llmTier, anonId }),
                        });
                        const data: AssistantResult = await res.json();
                        if (data.type === "quote") data.originMessage = origin;
                        setMessages(prev => prev.map((m, j) => {
                          if (j !== i || m.role !== "assistant" || m.result.type !== "rebalance") return m;
                          return { role: "assistant", result: { ...m.result, legs: m.result.legs.map((l, k) => k === legIndex ? (data as QuoteResult) : l) } };
                        }));
                      } catch { /* silent — QuoteDisplay resets isRefreshing */ }
                    }}
                    onLegRevalidate={async (legIndex: number) => {
                      const leg = (msg.result as RebalanceResult).legs[legIndex];
                      if (leg.type !== "quote" || !leg.originMessage) return leg.type === "quote" ? leg : null;
                      const origin = leg.originMessage;
                      try {
                        const res = await fetch("/api/chat", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ message: origin, senderAddress: connectedAddress, solanaAddress, history: [], slippage, llmTier, anonId }),
                        });
                        const data: AssistantResult = await res.json();
                        if (data.type === "quote") {
                          data.originMessage = origin;
                          setMessages(prev => prev.map((m, j) => {
                            if (j !== i || m.role !== "assistant" || m.result.type !== "rebalance") return m;
                            return { role: "assistant", result: { ...m.result, legs: m.result.legs.map((l, k) => k === legIndex ? (data as QuoteResult) : l) } };
                          }));
                          return data as QuoteResult;
                        }
                        // Guard fired (REVERTED) or any non-quote → abort this leg.
                        return null;
                      } catch {
                        // Network error re-checking — don't block a quote the user already holds.
                        return leg;
                      }
                    }}
                  />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "tx" && (
                      <ErrorBoundary label={t("errorBoundary.tx")}>
                        <TxDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "pay" && (
                      <ErrorBoundary label={t("errorBoundary.pay")}>
                        <PayDisplay result={msg.result} onTxSubmitted={saveTx} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "payments" && (
                      <ErrorBoundary label={t("errorBoundary.payments")}>
                        <PaymentsDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "address" && (
                      <ErrorBoundary label={t("errorBoundary.address")}>
                        <AddressDisplay result={msg.result} onSwap={prompt => submit(prompt)} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "token_risk" && (
                      <ErrorBoundary label={t("errorBoundary.tokenRisk")}>
                        <TokenRiskDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "token_risk" && msg.result.stockPaired && (
                      <ErrorBoundary label={t("errorBoundary.stockPaired")}>
                        <StockPairedDisplay result={{ type: "stock_paired", mode: "single", heading: "", note: "", items: [msg.result.stockPaired] }} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "prebuy" && (
                      <ErrorBoundary label={t("errorBoundary.prebuy")}>
                        <PrebuyDisplay result={msg.result} connectedAddress={connectedAddress} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "prebuy" && msg.result.stockPaired && (
                      <ErrorBoundary label={t("errorBoundary.stockPaired")}>
                        <StockPairedDisplay result={{ type: "stock_paired", mode: "single", heading: "", note: "", items: [msg.result.stockPaired] }} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "yield_pools" && (
                      <ErrorBoundary label={t("errorBoundary.yieldPools")}>
                        <YieldPoolsDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "polymarket" && (
                      <ErrorBoundary label={t("errorBoundary.polymarket")}>
                        <PolymarketDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "suggestions" && (
                      <SuggestionsDisplay result={msg.result} onSelect={(cmd: string) => submit(cmd)} />
                    )}
                    {msg.result.type === "intel" && (
                      <ErrorBoundary label={t("errorBoundary.intel")}>
                        <IntelDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "aeon" && (
                      <ErrorBoundary label={t("errorBoundary.aeon")}>
                        <AeonDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "x402check" && (
                      <ErrorBoundary label={t("errorBoundary.x402check")}>
                        <X402CheckDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "robinhood_launches" && (
                      <ErrorBoundary label={t("errorBoundary.robinhoodLaunches")}>
                        <RobinhoodLaunchesDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "stock_paired" && (
                      <ErrorBoundary label={t("errorBoundary.stockPaired")}>
                        <StockPairedDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "approval_scan" && (
                      <ErrorBoundary label={t("errorBoundary.approvalScan")}>
                        <ApprovalScanDisplay result={msg.result} onTxSubmitted={saveTx} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "flash_orders" && (
                      <ErrorBoundary label={t("errorBoundary.flashOrders")}>
                        <FlashOrdersDisplay result={msg.result} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "paywall" && (
                      <ErrorBoundary label={t("errorBoundary.paywall")}>
                        <PaywallDisplay
                          result={msg.result}
                          onConnect={handleWalletAction}
                          onSwitchToFast={() => setLlmTier("fast")}
                        />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "price" && (
                      <ErrorBoundary label={t("errorBoundary.price")}>
                        <PriceDisplay result={msg.result} onSubmit={(text) => submit(text)} />
                      </ErrorBoundary>
                    )}
                    {msg.result.type === "text" && (
                      <AeonMarkdown text={msg.result.text} accent="#F5B800" />
                    )}
                    {msg.result.type === "error" && (
                      /enable.*(?:alerts|notifications)/i.test(msg.result.text) ? (
                        <div style={{ background: isDark ? "rgba(245,184,0,0.04)" : "rgba(245,184,0,0.07)", border: "1px solid rgba(245,184,0,0.18)", borderRadius: 14, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14, maxWidth: 360 }}>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                            <div style={{ width: 30, height: 30, borderRadius: 8, background: "rgba(245,184,0,0.1)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(245,184,0,0.85)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                              </svg>
                            </div>
                            <div>
                              <p style={{ ...MONO, fontSize: "0.68rem", color: "rgba(245,184,0,0.7)", letterSpacing: "0.07em", margin: "0 0 5px" }}>{t("alerts.eyebrow")}</p>
                              <p style={{ ...MONO, fontSize: "0.82rem", color: T.textMuted, margin: 0, lineHeight: 1.55 }}>{msg.result.text}</p>
                            </div>
                          </div>
                          <button
                            onClick={async () => {
                              const ok = await subscribeToPush();
                              setMessages(prev => [...prev, {
                                role: "assistant",
                                result: { type: "text", text: ok ? t("alerts.enabled") : t("alerts.enableFailed") },
                              }]);
                            }}
                            style={{ ...MONO, width: "100%", padding: "9px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.04em", color: "#000", background: "#F5B800", border: "none", borderRadius: 9, cursor: "pointer" }}
                          >
                            {pushLoading ? t("alerts.enabling") : t("alerts.enableButton")}
                          </button>
                        </div>
                      ) : /wallet|reconnect/i.test(msg.result.text) ? (
                        <div style={{ background: isDark ? "rgba(245,184,0,0.04)" : "rgba(245,184,0,0.07)", border: "1px solid rgba(245,184,0,0.18)", borderRadius: 14, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14, maxWidth: 360 }}>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                            <div style={{ width: 30, height: 30, borderRadius: 8, background: "rgba(245,184,0,0.1)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(245,184,0,0.85)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="2" y="6" width="20" height="14" rx="2"/><path d="M16 14h2"/><path d="M2 10h20"/>
                              </svg>
                            </div>
                            <div>
                              <p style={{ ...MONO, fontSize: "0.68rem", color: "rgba(245,184,0,0.7)", letterSpacing: "0.07em", margin: "0 0 5px" }}>{t("wallet.eyebrow")}</p>
                              <p style={{ ...MONO, fontSize: "0.82rem", color: T.textMuted, margin: 0, lineHeight: 1.55 }}>{msg.result.text}</p>
                            </div>
                          </div>
                          <button
                            onClick={handleWalletAction}
                            style={{ ...MONO, width: "100%", padding: "9px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.04em", color: "#000", background: "#F5B800", border: "none", borderRadius: 9, cursor: "pointer" }}
                          >
                            {walletLoading ? t("wallet.connecting") : t("wallet.connect")}
                          </button>
                        </div>
                      ) : (
                        <p style={{ ...MONO, fontSize: "0.875rem", lineHeight: 1.75, color: "#ff5555", margin: 0 }}>
                          {msg.result.text}
                        </p>
                      )
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
                        {t("sendFeedback")}
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
                  {t.rich("greeting", { brand: (chunks) => <span style={{ color: "#F5B800", fontWeight: 600 }}>{chunks}</span> })}
                </p>
                <p style={{ ...MONO, fontSize: "0.82rem", color: T.textDim, marginTop: 10, marginBottom: 0 }}>
                  {t("greetingSubtitle")}
                </p>
              </>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: isMobile ? 20 : 0, maxWidth: 520 }}>
              {EXAMPLE_PROMPTS.map(p => (
                <button
                  key={p.key}
                  onClick={() => submit(p.prompt)}
                  style={{ ...MONO, padding: "6px 14px", fontSize: "0.7rem", background: T.surface, border: `1px solid ${T.borderStrong}`, borderRadius: 999, color: T.textDim, cursor: "pointer", whiteSpace: "nowrap", transition: "border-color 0.15s, color 0.15s" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(245,184,0,0.3)"; e.currentTarget.style.color = "rgba(245,184,0,0.7)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.color = T.textDim; }}
                >
                  {t(`examplePrompts.${p.key}`)}
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
                  placeholder={isOnline ? t("composerPlaceholder") : t("composerPlaceholderOffline")}
                  disabled={!isOnline}
                  className={isDark ? "placeholder:text-white/15" : "placeholder:text-black/20"}
                  style={{ ...MONO, width: "100%", background: "none", border: "none", outline: "none", color: T.textPrimary, caretColor: T.textPrimary, fontSize: "0.95rem", opacity: isOnline ? 1 : 0.4 }}
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
                            if (pill.soon) {
                              setHorizonToast(pill.label);
                              setTimeout(() => setHorizonToast(null), 2000);
                            }
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
                          ◆ {t(`horizonPills.${pill.key}`)}{pill.soon && <span style={{ opacity: 0.55, marginLeft: 4 }}>{t("soonSuffix")}</span>}
                        </button>
                      ))}
                    </div>
                    {/* Fade mask on right */}
                    <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 24, background: T.fadeMask, pointerEvents: "none" }} />
                  </div>
                  {/* Toast */}
                  {horizonToast && (
                    <span style={{ ...MONO, fontSize: "0.58rem", color: "rgba(245,184,0,0.5)", whiteSpace: "nowrap", flexShrink: 0 }}>
                      {t("soonToast")}
                    </span>
                  )}
                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      onClick={() => setTierMenuOpen(o => !o)}
                      title={t("tier.chooseResponseTier")}
                      style={{
                        ...MONO, fontSize: "0.6rem", padding: "3px 8px", borderRadius: 4, whiteSpace: "nowrap",
                        display: "flex", alignItems: "center", gap: 4,
                        border: "1px solid rgba(245,184,0,0.35)",
                        background: "rgba(245,184,0,0.06)",
                        color: "rgba(245,184,0,0.85)",
                        cursor: "pointer",
                      }}
                    >
                      {t(llmTier === "smart" ? "tiers.smart.label" : "tiers.fast.label")}
                      <span style={{ fontSize: "0.5rem", opacity: 0.7, transform: tierMenuOpen ? "rotate(180deg)" : "none" }}>▾</span>
                    </button>
                    {tierMenuOpen && (
                      <>
                        <div
                          onClick={() => setTierMenuOpen(false)}
                          style={{ position: "fixed", inset: 0, zIndex: 40 }}
                        />
                        <div
                          role="listbox"
                          style={{
                            position: "absolute", bottom: "calc(100% + 6px)", right: 0, zIndex: 41,
                            minWidth: 188, padding: 4, borderRadius: 8,
                            background: T.bg, border: `1px solid ${T.borderStrong}`,
                            boxShadow: "0 8px 28px rgba(0,0,0,0.45)",
                          }}
                        >
                          {TIER_OPTIONS.map(opt => {
                            const active = llmTier === opt.id;
                            return (
                              <button
                                key={opt.id}
                                type="button"
                                role="option"
                                aria-selected={active}
                                onClick={() => { setLlmTier(opt.id); setTierMenuOpen(false); }}
                                style={{
                                  ...MONO, display: "flex", alignItems: "flex-start", gap: 8, width: "100%",
                                  textAlign: "left", padding: "7px 9px", borderRadius: 5, border: "none",
                                  background: active ? "rgba(245,184,0,0.08)" : "transparent",
                                  cursor: "pointer",
                                }}
                              >
                                <span style={{ flex: 1 }}>
                                  <span style={{ display: "block", fontSize: "0.66rem", color: active ? "rgba(245,184,0,0.9)" : T.textDim }}>
                                    {t(`tiers.${opt.key}.label`)}
                                  </span>
                                  <span style={{ display: "block", fontSize: "0.55rem", color: T.textFaint, marginTop: 2 }}>
                                    {t(`tiers.${opt.key}.desc`)}
                                  </span>
                                </span>
                                {active && <span style={{ fontSize: "0.66rem", color: "rgba(245,184,0,0.9)", lineHeight: "0.66rem" }}>✓</span>}
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                  <button
                    type="submit"
                    disabled={!value.trim() || loading || !isOnline}
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
              {t("aiDisclaimer")}
            </p>
          </div>
        </div>
      </div>
    </main>
    <WhatsNewToast
      storageKey="skopos-whatsnew-v4"
      changes={[
        t("whatsNew.aeonReads"),
        t("whatsNew.txFlags"),
        t("whatsNew.cleanerReplies"),
      ]}
    />
    </>
  );
}

// ─── FeatureCarousel ──────────────────────────────────────────────────────────

// ─── AutoSubmit ───────────────────────────────────────────────────────────────

function AutoSubmit({ onSubmit }: { onSubmit: (q: string) => void }) {
  const searchParams = useSearchParams();
  // Hold the latest onSubmit in a ref so it isn't an effect dependency — otherwise
  // the effect re-runs on every render (onSubmit is recreated each render).
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    const q = searchParams.get("q");
    if (!q) return;
    fired.current = true;
    // Defer a tick so app state is initialised. Deliberately NO cleanup: a
    // re-render within the delay (Privy/wallet init on prod/mobile) must not cancel
    // the pending submit — that was the bug that stopped the ?q= handoff firing.
    setTimeout(() => onSubmitRef.current(q), 150);
  }, [searchParams]);

  return null;
}

// ─── FeatureCarousel ──────────────────────────────────────────────────────────

function FeatureCarousel({ slide, setSlide }: { slide: number; setSlide: (i: number) => void }) {
  const t = useTranslations("app.featureSlides");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const cards = FEATURE_SLIDES[slide];

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        {cards.map(card => (
          <div key={card.key} style={{
            flex: 1, background: "var(--recent-active-bg)",
            border: "1px solid var(--drawer-label)",
            borderRadius: 14, padding: "16px",
          }}>
            <div style={{ color: "var(--drawer-action)", marginBottom: 12 }}>{card.icon}</div>
            <p style={{ ...MONO, fontSize: "0.75rem", color: "var(--drawer-action-hover)", margin: 0 }}>{t(`${card.key}.label`)}</p>
            <p style={{ ...MONO, fontSize: "0.63rem", color: "var(--drawer-action)", marginTop: 3 }}>{t(`${card.key}.sub`)}</p>
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

// ─── ChainLogo ────────────────────────────────────────────────────────────────

const SOLANA_CHAIN_ID = 1000000001;

function ChainLogo({ chainId, size = 48 }: { chainId: number; size?: number }) {
  const [err, setErr] = useState(false);
  const src = chainId === SOLANA_CHAIN_ID
    ? "https://icons.llamao.fi/icons/chains/rsz_solana?w=64&h=64"
    : `https://assets.relay.link/icons/${chainId}/light.png`;

  if (err) {
    const hue = (chainId * 137) % 360;
    return (
      <div style={{ width: size, height: size, borderRadius: 999, background: `hsl(${hue}, 55%, 38%)`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <span style={{ fontFamily: "var(--font-jetbrains-mono)", fontSize: size * 0.32, color: "#fff", fontWeight: 700 }}>
          {String(chainId).slice(-2)}
        </span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" width={size} height={size}
      style={{ borderRadius: 999, display: "block", flexShrink: 0 }}
      onError={() => setErr(true)}
    />
  );
}

// ─── QuoteDisplay ─────────────────────────────────────────────────────────────

const QUOTE_TTL = 30;

function QuoteDisplay({ result, connectedAddress, onTxSubmitted, onRefresh, onRevalidate, onSlippageChange, onResultUpdate, slippage = 0.005 }: {
  result: QuoteResult;
  connectedAddress: string | null;
  onTxSubmitted?: (r: TxRecord) => void;
  onRefresh?: (slippageOverride?: number) => Promise<void>;
  onRevalidate?: () => Promise<QuoteResult | null>;
  onSlippageChange?: (v: number) => void;
  // Persists a completion patch (FlashLegInfo.completedOrderId /
  // RelayLegInfo.completedTxHash) into the actual chat message, not just
  // this component's local state, so the success view survives a reload.
  onResultUpdate?: (patch: Partial<QuoteResult>) => void;
  slippage?: number;
}) {
  const t = useTranslations("app.quote");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { address }                  = useAccount();
  const { wallets }                  = useWallets();
  const { login, authenticated }     = usePrivy();
  const { intent, route, calldata, approval } = result;
  const originChainId = intent.from.chainId;
  const destChainId   = intent.to.chainId;
  // Only when the ORIGIN is Solana does Phantom sign the source tx. EVM→Solana is
  // signed on the EVM side (the Solana address is just the destination), so it must
  // use the normal EVM execute path, not the Phantom-signing button.
  const isSolanaOrigin    = originChainId === SOLANA_CHAIN_ID;
  // Checked separately from (and takes priority over) isRobinhoodOrigin below:
  // a Relay leg moving funds OFF Robinhood Chain also has originChainId ===
  // ROBINHOOD_CHAIN_ID, but it's a plain multi-step tx sequence, not a Flash
  // same-chain swap — result.relay (not the chain ID alone) is the real signal.
  const isRelayLeg        = !!result.relay;
  const isRobinhoodOrigin = !isRelayLeg && originChainId === ROBINHOOD_CHAIN_ID;
  const isSwap        = originChainId === destChainId;

  // Track the real MetaMask chain via window.ethereum — wagmi's useChainId() reads
  // Privy's embedded wallet (chain 1) which diverges from the external wallet's chain.
  const [providerChainId, setProviderChainId] = useState<number | null>(null);
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eth = (window as any).ethereum;
    if (!eth) return;
    const onChainChanged = (hex: string) => setProviderChainId(parseInt(hex, 16));
    void (eth.request({ method: "eth_chainId" }) as Promise<string>).then(onChainChanged);
    eth.on("chainChanged", onChainChanged);
    return () => eth.removeListener("chainChanged", onChainChanged);
  }, []);

  // Privy's own documented method (switches embedded wallets silently,
  // prompts external ones) — same pattern already proven correct in the
  // Smart-tier payment flow. Not wagmi's useSwitchChain: that hook binds to
  // Privy's embedded wallet specifically, which is exactly the divergence
  // the providerChainId tracking above exists to work around.
  async function switchToChain(chainId: number) {
    const evmWallet = wallets.find(w => w.address?.startsWith("0x"));
    if (!evmWallet) throw new Error("No EVM wallet connected.");
    await evmWallet.switchChain(chainId);
  }
  const onCorrectChain = providerChainId === null ? true : providerChainId === originChainId;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: approval?.tokenAddress as `0x${string}` | undefined,
    abi: ERC20_ABI, functionName: "allowance", chainId: originChainId,
    args: address && approval ? [address, approval.spender as `0x${string}`] : undefined,
    query: { enabled: !!address && !!approval },
  });

  const needsApproval = !!approval && (allowance === undefined || BigInt(allowance as bigint) < BigInt(approval.amount));

  const { mutateAsync: writeContract, isPending: isApproving } = useWriteContract();
  const [approvalHash, setApprovalHash] = useState<`0x${string}` | undefined>();
  const { isSuccess: approvalConfirmed } = useWaitForTransactionReceipt({ hash: approvalHash, chainId: originChainId });
  useEffect(() => { if (approvalConfirmed) refetchAllowance(); }, [approvalConfirmed, refetchAllowance]);

  const { mutateAsync: sendTransaction, isPending: isSending } = useSendTransaction();
  const [txHash, setTxHash]   = useState<`0x${string}` | undefined>();
  // chainId pins the receipt poll to the route's chain — without it the poll runs
  // on the wallet's active chain (often the embedded wallet's chain 1) and hangs
  // forever. Read the receipt's status, not just isSuccess: a reverted tx still
  // produces a receipt, so isSuccess alone can't tell failure from success.
  const { isLoading: isConfirming, data: txReceipt, isError: txReceiptError } = useWaitForTransactionReceipt({ hash: txHash, chainId: originChainId });
  const txConfirmed = txReceipt?.status === "success";
  const txFailed    = txReceipt?.status === "reverted" || txReceiptError;

  const [switchErr, setSwitchErr]       = useState<string | null>(null);
  const [isSwitching, setIsSwitching]   = useState(false);
  const [secondsLeft, setSecondsLeft]   = useState(QUOTE_TTL);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    const elapsed = result.quotedAt ? Math.floor((Date.now() - result.quotedAt) / 1000) : 0;
    setSecondsLeft(Math.max(0, QUOTE_TTL - elapsed));
    setIsRefreshing(false);
  }, [result]);

  useEffect(() => {
    if (txHash || secondsLeft <= 0) return;
    const id = setTimeout(() => setSecondsLeft(s => s - 1), 1000);
    return () => clearTimeout(id);
  }, [secondsLeft, txHash]);

  useEffect(() => {
    if (onCorrectChain) setSwitchErr(null);
  }, [onCorrectChain]);

  // ── live quote stream ──────────────────────────────────────────────────
  // Flash revises a market quote as deeper routing completes. Subscribing
  // once beats re-polling: the first quote arrives sooner and the better one
  // follows on the same session, so the price on screen while the user reads
  // the card is one they can actually sign.
  //
  // Scope is Flash's: market orders, same chain. Skopos's own re-quote before
  // signing (onRevalidate) still runs — that keeps us CORRECT; this keeps the
  // displayed number TRUE, so the re-quote is no longer a surprise.
  const flashLeg = result.flash;
  const streamable =
    !!flashLeg && flashLeg.orderType === "market" &&
    flashLeg.targetChain === flashLeg.contraChain && !txHash;
  const [isStreaming, setIsStreaming] = useState(false);

  // Identity of the session, not the revision — a new quoteId arriving on the
  // stream must not tear down and reopen the very stream that produced it.
  const streamKey = streamable
    ? `${flashLeg.targetChain}:${flashLeg.targetAsset}:${flashLeg.contraAsset}:${flashLeg.side}:${flashLeg.qty}`
    : null;

  const onResultUpdateRef = useRef(onResultUpdate);
  onResultUpdateRef.current = onResultUpdate;

  useEffect(() => {
    if (!streamKey || !flashLeg) return;
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/flash/quote-stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            targetChain: flashLeg.targetChain, contraChain: flashLeg.contraChain,
            targetAsset: flashLeg.targetAsset, contraAsset: flashLeg.contraAsset,
            side: flashLeg.side, qty: flashLeg.qty, orderType: "market",
            funderAddress: flashLeg.funderAddress,
            flashIntegratorFeeBps: flashLeg.flashIntegratorFeeBps,
          }),
        });
        if (!res.ok || !res.body) return;
        if (!cancelled) setIsStreaming(true);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const state = { buffer: "" };
        for (;;) {
          const { done, value } = await reader.read();
          if (done || cancelled) break;
          for (const ev of pushSseChunk(state, decoder.decode(value, { stream: true }))) {
            if (ev.event === "quote") {
              const revision = toQuoteRevision(ev.quote);
              // A revision with no signable payload is dropped rather than
              // replacing a quote the user could have signed.
              if (!revision) continue;
              onResultUpdateRef.current?.({
                quotedAt: Date.now(),
                route: {
                  ...result.route,
                  ...(revision.outputAmount ? { outputAmount: revision.outputAmount } : {}),
                  ...(revision.feesUSD ? { feesUSD: revision.feesUSD } : {}),
                },
                flash: {
                  ...flashLeg,
                  quoteId: revision.quoteId,
                  orderTypedData: revision.orderTypedData,
                  permitTypedData: revision.permitTypedData,
                  approveTx: revision.approveTx,
                },
              });
            } else {
              // expired or error — the session is over either way; the card
              // falls back to its countdown and manual refresh.
              cancelled = true;
              break;
            }
          }
        }
      } catch {
        // Abort or network failure — polling and the countdown still apply.
      } finally {
        if (!cancelled) setIsStreaming(false);
      }
    })();

    return () => { cancelled = true; setIsStreaming(false); controller.abort(); };
    // Keyed on the session, deliberately not on `result` — see streamKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamKey]);

  const isExpired = secondsLeft <= 0 && !txHash;

  async function handleRefresh(slippageOverride?: number) {
    if (!onRefresh) return;
    setIsRefreshing(true);
    try { await onRefresh(slippageOverride); } catch { setIsRefreshing(false); }
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
      if (!onCorrectChain) await switchToChain(originChainId);
      const hash = await writeContract({ address: approval.tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "approve", args: [approval.spender as `0x${string}`, BigInt(approval.amount)], chainId: originChainId });
      setApprovalHash(hash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSwitchErr(msg.toLowerCase().includes("user rejected") ? t("rejectedInWallet") : t("errorPrefix", { msg: msg.slice(0, 120) }));
    }
  }

  const [isRevalidating, setIsRevalidating] = useState(false);

  async function execute() {
    if (!calldata) return;
    setSwitchErr(null);
    try {
      // Re-simulate right before signing. Delora has no re-validate-by-id, so we
      // re-quote (which re-runs the REVERTED guard) and sign the FRESH calldata.
      // null = the route now reverts → the card has been replaced with the error,
      // so abort rather than burn gas on a tx the chain just rejected.
      let cd = calldata;
      if (onRevalidate) {
        setIsRevalidating(true);
        let fresh: QuoteResult | null;
        try { fresh = await onRevalidate(); } finally { setIsRevalidating(false); }
        if (!fresh) {
          setSwitchErr(t("routeFailedRecheck"));
          return;
        }
        if (fresh.calldata) cd = fresh.calldata;
      }
      if (!onCorrectChain) await switchToChain(originChainId);
      const hash = await sendTransaction({ to: cd.to as `0x${string}`, value: BigInt(cd.value || "0x0"), data: cd.data as `0x${string}`, chainId: originChainId });
      setTxHash(hash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSwitchErr(msg.toLowerCase().includes("user rejected") ? t("rejectedInWallet") : t("errorPrefix", { msg: msg.slice(0, 120) }));
    }
  }

  async function handleSwitchChain() {
    setSwitchErr(null);
    setIsSwitching(true);
    try {
      await switchToChain(originChainId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSwitchErr(msg.toLowerCase().includes("user rejected") ? t("rejectedInWalletShort") : t("switchFailed", { msg: msg.slice(0, 80) }));
    } finally {
      setIsSwitching(false);
    }
  }

  const explorerUrl   = txHash ? `${EXPLORER_URLS[intent.from.chain] ?? "https://etherscan.io/tx/"}${txHash}` : null;
  const executionMode = !!txHash;

  const minReceived = (() => {
    const out = parseFloat(route.outputAmount);
    return isFinite(out) ? (out * (1 - slippage)).toFixed(6) : route.outputAmount;
  })();

  // Advanced Flash order types (route.ts's resolveFlashOrderLeg) reuse the
  // exact same card/sign/submit flow as a plain Flash market order — the
  // only difference is this header label and the trigger/schedule banner
  // below, both purely informational so the user sees exactly what they're
  // about to sign before they sign it.
  const orderTypeLabel: string | null =
    result.flash?.orderType === "limit" ? t("orderType.limit") :
    result.flash?.orderType === "stop-loss" ? t("orderType.stopLoss") :
    result.flash?.orderType === "take-profit" ? t("orderType.takeProfit") :
    result.flash?.orderType === "twap" ? t("orderType.twap") : null;

  const triggerToken = result.flash?.side === "buy" ? intent.to.token : intent.from.token;
  const triggerBanner: string | null = result.flash?.triggerPrice
    ? t(result.flash.triggerType === "lower" ? "triggerBanner.dropsTo" : "triggerBanner.hits", { token: triggerToken, price: Number(result.flash.triggerPrice).toLocaleString() })
    : result.flash?.durationSeconds
      ? t(result.flash.twapBucketCount ? "triggerBanner.twapWithCount" : "triggerBanner.twap", { amount: intent.from.amount, token: intent.from.token, duration: formatDuration(result.flash.durationSeconds), count: result.flash.twapBucketCount ?? 0 })
      : null;

  // Attached bracket: the pair the entry carries. Stated on the card BEFORE
  // signing, cap included — protection stops at signedMaxFromAmount, so an
  // entry that fills beyond it leaves the excess unprotected. A user who
  // believes they are covered and is not is the worst outcome this card can
  // produce, so the limit is shown rather than merely carried in the payload.
  const bracket = result.flash?.bracket ?? null;
  const bracketBanner: string | null = bracket
    ? t("bracketBanner.pair", {
        token: intent.to.token,
        stop: Number(bracket.stopLoss.price).toLocaleString(),
        target: Number(bracket.takeProfit.price).toLocaleString(),
      })
    : null;

  // Trigger orders (stop-loss / take-profit) market-sell when the trigger
  // fires, so Flash's quoted output reflects the CURRENT price — misleading
  // next to a banner promising execution at the trigger. Show what the trigger
  // price actually implies: qty × trigger, minus the current fee estimate
  // (network fee is a USD-denominated cost, so it's a fair proxy for the fee
  // at execution time). Contra asset is always a dollar stable (USDG/USDC).
  const isTriggerOrder = !!result.flash?.triggerPrice;
  const estAtTrigger: string | null = (() => {
    if (!isTriggerOrder || result.flash?.side !== "sell") return null;
    const qty = parseFloat(intent.from.amount);
    const px = parseFloat(result.flash.triggerPrice!);
    if (!isFinite(qty) || !isFinite(px)) return null;
    const fees = Number(route.feesUSD);
    const net = Math.max(0, qty * px - (isFinite(fees) ? fees : 0));
    return parseFloat(net.toFixed(6)).toString();
  })();

  const recipient = intent.to.receiver ?? connectedAddress;
  const summaryRows: { label: string; value: string }[] = [
    { label: t("summary.via"),           value: route.tool },
    ...(route.etaSec ? [{ label: t("summary.estTime"), value: route.etaSec >= 60 ? t("summary.minutesEta", { n: Math.round(route.etaSec / 60) }) : t("summary.secondsEta", { n: Math.round(route.etaSec) }) }] : []),
    { label: t("summary.minReceived"), value: `~${minReceived} ${intent.to.token}` },
    ...(route.feesUSD ? [{ label: t("summary.networkFee"), value: `~$${Number(route.feesUSD).toFixed(2)}` }] : []),
    ...(recipient ? [{ label: t("summary.recipient"), value: shortAddr(recipient) }] : []),
  ];

  return (
    <div style={{
      background: "var(--card-container-bg, #0D0D0D)",
      border: `1px solid ${executionMode ? "rgba(245,184,0,0.2)" : "var(--card-border, rgba(255,255,255,0.09))"}`,
      borderRadius: 16, overflow: "hidden", maxWidth: 400,
    }}>

      {/* Header */}
      <div style={{ padding: "11px 16px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ ...MONO, fontSize: "0.62rem", letterSpacing: "0.09em", color: "var(--card-text-faint)" }}>
          {executionMode ? t("header.transaction") : orderTypeLabel ?? (isSwap ? t("header.swapPreview") : t("header.bridgePreview"))}
        </span>
        {/* Flash/Relay flows realistically take longer than QUOTE_TTL to click
            through with real wallet confirmations (wrap, approve, sign are
            each a separate prompt) — neither FlashExecuteButton nor
            RelayExecuteSteps checks or enforces this countdown, so showing
            "EXPIRED" here would be actively misleading, not just cosmetic:
            confirmed live, the sign+submit flow still completes fine after
            this badge says EXPIRED. */}
        {/* A streamed quote is not going stale — revisions keep arriving — so
            it reports as live rather than counting down to an expiry that no
            longer applies. */}
        {!executionMode && isStreaming && (
          <span style={{
            ...MONO, fontSize: "0.6rem", padding: "2px 8px", borderRadius: 4,
            background: "rgba(76,194,106,0.08)", color: "rgba(76,194,106,0.9)",
          }}>
            {t("streamingLive")}
          </span>
        )}
        {!executionMode && !isStreaming && !result.flash && !result.relay && (
          <span style={{
            ...MONO, fontSize: "0.6rem", padding: "2px 8px", borderRadius: 4,
            background: "var(--card-border-faint, rgba(255,255,255,0.05))",
            color: isExpired ? "#F5B800" : secondsLeft <= 10 ? "rgba(245,184,0,0.65)" : "var(--card-text-faint)",
          }}>
            {isExpired ? t("expired") : secondsLeft <= 15 ? t("secondsLeft", { n: secondsLeft }) : t("live")}
          </span>
        )}
      </div>

      {!executionMode && triggerBanner && (
        <div style={{ margin: "10px 14px 0", padding: "8px 12px", background: "rgba(245,184,0,0.06)", border: "1px solid rgba(245,184,0,0.2)", borderRadius: 8, textAlign: "center" }}>
          <span style={{ ...MONO, fontSize: "0.68rem", color: "rgba(245,184,0,0.85)" }}>{triggerBanner}</span>
          {estAtTrigger && (
            <span style={{ ...MONO, display: "block", marginTop: 4, fontSize: "0.62rem", color: "rgba(245,184,0,0.55)" }}>
              {t("triggerBanner.estAtTrigger", { amount: estAtTrigger, token: intent.to.token })}
            </span>
          )}
        </div>
      )}

      {!executionMode && bracketBanner && bracket && (
        <div style={{ margin: "10px 14px 0", padding: "8px 12px", background: "rgba(76,194,106,0.06)", border: "1px solid rgba(76,194,106,0.22)", borderRadius: 8, textAlign: "center" }}>
          <span style={{ ...MONO, fontSize: "0.68rem", color: "rgba(76,194,106,0.9)" }}>{bracketBanner}</span>
          <span style={{ ...MONO, display: "block", marginTop: 4, fontSize: "0.62rem", color: "var(--card-text-faint)" }}>
            {t("bracketBanner.cap", { amount: Number(bracket.signedMaxFromAmount).toLocaleString(undefined, { maximumFractionDigits: 8 }), token: intent.to.token })}
          </span>
          <span style={{ ...MONO, display: "block", marginTop: 2, fontSize: "0.62rem", color: "var(--card-text-faint)" }}>
            {t("bracketBanner.keepFunds")}
          </span>
        </div>
      )}

      {/* Token pair hero */}
      {!executionMode && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-around", padding: "24px 20px 18px", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, flex: 1 }}>
            <ChainLogo chainId={originChainId} size={50} />
            <span style={{ ...MONO, fontSize: "1.05rem", fontWeight: 700, color: "var(--card-text, rgba(255,255,255,0.9))", textAlign: "center", lineHeight: 1.2 }}>
              {intent.from.amount} {intent.from.token}
            </span>
            <span style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-faint)", letterSpacing: "0.04em" }}>
              {intent.from.chain}
            </span>
          </div>

          <div style={{ flexShrink: 0, color: "var(--card-text-faint)" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6"/>
            </svg>
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, flex: 1 }}>
            <ChainLogo chainId={destChainId} size={50} />
            <span style={{ ...MONO, fontSize: "1.05rem", fontWeight: 700, color: "#F5B800", textAlign: "center", lineHeight: 1.2 }}>
              ~{route.outputAmount} {intent.to.token}
            </span>
            {isTriggerOrder && (
              <span style={{ ...MONO, marginTop: -4, fontSize: "0.56rem", color: "var(--card-text-faint)" }}>
                {t("atCurrentPrice")}
              </span>
            )}
            <span style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-faint)", letterSpacing: "0.04em" }}>
              {intent.to.chain}
            </span>
          </div>
        </div>
      )}

      {/* Summary card */}
      <div style={{ margin: "0 14px 14px", padding: "12px 14px", background: "var(--card-bg)", border: "1px solid var(--card-border-faint)", borderRadius: 12 }}>
        <p style={{ ...MONO, fontSize: "0.56rem", letterSpacing: "0.1em", color: "var(--card-text-faint)", margin: "0 0 9px" }}>{t("summaryLabel")}</p>
        {summaryRows.map(({ label, value }, i) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: i > 0 ? "1px solid var(--card-bg)" : undefined }}>
            <span style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-dim)" }}>{label}</span>
            <span style={{ ...MONO, fontSize: "0.72rem", color: "var(--card-text-muted, rgba(255,255,255,0.75))", fontWeight: 500 }}>{value}</span>
          </div>
        ))}
        {/* Slippage — adjustable before execution (re-quotes on change), read-only after */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--card-bg)" }}>
          <span style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-dim)" }}>{t("slippage")}</span>
          {!executionMode && onSlippageChange ? (
            <div style={{ display: "flex", gap: 4 }}>
              {SLIPPAGE_OPTIONS.map(({ value, label }) => {
                const active = Math.abs(slippage - value) < 1e-9;
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={isRefreshing}
                    onClick={() => { onSlippageChange(value); void handleRefresh(value); }}
                    style={{
                      ...MONO, fontSize: "0.62rem", padding: "2px 7px", borderRadius: 4,
                      border: `1px solid ${active ? "rgba(245,184,0,0.45)" : "var(--card-border, rgba(255,255,255,0.12))"}`,
                      background: active ? "rgba(245,184,0,0.1)" : "transparent",
                      color: active ? "rgba(245,184,0,0.9)" : "var(--card-text-dim)",
                      cursor: isRefreshing ? "wait" : "pointer",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : (
            <span style={{ ...MONO, fontSize: "0.72rem", color: "var(--card-text-muted, rgba(255,255,255,0.75))", fontWeight: 500 }}>{(slippage * 100).toFixed(1)}%</span>
          )}
        </div>
      </div>

      {/* Action area */}
      <div style={{ padding: "0 14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
        {switchErr && (
          <p style={{ ...MONO, fontSize: "0.68rem", color: "#ff6b6b", margin: 0, textAlign: "center" }}>{switchErr}</p>
        )}
        {approvalConfirmed && !txHash && (
          <p style={{ ...MONO, fontSize: "0.65rem", color: "#4ade80", textAlign: "center", margin: 0 }}>
            {t("approvalConfirmed")}
          </p>
        )}

        {txHash ? (
          txConfirmed ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <a href={explorerUrl ?? "#"} target="_blank" rel="noopener noreferrer"
                style={{ ...MONO, display: "block", width: "100%", padding: "12px 0", fontSize: "0.72rem", letterSpacing: "0.08em", textAlign: "center", background: "rgba(40,200,100,0.07)", border: "1px solid rgba(40,200,100,0.35)", borderRadius: 10, color: "#4ade80", textDecoration: "none" }}>
                {route.etaSec ? t("originConfirmed") : t("confirmed")}
              </a>
              {route.etaSec ? (
                <div style={{ ...MONO, width: "100%", padding: "10px 0", fontSize: "0.68rem", letterSpacing: "0.04em", textAlign: "center", background: "rgba(245,184,0,0.05)", border: "1px solid rgba(245,184,0,0.2)", borderRadius: 10, color: "rgba(245,184,0,0.8)" }}>
                  {route.etaSec >= 60 ? t("bridgingToMinutes", { chain: intent.to.chain, n: Math.round(route.etaSec / 60) }) : t("bridgingToSeconds", { chain: intent.to.chain, n: Math.round(route.etaSec) })}
                </div>
              ) : null}
            </div>
          ) : txFailed ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <a href={explorerUrl ?? "#"} target="_blank" rel="noopener noreferrer"
                style={{ ...MONO, display: "block", width: "100%", padding: "12px 0", fontSize: "0.72rem", letterSpacing: "0.08em", textAlign: "center", background: "rgba(255,107,107,0.07)", border: "1px solid rgba(255,107,107,0.35)", borderRadius: 10, color: "#ff6b6b", textDecoration: "none" }}>
                {t("transactionFailed")}
              </a>
              {onRefresh && (
                <button onClick={() => { setTxHash(undefined); void handleRefresh(); }}
                  style={{ ...MONO, width: "100%", padding: "10px 0", fontSize: "0.7rem", fontWeight: 600, letterSpacing: "0.03em", background: "none", border: "1px solid var(--card-border)", borderRadius: 10, color: "var(--card-text-dim)", cursor: "pointer" }}>
                  {t("freshQuoteRetry")}
                </button>
              )}
            </div>
          ) : (
            <div style={{ ...MONO, width: "100%", padding: "12px 0", fontSize: "0.72rem", letterSpacing: "0.08em", textAlign: "center", background: "rgba(245,184,0,0.04)", border: "1px solid rgba(245,184,0,0.15)", borderRadius: 10, color: "rgba(245,184,0,0.5)" }}
              className={isConfirming ? "animate-pulse" : ""}>
              {isConfirming ? t("confirmingOnChain") : t("submittedWaiting")}
            </div>
          )
        ) : isRelayLeg ? (
          <RelayExecuteSteps result={result} onTxSubmitted={onTxSubmitted} onCorrectChain={onCorrectChain} onResultUpdate={onResultUpdate} />
        ) : isSolanaOrigin ? (
          <SolanaExecuteButton result={result} onTxSubmitted={onTxSubmitted} onRevalidate={onRevalidate} />
        ) : isRobinhoodOrigin ? (
          <FlashExecuteButton result={result} onTxSubmitted={onTxSubmitted} onCorrectChain={onCorrectChain} onResultUpdate={onResultUpdate} />
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => handleRefresh()} disabled={isRefreshing || !onRefresh}
              style={{
                ...MONO, padding: "11px 14px", fontSize: "0.7rem", fontWeight: 600, letterSpacing: "0.03em",
                background: "none",
                border: `1px solid ${isExpired ? "rgba(245,184,0,0.35)" : "var(--card-border)"}`,
                borderRadius: 10,
                color: isExpired ? "rgba(245,184,0,0.85)" : "var(--card-text-dim)",
                cursor: isRefreshing || !onRefresh ? "not-allowed" : "pointer", flexShrink: 0,
              }}
              className={isRefreshing ? "animate-pulse" : ""}
            >
              {isRefreshing ? t("ellipsis") : isExpired ? t("refreshArrow") : t("refresh")}
            </button>

            {!authenticated ? (
              <button onClick={login}
                style={{ ...MONO, flex: 1, padding: "11px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.03em", background: "#F5B800", border: "none", borderRadius: 10, color: "#000", cursor: "pointer" }}>
                {t("connectWallet")}
              </button>
            ) : !onCorrectChain && !isSolanaOrigin ? (
              <button onClick={handleSwitchChain} disabled={isSwitching}
                style={{ ...MONO, flex: 1, padding: "11px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.03em", background: "#F5B800", border: "none", borderRadius: 10, color: "#000", cursor: isSwitching ? "wait" : "pointer", opacity: isSwitching ? 0.65 : 1 }}>
                {isSwitching ? t("switching") : t("switchTo", { chain: intent.from.chain.charAt(0).toUpperCase() + intent.from.chain.slice(1) })}
              </button>
            ) : needsApproval ? (
              <button onClick={approve} disabled={isApproving || (!!approvalHash && !approvalConfirmed)}
                style={{ ...MONO, flex: 1, padding: "11px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.03em", background: "#F5B800", border: "none", borderRadius: 10, color: "#000", cursor: isApproving ? "wait" : "pointer", opacity: (isApproving || (!!approvalHash && !approvalConfirmed)) ? 0.65 : 1 }}>
                {isApproving ? t("approving") : approvalHash && !approvalConfirmed ? t("confirming") : t("approveToken", { token: intent.from.token })}
              </button>
            ) : (
              <button onClick={execute} disabled={!calldata || isSending || isRevalidating || isExpired}
                style={{ ...MONO, flex: 1, padding: "11px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.03em", background: calldata && !isExpired ? "#F5B800" : "var(--card-surface)", border: calldata && !isExpired ? "none" : "1px solid var(--card-border)", borderRadius: 10, color: calldata && !isExpired ? "#000" : "var(--card-text-faint)", cursor: calldata && !isSending && !isRevalidating && !isExpired ? "pointer" : "not-allowed" }}>
                {isRevalidating ? t("recheckingRoute") : isSending ? t("confirmInWallet") : isExpired ? t("quoteExpiredRefresh") : t("executeArrow")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SolanaExecuteButton ─────────────────────────────────────────────────────

function SolanaExecuteButton({ result, onTxSubmitted, onRevalidate }: {
  result: QuoteResult;
  onTxSubmitted?: (r: TxRecord) => void;
  onRevalidate?: () => Promise<QuoteResult | null>;
}) {
  const t = useTranslations("app.solana");
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
      // Re-simulate right before signing — re-quote (re-runs the REVERTED guard)
      // and sign the FRESH transaction. null = the route now reverts, so abort.
      let cd = result.calldata;
      if (onRevalidate) {
        const fresh = await onRevalidate();
        if (!fresh) {
          setErr(t("routeFailedRecheck"));
          return;
        }
        if (fresh.calldata) cd = fresh.calldata;
      }

      // Delora returns base64-encoded VersionedTransaction
      const txBuffer = Uint8Array.from(atob(cd.data), c => c.charCodeAt(0));
      const tx = VersionedTransaction.deserialize(txBuffer);

      const requiredSigners = tx.message.staticAccountKeys
        .slice(0, tx.message.header.numRequiredSignatures)
        .map(k => k.toBase58());
      if (!requiredSigners.includes(publicKey.toBase58())) {
        throw new Error(t("wrongAccount"));
      }

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
      if (confirmation.value.err) throw new Error(t("transactionFailedDetail", { detail: JSON.stringify(confirmation.value.err) }));

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
      setErr(e instanceof Error ? e.message : t("transactionFailed"));
    } finally {
      setSending(false);
    }
  }

  if (sig) {
    return (
      <a href={`https://solscan.io/tx/${sig}`} target="_blank" rel="noopener noreferrer"
        style={{ ...MONO, display: "block", width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", background: "rgba(245,184,0,0.06)", border: "1px solid rgba(245,184,0,0.3)", borderRadius: 10, color: "#F5B800", cursor: "pointer", textAlign: "center", textDecoration: "none" }}>
        {t("viewOnSolscan")}
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
              setErr(e instanceof Error ? e.message : t("failedToConnect"));
            }
          }}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", background: "rgba(245,184,0,0.08)", border: "1px solid rgba(245,184,0,0.3)", borderRadius: 10, color: "#F5B800", cursor: "pointer" }}>
          {wallet ? t("connectNamed", { name: wallet.adapter.name }) : t("connectPhantom")}
        </button>
      ) : (
        <button
          onClick={execute}
          disabled={sending || !result.calldata}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", background: result.calldata ? "rgba(245,184,0,0.08)" : "transparent", border: `1px solid ${result.calldata ? "rgba(245,184,0,0.3)" : "var(--card-border, rgba(255,255,255,0.09))"}`, borderRadius: 10, color: result.calldata ? "#F5B800" : "var(--card-text-faint)", cursor: sending || !result.calldata ? "not-allowed" : "pointer" }}>
          {sending ? t("confirmInPhantom") : t("executeViaPhantom")}
        </button>
      )}
      <p style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint)", margin: 0, textAlign: "center" }}>
        {publicKey ? `${publicKey.toBase58().slice(0, 6)}…${publicKey.toBase58().slice(-4)}` : t("phantomSolana")}
      </p>
    </div>
  );
}

// ─── FlashExecuteButton ───────────────────────────────────────────────────────
// Robinhood Chain leg (result.flash set by resolveFlashLeg()). Same EVM wallet
// as every other chain — unlike Solana this isn't a different signer — but a
// genuinely different signing flow: Flash needs EIP-712 typed-data signing
// plus a submit round-trip (POST /api/flash/submit, since only the server
// holds the x-definitive-api-key), not a raw calldata send via
// sendTransaction. No existing signTypedData usage anywhere in this codebase
// to follow, so this is a new pattern, built and verified against Flash's
// real OpenAPI spec and a live quote (see lib/flash.ts).
function FlashExecuteButton({ result, onTxSubmitted, onCorrectChain, onResultUpdate }: {
  result: QuoteResult;
  onTxSubmitted?: (r: TxRecord) => void;
  onCorrectChain: boolean;
  onResultUpdate?: (patch: Partial<QuoteResult>) => void;
}) {
  const t = useTranslations("app.flash");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { login, authenticated } = usePrivy();
  const { wallets }              = useWallets();
  const { mutateAsync: sendTransaction, isPending: isApproving } = useSendTransaction();
  const { mutateAsync: signTypedDataAsync, isPending: isSigning } = useSignTypedData();
  const flash = result.flash;
  const originChainId = result.intent.from.chainId;

  // Privy's own documented method — switches embedded wallets silently,
  // prompts external ones. Not wagmi's useSwitchChain, which binds to
  // Privy's embedded wallet specifically rather than whichever wallet the
  // user is actually connected with.
  async function switchToChain(chainId: number) {
    const evmWallet = wallets.find(w => w.address?.startsWith("0x"));
    if (!evmWallet) throw new Error("No EVM wallet connected.");
    await evmWallet.switchChain(chainId);
  }

  const [wrapHash, setWrapHash] = useState<`0x${string}` | undefined>();
  const { isSuccess: wrapConfirmed } = useWaitForTransactionReceipt({ hash: wrapHash, chainId: originChainId });
  const [approvalHash, setApprovalHash] = useState<`0x${string}` | undefined>();
  const { isSuccess: approvalConfirmed } = useWaitForTransactionReceipt({ hash: approvalHash, chainId: originChainId });
  // Allowance on the asset the entry RECEIVES, needed only when a bracket is
  // attached — that is the asset the exits sell.
  const [bracketApprovalHash, setBracketApprovalHash] = useState<`0x${string}` | undefined>();
  const { isSuccess: bracketApprovalConfirmed } = useWaitForTransactionReceipt({ hash: bracketApprovalHash, chainId: originChainId });
  const [err, setErr]               = useState<string | null>(null);
  // Initialized from the persisted message, not just fresh local state — a
  // reload after a completed order should show "submitted ✓" immediately,
  // not the pre-execution card again.
  const [orderId, setOrderId]       = useState<string | null>(flash?.completedOrderId ?? null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSwitching, setIsSwitching]   = useState(false);

  async function handleSwitchChain() {
    setErr(null);
    setIsSwitching(true);
    try {
      await switchToChain(originChainId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.toLowerCase().includes("user rejected") ? t("rejectedInWalletShort") : t("switchFailed", { msg: msg.slice(0, 80) }));
    } finally {
      setIsSwitching(false);
    }
  }

  async function wrap() {
    if (!flash?.wrapTx) return;
    setErr(null);
    try {
      const hash = await sendTransaction({
        to: flash.wrapTx.to as `0x${string}`, data: flash.wrapTx.data as `0x${string}`,
        value: BigInt(flash.wrapTx.value || "0"), chainId: originChainId,
      });
      setWrapHash(hash);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.toLowerCase().includes("user rejected") ? t("rejectedInWallet") : t("errorPrefix", { msg: msg.slice(0, 120) }));
    }
  }

  async function approve() {
    if (!flash?.approveTx) return;
    setErr(null);
    try {
      // Flash's approveTx is already-built raw calldata (a standard ERC-20
      // approve() call), not an ABI + args triple — sent directly, unlike
      // Delora's approval which goes through writeContract().
      const hash = await sendTransaction({
        to: flash.approveTx.to as `0x${string}`, data: flash.approveTx.data as `0x${string}`,
        value: BigInt(0), chainId: originChainId,
      });
      setApprovalHash(hash);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.toLowerCase().includes("user rejected") ? t("rejectedInWallet") : t("errorPrefix", { msg: msg.slice(0, 120) }));
    }
  }

  // Flash's raw typed-data JSON needs two fixes before viem will take it, and
  // an attached bracket means signing TWO of them — so the quirks live here
  // once instead of being copied for the second payload.
  async function signFlashTypedData(rawJson: string): Promise<`0x${string}`> {
    const parsed = JSON.parse(rawJson) as {
      domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown>;
    };
    // viem/wagmi derive EIP712Domain internally from `domain` — passing it
    // inside `types` too (as Flash's raw JSON does) throws. Domain's chainId
    // also arrives as a string ("4663") but viem's typed-data domain wants a
    // number.
    const { EIP712Domain, ...types } = parsed.types;
    void EIP712Domain;
    const chainIdRaw = parsed.domain.chainId;
    return signTypedDataAsync({
      domain: { ...parsed.domain, chainId: typeof chainIdRaw === "string" ? Number(chainIdRaw) : chainIdRaw },
      types,
      primaryType: parsed.primaryType,
      message: parsed.message,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  // The pair sells the asset the entry RECEIVES, so that asset needs its own
  // allowance before submit — exactly as the spent asset does for the entry.
  // Separate transaction, separate confirmation, and it must land before the
  // order is placed or the exits cannot pull the funds when a leg fires.
  async function approveBracket() {
    if (!flash?.bracket?.approveTx) return;
    setErr(null);
    try {
      const hash = await sendTransaction({
        to: flash.bracket.approveTx.to as `0x${string}`, data: flash.bracket.approveTx.data as `0x${string}`,
        value: BigInt(0), chainId: originChainId,
      });
      setBracketApprovalHash(hash);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.toLowerCase().includes("user rejected") ? t("rejectedInWallet") : t("errorPrefix", { msg: msg.slice(0, 120) }));
    }
  }

  async function signAndSubmit() {
    if (!flash) return;
    setErr(null);
    try {
      // Flash picks between its settlement-contract flow and Permit2 from the
      // funder's on-chain state (evmUsePermit2 is left unset). Only the
      // settlement flow is implemented — neither the entry nor the pair
      // forwards evmPermitTypedData/evmPermitSignature at submit — so a wallet
      // that lands on the Permit2 flow would sign here and be rejected at
      // /order with nothing explaining why. Refuse before the wallet prompt
      // instead. Pre-existing on the entry (permitTypedData has always been
      // typed and never sent); the bracket inherits the same limit, and
      // failing loudly is better than one path silently working and the other
      // not. See issue for real Permit2 support.
      if (flash.permitTypedData || flash.bracket?.permitTypedData) {
        setErr(t("permitFlowUnsupported"));
        return;
      }
      const signature = await signFlashTypedData(flash.orderTypedData);

      // Second signature, over the pair's own payload. Deliberately after the
      // entry's: if the user rejects this one we have not yet submitted an
      // unprotected entry, which is the failure that matters here.
      let bracketSignature: `0x${string}` | undefined;
      if (flash.bracket) {
        bracketSignature = await signFlashTypedData(flash.bracket.orderTypedData);
      }

      setIsSubmitting(true);
      const res = await fetch("/api/flash/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetChain: flash.targetChain, contraChain: flash.contraChain,
          targetAsset: flash.targetAsset, contraAsset: flash.contraAsset,
          side: flash.side, qty: flash.qty, orderType: flash.orderType,
          funderAddress: flash.funderAddress, quoteId: flash.quoteId,
          flashIntegratorFeeBps: flash.flashIntegratorFeeBps,
          userSignature: signature, evmOrderTypedData: flash.orderTypedData,
          // Flash's /order endpoint validates limit/trigger/twap fields
          // independently of /quote — a limit order submitted without
          // limitNotionalPrice 400s even though the quote already required
          // one. triggers/twapBucketCount must echo the exact quote-time
          // values, not be recomputed here.
          // Must mirror the basis the QUOTE used. A bracketed limit entry is
          // quoted in cross basis (Flash rejects notional with a bracket), and
          // /order validates independently of /quote — sending the wrong field
          // here fails AFTER the user has signed twice, which is the most
          // expensive place to discover it.
          ...(flash.orderType === "limit" && flash.triggerPrice
            ? flash.bracket
              ? { limitCrossPrice: flash.triggerPrice }
              : { limitNotionalPrice: flash.triggerPrice }
            : {}),
          ...(flash.triggerType && flash.triggerPrice ? { triggers: [{ notionalPrice: flash.triggerPrice, triggerType: flash.triggerType }] } : {}),
          ...(flash.twapBucketCount ? { twapBucketCount: flash.twapBucketCount } : {}),
          // The pair's legs plus the three values baked into its signed typed
          // data, echoed verbatim. signedMaxFromAmount in particular is part
          // of what was signed — recomputing it here would invalidate the
          // signature.
          ...(flash.bracket && bracketSignature
            ? {
                attachedBracket: {
                  // Same wire conversion the quote used — the legs are stored
                  // internally as {price, basis} for the card, and Flash only
                  // accepts notionalPrice/crossPrice.
                  ...toFlashBracketWire({ takeProfit: flash.bracket.takeProfit, stopLoss: flash.bracket.stopLoss }),
                  userSignature: bracketSignature,
                  deadline: flash.bracket.deadline,
                  signedMaxFromAmount: flash.bracket.signedMaxFromAmount,
                  ...(flash.bracket.salt ? { salt: flash.bracket.salt } : {}),
                },
              }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || t("orderSubmissionFailed", { status: res.status }));
      setOrderId(data.orderId);
      if (flash) onResultUpdate?.({ flash: { ...flash, completedOrderId: data.orderId } });
      onTxSubmitted?.({
        hash: data.orderId,
        label: `${result.intent.from.amount} ${result.intent.from.token} → ${result.intent.to.token}`,
        explorerUrl: `https://robinhoodchain.blockscout.com/address/${flash.funderAddress}`,
        chainId: originChainId, chain: result.intent.from.chain, timestamp: Date.now(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.toLowerCase().includes("user rejected") ? t("signatureRejected") : msg.slice(0, 160));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (orderId) {
    return (
      <div style={{ ...MONO, width: "100%", padding: "12px 0", fontSize: "0.72rem", letterSpacing: "0.08em", textAlign: "center", background: "rgba(40,200,100,0.07)", border: "1px solid rgba(40,200,100,0.35)", borderRadius: 10, color: "#4ade80" }}>
        {t("orderSubmitted", { id: orderId.slice(0, 8) })}
      </div>
    );
  }

  const needsWrap     = !!flash?.wrapTx && !wrapConfirmed;
  const needsApproval = !needsWrap && !!flash?.approveTx && !approvalConfirmed;
  // Third gate, bracket only: the received asset's allowance. Ordered after
  // the entry's own approval so the ladder reads spend-side then receive-side
  // rather than interleaving two different assets.
  const needsBracketApproval =
    !needsWrap && !needsApproval && !!flash?.bracket?.approveTx && !bracketApprovalConfirmed;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {err && <p style={{ ...MONO, fontSize: "0.65rem", color: "#ff5555", margin: 0 }}>{err}</p>}
      {wrapConfirmed && !needsApproval && (
        <p style={{ ...MONO, fontSize: "0.65rem", color: "#4ade80", textAlign: "center", margin: 0 }}>
          {t("wrapConfirmed")}
        </p>
      )}
      {approvalConfirmed && (
        <p style={{ ...MONO, fontSize: "0.65rem", color: "#4ade80", textAlign: "center", margin: 0 }}>
          {t("approvalConfirmedSignBelow")}
        </p>
      )}
      {!authenticated ? (
        <button onClick={login}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.03em", background: "#F5B800", border: "none", borderRadius: 10, color: "#000", cursor: "pointer" }}>
          {t("connectWallet")}
        </button>
      ) : !onCorrectChain ? (
        <button onClick={handleSwitchChain} disabled={isSwitching}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.03em", background: "#F5B800", border: "none", borderRadius: 10, color: "#000", cursor: isSwitching ? "wait" : "pointer", opacity: isSwitching ? 0.65 : 1 }}>
          {isSwitching ? t("switching") : t("switchToRobinhoodChain")}
        </button>
      ) : needsWrap ? (
        <button onClick={wrap} disabled={isApproving || (!!wrapHash && !wrapConfirmed)}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.03em", background: "#F5B800", border: "none", borderRadius: 10, color: "#000", cursor: isApproving ? "wait" : "pointer", opacity: (isApproving || (!!wrapHash && !wrapConfirmed)) ? 0.65 : 1 }}>
          {isApproving ? t("wrapping") : wrapHash && !wrapConfirmed ? t("confirming") : t("wrapToken", { token: result.intent.from.token })}
        </button>
      ) : needsApproval ? (
        <button onClick={approve} disabled={isApproving || (!!approvalHash && !approvalConfirmed)}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.03em", background: "#F5B800", border: "none", borderRadius: 10, color: "#000", cursor: isApproving ? "wait" : "pointer", opacity: (isApproving || (!!approvalHash && !approvalConfirmed)) ? 0.65 : 1 }}>
          {isApproving ? t("approving") : approvalHash && !approvalConfirmed ? t("confirming") : t("approveToken", { token: result.intent.from.token })}
        </button>
      ) : needsBracketApproval ? (
        <button onClick={approveBracket} disabled={isApproving || (!!bracketApprovalHash && !bracketApprovalConfirmed)}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.03em", background: "#F5B800", border: "none", borderRadius: 10, color: "#000", cursor: isApproving ? "wait" : "pointer", opacity: (isApproving || (!!bracketApprovalHash && !bracketApprovalConfirmed)) ? 0.65 : 1 }}>
          {isApproving ? t("approving") : bracketApprovalHash && !bracketApprovalConfirmed ? t("confirming") : t("approveProtection", { token: result.intent.to.token })}
        </button>
      ) : (
        <button onClick={signAndSubmit} disabled={isSigning || isSubmitting || !flash}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.03em", background: "#F5B800", border: "none", borderRadius: 10, color: "#000", cursor: (isSigning || isSubmitting) ? "wait" : "pointer", opacity: (isSigning || isSubmitting) ? 0.65 : 1 }}>
          {isSigning ? t("confirmInWallet") : isSubmitting ? t("submittingOrder") : flash?.bracket ? t("signBothAndExecute") : t("signAndExecute")}
        </button>
      )}
    </div>
  );
}

// ─── RelayExecuteSteps ────────────────────────────────────────────────────────
// Bridges funds onto/off Robinhood Chain (result.relay set by
// resolveRelayLeg()). Same signing primitive as the plain EVM execute path
// below (sendTransaction, no EIP-712 — unlike FlashExecuteButton) but a
// genuinely different shape: 1-2 raw transactions to send IN SEQUENCE
// (approve, then deposit, for an ERC-20 source) rather than one. All steps
// run on the origin chain (intent.from.chainId) — a bridge deposit is
// entirely client-side on the source; nothing is sent on the destination.
function RelayExecuteSteps({ result, onTxSubmitted, onCorrectChain, onResultUpdate }: {
  result: QuoteResult;
  onTxSubmitted?: (r: TxRecord) => void;
  onCorrectChain: boolean;
  onResultUpdate?: (patch: Partial<QuoteResult>) => void;
}) {
  const t = useTranslations("app.relay");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { login, authenticated } = usePrivy();
  const { wallets }              = useWallets();
  const { mutateAsync: sendTransaction, isPending: isSending } = useSendTransaction();
  const relay = result.relay;
  const originChainId = result.intent.from.chainId;
  const steps = relay?.steps ?? [];
  const totalSteps = steps.length;

  // Privy's own documented method — switches embedded wallets silently,
  // prompts external ones. Not wagmi's useSwitchChain, which binds to
  // Privy's embedded wallet specifically rather than whichever wallet the
  // user is actually connected with — confirmed live, this exact gap
  // produced "current chain of the wallet (id: 1) does not match the
  // target chain (id: 4663)" instead of a clean chain-switch prompt.
  async function switchToChain(chainId: number) {
    const evmWallet = wallets.find(w => w.address?.startsWith("0x"));
    if (!evmWallet) throw new Error("No EVM wallet connected.");
    await evmWallet.switchChain(chainId);
  }

  const [stepIndex, setStepIndex] = useState(0);
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { isLoading: isConfirming, data: txReceipt, isError: txReceiptError } =
    useWaitForTransactionReceipt({ hash: txHash, chainId: originChainId });
  const [err, setErr] = useState<string | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);
  // Initialized from the persisted message — a reload after the bridge
  // already completed should show "confirmed ✓" immediately, not the
  // pre-execution step sequence again.
  const [allDone, setAllDone] = useState(!!relay?.completedTxHash);
  const [finalHash, setFinalHash] = useState<`0x${string}` | undefined>(relay?.completedTxHash as `0x${string}` | undefined);

  const currentStep = steps[stepIndex];

  useEffect(() => {
    if (!txReceipt || txReceipt.status !== "success") return;
    if (stepIndex + 1 < totalSteps) {
      setTxHash(undefined);
      setStepIndex((i) => i + 1);
      return;
    }
    setAllDone(true);
    setFinalHash(txHash);
    if (txHash) {
      if (relay) onResultUpdate?.({ relay: { ...relay, completedTxHash: txHash } });
      onTxSubmitted?.({
        hash: txHash,
        label: `${result.intent.from.amount} ${result.intent.from.token} → ${result.intent.to.chain}`,
        explorerUrl: `${EXPLORER_URLS[result.intent.from.chain] ?? "https://etherscan.io/tx/"}${txHash}`,
        chainId: originChainId, chain: result.intent.from.chain, timestamp: Date.now(),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txReceipt]);

  async function handleSwitchChain() {
    setErr(null);
    setIsSwitching(true);
    try {
      await switchToChain(originChainId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.toLowerCase().includes("user rejected") ? t("rejectedInWalletShort") : t("switchFailed", { msg: msg.slice(0, 80) }));
    } finally {
      setIsSwitching(false);
    }
  }

  async function sendCurrentStep() {
    if (!currentStep) return;
    setErr(null);
    try {
      const hash = await sendTransaction({
        to: currentStep.tx.to as `0x${string}`,
        data: currentStep.tx.data as `0x${string}`,
        value: BigInt(currentStep.tx.value || "0"),
        chainId: originChainId,
      });
      setTxHash(hash);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.toLowerCase().includes("user rejected") ? t("rejectedInWallet") : t("errorPrefix", { msg: msg.slice(0, 120) }));
    }
  }

  if (allDone) {
    const eta = relay?.timeEstimateSec;
    const explorerUrl = `${EXPLORER_URLS[result.intent.from.chain] ?? "https://etherscan.io/tx/"}${finalHash}`;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <a href={explorerUrl} target="_blank" rel="noopener noreferrer"
          style={{ ...MONO, display: "block", width: "100%", padding: "12px 0", fontSize: "0.72rem", letterSpacing: "0.08em", textAlign: "center", background: "rgba(40,200,100,0.07)", border: "1px solid rgba(40,200,100,0.35)", borderRadius: 10, color: "#4ade80", textDecoration: "none" }}>
          {t("depositConfirmed")}
        </a>
        {eta != null && (
          <div style={{ ...MONO, width: "100%", padding: "10px 0", fontSize: "0.68rem", letterSpacing: "0.04em", textAlign: "center", background: "rgba(245,184,0,0.05)", border: "1px solid rgba(245,184,0,0.2)", borderRadius: 10, color: "rgba(245,184,0,0.8)" }}>
            {eta >= 60 ? t("bridgingToMinutes", { chain: result.intent.to.chain, n: Math.round(eta / 60) }) : t("bridgingToSeconds", { chain: result.intent.to.chain, n: Math.round(eta) })}
          </div>
        )}
      </div>
    );
  }

  if (txReceipt?.status === "reverted" || txReceiptError) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p style={{ ...MONO, fontSize: "0.65rem", color: "#ff5555", margin: 0 }}>
          {t("transactionFailedRefresh")}
        </p>
      </div>
    );
  }

  const stepLabel = currentStep?.id === "approve"
    ? t("approveToken", { token: result.intent.from.token })
    : currentStep?.id === "deposit"
      ? t("bridgeArrow")
      : currentStep?.action ?? t("executeArrow");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {totalSteps > 1 && (
        <p style={{ ...MONO, fontSize: "0.62rem", letterSpacing: "0.06em", color: "var(--card-text-faint)", textAlign: "center", margin: 0 }}>
          {currentStep ? t("stepOfWithDescription", { n: stepIndex + 1, total: totalSteps, description: currentStep.description }) : t("stepOf", { n: stepIndex + 1, total: totalSteps })}
        </p>
      )}
      {err && <p style={{ ...MONO, fontSize: "0.65rem", color: "#ff5555", margin: 0 }}>{err}</p>}
      {txHash ? (
        <div style={{ ...MONO, width: "100%", padding: "12px 0", fontSize: "0.72rem", letterSpacing: "0.08em", textAlign: "center", background: "rgba(245,184,0,0.04)", border: "1px solid rgba(245,184,0,0.15)", borderRadius: 10, color: "rgba(245,184,0,0.5)" }}
          className={isConfirming ? "animate-pulse" : ""}>
          {isConfirming ? t("confirmingOnChain") : t("submittedWaiting")}
        </div>
      ) : !authenticated ? (
        <button onClick={login}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.03em", background: "#F5B800", border: "none", borderRadius: 10, color: "#000", cursor: "pointer" }}>
          {t("connectWallet")}
        </button>
      ) : !onCorrectChain ? (
        <button onClick={handleSwitchChain} disabled={isSwitching}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.03em", background: "#F5B800", border: "none", borderRadius: 10, color: "#000", cursor: isSwitching ? "wait" : "pointer", opacity: isSwitching ? 0.65 : 1 }}>
          {isSwitching ? t("switching") : t("switchTo", { chain: result.intent.from.chain })}
        </button>
      ) : (
        <button onClick={sendCurrentStep} disabled={isSending || !currentStep}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.76rem", fontWeight: 700, letterSpacing: "0.03em", background: "#F5B800", border: "none", borderRadius: 10, color: "#000", cursor: isSending ? "wait" : "pointer", opacity: isSending ? 0.65 : 1 }}>
          {isSending ? t("confirmInWallet") : stepLabel}
        </button>
      )}
    </div>
  );
}

// ─── FlashOrdersDisplay ───────────────────────────────────────────────────────

const FLASH_ORDER_STATUS_COLOR: Record<string, string> = {
  ORDER_STATUS_PENDING: "#F5B800", ORDER_STATUS_ACCEPTED: "#F5B800",
  ORDER_STATUS_PARTIALLY_FILLED: "#F5B800", ORDER_STATUS_FILLED: "#4ade80",
  ORDER_STATUS_CANCELLED: "rgba(255,255,255,0.4)", ORDER_STATUS_REJECTED: "#ff5555",
  ORDER_STATUS_TERMINATED: "rgba(255,255,255,0.4)", ORDER_STATUS_UNSPECIFIED: "rgba(255,255,255,0.4)",
};

function FlashOrderRow({ order }: { order: FlashOrder }) {
  const t = useTranslations("app.flashOrders");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { signMessage: signMessageWithWallet } = useSignMessage();
  const { wallets } = useWallets();
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(order.status === "ORDER_STATUS_CANCELLED");
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftPrice, setDraftPrice] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateSubmitted, setUpdateSubmitted] = useState(false);

  const status = cancelled ? "ORDER_STATUS_CANCELLED" : order.status;
  const cancellable = !cancelled && FLASH_CANCELLABLE_STATUSES.has(order.status);
  const statusLabel = t(`status.${status}`);

  async function cancel() {
    setErr(null);
    setIsCancelling(true);
    try {
      // Same funder-wallet rule as submitUpdate below: Flash only accepts a
      // cancel signature from the wallet that placed the order, and answers a
      // wrong signer with a bare 404 that reads as "the order is gone". With
      // an embedded wallet plus an external one linked, "the first EVM wallet
      // Privy lists" is regularly not the funder — so the user would be told
      // a live order had vanished while it kept working toward its trigger.
      const funder = order.funderAddress.toLowerCase();
      const funderWallet = wallets.find(w => w.address?.toLowerCase() === funder);
      if (!funderWallet) throw new Error(t("funderNotConnected", { address: shortAddr(order.funderAddress) }));
      const cancelMessage = buildFlashCancelMessage(order.orderId);
      const { signature: userSignature } = await signMessageWithWallet({ message: cancelMessage }, { address: funderWallet.address });
      const res = await fetch("/api/flash/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.orderId, cancelMessage, userSignature }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Cancel failed.");
      setCancelled(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.toLowerCase().includes("user rejected") ? t("rejectedInWallet") : t("errorPrefix", { msg: msg.slice(0, 100) }));
    } finally {
      setIsCancelling(false);
    }
  }

  const qtyLine = order.side === "buy"
    ? `${order.qty} ${order.contraAsset.ticker} → ${order.targetAsset.ticker}`
    : `${order.qty} ${order.targetAsset.ticker} → ${order.contraAsset.ticker}`;
  const filledAmount = order.filled?.targetAmount ?? order.filled?.contraAmount;

  // Which price this order can move, and what it currently reads. Flash fixes
  // a trigger's direction and basis for the order's life, so both are taken
  // from the order itself and never from anything the user typed.
  const axis = flashUpdateAxis(order);
  const currentTrigger = triggerPriceOf(order.trigger);
  const currentLimit = limitPriceOf(order);
  const current = axis === "trigger" ? currentTrigger : currentLimit;
  // A cross-basis price is a pair rate, not dollars — labelling it with a
  // "$" would misstate it by orders of magnitude on a thin pair.
  const priceLabel = (p: { price: string; basis: "notional" | "cross" }) =>
    p.basis === "notional" ? `$${p.price}` : p.price;
  const updatable = !cancelled && !updateSubmitted && isFlashOrderUpdatable(order) && current !== null;

  // An attached pair is not an order until the entry's first fill, so its
  // state lives on the entry until then. Worth showing plainly: an entry that
  // never fills means protection that never existed, and "pending" reads as
  // "armed" to most people unless it says otherwise.
  // This row IS a protective pair, not an ordinary sell. Cancelling it leaves
  // the entry working with nothing protecting it — the doc is explicit that
  // the independence runs both ways — so it gets said before the click, not
  // after.
  const isProtection = order.orderType === "bracket" || !!order.sourceEntryOrderId;

  const ab = order.attachedBracket;
  const abPrice = (leg: { notionalPrice?: string; crossPrice?: string }) => leg.notionalPrice ?? leg.crossPrice ?? "?";
  const bracketLine = ab
    ? t(`bracket.${ab.status}`, { stop: abPrice(ab.stopLoss), target: abPrice(ab.takeProfit) })
    : null;

  async function submitUpdate() {
    setErr(null);
    const price = normalizeFlashPrice(draftPrice);
    if (!price) {
      setErr(t("badPrice"));
      return;
    }
    if (!axis || !current) return;
    setIsUpdating(true);
    try {
      // Signature is only accepted from the wallet that placed the order.
      // Deliberately not "the first connected EVM wallet" — with several
      // wallets linked, that can be a different address, and Flash answers a
      // wrong signer with a bare 404 that reads like a missing order.
      const funder = order.funderAddress.toLowerCase();
      const funderWallet = wallets.find(w => w.address?.toLowerCase() === funder);
      if (!funderWallet) throw new Error(t("funderNotConnected", { address: shortAddr(order.funderAddress) }));

      // Built immediately before signing: the message carries an "Issued At"
      // stamp Flash only accepts within a minute of its own clock.
      const built = buildFlashUpdate({
        orderId: order.orderId,
        ...(axis === "trigger"
          ? { trigger: { price, basis: currentTrigger!.basis, triggerType: currentTrigger!.triggerType } }
          : { limit: { price, basis: currentLimit!.basis } }),
      });
      if (!built) throw new Error(t("badPrice"));

      const { signature: userSignature } = await signMessageWithWallet(
        { message: built.updateMessage },
        { address: funderWallet.address },
      );
      const res = await fetch("/api/flash/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.orderId, ...built.body, userSignature }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? t("updateFailed"));
      // A 200 means Flash ACCEPTED the update, not that it applied — it runs
      // as an async cancel-and-replace. Saying "moved to $X" here would be a
      // claim the API never made, so the row reports it as submitted and asks
      // the user to re-check.
      setUpdateSubmitted(true);
      setEditing(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.toLowerCase().includes("user rejected") ? t("updateRejectedInWallet") : t("errorPrefix", { msg: msg.slice(0, 140) }));
    } finally {
      setIsUpdating(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 0", borderTop: "1px solid var(--card-border-faint, rgba(255,255,255,0.05))" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ ...MONO, fontSize: "0.72rem", color: "var(--card-text, #fff)", fontWeight: 600, textTransform: "uppercase" }}>
            {order.side} {order.orderType}
          </span>
          <span style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)" }}>{qtyLine}</span>
        </div>
        <span style={{
          ...MONO, fontSize: "0.58rem", fontWeight: 700, textTransform: "uppercase",
          color: FLASH_ORDER_STATUS_COLOR[status] ?? "rgba(255,255,255,0.4)",
          background: `${FLASH_ORDER_STATUS_COLOR[status] ?? "rgba(255,255,255,0.4)"}1a`,
          border: `1px solid ${FLASH_ORDER_STATUS_COLOR[status] ?? "rgba(255,255,255,0.4)"}44`,
          borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap",
        }}>
          {statusLabel}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <span style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint)" }}>
          {[
            isProtection ? t("protectionRow", { entry: (order.sourceEntryOrderId ?? "").slice(0, 8) }) : null,
            currentTrigger ? t("triggerLine", { price: priceLabel(currentTrigger) }) : null,
            currentLimit ? t("limitLine", { price: priceLabel(currentLimit) }) : null,
            bracketLine,
            order.twapBucketCount ? t("twapLine", { count: order.twapBucketCount }) : null,
            filledAmount ? t("filledLine", { amount: filledAmount, symbol: order.targetAsset.ticker }) : null,
          ].filter(Boolean).join(" · ")}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {updatable && !editing && (
            <button onClick={() => { setErr(null); setDraftPrice(current!.price); setEditing(true); }}
              style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.05em", textTransform: "uppercase", padding: "4px 9px", borderRadius: 6, border: "1px solid var(--card-border, rgba(255,255,255,0.09))", background: "var(--card-bg, rgba(255,255,255,0.04))", color: "var(--card-text-muted, rgba(255,255,255,0.7))", cursor: "pointer", whiteSpace: "nowrap" }}>
              {axis === "trigger" ? t("moveTrigger") : t("movePrice")}
            </button>
          )}
          {cancellable && (
            <button onClick={cancel} disabled={isCancelling}
              style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.05em", textTransform: "uppercase", padding: "4px 9px", borderRadius: 6, border: "1px solid rgba(255,85,85,0.25)", background: "rgba(255,85,85,0.05)", color: "#ff5555", cursor: isCancelling ? "wait" : "pointer", whiteSpace: "nowrap" }}>
              {isCancelling ? t("cancelling") : t("cancelArrow")}
            </button>
          )}
        </span>
      </div>
      {editing && current && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingTop: 2 }}>
          <label htmlFor={`price-${order.orderId}`} style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)" }}>
            {current.basis === "notional" ? t("newPriceUsd") : t("newPriceRate", { symbol: order.contraAsset.ticker })}
          </label>
          <input
            id={`price-${order.orderId}`}
            value={draftPrice}
            onChange={e => setDraftPrice(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !isUpdating) void submitUpdate(); if (e.key === "Escape") setEditing(false); }}
            inputMode="decimal"
            autoComplete="off"
            style={{ ...MONO, fontSize: "0.65rem", width: 120, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--card-border, rgba(255,255,255,0.09))", background: "var(--card-surface, rgba(255,255,255,0.05))", color: "var(--card-text, #fff)" }}
          />
          <button onClick={() => void submitUpdate()} disabled={isUpdating}
            style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.05em", textTransform: "uppercase", padding: "4px 9px", borderRadius: 6, border: "1px solid rgba(245,184,0,0.3)", background: "rgba(245,184,0,0.08)", color: "#F5B800", cursor: isUpdating ? "wait" : "pointer", whiteSpace: "nowrap" }}>
            {isUpdating ? t("updating") : t("signUpdate")}
          </button>
          <button onClick={() => { setEditing(false); setErr(null); }} disabled={isUpdating}
            style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.05em", textTransform: "uppercase", padding: "4px 9px", borderRadius: 6, border: "1px solid var(--card-border-faint, rgba(255,255,255,0.05))", background: "transparent", color: "var(--card-text-faint)", cursor: "pointer", whiteSpace: "nowrap" }}>
            {t("cancelEdit")}
          </button>
        </div>
      )}
      {updateSubmitted && (
        <span style={{ ...MONO, fontSize: "0.58rem", color: "#F5B800" }}>{t("updateSubmitted")}</span>
      )}
      {err && <span style={{ ...MONO, fontSize: "0.58rem", color: "#ff5555" }}>{err}</span>}
    </div>
  );
}

function FlashOrdersDisplay({ result }: { result: FlashOrdersResult }) {
  const t = useTranslations("app.flashOrders");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const visibleOrders = result.orders;

  return (
    <div style={{ background: "var(--card-container-bg, #0D0D0D)", border: "1px solid var(--card-border, rgba(255,255,255,0.09))", borderRadius: 16, overflow: "hidden" }}>
      <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <p style={{ ...MONO, fontSize: "0.65rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--card-text-faint)", margin: 0 }}>
          {t("header")}
        </p>
        <span style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint)" }}>
          {t("orderCount", { count: visibleOrders.length })}
        </span>
      </div>
      <div style={{ padding: "2px 20px" }}>
        {visibleOrders.length === 0 ? (
          <p style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-dim)", padding: "16px 0" }}>
            {t("empty")}
          </p>
        ) : (
          visibleOrders.map(order => (
            <FlashOrderRow key={order.orderId} order={order} />
          ))
        )}
      </div>
    </div>
  );
}

// ─── RebalanceDisplay ─────────────────────────────────────────────────────────

function RebalanceDisplay({ result, connectedAddress, onTxSubmitted, slippage, onLegRefresh, onLegRevalidate, onSlippageChange }: { result: RebalanceResult; connectedAddress: string | null; onTxSubmitted?: (r: TxRecord) => void; slippage?: number; onLegRefresh?: (legIndex: number, slippageOverride?: number) => Promise<void>; onLegRevalidate?: (legIndex: number) => Promise<QuoteResult | null>; onSlippageChange?: (v: number) => void }) {
  const t = useTranslations("app.rebalance");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const total     = result.legs.length;
  const okLegs    = result.legs.filter(l => l.type === "quote").length;
  const destChain = result.legs.find(l => l.type === "quote")
    ? (result.legs.find(l => l.type === "quote") as QuoteResult).intent.to.chain
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Summary header */}
      <p style={{ ...MONO, fontSize: "0.72rem", color: "var(--card-text-dim)", margin: 0 }}>
        <span style={{ color: "#F5B800" }}>{okLegs}</span>
        {` ${t("routeCount", { count: okLegs })}`}
        {destChain ? t("consolidatingTo", { chain: destChain }) : ""}
        {t("executeInOrder")}
      </p>

      {/* One card per leg */}
      {result.legs.map((leg, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ ...MONO, fontSize: "0.6rem", letterSpacing: "0.1em", color: "var(--card-text-faint)" }}>
            {t("stepOf", { n: i + 1, total })}
          </span>
          {leg.type === "quote" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <p style={{ ...MONO, fontSize: "0.72rem", color: "var(--card-text-dim)", margin: 0 }}>
                <span style={{ color: "#F5B800" }}>{leg.route.tool}</span>
                {"  ·  "}
                <span style={{ color: "var(--card-text, #ffffff)" }}>
                  ~{leg.route.outputAmount} {leg.intent.to.token}
                </span>
                {leg.route.feesUSD && (
                  <span style={{ color: "var(--card-text-dim)" }}>
                    {"  ·  "}{t("feesAmount", { amount: Number(leg.route.feesUSD).toFixed(2) })}
                  </span>
                )}
              </p>
              <QuoteDisplay
                result={leg} connectedAddress={connectedAddress} onTxSubmitted={onTxSubmitted} slippage={slippage}
                onSlippageChange={onSlippageChange}
                onRefresh={onLegRefresh ? (slippageOverride?: number) => onLegRefresh(i, slippageOverride) : undefined}
                onRevalidate={onLegRevalidate ? () => onLegRevalidate(i) : undefined}
              />
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

// ─── PaymentsDisplay ──────────────────────────────────────────────────────────

function timeAgo(ts: number | null): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function PaymentsDisplay({ result }: { result: PaymentsResult }) {
  const t = useTranslations("app.payments");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const explorer = (chainName: string, hash: string) => `${EXPLORER_URLS[chainName] ?? "https://basescan.org/tx/"}${hash}`;
  const { payments } = result;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px", borderRadius: 12, border: "1px solid var(--card-border, rgba(255,255,255,0.09))", background: "var(--card-bg, rgba(255,255,255,0.02))" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ ...MONO, fontSize: "0.6rem", letterSpacing: "0.12em", color: "#F5B800" }}>{t("eyebrow")}</span>
        <span style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)" }}>
          {t("tagged", { count: payments.length })}
        </span>
      </div>
      {payments.length === 0 ? (
        <p style={{ ...MONO, fontSize: "0.74rem", lineHeight: 1.6, color: "var(--card-text-dim)", margin: 0 }}>
          {t("noneYet", { address: short(result.address) })}
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {payments.map(p => (
            <a key={p.txHash} href={explorer(p.chainName, p.txHash)} target="_blank" rel="noopener noreferrer"
              style={{ display: "flex", flexDirection: "column", gap: 5, padding: "11px 13px", borderRadius: 10, border: "1px solid var(--card-border, rgba(255,255,255,0.07))", background: "rgba(245,184,0,0.03)", textDecoration: "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <span style={{ ...MONO, fontSize: "0.82rem", color: "#F5B800", fontWeight: 600 }}>{p.memoText || t("noMemo")}</span>
                <span style={{ ...MONO, fontSize: "0.78rem", color: "var(--card-text, #fff)" }}>{p.amount} {p.tokenSymbol}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <span style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-faint)" }}>{t("from", { address: short(p.from), chain: p.chainName })}</span>
                <span style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-faint)" }}>{timeAgo(p.timestamp)} ↗</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── TxDisplay ────────────────────────────────────────────────────────────────

function PayRow({ label, value, mono = true }: { label: string; value: React.ReactNode; mono?: boolean }) {
  const M: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <span style={{ ...M, fontSize: "0.6rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--card-text-faint)" }}>{label}</span>
      <span style={{ ...(mono ? M : {}), fontSize: "0.74rem", color: "var(--card-text, #fff)", textAlign: "right" }}>{value}</span>
    </div>
  );
}

function PayDisplay({ result, onTxSubmitted }: { result: PayResult; onTxSubmitted?: (r: TxRecord) => void }) {
  const t = useTranslations("app.pay");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { mutateAsync: writeContract, isPending } = useWriteContract();
  const { wallets } = useWallets();
  const activeChainId = useChainId();
  const [hash, setHash] = useState<string | null>(null);
  const [err, setErr]   = useState<string | null>(null);
  const { data: receipt, isLoading: confirming, isError: receiptError } =
    useWaitForTransactionReceipt({ hash: (hash ?? undefined) as `0x${string}` | undefined, chainId: result.chainId });
  const confirmed = receipt?.status === "success";
  const failed    = receipt?.status === "reverted" || receiptError;
  const explorerBase = EXPLORER_URLS[result.chainName] ?? "https://basescan.org/tx/";
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  async function pay() {
    setErr(null);
    try {
      if (activeChainId !== result.chainId) {
        const evmWallet = wallets.find(w => w.address?.startsWith("0x"));
        if (!evmWallet) throw new Error("No EVM wallet connected.");
        await evmWallet.switchChain(result.chainId);
      }
      const h = result.method === "transferWithMemo"
        ? await writeContract({
            address: result.token as `0x${string}`,
            abi: PAY_ABI,
            functionName: "transferWithMemo",
            args: [result.to as `0x${string}`, BigInt(result.amountWei), result.memo as `0x${string}`],
            chainId: result.chainId,
          })
        : await writeContract({
            address: result.token as `0x${string}`,
            abi: PAY_ABI,
            functionName: "transfer",
            args: [result.to as `0x${string}`, BigInt(result.amountWei)],
            chainId: result.chainId,
          });
      setHash(h);
      onTxSubmitted?.({ hash: h, chainId: result.chainId, chain: result.chainName,
        label: t("payLabel", { amount: result.amountDisplay, token: result.tokenSymbol }), timestamp: Date.now(),
        explorerUrl: `${explorerBase}${h}` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.toLowerCase().includes("user rejected") ? t("rejectedInWallet") : t("errorPrefix", { msg: msg.slice(0, 120) }));
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px", borderRadius: 12, border: "1px solid var(--card-border, rgba(255,255,255,0.09))", background: "var(--card-bg, rgba(255,255,255,0.02))" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ ...MONO, fontSize: "0.6rem", letterSpacing: "0.12em", color: "#F5B800" }}>{result.isB20 ? t("b20Payment") : t("payment")}</span>
        <span style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)" }}>{result.chainName}</span>
      </div>
      <div style={{ ...MONO, fontSize: "1.1rem", color: "var(--card-text, #fff)" }}>
        {result.amountDisplay} <span style={{ color: "#F5B800" }}>{result.tokenSymbol}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 4, borderTop: "1px solid var(--card-border, rgba(255,255,255,0.06))" }}>
        <PayRow label={t("to")} value={short(result.to)} />
        {result.memoApplied && <PayRow label={result.memoHashed ? t("memoHashed") : t("memo")} value={result.memoText} mono={false} />}
        {result.memoText && !result.isB20 && <PayRow label={t("memo")} value={t("memoSkipped", { token: result.tokenSymbol })} mono={false} />}
        <PayRow label={t("token")} value={`${result.tokenSymbol} · ${short(result.token)}${result.isB20 ? " · B20" : ""}`} />
      </div>

      {err && <p style={{ ...MONO, fontSize: "0.65rem", color: "#ff5555", margin: 0 }}>{err}</p>}

      {confirmed ? (
        <a href={`${explorerBase}${hash}`} target="_blank" rel="noopener noreferrer"
          style={{ ...MONO, display: "block", width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", background: "rgba(245,184,0,0.06)", border: "1px solid rgba(245,184,0,0.3)", borderRadius: 10, color: "#F5B800", textAlign: "center", textDecoration: "none" }}>
          {t("paidConfirmed")}
        </a>
      ) : failed ? (
        <a href={`${explorerBase}${hash}`} target="_blank" rel="noopener noreferrer"
          style={{ ...MONO, display: "block", width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", background: "rgba(255,85,85,0.06)", border: "1px solid rgba(255,85,85,0.3)", borderRadius: 10, color: "#ff5555", textAlign: "center", textDecoration: "none" }}>
          {t("paymentFailed")}
        </a>
      ) : (
        <button onClick={pay} disabled={isPending || confirming}
          style={{ ...MONO, width: "100%", padding: "11px 0", fontSize: "0.72rem", letterSpacing: "0.1em", textTransform: "uppercase", background: "rgba(245,184,0,0.08)", border: "1px solid rgba(245,184,0,0.3)", borderRadius: 10, color: "#F5B800", cursor: isPending || confirming ? "wait" : "pointer" }}>
          {isPending ? t("confirmInWallet") : confirming ? t("confirmingEllipsis") : t("payArrow")}
        </button>
      )}
    </div>
  );
}

function TxDisplay({ result }: { result: TxResult }) {
  const t = useTranslations("app.tx");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { tx, summary } = result;

  const statusColor = tx.status === "success" ? "#4ade80" : tx.status === "failed" ? "#ff6b6b" : "#F5B800";
  const ts = tx.timestamp ? new Date(tx.timestamp * 1000) : null;

  type Row = { label: string; value: React.ReactNode };
  const rows: Row[] = [
    { label: t("hash"),    value: <span title={tx.hash}>{tx.hash.slice(0, 12)}…{tx.hash.slice(-8)}</span> },
    { label: t("chain"),   value: tx.chainName },
    { label: t("status"),  value: <span style={{ color: statusColor }}>{tx.status}</span> },
    { label: t("block"),   value: tx.blockNumber ? `#${tx.blockNumber.toLocaleString()}` : "—" },
    { label: t("from"),    value: <span title={tx.from}>{tx.from.slice(0, 8)}…{tx.from.slice(-6)}</span> },
    ...(tx.to ? [{ label: t("to"), value: <span title={tx.to}>{tx.to.slice(0, 8)}…{tx.to.slice(-6)}</span> }] : []),
    ...(tx.method ? [{ label: t("method"), value: <span style={{ color: "#F5B800" }}>{tx.method}</span> }] : []),
    { label: t("value"),   value: `${tx.valueEth} ETH` },
    { label: t("gas"),     value: `${tx.gasCostEth} ETH` },
    { label: t("logs"),    value: tx.logCount.toString() },
    ...(ts ? [{ label: t("time"), value: ts.toLocaleString() }] : []),
  ];

  return (
    <div style={{ background: "var(--card-container-bg, #0D0D0D)", border: "1px solid var(--card-border, rgba(255,255,255,0.09))", borderRadius: 16, overflow: "hidden" }}>
      <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <p style={{ ...MONO, fontSize: "0.65rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--card-text-faint)", margin: 0 }}>
          {t("header")}
        </p>
        <span style={{ ...MONO, fontSize: "0.6rem", letterSpacing: "0.06em", padding: "2px 8px", borderRadius: 4, background: "var(--card-border-faint, rgba(255,255,255,0.05))", color: statusColor }}>
          {tx.chainName}
        </span>
      </div>

      <div style={{ padding: "4px 16px" }}>
        {rows.map(({ label, value }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between", padding: "9px 0", borderBottom: "1px solid var(--card-border-faint, rgba(255,255,255,0.05))" }}>
            <span style={{ ...MONO, fontSize: "0.65rem", color: "var(--card-text-dim)", letterSpacing: "0.04em", flexShrink: 0 }}>{label}</span>
            <span style={{ ...MONO, fontSize: "0.72rem", color: "var(--card-text-muted, rgba(255,255,255,0.7))", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}>{value}</span>
          </div>
        ))}
      </div>

      {summary && (
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--card-border-faint, rgba(255,255,255,0.05))" }}>
          <p style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-dim)", lineHeight: 1.65, margin: 0 }}>{summary}</p>
        </div>
      )}

      <div style={{ padding: "12px 16px 16px" }}>
        <a
          href={tx.explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...MONO, display: "block", width: "100%", padding: "10px 0", fontSize: "0.72rem", letterSpacing: "0.08em", textTransform: "uppercase", textAlign: "center", background: "var(--card-header-bg, rgba(255,255,255,0.04))", border: "1px solid var(--card-border, rgba(255,255,255,0.09))", borderRadius: 10, color: "var(--card-text-muted, rgba(255,255,255,0.7))", textDecoration: "none" }}
        >
          {t("viewOnExplorer")}
        </a>
      </div>
    </div>
  );
}

// ─── AddressDisplay ───────────────────────────────────────────────────────────

function AddressDisplay({ result, onSwap }: { result: AddressResult; onSwap?: (prompt: string) => void }) {
  const t = useTranslations("app.address");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { data, summary, ensName } = result;

  const fmtUsd = (n: number) => {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
    return `$${n.toFixed(2)}`;
  };

  const total = data.totalUsdValue ?? 0;
  const nativeRows = data.balances.filter(b => parseFloat(b.native) > 0.00001);
  // Dust/no-price tokens made the card both long and confusing — same rows
  // duplicating their raw amount in place of a $ value with nothing useful
  // to show. Cap the priced list and fold everything else into one line
  // instead of a row each.
  const PRICED_TOKEN_LIMIT = 6;
  const pricedTokens   = data.tokenBalances.filter(t => (t.usdValue ?? 0) >= 0.01);
  const dustTokenCount = data.tokenBalances.length - pricedTokens.length;
  const tokenRows      = pricedTokens.slice(0, PRICED_TOKEN_LIMIT);
  const omittedPricedCount = Math.max(0, pricedTokens.length - PRICED_TOKEN_LIMIT);

  const NATIVE_SYMS = new Set(["ETH", "BNB", "AVAX", "POL", "MATIC", "XDAI", "SOL"]);
  const recentBuys = data.recentTransfers
    .filter(t => t.direction === "in" && !NATIVE_SYMS.has(t.asset) && parseFloat(t.value) > 0)
    .reduce<{ asset: string; value: string; hash: string }[]>((acc, t) => {
      if (!acc.find(r => r.asset === t.asset)) acc.push({ asset: t.asset, value: t.value, hash: t.hash });
      return acc;
    }, [])
    .slice(0, 5);

  const tokenColor = (sym: string) => {
    let h = 0;
    for (const c of sym) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h}, 62%, 56%)`;
  };

  return (
    <div style={{ background: "var(--card-container-bg, #0D0D0D)", border: "1px solid var(--card-border, rgba(255,255,255,0.09))", borderRadius: 16, overflow: "hidden", maxWidth: 520 }}>

      {/* Header */}
      <div style={{ padding: "14px 20px 12px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
          <span style={{ ...MONO, fontSize: "0.62rem", letterSpacing: "0.09em", color: "var(--card-text-faint)" }}>
            {ensName ? `${ensName} · ` : ""}{t("walletOverview")}
          </span>
          <a href={`https://etherscan.io/address/${data.address}`} target="_blank" rel="noopener noreferrer"
            style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)", textDecoration: "none" }}>
            {t("etherscan")}
          </a>
        </div>
        <span style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-dim)", letterSpacing: "0.02em" }}>
          {data.address.slice(0, 10)}…{data.address.slice(-8)}
        </span>
      </div>

      {/* Total value */}
      {total > 0 && (
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))", display: "flex", gap: 28 }}>
          <div>
            <p style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.08em", color: "var(--card-text-faint)", margin: "0 0 5px" }}>{t("totalValue")}</p>
            <p style={{ ...MONO, fontSize: "1.45rem", fontWeight: 700, color: "var(--card-text-muted, rgba(255,255,255,0.85))", margin: 0, letterSpacing: "-0.01em" }}>{fmtUsd(total)}</p>
          </div>
          {nativeRows[0] && (
            <div style={{ borderLeft: "1px solid var(--card-border, rgba(255,255,255,0.07))", paddingLeft: 28 }}>
              <p style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.08em", color: "var(--card-text-faint)", margin: "0 0 5px" }}>{t("symbolBalance", { symbol: nativeRows[0].nativeSymbol })}</p>
              <p style={{ ...MONO, fontSize: "1rem", color: "var(--card-text-muted, rgba(255,255,255,0.65))", margin: 0 }}>{nativeRows[0].native}</p>
            </div>
          )}
        </div>
      )}

      {/* AI summary */}
      {summary && (
        <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))" }}>
          <p style={{ ...MONO, fontSize: "0.76rem", color: "var(--card-text-dim)", lineHeight: 1.7, margin: 0 }}>{summary}</p>
        </div>
      )}

      {/* Token holdings */}
      {(nativeRows.length > 0 || tokenRows.length > 0) && (
        <div style={{ borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))" }}>
          <div style={{ padding: "10px 20px 6px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.08em", color: "var(--card-text-faint)" }}>{t("tokenHoldings")}</span>
            {total > 0 && <span style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-dim)" }}>{fmtUsd(total)}</span>}
          </div>

          {[
            ...nativeRows.map(b => ({
              key: `n-${b.chainId}`, sym: b.nativeSymbol, name: b.chainName,
              amount: `${b.native} ${b.nativeSymbol}`, usdValue: b.usdValue,
              chain: b.chainName, isNative: true,
              priceChange24h: null as number | null,
              onSwapStr: null as string | null,
            })),
            ...tokenRows.map(tok => ({
              key: `t-${tok.chainId}-${tok.contractAddress}`, sym: tok.symbol, name: tok.name,
              amount: `${tok.balance} ${tok.symbol}`, usdValue: tok.usdValue,
              chain: tok.chainName, isNative: false,
              priceChange24h: tok.priceChange24h ?? null as number | null,
              onSwapStr: onSwap ? `swap ${tok.balance} ${tok.symbol} to USDC on ${tok.chainName.toLowerCase()}` : null,
            })),
          ].map(row => {
            const pct   = total > 0 && row.usdValue ? (row.usdValue / total) * 100 : 0;
            const color = tokenColor(row.sym);
            return (
              <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 20px", borderTop: "1px solid var(--card-header-bg, rgba(255,255,255,0.04))" }}>
                <div style={{ width: 30, height: 30, borderRadius: 999, background: `${color}22`, border: `1px solid ${color}44`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <span style={{ ...MONO, fontSize: "0.6rem", color, fontWeight: 700 }}>{row.sym.slice(0, 2)}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                      <span style={{ ...MONO, fontSize: "0.76rem", color: "var(--card-text-muted, rgba(255,255,255,0.78))", fontWeight: 600 }}>{row.sym}</span>
                      <span style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)" }}>· {row.chain}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {row.priceChange24h != null && (
                        <span style={{
                          ...MONO, fontSize: "0.62rem", fontWeight: 600,
                          color: row.priceChange24h >= 0 ? "#22c55e" : "#ef4444",
                          background: row.priceChange24h >= 0 ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
                          border: `1px solid ${row.priceChange24h >= 0 ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)"}`,
                          borderRadius: 4, padding: "1px 5px",
                        }}>
                          {row.priceChange24h >= 0 ? "+" : ""}{row.priceChange24h.toFixed(1)}%
                        </span>
                      )}
                      <span style={{ ...MONO, fontSize: "0.78rem", fontWeight: 600, color: row.usdValue != null ? "var(--card-text-muted, rgba(255,255,255,0.82))" : "var(--card-text-faint)" }}>
                        {row.usdValue != null ? fmtUsd(row.usdValue) : t("noPriceData")}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, height: 3, borderRadius: 999, background: "var(--card-header-bg, rgba(255,255,255,0.06))", overflow: "hidden" }}>
                      {pct > 0 && <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: color, borderRadius: 999 }} />}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      <span style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint)" }}>
                        {row.amount}{pct > 0 ? ` · ${pct.toFixed(1)}%` : ""}
                      </span>
                      {row.onSwapStr && onSwap && (
                        <button
                          onClick={() => onSwap(row.onSwapStr!)}
                          style={{ ...MONO, fontSize: "0.55rem", padding: "1px 6px", borderRadius: 4, border: "1px solid rgba(245,184,0,0.2)", background: "rgba(245,184,0,0.04)", color: "rgba(245,184,0,0.5)", cursor: "pointer", whiteSpace: "nowrap" }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(245,184,0,0.45)"; e.currentTarget.style.color = "rgba(245,184,0,0.9)"; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(245,184,0,0.2)"; e.currentTarget.style.color = "rgba(245,184,0,0.5)"; }}
                        >
                          {t("swapArrow")}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {(omittedPricedCount > 0 || dustTokenCount > 0) && (
            <p style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint)", margin: 0, padding: "8px 20px", borderTop: "1px solid var(--card-header-bg, rgba(255,255,255,0.04))" }}>
              {[
                omittedPricedCount > 0 ? t("moreHoldings", { count: omittedPricedCount }) : null,
                dustTokenCount > 0 ? t("dustHoldings", { count: dustTokenCount }) : null,
              ].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      )}

      {/* Recent buys */}
      {recentBuys.length > 0 && (
        <div style={{ padding: "10px 20px 14px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))" }}>
          <p style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.08em", color: "var(--card-text-faint)", marginBottom: 8 }}>{t("recentBuys")}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {recentBuys.map(r => (
              <a key={r.hash} href={`https://etherscan.io/tx/${r.hash}`} target="_blank" rel="noopener noreferrer"
                style={{ ...MONO, fontSize: "0.68rem", padding: "4px 10px", borderRadius: 6, background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.18)", color: "rgba(74,222,128,0.8)", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: "0.55rem" }}>↓</span>
                {r.value} {r.asset}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Recent activity */}
      {data.recentTransfers.length > 0 && (
        <div style={{ padding: "10px 20px 14px" }}>
          <p style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.08em", color: "var(--card-text-faint)", marginBottom: 8 }}>{t("recentActivity")}</p>
          {data.recentTransfers.slice(0, 6).map((transfer, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderTop: i > 0 ? "1px solid var(--card-header-bg, rgba(255,255,255,0.04))" : undefined, minWidth: 0 }}>
              <span style={{ ...MONO, fontSize: "0.58rem", color: transfer.direction === "in" ? "#4ade80" : "#F5B800", letterSpacing: "0.04em", flexShrink: 0, width: 24 }}>
                {transfer.direction === "in" ? t("in") : t("out")}
              </span>
              <span style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-muted, rgba(255,255,255,0.62))", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {transfer.value} {transfer.asset}
              </span>
              <a href={`https://etherscan.io/tx/${transfer.hash}`} target="_blank" rel="noopener noreferrer"
                style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)", textDecoration: "none", flexShrink: 0 }}>
                {transfer.hash.slice(0, 7)}…
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── PriceDisplay ─────────────────────────────────────────────────────────────

// Computed once at module load — 7-day chart labels (DD/MM) evenly spaced across W=400
const PRICE_CHART_DAY_LABELS: { label: string; x: number }[] = Array.from({ length: 7 }, (_, i) => {
  const ts = Date.now() - (6 - i) * 24 * 3600 * 1000;
  const d  = new Date(ts);
  return {
    label: `${d.getDate().toString().padStart(2, "0")}/${(d.getMonth() + 1).toString().padStart(2, "0")}`,
    x: Math.round((i / 6) * 400),
  };
});

// chain ID → delora chain name (EVM only; Solana/MegaETH handled via SYMBOL_CHAIN)
const EVM_CHAIN_NAMES: Record<number, string> = {
  1:      "ethereum",
  10:     "optimism",
  56:     "bsc",
  137:    "polygon",
  42161:  "arbitrum",
  8453:   "base",
  43114:  "avalanche",
  5000:   "mantle",
  81457:  "blast",
  534352: "scroll",
  59144:  "linea",
  34443:  "mode",
  80094:  "berachain",
};

// tokens that have a known home chain (non-EVM or distinctive)
const SYMBOL_CHAIN: Record<string, string> = {
  MEGAETH: "megaeth", MEGA: "megaeth",
  SOL: "solana",      MATIC: "polygon", POL: "polygon",
  AVAX: "avalanche",  BNB: "bsc",       MNT: "mantle",
  BERA: "berachain",  CRO: "cronos",    HYPE: "hyperevm",
};

function PriceDisplay({ result, onSubmit }: { result: PriceResult; onSubmit: (text: string) => void }) {
  const t = useTranslations("app.price");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const chainId = useChainId();
  const detectedChain = EVM_CHAIN_NAMES[chainId] ?? null;

  const { symbol, name, image, price, change24h, sparkline, marketCap, volume24h, circulatingSupply, maxSupply } = result;
  const positive  = (change24h ?? 0) >= 0;
  const lineColor = positive ? "#22c55e" : "#ef4444";

  const fmtPrice = (p: number): string =>
    p >= 1000 ? `$${p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : p >= 1   ? `$${p.toFixed(4)}`
    : `$${p.toPrecision(4)}`;

  const fmtUsd = (n: number): string =>
    n >= 1e12 ? `$${(n / 1e12).toFixed(2)}T`
    : n >= 1e9  ? `$${(n / 1e9).toFixed(2)}B`
    : n >= 1e6  ? `$${(n / 1e6).toFixed(2)}M`
    : `$${n.toFixed(0)}`;

  const fmtSupply = (n: number): string =>
    n >= 1e9 ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1e3 ? `${(n / 1e3).toFixed(2)}K`
    : n.toFixed(0);

  // SVG chart — 7-day no-fill line
  const W = 400, H = 100, PAD_Y = 8;
  const pts = sparkline.length >= 2 ? (() => {
    const mn = Math.min(...sparkline), mx = Math.max(...sparkline);
    const range = mx - mn || 1;
    return sparkline.map((p, i) => ({
      x: (i / (sparkline.length - 1)) * W,
      y: H - PAD_Y - ((p - mn) / range) * (H - PAD_Y * 2),
    }));
  })() : [];

  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // Day labels are stable for the session lifetime — W=400 is a module constant
  const dayLabels = PRICE_CHART_DAY_LABELS;

  const hoverPt    = hoverIdx !== null ? pts[hoverIdx]      : null;
  const hoverPrice = hoverIdx !== null ? sparkline[hoverIdx] : null;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (pts.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct  = (e.clientX - rect.left) / rect.width;
    const idx  = Math.round(Math.max(0, Math.min(1, pct)) * (sparkline.length - 1));
    setHoverIdx(idx);
  };

  const stats: [string, string][] = [];
  if (marketCap         && marketCap         > 0) stats.push([t("marketCap"),   fmtUsd(marketCap)]);
  if (volume24h         && volume24h         > 0) stats.push([t("volume24h"),   fmtUsd(volume24h)]);
  if (circulatingSupply && circulatingSupply > 0) stats.push([t("circulating"), fmtSupply(circulatingSupply)]);
  if (maxSupply         && maxSupply         > 0) stats.push([t("maxSupply"),   fmtSupply(maxSupply)]);

  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };

  return (
    <div style={{ border: "1px solid var(--card-border)", borderRadius: 16, overflow: "hidden", maxWidth: 420, background: "var(--card-container-bg, #0D0D0D)" }}>

      {/* Header — circular icon + name/ticker left · price + change right */}
      <div style={{ padding: "16px 18px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          {image ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={image} alt={symbol} width={40} height={40} style={{ borderRadius: "50%", flexShrink: 0 }} />
          ) : (
            <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--card-surface)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ ...MONO, fontSize: "0.65rem", color: "var(--card-text-dim)" }}>{symbol.slice(0, 3)}</span>
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <p style={{ fontSize: "0.88rem", fontWeight: 600, color: "var(--card-text, #fff)", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name ?? symbol}</p>
            <p style={{ ...MONO, fontSize: "0.72rem", color: "var(--card-text-dim)", margin: "2px 0 0" }}>{symbol}</p>
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <p style={{ ...MONO, fontSize: "1.35rem", fontWeight: 700, color: "var(--card-text, #fff)", margin: 0, lineHeight: 1.1 }}>
            {fmtPrice(hoverPrice ?? price)}
          </p>
          {change24h != null && (
            <span style={{
              ...MONO, fontSize: "0.68rem", fontWeight: 600, color: lineColor,
              background: positive ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
              border: `1px solid ${lineColor}30`,
              borderRadius: 6, padding: "2px 8px", display: "inline-block", marginTop: 4,
            }}>
              {positive ? "▲" : "▼"} {Math.abs(change24h).toFixed(2)}% {t("oneDay")}
            </span>
          )}
        </div>
      </div>

      {/* 7-day no-fill line chart with hover crosshair */}
      {pts.length >= 2 && (
        <div style={{ borderTop: "1px solid var(--card-border-faint)" }}>
          <svg
            width="100%"
            viewBox={`0 0 ${W} ${H + 22}`}
            style={{ display: "block", cursor: "crosshair" }}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <path d={line} fill="none" stroke={lineColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            {hoverPt && (
              <>
                <line x1={hoverPt.x} y1={PAD_Y} x2={hoverPt.x} y2={H - PAD_Y} style={{ stroke: "var(--card-text-faint)" }} strokeWidth="1" strokeDasharray="3,3" />
                <circle cx={hoverPt.x} cy={hoverPt.y} r={3.5} fill={lineColor} style={{ stroke: "var(--card-container-bg)" }} strokeWidth="2" />
              </>
            )}
            {dayLabels.map(({ x, label }) => (
              <text key={label} x={Math.min(Math.max(x, 16), W - 16)} y={H + 17} textAnchor="middle" fontSize="9" style={{ fill: "var(--card-text-faint)" }} fontFamily="monospace">{label}</text>
            ))}
          </svg>
        </div>
      )}

      {/* Stats grid — 2 columns */}
      {stats.length > 0 && (
        <div style={{ borderTop: "1px solid var(--card-border-faint)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1px", background: "var(--card-border-faint)" }}>
          {stats.map(([label, val]) => (
            <div key={label} style={{ padding: "10px 14px", background: "var(--card-container-bg, #0D0D0D)" }}>
              <p style={{ ...MONO, fontSize: "0.57rem", color: "var(--card-text-faint)", margin: "0 0 3px", letterSpacing: "0.07em", textTransform: "uppercase" }}>{label}</p>
              <p style={{ ...MONO, fontSize: "0.82rem", color: "var(--card-text, #fff)", margin: 0 }}>{val}</p>
            </div>
          ))}
        </div>
      )}

      {/* Buy / Sell buttons — submit to chat, backend responds with swap suggestions */}
      <div style={{ padding: "12px 16px", display: "flex", gap: 8, borderTop: "1px solid var(--card-border-faint)" }}>
        <button
          onClick={() => {
            const chain = detectedChain ?? "ethereum";
            onSubmit(`buy ${symbol} on ${chain}`);
          }}
          style={{ flex: 1, padding: "9px 0", borderRadius: 10, border: "none", background: "#F5B800", color: "#000", fontSize: "0.82rem", fontWeight: 700, cursor: "pointer" }}
        >
          {t("buySymbol", { symbol })}
        </button>
        <button
          onClick={() => {
            const impliedChain = SYMBOL_CHAIN[symbol] ?? detectedChain ?? null;
            const msg = impliedChain ? `sell ${symbol} on ${impliedChain}` : `sell ${symbol}`;
            onSubmit(msg);
          }}
          style={{ flex: 1, padding: "9px 0", borderRadius: 10, border: "1px solid var(--card-border)", background: "transparent", color: "var(--card-text-muted)", fontSize: "0.82rem", fontWeight: 600, cursor: "pointer" }}
        >
          {t("sellSymbol", { symbol })}
        </button>
      </div>
    </div>
  );
}

// ─── Sparkline ────────────────────────────────────────────────────────────────

function Sparkline({ prices, positive, width = 280, height = 64 }: { prices: number[]; positive: boolean; width?: number; height?: number }) {
  if (prices.length < 2) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const pts = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * width;
    const y = height - ((p - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const color = positive ? "#22c55e" : "#ef4444";
  const fillColor = positive ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)";
  const pathD = `M ${pts.join(" L ")}`;
  const fillD = `M 0,${height} L ${pts.join(" L ")} L ${width},${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
      <path d={fillD} fill={fillColor} />
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── TokenRiskDisplay ─────────────────────────────────────────────────────────

type SmRow = Record<string, unknown>;

// Field names from Nansen's TGMWhoBoughtSold OpenAPI schema, with looser
// fallbacks first in case the wrapper shape shifts. trade_volume_usd is the net
// USD (buy − sell) — the accumulating(+)/exiting(−) signal.
const SM_FIELDS = {
  address: ["address", "wallet_address", "wallet", "walletAddress", "owner"],
  label:   ["address_label", "label", "entity", "name", "smart_money_label"],
  bought:  ["bought_volume_usd", "volume_bought_usd", "buy_volume_usd"],
  sold:    ["sold_volume_usd", "volume_sold_usd", "sell_volume_usd"],
  net:     ["trade_volume_usd", "net_flow_usd", "net_volume_usd", "net_usd"],
};

function smRows(data: unknown): SmRow[] {
  if (Array.isArray(data)) return data as SmRow[];
  if (data && typeof data === "object") {
    for (const k of ["data", "result", "rows", "items", "holders", "traders"]) {
      const v = (data as SmRow)[k];
      if (Array.isArray(v)) return v as SmRow[];
    }
  }
  return [];
}

function pickStr(row: SmRow, keys: string[]): string | null {
  for (const k of keys) { const v = row[k]; if (typeof v === "string" && v) return v; }
  return null;
}

function pickNum(row: SmRow, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function fmtUsdShort(n: number): string {
  const abs = Math.abs(n);
  const s = abs >= 1e9 ? `${(abs / 1e9).toFixed(1)}B`
    : abs >= 1e6 ? `${(abs / 1e6).toFixed(1)}M`
    : abs >= 1e3 ? `${(abs / 1e3).toFixed(1)}K`
    : abs.toFixed(0);
  return `${n < 0 ? "-" : ""}$${s}`;
}

const SM_EXPLORER: Record<string, string> = {
  ethereum: "https://etherscan.io/address/",
  base:     "https://basescan.org/address/",
  arbitrum: "https://arbiscan.io/address/",
  polygon:  "https://polygonscan.com/address/",
  solana:   "https://solscan.io/account/",
};

function SmartMoneyPanel({ data, chain, tf }: { data: unknown; chain: string | null; tf?: string }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const shorten = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
  const explorerBase = chain ? SM_EXPLORER[chain] : undefined;
  const rows = smRows(data);

  if (rows.length === 0) {
    return (
      <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)" }}>
        <p style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-dim)", margin: 0 }}>
          No wallet trades found for this token in the last 30 days.
        </p>
      </div>
    );
  }

  const parsed = rows.map((r) => {
    const bought = pickNum(r, SM_FIELDS.bought);
    const sold = pickNum(r, SM_FIELDS.sold);
    let net = pickNum(r, SM_FIELDS.net);
    if (net === null && bought !== null && sold !== null) net = bought - sold;
    return { id: pickStr(r, SM_FIELDS.address), label: pickStr(r, SM_FIELDS.label), net };
  }).filter((p) => p.id || p.label || p.net !== null);

  if (parsed.length === 0) {
    return (
      <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)" }}>
        <p style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-dim)", margin: "0 0 6px" }}>
          Read complete — {rows.length} record(s), unrecognized shape.
        </p>
        <pre style={{ ...MONO, fontSize: "0.55rem", color: "var(--card-text-faint)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 160, overflow: "auto" }}>
          {JSON.stringify(data, null, 2).slice(0, 600)}
        </pre>
      </div>
    );
  }

  const sorted = [...parsed].sort((a, b) => (b.net ?? 0) - (a.net ?? 0)).slice(0, 6);
  const totalNet = parsed.reduce((s, p) => s + (p.net ?? 0), 0);
  const accumulating = totalNet >= 0;

  return (
    <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 2 }}>
        <span style={{ ...MONO, fontSize: "0.58rem", fontWeight: 700, letterSpacing: "0.1em", color: "var(--card-text-faint)" }}>
          TOP WALLETS · {(tf ?? "30d").toUpperCase()} · {parsed.length} TRADER{parsed.length === 1 ? "" : "S"}
        </span>
        <span style={{ ...MONO, fontSize: "0.66rem", fontWeight: 700, color: accumulating ? "#22c55e" : "#ef4444", whiteSpace: "nowrap" }}>
          {accumulating ? "▲ accumulating" : "▼ exiting"} {fmtUsdShort(totalNet)}
        </span>
      </div>
      {sorted.map((p, i) => {
        const positive = (p.net ?? 0) >= 0;
        const display = p.label ?? (p.id ? shorten(p.id) : "Unknown");
        const href = p.id && explorerBase ? `${explorerBase}${p.id}` : null;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer"
                title={p.id ?? undefined}
                style={{ ...MONO, fontSize: "0.66rem", color: "var(--card-text, #ffffff)", textDecoration: "none", borderBottom: "1px dotted var(--card-text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {display}
              </a>
            ) : (
              <span style={{ ...MONO, fontSize: "0.66rem", color: "var(--card-text, #ffffff)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {display}
              </span>
            )}
            {p.net !== null && (
              <span style={{ ...MONO, fontSize: "0.66rem", fontWeight: 700, color: positive ? "#22c55e" : "#ef4444", whiteSpace: "nowrap" }}>
                {positive ? "▲" : "▼"} {fmtUsdShort(p.net)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PaywallDisplay({ result, onConnect, onSwitchToFast }: {
  result: PaywallResult;
  onConnect: () => void;
  onSwitchToFast: () => void;
}) {
  const t = useTranslations("app.paywall");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const ACCENT = "#F5B800";
  const isConnect = result.reason === "connect";

  const { data: walletClient } = useWalletClient();
  const { login, logout, authenticated } = usePrivy();
  const { fundWallet } = useFundWallet();
  const [subState, setSubState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [subMessage, setSubMessage] = useState<string | null>(null);

  // Untested at live settlement — first real run needs a connected, funded wallet.
  async function handleSubscribe() {
    if (!walletClient) {
      setSubMessage(t("connectThenSubscribe"));
      if (authenticated) await logout().catch(() => {});
      login();
      return;
    }
    setSubState("loading");
    setSubMessage(null);
    try {
      const res = await subscribe(walletClient);
      if (res.ok) {
        setSubState("done");
        setSubMessage(t("smartUnlocked"));
      } else {
        setSubState("error");
        setSubMessage(res.error ?? t("subscriptionFailed"));
      }
    } catch (err) {
      setSubState("error");
      setSubMessage(err instanceof Error ? err.message : t("paymentFailed"));
    }
  }

  const title = isConnect ? t("titleConnect") : t("titleLimitReached");
  const body = isConnect
    ? t("bodyConnect", { cap: result.cap })
    : t("bodyLimitReached", { cap: result.cap });

  const note = subState === "done" || subState === "error" ? subMessage : body;
  const noteColor =
    subState === "error" ? "#ef4444"
    : subState === "done" ? ACCENT
    : "var(--card-text-dim)";

  const btnBase: React.CSSProperties = {
    ...MONO, fontSize: "0.7rem", fontWeight: 600, padding: "9px 14px", borderRadius: 10,
    cursor: "pointer", border: "1px solid", textAlign: "center", flex: 1,
  };

  return (
    <div style={{ border: "1px solid rgba(245,184,0,0.22)", borderRadius: 16, overflow: "hidden", maxWidth: 380, background: "var(--card-container-bg, #0D0D0D)" }}>
      <div style={{ padding: "14px 18px 4px", display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: "0.78rem", color: ACCENT }}>✦</span>
        <span style={{ ...MONO, fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.14em", color: ACCENT }}>
          {t("smartTier")}
        </span>
      </div>
      <div style={{ padding: "0 18px 16px" }}>
        <p style={{ ...MONO, fontSize: "0.95rem", fontWeight: 700, color: "var(--card-text, #ffffff)", margin: "0 0 6px", lineHeight: 1.3 }}>
          {title}
        </p>
        <p style={{ ...MONO, fontSize: "0.72rem", lineHeight: 1.6, color: noteColor, margin: "0 0 14px" }}>
          {note}
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          {isConnect ? (
            <button
              type="button"
              onClick={onConnect}
              style={{ ...btnBase, borderColor: "rgba(245,184,0,0.4)", background: "rgba(245,184,0,0.1)", color: ACCENT }}
            >
              {t("connectWallet")}
            </button>
          ) : subState !== "done" && (
            <button
              type="button"
              onClick={handleSubscribe}
              disabled={subState === "loading"}
              style={{ ...btnBase, borderColor: "rgba(245,184,0,0.4)", background: "rgba(245,184,0,0.1)", color: ACCENT, opacity: subState === "loading" ? 0.6 : 1 }}
            >
              {subState === "loading" ? t("confirming") : t("subscribe")}
            </button>
          )}
          <button
            type="button"
            onClick={onSwitchToFast}
            style={{ ...btnBase, borderColor: "var(--card-border, rgba(255,255,255,0.12))", background: "transparent", color: "var(--card-text-dim)" }}
          >
            {t("switchToFast")}
          </button>
        </div>
        {!isConnect && subState === "error" && walletClient?.account && (
          <button
            type="button"
            onClick={() => fundWallet({ address: walletClient.account!.address })}
            style={{ ...MONO, fontSize: "0.6rem", fontWeight: 600, color: ACCENT, background: "transparent", border: "none", cursor: "pointer", margin: "12px 0 0", padding: 0, width: "100%", textAlign: "center" }}
          >
            {t("needUsdcFundWallet")}
          </button>
        )}
      </div>
    </div>
  );
}

const AEON_CALLS: Record<string, string> = {
  RIDE: "#22c55e",
  FADE: "#ef4444",
  SKIP: "var(--card-text-faint)",
  "FRONT-RUN": "#F5B800",
  "FRONT RUN": "#F5B800",
};
const AEON_VIOLET = "#a78bfa";

// Color the call keywords (RIDE/FADE/SKIP/FRONT-RUN) so takeaways pop.
function colorCalls(s: string, keyBase: string): React.ReactNode[] {
  return s.split(/(\bRIDE\b|\bFADE\b|\bSKIP\b|\bFRONT[-\s]RUN\b)/gi).map((p, i) => {
    const c = AEON_CALLS[p.toUpperCase()];
    return c
      ? <span key={`${keyBase}-${i}`} style={{ color: c, fontWeight: 700 }}>{p}</span>
      : <span key={`${keyBase}-${i}`}>{p}</span>;
  });
}

// Inline: **bold** + call coloring.
function inlineNodes(s: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  s.split(/(\*\*[^*]+\*\*)/g).forEach((seg, i) => {
    if (!seg) return;
    if (/^\*\*[^*]+\*\*$/.test(seg)) {
      out.push(
        <strong key={`${keyBase}-b${i}`} style={{ color: "var(--card-text, #fff)", fontWeight: 700 }}>
          {colorCalls(seg.slice(2, -2), `${keyBase}-b${i}`)}
        </strong>,
      );
    } else {
      out.push(...colorCalls(seg, `${keyBase}-t${i}`));
    }
  });
  return out;
}

// Markdown-lite renderer for the agent read: title, numbered sections, bullets,
// inline labels, bold, and colored calls.
function AeonMarkdown({ text, accent = AEON_VIOLET }: { text: string; accent?: string }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const BODY: React.CSSProperties = { ...MONO, fontSize: "0.76rem", lineHeight: 1.6, color: "var(--card-text, #ffffff)", margin: 0 };
  const lines = text.replace(/\r/g, "").split("\n");
  const firstIdx = lines.findIndex((l) => l.trim() !== "");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {lines.map((raw, i) => {
        const line = raw.replace(/\s+$/, "");
        if (line.trim() === "") return <div key={i} style={{ height: 6 }} />;

        if (i === firstIdx) {
          return (
            <p key={i} style={{ ...MONO, fontSize: "0.85rem", fontWeight: 700, color: "var(--card-text, #fff)", margin: "0 0 4px", lineHeight: 1.3 }}>
              {inlineNodes(line, `l${i}`)}
            </p>
          );
        }

        const num = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
        if (num) {
          return (
            <p key={i} style={{ ...MONO, fontSize: "0.78rem", fontWeight: 700, color: "var(--card-text, #fff)", margin: "9px 0 1px", lineHeight: 1.5 }}>
              <span style={{ color: accent }}>{num[1]}.</span> {inlineNodes(num[2], `l${i}`)}
            </p>
          );
        }

        const bul = line.match(/^\s*[-•*]\s+(.*)$/);
        if (bul) {
          return (
            <div key={i} style={{ display: "flex", gap: 8, paddingLeft: 2 }}>
              <span style={{ ...MONO, color: accent, fontSize: "0.76rem", lineHeight: 1.72 }}>·</span>
              <span style={BODY}>{inlineNodes(bul[1], `l${i}`)}</span>
            </div>
          );
        }

        const lab = line.match(/^([A-Za-z][A-Za-z /&]{1,22}):\s+(.*)$/);
        if (lab && lab[2]) {
          return (
            <p key={i} style={BODY}>
              <span style={{ color: "var(--card-text-dim)", fontWeight: 600 }}>{lab[1]}:</span> {inlineNodes(lab[2], `l${i}`)}
            </p>
          );
        }

        return <p key={i} style={BODY}>{inlineNodes(line, `l${i}`)}</p>;
      })}
    </div>
  );
}

function AeonDisplay({ result }: { result: AeonResult }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const ACCENT = "#F5B800";
  const { kind, title, subtitle, premium } = result;
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  // Served from the Aeon fork's cache (lib/aeonFeed.ts) — a single fetch, no
  // polling. The fork's cron runs every few hours, so a miss is brief.
  async function handleRead() {
    setState("loading");
    setMessage(null);
    try {
      const sub = await fetch("/api/aeon/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const subData = await sub.json();
      if (sub.ok && subData.ok && typeof subData.text === "string" && subData.text) {
        setText(subData.text);
        setState("done");
        return;
      }
      setState("error");
      setMessage(subData.error ?? "Couldn't get the read.");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Request failed.");
    }
  }

  return (
    <div style={{ border: "1px solid var(--card-border)", borderRadius: 14, overflow: "hidden", maxWidth: 340, background: "var(--card-container-bg, #0D0D0D)" }}>
      <div style={{ padding: "9px 13px 5px", display: "flex", alignItems: "center", gap: 7 }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="3.2" />
        </svg>
        <span style={{ ...MONO, fontSize: "0.56rem", fontWeight: 700, letterSpacing: "0.13em", color: ACCENT }}>{({ defi: "DEFI READ", narrative: "NARRATIVE", trending: "TRENDING", protocols: "TOP TVL", onchain: "ONCHAIN", fear: "FEAR DIVERGENCE", x402: "X402 PULSE", tokenpick: "TOKEN PICK", pickstracker: "PICKS TRACKER" } as Record<string, string>)[kind] ?? "READ"}</span>
        <span style={{ ...MONO, fontSize: "0.54rem", color: "var(--card-text-faint)", marginLeft: "auto" }}>daily · skopos</span>
      </div>

      <div style={{ padding: "0 13px 10px" }}>
        <p style={{ ...MONO, fontSize: "0.98rem", fontWeight: 700, color: "var(--card-text, #ffffff)", margin: "0 0 3px", lineHeight: 1.2 }}>{title}</p>
        <p style={{ ...MONO, fontSize: "0.68rem", lineHeight: 1.5, color: "var(--card-text-dim)", margin: 0 }}>{subtitle}</p>
      </div>

      {premium && (
        <div style={{ padding: "9px 13px", borderTop: "1px solid var(--card-border-faint)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "var(--card-surface)" }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ ...MONO, fontSize: "0.72rem", fontWeight: 600, color: "var(--card-text, #ffffff)", margin: "0 0 2px" }}>{premium.label}</p>
            <p style={{ ...MONO, fontSize: "0.58rem", color: state === "error" ? "#ef4444" : "var(--card-text-faint)", margin: 0 }}>
              {message ?? (state === "loading" ? "Fetching the read…" : premium.note)}
            </p>
          </div>
          <button
            onClick={handleRead}
            disabled={!premium.available || state === "loading"}
            style={{
              ...MONO, fontSize: "0.66rem", fontWeight: 700,
              color: premium.available ? ACCENT : "var(--card-text-faint)",
              background: premium.available ? `${ACCENT}18` : "transparent",
              border: `1px solid ${premium.available ? `${ACCENT}40` : "var(--card-border)"}`,
              borderRadius: 8, padding: "6px 12px", whiteSpace: "nowrap",
              cursor: premium.available && state !== "loading" ? "pointer" : "default",
              opacity: premium.available ? 1 : 0.65,
            }}
          >
            {state === "loading" ? "…" : state === "done" ? "✓" : premium.available ? "Read" : "Soon"}
          </button>
        </div>
      )}

      {state === "done" && text && (
        <div style={{ padding: "11px 13px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)" }}>
          <AeonMarkdown text={text} accent="#F5B800" />
        </div>
      )}
    </div>
  );
}

function IntelDisplay({ result }: { result: IntelResult }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const ACCENT = "#38bdf8";
  const { context, token, premium, direction, read, screenChain, timeframe } = result;
  const isToken = !!token;
  const isWeb = !!context;
  const isScreener = read === "screener";

  const ENDPOINT: Record<string, string> = {
    "smart-money": "/api/intel/smart-money",
    holders: "/api/intel/holders",
    flows: "/api/intel/flows",
    "flow-intel": "/api/intel/flow-intel",
    screener: "/api/intel/screener",
  };
  const endpoint = ENDPOINT[read ?? "smart-money"] ?? "/api/intel/smart-money";

  const EYEBROW: Record<string, string> = {
    "smart-money": "TOKEN INTEL", holders: "TOKEN HOLDERS",
    flows: "FLOW TREND", "flow-intel": "FLOW INTEL", screener: "SMART MONEY",
  };
  const DESC: Record<string, string> = {
    "smart-money": "See which wallets are accumulating or exiting this token (top traders by net flow).",
    holders: "See the biggest holders — how concentrated the supply is, and who's been adding or trimming.",
    flows: "Track how smart money's position in this token has grown or shrunk over the last 30 days.",
    "flow-intel": "See where this token is flowing — smart traders, whales, fresh wallets, and exchanges.",
    screener: "The tokens smart money is buying right now, ranked by net inflow across chains.",
  };

  const shorten = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  const { data: walletClient } = useWalletClient();
  const activeChainId = useChainId();
  const { wallets } = useWallets();
  const { login, logout, authenticated } = usePrivy();
  const [smState, setSmState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [smMessage, setSmMessage] = useState<string | null>(null);
  const [smData, setSmData] = useState<unknown>(null);

  async function handleSmartMoney() {
    if (!token && !isScreener) return;

    // Agent-paid: Skopos's wallet fronts the x402 fee server-side, so the browser
    // needs no wallet, no chain switch, no signature — one tap and the data lands.
    if (premium?.mode === "agent") {
      setSmState("loading");
      setSmMessage(null);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(isScreener ? { chain: screenChain ?? null, timeframe } : { token, direction, timeframe }),
        });
        const payload = await res.json();
        if (res.ok && payload.ok) {
          setSmData(payload.data);
          setSmState("done");
          setSmMessage(null);
        } else {
          setSmState("error");
          setSmMessage(payload.error ?? "Request failed.");
        }
      } catch (err) {
        setSmState("error");
        setSmMessage(err instanceof Error ? err.message : "Request failed.");
      }
      return;
    }

    // User-signed x402 fallback — only smart-money has one; other reads are
    // agent-paid only, so they always return above. token is defined here.
    if (!token) return;
    if (!walletClient) {
      // Reuse the app's existing Privy connect (mirrors handleWalletAction):
      // reconnect a ghost session, otherwise open login.
      setSmState("idle");
      setSmMessage("Connect your wallet, then tap again to pay $0.01.");
      if (authenticated) await logout().catch(() => {});
      login();
      return;
    }
    // The x402 read settles in USDC on Base (8453). If the wallet is on another
    // chain, switch first (direct call hits MetaMask, not Privy's embedded
    // connector), then ask the user to tap again — the re-render hands us a Base
    // wallet client to build the payment with. Avoids the chainId-mismatch error.
    if (activeChainId !== 8453) {
      const evm = wallets.find(w => w.address?.startsWith("0x"));
      if (!evm) { setSmMessage("Connect an EVM wallet first."); return; }
      setSmState("loading");
      try {
        await evm.switchChain(8453); // Privy: switches embedded silently, prompts external
      } catch (e) {
        setSmState("error");
        setSmMessage(e instanceof Error ? `Couldn't switch to Base: ${e.message.slice(0, 90)}` : "Couldn't switch to Base.");
        return;
      }
      setSmState("idle");
      setSmMessage("Switched to Base. Tap again to pay $0.01.");
      return;
    }
    setSmState("loading");
    setSmMessage(null);
    try {
      const res = await fetchSmartMoney(walletClient, token, direction);
      if (res.ok) {
        setSmData(res.data);
        setSmState("done");
        setSmMessage(null);
      } else {
        setSmState("error");
        setSmMessage(res.error ?? "Request failed.");
      }
    } catch (err) {
      setSmState("error");
      setSmMessage(err instanceof Error ? err.message : "Payment failed.");
    }
  }

  return (
    <div style={{ border: "1px solid var(--card-border)", borderRadius: 16, overflow: "hidden", maxWidth: 400, background: "var(--card-container-bg, #0D0D0D)" }}>

      {/* Eyebrow: distinct intel identity */}
      <div style={{ padding: "12px 18px 8px", display: "flex", alignItems: "center", gap: 8 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <span style={{ ...MONO, fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.14em", color: ACCENT }}>
          {isWeb ? "WEB INTEL" : (EYEBROW[read ?? "smart-money"] ?? "TOKEN INTEL")}
        </span>
        <span style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)", marginLeft: "auto" }}>
          {isWeb
            ? context!.sourceHost
            : isScreener
              ? "across chains"
              : [token!.chain, token!.address ? shorten(token!.address) : null].filter(Boolean).join(" · ") || "on-chain"}
        </span>
      </div>

      {isWeb ? (
        /* Web mode — free Jina context */
        <div style={{ padding: "0 18px 14px" }}>
          <a href={context!.url} target="_blank" rel="noopener noreferrer"
            style={{ ...MONO, fontSize: "0.95rem", fontWeight: 700, color: "var(--card-text, #ffffff)", textDecoration: "none", lineHeight: 1.3, display: "block", marginBottom: 8 }}>
            {context!.title}
          </a>
          <p style={{ ...MONO, fontSize: "0.74rem", lineHeight: 1.6, color: "var(--card-text-dim)", margin: 0 }}>
            {context!.excerpt}
          </p>
        </div>
      ) : isScreener ? (
        /* Screener mode — discovery, no token target */
        <div style={{ padding: "0 18px 14px" }}>
          <p style={{ ...MONO, fontSize: "1.15rem", fontWeight: 700, color: "var(--card-text, #ffffff)", margin: "0 0 4px", lineHeight: 1.2 }}>
            Smart money is buying
          </p>
          <p style={{ ...MONO, fontSize: "0.72rem", lineHeight: 1.6, color: "var(--card-text-dim)", margin: 0 }}>
            {DESC.screener}
          </p>
        </div>
      ) : (
        /* Token mode — header is the target token */
        <div style={{ padding: "0 18px 14px" }}>
          <p style={{ ...MONO, fontSize: "1.15rem", fontWeight: 700, color: "var(--card-text, #ffffff)", margin: "0 0 4px", lineHeight: 1.2 }}>
            {token!.symbol ? `$${token!.symbol}` : (token!.address ? shorten(token!.address) : "Token")}
          </p>
          <p style={{ ...MONO, fontSize: "0.72rem", lineHeight: 1.6, color: "var(--card-text-dim)", margin: 0 }}>
            {DESC[read ?? "smart-money"] ?? DESC["smart-money"]}
          </p>
        </div>
      )}

      {/* Premium upsell — gated pay-to-call. Only meaningful with a token target. */}
      {premium && (
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "var(--card-surface)" }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ ...MONO, fontSize: "0.72rem", fontWeight: 600, color: "var(--card-text, #ffffff)", margin: "0 0 2px" }}>{premium.label}</p>
            <p style={{ ...MONO, fontSize: "0.58rem", color: smState === "error" ? "#ef4444" : "var(--card-text-faint)", margin: 0 }}>
              {smMessage ?? premium.note}
            </p>
          </div>
          <button
            onClick={handleSmartMoney}
            disabled={!premium.available || smState === "loading"}
            style={{
              ...MONO, fontSize: "0.66rem", fontWeight: 700,
              color: premium.available ? ACCENT : "var(--card-text-faint)",
              background: premium.available ? `${ACCENT}18` : "transparent",
              border: `1px solid ${premium.available ? `${ACCENT}40` : "var(--card-border)"}`,
              borderRadius: 8, padding: "6px 12px", whiteSpace: "nowrap",
              cursor: premium.available && smState !== "loading" ? "pointer" : "default",
              opacity: premium.available ? 1 : 0.65,
            }}
          >
            {smState === "loading" ? "…" : smState === "done" ? "✓" : premium.mode === "agent" ? premium.price : !walletClient ? "Connect" : premium.price}
          </button>
        </div>
      )}

      {smState === "done" && smData != null && (
        read === "holders" ? <HoldersPanel data={smData} chain={token?.chain ?? null} />
        : read === "flows" ? <FlowsPanel data={smData} />
        : read === "flow-intel" ? <FlowIntelPanel data={smData} tf={timeframe ?? undefined} />
        : read === "screener" ? <ScreenerPanel data={smData} tf={timeframe ?? undefined} />
        : <SmartMoneyPanel data={smData} chain={token?.chain ?? null} tf={timeframe ?? undefined} />
      )}
    </div>
  );
}

function X402CheckDisplay({ result }: { result: X402CheckResult }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const ACCENT = "#38bdf8";
  const { url, method, discovery } = result;
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();

  const { data: walletClient } = useWalletClient();
  const activeChainId = useChainId();
  const { wallets } = useWallets();
  const { login, logout, authenticated } = usePrivy();
  const { fundWallet } = useFundWallet();
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [data, setData] = useState<unknown>(null);

  const address = walletClient?.account?.address;
  const onBase  = activeChainId === 8453;
  const priceUsd = discovery.ok ? Number(discovery.priceUsd ?? "0") : 0;

  // Live balance reads, polled while connected on Base — this is how the funding
  // panel below knows to disappear the moment a covering swap actually confirms
  // on-chain, with no callback threaded through the nested QuoteDisplay for it.
  // USDC is an ERC-20 read (this wagmi build's useBalance has no `token` option,
  // same reason the wallet-status panel above reads it via useReadContract).
  const { data: usdcRaw } = useReadContract({
    address: USDC_ADDRESSES[8453], abi: ERC20_ABI, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId: 8453,
    query: { enabled: !!address && onBase, refetchInterval: 4000 },
  });
  const { data: ethBal } = useBalance({
    address, chainId: 8453,
    query: { enabled: !!address && onBase, refetchInterval: 4000 },
  });

  const usdcHeld   = usdcRaw != null ? Number(usdcRaw as bigint) / 1e6 : 0;
  const shortfall  = discovery.ok && address && onBase ? Math.max(0, priceUsd - usdcHeld) : 0;
  const needsCover = shortfall > 0;
  const hasEth     = !!ethBal && ethBal.value > BigInt(0);

  const [swapQuote, setSwapQuote]       = useState<QuoteResult | null>(null);
  const [swapFetching, setSwapFetching] = useState(false);
  const [swapError, setSwapError]       = useState<string | null>(null);
  const fetchedForRef = useRef<string | null>(null);

  // A stale offer (from a resolved shortfall, or a wallet/chain change) shouldn't
  // linger — clearing it lets the next real shortfall fetch a fresh one.
  useEffect(() => {
    if (!needsCover) { setSwapQuote(null); setSwapError(null); fetchedForRef.current = null; }
  }, [needsCover]);

  // Fetching a quote signs nothing and moves no funds, so this runs automatically
  // the moment a real shortfall + a coverable ETH balance are both true — the
  // user still explicitly reviews and signs the swap itself, via the nested
  // QuoteDisplay below. Keyed on (address, shortfall) so it only fires once per
  // distinct gap, not on every balance-poll tick.
  useEffect(() => {
    const key = `${address}:${shortfall.toFixed(6)}`;
    if (needsCover && hasEth && !swapFetching && fetchedForRef.current !== key) {
      fetchedForRef.current = key;
      void fetchCoverSwap();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsCover, hasEth, address, shortfall]);

  // Reuses the exact same swap pipeline as the main chat (classifyIntent →
  // parseIntent → resolveLeg) via /api/chat — no separate quote code path to
  // drift out of sync. Needs a live ETH price first since the swap message
  // takes a token amount, not a dollar target; +25% buffer absorbs the swap's
  // own price impact/slippage so the shortfall doesn't come up short again
  // right after this one lands.
  async function fetchCoverSwap() {
    if (!address || shortfall <= 0) return;
    setSwapFetching(true);
    setSwapError(null);
    try {
      const priceRes = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "eth price" }),
      });
      const priceCard = await priceRes.json();
      const ethUsd = typeof priceCard?.price === "number" ? priceCard.price : null;
      if (!ethUsd || ethUsd <= 0) throw new Error("Couldn't price ETH right now.");

      const ethNeeded = (shortfall * 1.25) / ethUsd;
      const quoteRes = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `swap ${ethNeeded.toFixed(8)} ETH to USDC on base`, senderAddress: address }),
      });
      const quoteCard = await quoteRes.json();
      if (quoteCard?.type === "quote" && quoteCard.calldata) {
        setSwapQuote(quoteCard as QuoteResult);
      } else {
        setSwapError(quoteCard?.text ?? "Couldn't find a swap to cover this right now.");
      }
    } catch (err) {
      setSwapError(err instanceof Error ? err.message : "Couldn't get a covering swap quote.");
    } finally {
      setSwapFetching(false);
    }
  }

  const swapFeeUsd    = swapQuote?.route.feesUSD ? Number(swapQuote.route.feesUSD) : 0;
  const totalCostUsd  = priceUsd + (swapQuote ? swapFeeUsd : 0);

  async function handlePay() {
    if (!discovery.ok) return;
    if (!walletClient) {
      // This endpoint is unknown to Skopos — the user's own wallet pays, never
      // Skopos's agent wallet (docs/paid-data-sources.md draws that line on
      // purpose). Reuses the same reconnect-ghost-session pattern as IntelDisplay.
      setState("idle");
      setMessage(`Connect your wallet, then tap again to pay $${discovery.priceUsd ?? "?"}.`);
      if (authenticated) await logout().catch(() => {});
      login();
      return;
    }
    if (activeChainId !== 8453) {
      const evm = wallets.find(w => w.address?.startsWith("0x"));
      if (!evm) { setMessage("Connect an EVM wallet first."); return; }
      setState("loading");
      try {
        await evm.switchChain(8453);
      } catch (e) {
        setState("error");
        setMessage(e instanceof Error ? `Couldn't switch to Base: ${e.message.slice(0, 90)}` : "Couldn't switch to Base.");
        return;
      }
      setState("idle");
      setMessage("Switched to Base. Tap again to pay.");
      return;
    }
    setState("loading");
    setMessage(null);
    try {
      const res = await callX402Endpoint(walletClient, url, method);
      if (res.ok) {
        setData(res.data);
        setState("done");
        setMessage(null);
      } else {
        setState("error");
        setMessage(res.error ?? "Request failed.");
      }
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Payment failed.");
    }
  }

  return (
    <div style={{ border: "1px solid var(--card-border)", borderRadius: 16, overflow: "hidden", maxWidth: 400, background: "var(--card-container-bg, #0D0D0D)" }}>
      <div style={{ padding: "12px 18px 8px", display: "flex", alignItems: "center", gap: 8 }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="10" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span style={{ ...MONO, fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.14em", color: ACCENT }}>x402 ENDPOINT</span>
        <span style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)", marginLeft: "auto" }}>{host}</span>
      </div>

      <div style={{ padding: "0 18px 14px" }}>
        <p style={{ ...MONO, fontSize: "0.95rem", fontWeight: 700, color: "var(--card-text, #ffffff)", margin: "0 0 4px", lineHeight: 1.3, wordBreak: "break-word" }}>
          {discovery.ok ? (discovery.description ?? "Paid endpoint") : "Couldn't reach this endpoint"}
        </p>
        <p style={{ ...MONO, fontSize: "0.72rem", lineHeight: 1.6, color: "var(--card-text-dim)", margin: 0 }}>
          {discovery.ok
            ? "This isn't a Skopos-run source — it's a third-party x402 endpoint you named. Paying it uses your own connected wallet, not Skopos's."
            : (discovery.error ?? "Unknown error.")}
        </p>
      </div>

      {discovery.ok && (
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "var(--card-surface)" }}>
          <div style={{ minWidth: 0 }}>
            <p style={{ ...MONO, fontSize: "0.72rem", fontWeight: 600, color: "var(--card-text, #ffffff)", margin: "0 0 2px" }}>
              ${discovery.priceUsd ?? "?"} · {discovery.network ?? "base"}
            </p>
            <p style={{ ...MONO, fontSize: "0.58rem", color: state === "error" ? "#ef4444" : "var(--card-text-faint)", margin: 0 }}>
              {message ?? "Paid per call, from your wallet."}
            </p>
          </div>
          <button
            onClick={handlePay}
            disabled={state === "loading"}
            style={{
              ...MONO, fontSize: "0.66rem", fontWeight: 700,
              color: ACCENT, background: `${ACCENT}18`, border: `1px solid ${ACCENT}40`,
              borderRadius: 8, padding: "6px 12px", whiteSpace: "nowrap",
              cursor: state !== "loading" ? "pointer" : "default",
            }}
          >
            {state === "loading" ? "…" : state === "done" ? "✓" : !walletClient ? "Connect" : `Pay $${discovery.priceUsd ?? "?"}`}
          </button>
        </div>
      )}

      {discovery.ok && needsCover && (
        <div style={{ padding: "12px 18px 16px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)" }}>
          <p style={{ ...MONO, fontSize: "0.66rem", lineHeight: 1.6, color: "var(--card-text-dim)", margin: "0 0 8px" }}>
            You're ${shortfall.toFixed(2)} short of the ${priceUsd.toFixed(2)} USDC needed on Base.
          </p>

          {swapFetching && (
            <p style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-faint)", margin: 0 }}>
              Checking if your ETH can cover it…
            </p>
          )}

          {swapError && !swapFetching && (
            <p style={{ ...MONO, fontSize: "0.62rem", color: "#ef4444", margin: 0 }}>{swapError}</p>
          )}

          {swapQuote && !swapFetching && (
            <>
              <p style={{ ...MONO, fontSize: "0.62rem", fontWeight: 600, color: "var(--card-text, #ffffff)", margin: "0 0 8px" }}>
                Total to proceed: ~${totalCostUsd.toFixed(2)} — ${priceUsd.toFixed(2)} payment + ~${swapFeeUsd.toFixed(2)} swap fee to cover the gap.
              </p>
              <QuoteDisplay
                result={swapQuote}
                connectedAddress={address ?? null}
                onRefresh={async () => { fetchedForRef.current = null; await fetchCoverSwap(); }}
              />
            </>
          )}

          {!swapFetching && !swapQuote && !hasEth && (
            <button
              onClick={() => address && fundWallet({ address })}
              style={{
                ...MONO, fontSize: "0.62rem", fontWeight: 700,
                color: ACCENT, background: `${ACCENT}18`, border: `1px solid ${ACCENT}40`,
                borderRadius: 8, padding: "6px 12px", cursor: "pointer",
              }}
            >
              No ETH to cover it — fund wallet →
            </button>
          )}
        </div>
      )}

      {state === "done" && data != null && (
        <pre style={{ ...MONO, fontSize: "0.68rem", lineHeight: 1.6, color: "var(--card-text-dim)", margin: 0, padding: "12px 18px 16px", borderTop: "1px solid var(--card-border-faint)", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

const HOLDER_FIELDS = {
  ownership: ["ownership_percentage", "ownership_pct", "supply_percentage"],
  change:    ["balance_change_7d", "balance_change_30d", "balance_change_24h"],
  value:     ["value_usd", "balance_usd", "usd_value"],
};

function HoldersPanel({ data, chain }: { data: unknown; chain: string | null }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const shorten = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
  const explorerBase = chain ? SM_EXPLORER[chain] : undefined;
  const rows = smRows(data);

  if (rows.length === 0) {
    return (
      <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)" }}>
        <p style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-dim)", margin: 0 }}>
          No holder data found for this token.
        </p>
      </div>
    );
  }

  const parsed = rows.map((r) => ({
    id: pickStr(r, SM_FIELDS.address),
    label: pickStr(r, SM_FIELDS.label),
    ownership: pickNum(r, HOLDER_FIELDS.ownership),
    change: pickNum(r, HOLDER_FIELDS.change),
    value: pickNum(r, HOLDER_FIELDS.value),
  })).filter((p) => p.id || p.label);

  if (parsed.length === 0) {
    return (
      <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)" }}>
        <p style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-dim)", margin: "0 0 6px" }}>
          Read complete — {rows.length} record(s), unrecognized shape.
        </p>
        <pre style={{ ...MONO, fontSize: "0.55rem", color: "var(--card-text-faint)", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 160, overflow: "auto" }}>
          {JSON.stringify(data, null, 2).slice(0, 600)}
        </pre>
      </div>
    );
  }

  const sorted = [...parsed].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 6);
  const shownOwnership = sorted.reduce((s, p) => s + (p.ownership ?? 0), 0);

  return (
    <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, marginBottom: 2 }}>
        <span style={{ ...MONO, fontSize: "0.58rem", fontWeight: 700, letterSpacing: "0.1em", color: "var(--card-text-faint)" }}>
          TOP HOLDERS · {sorted.length} SHOWN
        </span>
        {shownOwnership > 0 && (
          <span style={{ ...MONO, fontSize: "0.66rem", fontWeight: 700, color: "var(--card-text-dim)", whiteSpace: "nowrap" }}>
            {(shownOwnership * 100).toFixed(1)}% of supply
          </span>
        )}
      </div>
      {sorted.map((p, i) => {
        const adding = (p.change ?? 0) >= 0;
        const display = p.label ?? (p.id ? shorten(p.id) : "Unknown");
        const href = p.id && explorerBase ? `${explorerBase}${p.id}` : null;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" title={p.id ?? undefined}
                style={{ ...MONO, fontSize: "0.66rem", color: "var(--card-text, #ffffff)", textDecoration: "none", borderBottom: "1px dotted var(--card-text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {display}
              </a>
            ) : (
              <span style={{ ...MONO, fontSize: "0.66rem", color: "var(--card-text, #ffffff)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {display}
              </span>
            )}
            <span style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
              {p.ownership != null && (
                <span style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-dim)" }}>
                  {(p.ownership * 100).toFixed(2)}%
                </span>
              )}
              {p.value != null && (
                <span style={{ ...MONO, fontSize: "0.66rem", fontWeight: 700, color: "var(--card-text, #ffffff)" }}>
                  {fmtUsdShort(p.value)}
                </span>
              )}
              {p.change != null && p.change !== 0 && (
                <span title={adding ? "added in the last 7d" : "trimmed in the last 7d"}
                  style={{ ...MONO, fontSize: "0.66rem", fontWeight: 700, color: adding ? "#22c55e" : "#ef4444" }}>
                  {adding ? "▲" : "▼"}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FlowsPanel({ data }: { data: unknown }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const rows = smRows(data)
    .map((r) => ({ date: pickStr(r, ["date"]), value: pickNum(r, ["value_usd"]), amount: pickNum(r, ["token_amount"]) }))
    .filter((p) => p.value != null)
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  if (rows.length < 2) {
    return (
      <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)" }}>
        <p style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-dim)", margin: 0 }}>Not enough flow history for a trend yet.</p>
      </div>
    );
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const base = first.amount ?? 0;
  const changePct = base > 0 ? (((last.amount ?? 0) - base) / base) * 100 : 0;
  const up = (last.amount ?? 0) >= base;
  const maxVal = Math.max(...rows.map((r) => r.value ?? 0)) || 1;
  const bars = rows.slice(-24);

  return (
    <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span style={{ ...MONO, fontSize: "0.58rem", fontWeight: 700, letterSpacing: "0.1em", color: "var(--card-text-faint)" }}>
          SMART MONEY · {rows.length}D
        </span>
        <span style={{ ...MONO, fontSize: "0.66rem", fontWeight: 700, color: up ? "#22c55e" : "#ef4444", whiteSpace: "nowrap" }}>
          {up ? "▲ accumulating" : "▼ distributing"} {changePct >= 0 ? "+" : ""}{changePct.toFixed(1)}%
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 40 }}>
        {bars.map((b, i) => (
          <div key={i} title={`${b.date}: ${fmtUsdShort(b.value ?? 0)}`}
            style={{ flex: 1, height: `${Math.max(2, ((b.value ?? 0) / maxVal) * 40)}px`, background: up ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)", borderRadius: 1 }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)" }}>{first.date}</span>
        <span style={{ ...MONO, fontSize: "0.62rem", fontWeight: 700, color: "var(--card-text, #ffffff)" }}>{fmtUsdShort(last.value ?? 0)} held</span>
        <span style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)" }}>{last.date}</span>
      </div>
    </div>
  );
}

const FLOW_SEGMENTS: { key: string; label: string; invert: boolean }[] = [
  { key: "smart_trader", label: "Smart traders", invert: false },
  { key: "top_pnl", label: "Top PnL wallets", invert: false },
  { key: "whale", label: "Whales", invert: false },
  { key: "public_figure", label: "Public figures", invert: false },
  { key: "fresh_wallets", label: "Fresh wallets", invert: false },
  { key: "exchange", label: "Exchanges", invert: true },
];

function FlowIntelPanel({ data, tf }: { data: unknown; tf?: string }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const rows = smRows(data);
  const obj = (rows[0] ?? (data && typeof data === "object" ? data : {})) as Record<string, unknown>;

  const segs = FLOW_SEGMENTS.map((s) => ({
    label: s.label,
    invert: s.invert,
    net: pickNum(obj, [`${s.key}_net_flow_usd`]),
    count: pickNum(obj, [`${s.key}_wallet_count`]),
  })).filter((s) => (s.net != null && s.net !== 0) || (s.count != null && s.count > 0));

  if (segs.length === 0) {
    return (
      <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)" }}>
        <p style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-dim)", margin: 0 }}>No segment flow data for this token.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)", display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ ...MONO, fontSize: "0.58rem", fontWeight: 700, letterSpacing: "0.1em", color: "var(--card-text-faint)", marginBottom: 2 }}>
        NET FLOW · {tf ? ((["30m", "1h", "4h", "24h"].includes(tf) ? "1D" : "7D")) : "7D"}
      </span>
      {segs.map((s, i) => {
        const net = s.net ?? 0;
        const inflow = net >= 0;
        const bullish = s.invert ? net < 0 : net >= 0;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ ...MONO, fontSize: "0.66rem", color: "var(--card-text, #ffffff)" }}>{s.label}</span>
            <span style={{ ...MONO, fontSize: "0.66rem", fontWeight: 700, color: bullish ? "#22c55e" : "#ef4444", whiteSpace: "nowrap" }}>
              {inflow ? "▲" : "▼"} {fmtUsdShort(Math.abs(net))}
            </span>
          </div>
        );
      })}
      <span style={{ ...MONO, fontSize: "0.56rem", color: "var(--card-text-faint)", marginTop: 4 }}>
        Exchange outflows (▼) = leaving exchanges = less sell pressure.
      </span>
    </div>
  );
}

function ScreenerPanel({ data, tf }: { data: unknown; tf?: string }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const rows = smRows(data)
    .map((r) => ({
      symbol: pickStr(r, ["token_symbol"]),
      chain: pickStr(r, ["chain"]),
      addr: pickStr(r, ["token_address"]),
      net: pickNum(r, ["netflow"]),
      change: pickNum(r, ["price_change"]),
    }))
    .filter((p) => p.symbol)
    .slice(0, 8);

  if (rows.length === 0) {
    return (
      <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)" }}>
        <p style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-dim)", margin: 0 }}>No screener results right now.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: "12px 18px", borderTop: "1px solid var(--card-border-faint)", background: "var(--card-surface)", display: "flex", flexDirection: "column", gap: 7 }}>
      <span style={{ ...MONO, fontSize: "0.58rem", fontWeight: 700, letterSpacing: "0.1em", color: "var(--card-text-faint)", marginBottom: 2 }}>
        TOP NET INFLOW · {(tf ?? "24h").toUpperCase()}
      </span>
      {rows.map((p, i) => {
        const explorerBase = p.chain ? SM_EXPLORER[p.chain] : undefined;
        const href = p.addr && explorerBase ? `${explorerBase}${p.addr}` : null;
        const changePct = (p.change ?? 0) * 100;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" style={{ ...MONO, fontSize: "0.68rem", fontWeight: 700, color: "var(--card-text, #ffffff)", textDecoration: "none" }}>${p.symbol}</a>
              ) : (
                <span style={{ ...MONO, fontSize: "0.68rem", fontWeight: 700, color: "var(--card-text, #ffffff)" }}>${p.symbol}</span>
              )}
              <span style={{ ...MONO, fontSize: "0.56rem", color: "var(--card-text-faint)" }}>{p.chain}</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
              {p.change != null && (
                <span style={{ ...MONO, fontSize: "0.6rem", color: changePct >= 0 ? "#22c55e" : "#ef4444" }}>
                  {changePct >= 0 ? "+" : ""}{changePct.toFixed(1)}%
                </span>
              )}
              {p.net != null && (
                <span style={{ ...MONO, fontSize: "0.66rem", fontWeight: 700, color: "#22c55e" }}>{fmtUsdShort(p.net)}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TokenRiskDisplay({ result }: { result: TokenRiskResult }) {
  const t = useTranslations("app.risk");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { risk } = result;

  const SCORE_COLOR = { 1: "#22c55e", 2: "#f59e0b", 3: "#f97316", 4: "#ef4444" } as const;
  const riskColor = SCORE_COLOR[risk.score];
  const changePositive = (risk.priceChange24h ?? 0) >= 0;
  const changeColor = changePositive ? "#22c55e" : "#ef4444";

  const fmt = (n: number) =>
    n >= 1_000_000_000 ? `$${(n / 1_000_000_000).toFixed(2)}B`
    : n >= 1_000_000   ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000       ? `$${(n / 1_000).toFixed(1)}K`
    : `$${n.toFixed(2)}`;

  const fmtPrice = (p: string) => {
    const n = Number(p);
    if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    if (n >= 1)    return `$${n.toFixed(4)}`;
    return `$${n.toPrecision(4)}`;
  };

  const FLAG_LABELS: Record<string, string> = {
    NO_LIQUIDITY:    t("flags.noLiquidity"),
    VOLUME_SPIKE:    t("flags.volumeSpike"),
    SINGLE_POOL:     t("flags.singlePool"),
    NEW_TOKEN:       t("flags.newToken"),
    HIGH_VOLATILITY: t("flags.highVolatility"),
    HEAVY_SELLING:   t("flags.heavySelling"),
    POSSIBLE_HONEYPOT: t("flags.possibleHoneypot"),
    SNIPED:          t("flags.sniped"),
    CONCENTRATED:    t("flags.concentrated"),
  };

  return (
    <div style={{ border: "1px solid var(--card-border)", borderRadius: 16, overflow: "hidden", maxWidth: 400, background: "var(--card-container-bg, #0D0D0D)" }}>

      {/* Header: name + risk badge */}
      <div style={{ padding: "14px 18px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <span style={{ ...MONO, fontSize: "1.05rem", fontWeight: 700, color: "var(--card-text, #ffffff)" }}>{risk.symbol}</span>
          <span style={{ ...MONO, fontSize: "0.65rem", color: "var(--card-text-dim)", marginLeft: 8 }}>{risk.name}</span>
        </div>
        <span style={{ ...MONO, fontSize: "0.65rem", fontWeight: 700, color: riskColor, background: `${riskColor}18`, border: `1px solid ${riskColor}35`, borderRadius: 6, padding: "3px 10px" }}>
          {risk.label} {t("risk")}
        </span>
      </div>

      {/* Price + 24h change hero */}
      <div style={{ padding: "4px 18px 16px", display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <p style={{ ...MONO, fontSize: "1.6rem", fontWeight: 700, color: "var(--card-text, #ffffff)", margin: 0, lineHeight: 1.1 }}>
            {risk.priceUsd ? fmtPrice(risk.priceUsd) : "—"}
          </p>
          {risk.priceChange24h != null && (
            <span style={{
              ...MONO, fontSize: "0.75rem", fontWeight: 600,
              color: changeColor,
              background: changePositive ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
              border: `1px solid ${changeColor}30`,
              borderRadius: 6, padding: "2px 8px", display: "inline-block", marginTop: 6,
            }}>
              {changePositive ? "+" : ""}{risk.priceChange24h.toFixed(2)}% {t("oneDay")}
            </span>
          )}
        </div>
      </div>

      {/* Sparkline chart */}
      {risk.sparkline && risk.sparkline.length > 2 && (
        <div style={{ padding: "0 0 0 0", borderTop: "1px solid var(--card-border-faint)", borderBottom: "1px solid var(--card-border-faint)" }}>
          <Sparkline prices={risk.sparkline} positive={changePositive} width={400} height={72} />
        </div>
      )}

      {/* Stats grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1px", background: "var(--card-surface)", margin: "0" }}>
        {[
          [t("stats.marketCap"),  risk.marketCap ? fmt(risk.marketCap) : "—"],
          [t("stats.vol24h"),     fmt(risk.volume24h)],
          [t("stats.liquidity"),  fmt(risk.totalLiquidityUsd)],
          [t("stats.pools"),      t("stats.poolsValue", { pairs: risk.pairCount, dex: risk.dexCount })],
          ...(risk.top10HolderPct != null ? [[t("stats.top10Hold"), `${risk.top10HolderPct.toFixed(1)}%`]] : []),
        ].map(([label, val]) => (
          <div key={label} style={{ padding: "11px 16px", background: "var(--card-container-bg, #0D0D0D)" }}>
            <p style={{ ...MONO, fontSize: "0.57rem", color: "var(--card-text-faint)", margin: "0 0 3px", letterSpacing: "0.07em" }}>{label!.toUpperCase()}</p>
            <p style={{ ...MONO, fontSize: "0.82rem", color: "var(--card-text, #ffffff)", margin: 0 }}>{val}</p>
          </div>
        ))}
      </div>

      {/* Risk flags */}
      {risk.flags.length > 0 && (
        <div style={{ padding: "12px 18px", borderTop: `1px solid ${riskColor}20` }}>
          <p style={{ ...MONO, fontSize: "0.57rem", color: "var(--card-text-faint)", marginBottom: 8, letterSpacing: "0.07em" }}>{t("riskFlags")}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {risk.flags.map(f => (
              <div key={f} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ color: riskColor, fontSize: "0.58rem" }}>▲</span>
                <span style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-muted, rgba(255,255,255,0.7))" }}>{FLAG_LABELS[f] ?? f}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer link */}
      {risk.topPair?.url && (
        <div style={{ padding: "10px 18px 14px", borderTop: "1px solid var(--card-border-faint)" }}>
          <a href={risk.topPair.url} target="_blank" rel="noopener noreferrer"
            style={{ ...MONO, fontSize: "0.64rem", color: "var(--card-text-dim)", textDecoration: "none" }}
            onMouseEnter={e => (e.currentTarget.style.color = "var(--card-text-muted)")}
            onMouseLeave={e => (e.currentTarget.style.color = "var(--card-text-dim)")}
          >
            {t("viewOnDexscreener", { dexId: risk.topPair.dexId, chainId: risk.topPair.chainId })}
          </a>
        </div>
      )}

      {result.analysis && (
        <div style={{ padding: "12px 18px 14px", borderTop: "1px solid var(--card-border-faint, rgba(255,255,255,0.05))" }}>
          <p style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-muted, rgba(255,255,255,0.7))", lineHeight: 1.7, margin: 0 }}>
            {result.analysis}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── PrebuyDisplay ────────────────────────────────────────────────────────────
// Composes three existing cards into one glance-able pre-buy read, rather than
// reimplementing price/risk or swap-execution UI: TokenRiskDisplay already
// covers price+chart+risk (scanToken backs both "price" and "risk" slots in
// one call server-side), and QuoteDisplay is nested exactly like the covering
// swap in X402CheckDisplay — same non-custodial contract, the user signs it
// themselves. Smart money and the entry route are both allowed to come back
// empty (new/thin chains, no wallet connected) — this card shows what's
// available and says plainly what isn't, never blocking on either slot.

function PrebuyDisplay({ result, connectedAddress }: { result: PrebuyResult; connectedAddress: string | null }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { risk, smartMoney, quote, quoteUnavailable, analysis } = result;

  const fmtUsd = (n: number) =>
    n >= 1_000_000_000 ? `$${(n / 1_000_000_000).toFixed(2)}B`
    : n >= 1_000_000   ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000       ? `$${(n / 1_000).toFixed(1)}K`
    : `$${n.toFixed(2)}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <TokenRiskDisplay result={{ type: "token_risk", risk, analysis }} />

      <div style={{ border: "1px solid var(--card-border)", borderRadius: 16, overflow: "hidden", maxWidth: 400, background: "var(--card-container-bg, #0D0D0D)" }}>
        <div style={{ padding: "10px 18px", borderBottom: "1px solid var(--card-border-faint)" }}>
          <p style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.1em", color: "var(--card-text-faint)", margin: 0 }}>
            SMART MONEY · 30D
          </p>
        </div>
        <div style={{ padding: "13px 18px" }}>
          {smartMoney ? (
            <p style={{ ...MONO, fontSize: "0.78rem", color: "var(--card-text, #ffffff)", margin: 0, lineHeight: 1.6 }}>
              {smartMoney.buyerCount} smart-money {smartMoney.buyerCount === 1 ? "wallet" : "wallets"} bought {fmtUsd(smartMoney.totalBoughtUsd)} worth
            </p>
          ) : (
            <p style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-faint)", margin: 0 }}>
              No smart-money data available for this token yet.
            </p>
          )}
        </div>
      </div>

      {quote ? (
        <div>
          <p style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.1em", color: "var(--card-text-faint)", margin: "0 0 6px 2px" }}>
            ENTRY ROUTE · $100 REFERENCE
          </p>
          <QuoteDisplay result={quote} connectedAddress={connectedAddress} />
        </div>
      ) : (
        <div style={{ border: "1px solid var(--card-border)", borderRadius: 16, padding: "13px 18px", background: "var(--card-container-bg, #0D0D0D)" }}>
          <p style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-faint)", margin: 0 }}>
            {quoteUnavailable ?? "No entry route available right now."}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── StockPairedDisplay ───────────────────────────────────────────────────────
// Stock-paired token card (Robinhood Chain): which tokenized stock the token's
// primary pool quotes against, the token/stock price ratio, and the estimated
// creator fee flywheel. Everything USD-derived is an estimate from trading
// volume (standard Doppler parameters) and labeled as such — never presented
// as an exact unclaimed balance. Standalone like the other card components:
// CSS --card-* vars only, no access to the T theme object.

function StockPairedDisplay({ result }: { result: StockPairedResult }) {
  const t = useTranslations("app.stockPaired");
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const fmtUsd = (x: number): string => {
    const a = Math.abs(x);
    const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M`
      : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : a >= 1 ? a.toFixed(2) : a.toPrecision(3);
    return `$${s}`;
  };

  return (
    <div style={{
      background: "var(--card-container-bg, #0D0D0D)",
      border: "1px solid var(--card-border, rgba(255,255,255,0.09))",
      borderRadius: 16, overflow: "hidden", maxWidth: 440,
    }}>
      {result.heading && (
        <div style={{ padding: "11px 16px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))" }}>
          <span style={{ ...MONO, fontSize: "0.62rem", letterSpacing: "0.09em", color: "var(--card-text-faint)", textTransform: "uppercase" }}>
            {result.heading}
          </span>
        </div>
      )}

      {result.items.map((it) => (
        <div key={`${it.tokenAddress}-${it.stockSymbol}`} style={{ padding: "14px 16px", borderBottom: "1px solid var(--card-border-faint, rgba(255,255,255,0.05))" }}>
          {/* Pairing headline */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ ...MONO, fontSize: "0.95rem", fontWeight: 700, color: "var(--card-text, rgba(255,255,255,0.9))" }}>
              {it.tokenSymbol}
            </span>
            <span style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-faint)" }}>⇄</span>
            <span style={{ ...MONO, fontSize: "0.95rem", fontWeight: 700, color: "#F5B800" }}>
              {it.stockSymbol}
            </span>
            <span style={{
              ...MONO, fontSize: "0.58rem", padding: "2px 7px", borderRadius: 4,
              border: `1px solid ${it.stockVerified ? "rgba(74,222,128,0.35)" : "rgba(245,184,0,0.4)"}`,
              color: it.stockVerified ? "rgba(74,222,128,0.9)" : "rgba(245,184,0,0.9)",
            }}>
              {it.stockVerified ? t("verified") : t("unverified")}
            </span>
          </div>
          <p style={{ ...MONO, fontSize: "0.66rem", color: "var(--card-text-dim)", margin: "6px 0 0" }}>
            {t("pairedWith", { stock: it.stockSymbol })}
          </p>

          {it.tokenImpersonatesTicker && (
            <p style={{
              ...MONO, fontSize: "0.63rem", lineHeight: 1.45, margin: "8px 0 0",
              padding: "7px 10px", borderRadius: 8,
              background: "rgba(248,113,113,0.07)", border: "1px solid rgba(248,113,113,0.28)",
              color: "rgba(248,113,113,0.92)",
            }}>
              {t("impersonationWarning", { token: it.tokenSymbol })}
            </p>
          )}

          {/* Ratio + prices */}
          <div style={{ margin: "10px 0 0", padding: "10px 12px", background: "var(--card-bg)", border: "1px solid var(--card-border-faint)", borderRadius: 10 }}>
            {it.priceInStockTerms && (
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <span style={{ ...MONO, fontSize: "0.66rem", color: "var(--card-text-dim)" }}>{t("ratio")}</span>
                <span style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-muted, rgba(255,255,255,0.75))" }}>
                  1 {it.tokenSymbol} = {it.priceInStockTerms} {it.stockSymbol}
                </span>
              </div>
            )}
            {it.tokenPriceUsd && (
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
                <span style={{ ...MONO, fontSize: "0.66rem", color: "var(--card-text-dim)" }}>{it.tokenSymbol}</span>
                <span style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-muted, rgba(255,255,255,0.75))" }}>${it.tokenPriceUsd}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
              <span style={{ ...MONO, fontSize: "0.66rem", color: "var(--card-text-dim)" }}>{it.stockSymbol}</span>
              <span style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-muted, rgba(255,255,255,0.75))" }}>
                {it.stockPriceUsd !== null
                  ? `${fmtUsd(it.stockPriceUsd)}${it.stockPriceStale ? ` · ${t("lastClose")}` : ""}`
                  : t("noFeed")}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
              <span style={{ ...MONO, fontSize: "0.66rem", color: "var(--card-text-dim)" }}>{t("poolLiquidity")}</span>
              <span style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-muted, rgba(255,255,255,0.75))" }}>
                {it.pairLiquidityUsd > 0 ? fmtUsd(it.pairLiquidityUsd) : t("liquidityNotIndexed")}
              </span>
            </div>
          </div>

          {/* Fee flywheel — only when the stock has a live USD feed */}
          {it.dailyStockValueEstimate !== null && (
            <div style={{ margin: "8px 0 0", padding: "10px 12px", background: "rgba(245,184,0,0.05)", border: "1px solid rgba(245,184,0,0.18)", borderRadius: 10 }}>
              <p style={{ ...MONO, fontSize: "0.56rem", letterSpacing: "0.1em", color: "rgba(245,184,0,0.7)", margin: "0 0 6px", textTransform: "uppercase" }}>
                {t("flywheelTitle")}
              </p>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
                <span style={{ ...MONO, fontSize: "0.66rem", color: "var(--card-text-dim)" }}>{t("dailyEst")}</span>
                <span style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-muted, rgba(255,255,255,0.75))" }}>
                  ~{fmtUsd(it.dailyStockValueEstimate)}/d
                  {it.dailyStockTokensEstimate !== null ? ` (~${it.dailyStockTokensEstimate.toFixed(2)} ${it.stockSymbol}/d)` : ""}
                </span>
              </div>
              {it.totalAccumulatedEstimate !== null && it.daysOld !== null && (
                <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
                  <span style={{ ...MONO, fontSize: "0.66rem", color: "var(--card-text-dim)" }}>{t("sinceLaunch", { days: it.daysOld.toFixed(1) })}</span>
                  <span style={{ ...MONO, fontSize: "0.7rem", color: "var(--card-text-muted, rgba(255,255,255,0.75))" }}>~{fmtUsd(it.totalAccumulatedEstimate)}</span>
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <a href={it.pairUrl} target="_blank" rel="noopener noreferrer"
               style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-dim)" }}>
              dexscreener ↗
            </a>
          </div>
        </div>
      ))}

      <div style={{ padding: "9px 16px" }}>
        <p style={{ ...MONO, fontSize: "0.56rem", color: "var(--card-text-faint)", margin: 0, lineHeight: 1.5 }}>
          {result.note || t("estimateNote")}
        </p>
      </div>
    </div>
  );
}

// ─── RobinhoodLaunchesDisplay ─────────────────────────────────────────────────

function CopyableAddress({ address }: { address: string }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const [copied, setCopied] = useState(false);
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard unavailable — ignore */ }
      }}
      title={address}
      style={{
        ...MONO, fontSize: "0.62rem", color: "var(--card-text-dim)",
        background: "transparent", border: "1px solid var(--card-border-faint)", borderRadius: 6,
        padding: "2px 7px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5,
      }}
    >
      {short}
      <span style={{ opacity: 0.7 }}>{copied ? "✓" : "⧉"}</span>
    </button>
  );
}

const RH_RISK_COLOR = { 1: "#22c55e", 2: "#f59e0b", 3: "#f97316", 4: "#ef4444" } as const;

function RiskBadge({ risk }: { risk: RobinhoodLaunchCard["risk"] }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  if (!risk) {
    return (
      <span style={{ ...MONO, fontSize: "0.6rem", fontWeight: 700, color: "var(--card-text-faint)", background: "rgba(255,255,255,0.06)", border: "1px solid var(--card-border-faint)", borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>
        ⏳ NOT SCANNED
      </span>
    );
  }
  const color = RH_RISK_COLOR[risk.score];
  return (
    <span style={{ ...MONO, fontSize: "0.6rem", fontWeight: 700, color, background: `${color}1f`, border: `1px solid ${color}45`, borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>
      ● {risk.label}
    </span>
  );
}

function RobinhoodLaunchesDisplay({ result }: { result: RobinhoodLaunchesResult }) {
  const MONO: React.CSSProperties = { fontFamily: "var(--font-jetbrains-mono), monospace" };
  const { heading, subtitle, launches, omittedCount } = result;

  const RISK_FLAG_LABELS: Record<string, string> = {
    NO_LIQUIDITY: "NO LIQUIDITY", VOLUME_SPIKE: "VOLUME SPIKE", SINGLE_POOL: "SINGLE POOL",
    NEW_TOKEN: "NEW TOKEN", HIGH_VOLATILITY: "HIGH VOLATILITY", HEAVY_SELLING: "HEAVY SELLING",
    POSSIBLE_HONEYPOT: "POSSIBLE HONEYPOT",
  };

  const fmtUsd = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000    ? `$${(n / 1_000).toFixed(1)}K`
    : `$${n.toFixed(0)}`;

  // Liquidity is the single most dangerous signal on this card — color it
  // instead of letting it blend into the rest of the stats line.
  const liqColor = (usd: number) => (usd <= 5_000 ? "#ef4444" : usd > 50_000 ? "#22c55e" : "var(--card-text-dim)");

  const LinkPill = ({ href, label }: { href: string; label: string }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-dim)", textDecoration: "none", border: "1px solid var(--card-border-faint)", borderRadius: 6, padding: "2px 7px" }}>
      {label} ↗
    </a>
  );

  return (
    <div style={{ border: "1px solid var(--card-border)", borderRadius: 16, overflow: "hidden", maxWidth: 460, background: "var(--card-container-bg, #0D0D0D)" }}>
      <div style={{ padding: "12px 18px 10px", borderBottom: "1px solid var(--card-border-faint)" }}>
        <p style={{ ...MONO, fontSize: "0.85rem", fontWeight: 700, color: "var(--card-text, #ffffff)", margin: 0 }}>
          {heading}
        </p>
        <p style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint)", margin: "4px 0 0" }}>
          {subtitle}
        </p>
      </div>

      <div>
        {launches.map((l, i) => {
          const repeat = l.creator.repeatLaunchCount > 1;
          const liq = l.risk ? l.risk.totalLiquidityUsd : null;
          return (
            <div key={l.address} style={{ padding: "13px 18px", borderBottom: i < launches.length - 1 ? "1px solid var(--card-border-faint)" : "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <RiskBadge risk={l.risk} />
                {l.hot && <span style={{ fontSize: "0.85rem" }}>🔥</span>}
                <span style={{ ...MONO, fontSize: "0.8rem", fontWeight: 700, color: "var(--card-text, #ffffff)" }}>
                  {l.symbol} <span style={{ fontWeight: 400, color: "var(--card-text-dim)" }}>({l.name})</span>
                </span>
                <span style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-faint)" }}>
                  · {l.ageMinutes}m old
                </span>
              </div>

              <p style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-dim)", margin: "6px 0 0" }}>
                {l.marketCapUsd > 0 ? `${fmtUsd(l.marketCapUsd)} mcap` : "no trades yet"}
                {liq !== null && <> · <span style={{ color: liqColor(liq), fontWeight: 600 }}>{fmtUsd(liq)} liq</span></>}
                {l.volumeToMcapRatio !== null && ` · ${l.volumeToMcapRatio.toFixed(1)}x vol/mcap`}
              </p>

              {l.risk && l.risk.flags.length > 0 && (
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 7 }}>
                  {l.risk.flags.map(f => (
                    <span key={f} style={{ ...MONO, fontSize: "0.56rem", fontWeight: 600, color: "var(--card-text-muted, rgba(255,255,255,0.65))", background: "rgba(255,255,255,0.06)", border: "1px solid var(--card-border-faint)", borderRadius: 5, padding: "2px 6px" }}>
                      {RISK_FLAG_LABELS[f] ?? f}
                    </span>
                  ))}
                </div>
              )}
              {!l.risk && (
                <p style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint)", margin: "7px 0 0" }}>
                  Not indexed by DexScreener yet — too new to scan.
                </p>
              )}

              <p style={{ ...MONO, fontSize: "0.64rem", margin: "7px 0 0" }}>
                <a href={l.creator.profileUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--card-text-dim)", textDecoration: "none" }}>
                  by @{l.creator.xUsername ?? "unknown"}
                </a>
                {repeat && (
                  <>
                    {" "}
                    <a href={l.creator.profileUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#f59e0b", textDecoration: "none" }}>
                      ⚠️ {l.creator.repeatLaunchCount} launches →
                    </a>
                  </>
                )}
              </p>

              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                <CopyableAddress address={l.address} />
                <LinkPill href={l.links.bankr} label="bankr" />
                {l.links.dexscreener && <LinkPill href={l.links.dexscreener} label="dexscreener" />}
                {l.links.geckoterminal && <LinkPill href={l.links.geckoterminal} label="geckoterminal" />}
                <LinkPill href={l.links.noxa} label="noxa" />
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ padding: "10px 18px 13px", borderTop: "1px solid var(--card-border-faint)" }}>
        {omittedCount > 0 && (
          <p style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint)", margin: "0 0 6px" }}>
            +{omittedCount} more fetched but not shown — ask again to see fresh ones as they land.
          </p>
        )}
        <p style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint)", margin: 0, lineHeight: 1.6 }}>
          Token names are unverified — anyone can launch a token referencing a public figure or brand with zero affiliation. Repeat-launch count and the DexScreener scan above are the only safety signals shown here.
        </p>
      </div>
    </div>
  );
}

// ─── ApprovalScanDisplay ──────────────────────────────────────────────────────

// Mirrors lib/alchemy.ts's ALCHEMY_CHAINS[chainId].explorer — kept as a
// separate client-side map rather than importing that module here, since it
// also carries the Alchemy API key template into the RPC URL.
const APPROVAL_EXPLORER_BASE: Record<number, string> = {
  1: "https://etherscan.io", 8453: "https://basescan.org", 42161: "https://arbiscan.io",
  10: "https://optimistic.etherscan.io", 137: "https://polygonscan.com", 56: "https://bscscan.com",
  43114: "https://snowtrace.io", 324: "https://explorer.zksync.io", 59144: "https://lineascan.build",
  100: "https://gnosisscan.io",
};

function ApprovalRowCard({ row, onTxSubmitted }: { row: ApprovalRow; onTxSubmitted?: (r: TxRecord) => void }) {
  const t = useTranslations("app.approvalScan");
  const { mutateAsync: writeContract, isPending } = useWriteContract();
  const { wallets } = useWallets();
  const activeChainId = useChainId();
  const [hash, setHash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);
  const { data: receipt, isLoading: confirming, isError: receiptError } =
    useWaitForTransactionReceipt({ hash: (hash ?? undefined) as `0x${string}` | undefined, chainId: row.chainId });
  const confirmed = receipt?.status === "success";
  const failed = receipt?.status === "reverted" || receiptError;
  const explorerBase = APPROVAL_EXPLORER_BASE[row.chainId] ?? "https://etherscan.io";
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  async function revoke() {
    setErr(null);
    try {
      if (activeChainId !== row.chainId) {
        const evmWallet = wallets.find(w => w.address?.startsWith("0x"));
        if (!evmWallet) throw new Error("No EVM wallet connected.");
        setIsSwitching(true);
        try { await evmWallet.switchChain(row.chainId); } finally { setIsSwitching(false); }
      }
      const h = await writeContract({
        address: row.tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "approve",
        args: [row.spender as `0x${string}`, BigInt(0)], chainId: row.chainId,
      });
      setHash(h);
      onTxSubmitted?.({
        hash: h, chainId: row.chainId, chain: row.chainName,
        label: t("revokeLabel", { token: row.tokenSymbol }), timestamp: Date.now(),
        explorerUrl: `${explorerBase}/tx/${h}`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.toLowerCase().includes("user rejected") ? t("rejectedInWallet") : t("errorPrefix", { msg: msg.slice(0, 100) }));
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--card-border-faint, rgba(255,255,255,0.05))", flexWrap: "wrap" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ ...MONO, fontSize: "0.72rem", color: "var(--card-text, #fff)" }}>{row.tokenSymbol}</span>
          {row.unlimited && (
            <span style={{ ...MONO, fontSize: "0.58rem", fontWeight: 700, color: "#ff5555", background: "rgba(255,85,85,0.1)", border: "1px solid rgba(255,85,85,0.3)", borderRadius: 999, padding: "1px 7px" }}>
              {t("unlimited")}
            </span>
          )}
          <span style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)" }}>{row.chainName}</span>
        </div>
        <a href={`${explorerBase}/address/${row.spender}`} target="_blank" rel="noopener noreferrer"
          style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-dim)", textDecoration: "none" }}
          title={row.spender}>
          {t("spender")} {short(row.spender)} ↗
        </a>
        {!row.unlimited && (
          <span style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint)" }}>
            {t("allowance")} {row.allowanceDisplay}
          </span>
        )}
        {err && <span style={{ ...MONO, fontSize: "0.6rem", color: "#ff5555" }}>{err}</span>}
      </div>

      {confirmed ? (
        <a href={`${explorerBase}/tx/${hash}`} target="_blank" rel="noopener noreferrer"
          style={{ ...MONO, fontSize: "0.62rem", letterSpacing: "0.06em", textTransform: "uppercase", padding: "7px 12px", borderRadius: 8, background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.3)", color: "#4ade80", textDecoration: "none", whiteSpace: "nowrap" }}>
          {t("revoked")}
        </a>
      ) : failed ? (
        <a href={`${explorerBase}/tx/${hash}`} target="_blank" rel="noopener noreferrer"
          style={{ ...MONO, fontSize: "0.62rem", letterSpacing: "0.06em", textTransform: "uppercase", padding: "7px 12px", borderRadius: 8, background: "rgba(255,85,85,0.08)", border: "1px solid rgba(255,85,85,0.3)", color: "#ff5555", textDecoration: "none", whiteSpace: "nowrap" }}>
          {t("revokeFailed")}
        </a>
      ) : (
        <button onClick={revoke} disabled={isPending || isSwitching || confirming}
          style={{ ...MONO, fontSize: "0.62rem", letterSpacing: "0.06em", textTransform: "uppercase", padding: "7px 12px", borderRadius: 8, background: "rgba(255,85,85,0.08)", border: "1px solid rgba(255,85,85,0.3)", color: "#ff5555", cursor: isPending || isSwitching || confirming ? "wait" : "pointer", whiteSpace: "nowrap" }}>
          {isPending ? t("confirmInWallet") : isSwitching ? t("switchingChain") : confirming ? t("confirmingEllipsis") : t("revokeArrow")}
        </button>
      )}
    </div>
  );
}

function ApprovalScanDisplay({ result, onTxSubmitted }: { result: ApprovalScanResult; onTxSubmitted?: (r: TxRecord) => void }) {
  const t = useTranslations("app.approvalScan");

  return (
    <div style={{ background: "var(--card-container-bg, #0D0D0D)", border: "1px solid var(--card-border, rgba(255,255,255,0.09))", borderRadius: 16, overflow: "hidden" }}>
      <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--card-border, rgba(255,255,255,0.09))", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <p style={{ ...MONO, fontSize: "0.65rem", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--card-text-faint)", margin: 0 }}>
          {t("header")}
        </p>
        <span style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint)" }}>
          {t("rowCount", { count: result.rows.length })}
        </span>
      </div>

      <div style={{ padding: "2px 20px" }}>
        {result.rows.length === 0 ? (
          <p style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-dim)", padding: "16px 0" }}>
            {t("empty")}
          </p>
        ) : (
          result.rows.map((row) => (
            <ApprovalRowCard key={`${row.chainId}-${row.tokenAddress}-${row.spender}`} row={row} onTxSubmitted={onTxSubmitted} />
          ))
        )}
      </div>

      <div style={{ padding: "10px 20px 13px" }}>
        <p style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint)", margin: 0, lineHeight: 1.6 }}>
          {t("windowCaveat", { days: result.windowDays })}
        </p>
      </div>
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
  const t = useTranslations("app.yield");
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
        <span style={{ ...MONO, fontSize: "0.58rem", letterSpacing: "0.1em", color: "var(--card-text-faint)" }}>{t("eyebrow")}</span>
        <span style={{ ...MONO, fontSize: "0.72rem", color: "#F5B800", fontWeight: 700 }}>{symbol}</span>
        <span style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)", marginLeft: "auto" }}>{t("viaDefiLlama")}</span>
      </div>

      <div>
        {pools.map((pool, i) => (
          <div key={pool.pool} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 18px", borderBottom: i < pools.length - 1 ? "1px solid var(--card-border-faint, rgba(255,255,255,0.05))" : "none" }}>
            <span style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)", width: 14, flexShrink: 0 }}>{i + 1}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ ...MONO, fontSize: "0.75rem", color: "var(--card-text, #ffffff)", margin: 0 }}>{PROJECT_LABELS[pool.project] ?? pool.project}</p>
              <p style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text-dim)", margin: "2px 0 0" }}>
                {pool.chain}
                {pool.apyReward != null && pool.apyReward > 0 && (
                  <span style={{ color: "#F5B800", marginLeft: 6 }}>{t("rewards", { pct: pool.apyReward.toFixed(2) })}</span>
                )}
              </p>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <p style={{ ...MONO, fontSize: "0.85rem", color: "#22c55e", fontWeight: 700, margin: 0 }}>{pool.apy.toFixed(2)}%</p>
              <p style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)", margin: "2px 0 0" }}>{t("tvl", { value: fmtTvl(pool.tvlUsd) })}</p>
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
                {t("deposit")}
              </a>
            )}
          </div>
        ))}
      </div>

      {result.analysis && (
        <div style={{ padding: "12px 18px 14px", borderTop: "1px solid var(--card-border-faint)" }}>
          <p style={{ ...MONO, fontSize: "0.68rem", color: "var(--card-text-muted)", lineHeight: 1.7, margin: 0 }}>
            {result.analysis}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── PolymarketDisplay ────────────────────────────────────────────────────────

function PolymarketDisplay({ result }: { result: PolymarketResult }) {
  const t = useTranslations("app.polymarket");
  const { topic, markets, deposit } = result;

  function fmtVolume(v: number): string {
    if (v >= 1_000_000) return t("volumeM", { n: (v / 1_000_000).toFixed(1) });
    if (v >= 1_000)     return t("volumeK", { n: (v / 1_000).toFixed(0) });
    return t("volume", { n: v.toFixed(0) });
  }

  function fmtPrice(price: string): string {
    const n = parseFloat(price);
    if (isNaN(n)) return "—";
    return `${Math.round(n * 100)}%`;
  }

  return (
    <div style={{ width: "100%" }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-dim)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
          {topic ? t("headerTopic", { topic: topic.toUpperCase() }) : t("headerTrending")}
        </span>
      </div>
      {deposit && (deposit.evm || deposit.svm || deposit.btc) && (
        <div style={{
          marginBottom: 12, padding: "12px 14px", borderRadius: 10,
          border: "1px solid rgba(245,184,0,0.2)",
          background: "rgba(245,184,0,0.04)",
        }}>
          <p style={{ ...MONO, fontSize: "0.58rem", color: "rgba(245,184,0,0.7)", letterSpacing: "0.1em", textTransform: "uppercase", margin: "0 0 8px" }}>
            {deposit.amount ? t("depositWithAmount", { amount: deposit.amount }) : t("deposit")}
          </p>
          <p style={{ ...MONO, fontSize: "0.63rem", color: "var(--card-text-dim)", margin: "0 0 8px", lineHeight: 1.5 }}>
            {t("depositInstructions")}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {deposit.evm && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ ...MONO, fontSize: "0.55rem", color: "rgba(245,184,0,0.6)", width: 32, flexShrink: 0 }}>EVM</span>
                <span style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text, #fff)", wordBreak: "break-all" }}>{deposit.evm}</span>
              </div>
            )}
            {deposit.svm && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ ...MONO, fontSize: "0.55rem", color: "rgba(245,184,0,0.6)", width: 32, flexShrink: 0 }}>SOL</span>
                <span style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text, #fff)", wordBreak: "break-all" }}>{deposit.svm}</span>
              </div>
            )}
            {deposit.btc && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ ...MONO, fontSize: "0.55rem", color: "rgba(245,184,0,0.6)", width: 32, flexShrink: 0 }}>BTC</span>
                <span style={{ ...MONO, fontSize: "0.62rem", color: "var(--card-text, #fff)", wordBreak: "break-all" }}>{deposit.btc}</span>
              </div>
            )}
          </div>
          <p style={{ ...MONO, fontSize: "0.55rem", color: "var(--card-text-faint)", margin: "8px 0 0", lineHeight: 1.5 }}>
            {t("checkBalanceHint")}
          </p>
        </div>
      )}

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
                <span style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-faint)", width: 16, flexShrink: 0 }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ ...MONO, fontSize: "0.75rem", color: "var(--card-text, #ffffff)", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {topMarket.question}
                  </p>
                  <p style={{ ...MONO, fontSize: "0.58rem", color: "var(--card-text-faint)", margin: "3px 0 0" }}>
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
                      <span style={{ ...MONO, fontSize: "0.5rem", color: "var(--card-text-dim)", marginTop: 1 }}>{outcome}</span>
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
  const t = useTranslations("app.suggestions");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ ...MONO, fontSize: "0.6rem", color: "var(--card-text-dim)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
        {t("tryOneOfThese")}
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
