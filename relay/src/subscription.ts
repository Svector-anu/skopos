import { GearApi } from "@gear-js/api";
import type { UserMessageSent } from "@gear-js/api";
import { decodeRequestPending, parsePayload } from "./event-parser.js";
import { dispatch } from "./dispatcher.js";
import { fulfillRequest, queryPending } from "./chain-writer.js";
import { config } from "./config.js";
import { withRetry } from "./retry.js";
import {
  getCursor,
  insertRequest,
  updateRequestStatus,
  loadPendingRequests,
} from "./request-state.js";
import type { InFlightRequest } from "./types.js";

// In-memory dedup guard for the current session only.
// The DB is the authoritative store; this just avoids redundant DB inserts
// for events seen in the same process lifetime.
const sessionSeen = new Set<string>();

const activeRequests = new Set<Promise<void>>();

export function waitForDrain(timeoutMs = 30_000): Promise<void> {
  if (activeRequests.size === 0) return Promise.resolve();
  console.log(`[relay] draining ${activeRequests.size} in-flight request(s)...`);
  return Promise.race([
    Promise.allSettled([...activeRequests]).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function track(p: Promise<void>): void {
  activeRequests.add(p);
  p.finally(() => activeRequests.delete(p));
}

// subscribeToGearEvent does not survive WS reconnections — the returned promise
// stays pending but stops delivering events after a disconnect/reconnect cycle.
// runSubscription wraps it so it can be called again on each reconnect.
async function runSubscription(api: GearApi): Promise<void> {
  const cursor = getCursor();
  console.log(`[relay] (re)subscribing to UserMessageSent from block ${cursor || "genesis"}`);
  await api.gearEvents.subscribeToGearEvent(
    "UserMessageSent",
    (event: UserMessageSent) => {
      void processEvent(api, event);
    },
    cursor > 0 ? cursor : undefined,
    "finalized",
  );
}

export async function startSubscription(api: GearApi): Promise<void> {
  console.log(`[relay] subscribing to UserMessageSent on ${config.rpcWs}`);
  console.log(`[relay] watching bridge program: ${config.bridgeProgramId}`);

  const cursor = getCursor();
  console.log(`[relay] cursor: last processed block = ${cursor}`);

  // Re-queue any requests that were in-flight when the relay last crashed.
  const recovered = loadPendingRequests();
  if (recovered.length > 0) {
    console.log(`[relay] recovering ${recovered.length} in-flight request(s) from DB`);
    for (const req of recovered) {
      sessionSeen.add(req.id.toString());

      // For requests that were mid-submission when the relay crashed, check the chain
      // before re-queuing. If the bridge no longer has this request pending, it was
      // already fulfilled — mark done and skip to avoid wasting gas on a double-submit.
      if (req.status === "submitting") {
        const stillPending = await queryPending(api, config.bridgeProgramId, req.id);
        if (!stillPending) {
          console.log(`[relay] recovering id=${req.id}: already fulfilled on-chain, marking done`);
          updateRequestStatus(req.id, config.bridgeProgramId, "done");
          continue;
        }
      }

      track(handleRequest(api, req));
    }
  }

  // Re-subscribe whenever the WS connection is restored.
  // Guard against multiple rapid disconnects racing to re-subscribe.
  let resubscribePending = false;
  api.on("disconnected", () => {
    console.log("[relay] WS disconnected — subscription paused, waiting for reconnect");
    if (resubscribePending) return;
    resubscribePending = true;
    api.once("connected", () => {
      resubscribePending = false;
      void api.isReady
        .then(() => runSubscription(api))
        .catch((err: unknown) => {
          console.error("[relay] resubscribe after reconnect failed:", err);
        });
    });
  });

  await runSubscription(api);
}

async function processEvent(api: GearApi, event: UserMessageSent): Promise<void> {
  const { message } = event.data;
  const sourceHex = message.source.toHex();

  if (sourceHex !== config.bridgeProgramId) return;

  const blockNumber = 0; // block number not directly on event; use for logging only
  const payloadHex = message.payload.toHex();

  console.log(`[relay] oracle UserMessageSent src=${sourceHex.slice(0, 10)} payload=${payloadHex.slice(0, 40)}`);

  const decoded = decodeRequestPending(payloadHex);
  if (!decoded) {
    console.warn(`[relay] decode failed payload=${payloadHex.slice(0, 60)}`);
    return;
  }

  const payload = parsePayload(decoded.payload);
  if (!payload) {
    console.warn(`[relay] invalid BridgePayload schema`);
    return;
  }

  const idStr = decoded.id.toString();
  if (sessionSeen.has(idStr)) return;

  const req: InFlightRequest = {
    id: decoded.id,
    caller: decoded.caller,
    payload,
    status: "pending",
    retryCount: 0,
  };

  const inserted = insertRequest(req, config.bridgeProgramId, blockNumber);
  if (!inserted) return; // DB INSERT OR IGNORE → already in DB from a prior run

  sessionSeen.add(idStr);
  console.log(`[relay] RequestPending id=${decoded.id} type=${payload.type}`);
  track(handleRequest(api, req));
}

export async function handleRequest(api: GearApi, req: InFlightRequest): Promise<void> {
  updateRequestStatus(req.id, config.bridgeProgramId, "querying");

  const result = await withRetry(
    req,
    () => dispatch(req.id, req.payload),
    (retryCount) => {
      updateRequestStatus(req.id, config.bridgeProgramId, "querying", retryCount);
    },
  );

  if (!result.ok) {
    console.error(`[relay] id=${req.id}: all retries exhausted — submitting error result to chain`);
  } else {
    console.log(`[relay] id=${req.id}: skopos ok, submitting fulfill_request`);
  }

  updateRequestStatus(req.id, config.bridgeProgramId, "submitting");
  try {
    await fulfillRequest(api, config.bridgeProgramId, req.id, result);
    updateRequestStatus(req.id, config.bridgeProgramId, result.ok ? "done" : "failed");
    console.log(`[relay] id=${req.id}: ${result.ok ? "DONE" : "DONE (error result delivered)"}`);
  } catch (err) {
    updateRequestStatus(req.id, config.bridgeProgramId, "failed");
    console.error(`[relay] id=${req.id}: fulfill_request failed:`, err);
  }
}
