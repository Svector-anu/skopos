// Eager import of every agentcash-paid route so the router's registry is
// populated on cold start, before anyone hits the route directly — required
// for /openapi.json and /llms.txt to list routes nobody has called yet.
// Add each new paid route file here as it's created.
import "@/app/api/price/route";
import "@/app/api/quote/route";
import "@/app/api/risk/route";
import "@/app/api/smart-money/route";
import "@/app/api/yield/route";
import "@/app/api/polymarket/route";
import "@/app/api/market-read/route";
import "@/app/api/treasury/route";
import "@/app/api/sniper-check/route";
import "@/app/api/flash-order/route";
