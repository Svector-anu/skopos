import { NextRequest } from "next/server";
import { listWatchers, removeWatcher, type PriceWatcherParams } from "@/lib/watchers";
import { sendNotification } from "@/lib/notifications";
import { getPrice } from "@/lib/priceCache";

export const dynamic = "force-dynamic";

// Vercel Cron target for the standing-watch trio (price-alert is the only one
// wired so far — monitor-polymarket and onchain-monitor plug into the same
// listWatchers/sendNotification pair with their own kind + check function).
// One-shot alerts: a fired watcher is removed, not re-armed, since re-firing
// every run once a threshold is crossed would spam.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const watchers = await listWatchers("price");
  let fired = 0;

  for (const watcher of watchers) {
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

  return Response.json({ ok: true, checked: watchers.length, fired });
}
