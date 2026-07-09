import { NextRequest } from "next/server";
import {
  listWatchers, removeWatcher, registerWatcher,
  type PriceWatcherParams, type PolymarketWatcherParams, type OnchainWatcherParams,
} from "@/lib/watchers";
import { sendNotification } from "@/lib/notifications";
import { getPrice } from "@/lib/priceCache";
import { getTopMarkets } from "@/lib/polymarket";
import { lookupAddress } from "@/lib/alchemy";

export const dynamic = "force-dynamic";

// Vercel Cron target for the standing-watch trio. price-alert is a one-shot
// (a crossed threshold is done, fired watcher removed); monitor-polymarket
// and onchain-monitor are recurring (removed then re-registered with a
// refreshed baseline/lastSeen, matching "watch over time" rather than a
// single trigger) — re-firing on every run once crossed would spam, but the
// watch itself should keep going.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  let fired = 0;
  let checked = 0;

  const priceWatchers = await listWatchers("price");
  checked += priceWatchers.length;
  for (const watcher of priceWatchers) {
    const params = watcher.params as PriceWatcherParams;
    const live = await getPrice(params.symbol);
    if (!live) continue;

    const triggered = params.direction === "above"
      ? live.price >= params.targetPrice
      : live.price <= params.targetPrice;
    if (!triggered) continue;

    const sent = await sendNotification(watcher.identity, {
      title: `${params.symbol} alert`,
      body: `${params.symbol} is now $${live.price} — ${params.direction === "above" ? "above" : "below"} your $${params.targetPrice.toLocaleString()} target.`,
      url: "https://www.tryskopos.xyz/app",
    });
    if (sent) fired++;
    await removeWatcher("price", watcher.id);
  }

  const polyWatchers = await listWatchers("polymarket");
  checked += polyWatchers.length;
  for (const watcher of polyWatchers) {
    const params = watcher.params as PolymarketWatcherParams;
    let markets;
    try { markets = await getTopMarkets(params.title, 1); } catch { continue; }
    const market = markets.find(m => m.slug === params.slug) ?? markets[0];
    if (!market) continue;

    const baseline = params.baselineVolume || 1;
    const pctChange = ((market.volume - baseline) / baseline) * 100;
    if (Math.abs(pctChange) < 20) continue; // not a meaningful move yet

    const sent = await sendNotification(watcher.identity, {
      title: "Polymarket alert",
      body: `"${params.title}" volume moved ${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(0)}% since you started watching.`,
      url: "https://www.tryskopos.xyz/app",
    });
    if (sent) fired++;
    await removeWatcher("polymarket", watcher.id);
    await registerWatcher("polymarket", watcher.identity, { ...params, baselineVolume: market.volume });
  }

  const onchainWatchers = await listWatchers("onchain");
  checked += onchainWatchers.length;
  for (const watcher of onchainWatchers) {
    const params = watcher.params as OnchainWatcherParams;
    const data = await lookupAddress(params.address);
    const latestHash = data.recentTransfers[0]?.hash ?? null;
    if (!latestHash || latestHash === params.lastSeenTxHash) continue;

    const sent = await sendNotification(watcher.identity, {
      title: "Onchain activity",
      body: `New activity on ${params.address.slice(0, 6)}…${params.address.slice(-4)}.`,
      url: `https://www.tryskopos.xyz/address/${params.address}`,
    });
    if (sent) fired++;
    await removeWatcher("onchain", watcher.id);
    await registerWatcher("onchain", watcher.identity, { ...params, lastSeenTxHash: latestHash });
  }

  return Response.json({ ok: true, checked, fired });
}
