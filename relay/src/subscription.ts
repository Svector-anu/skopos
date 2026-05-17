import { GearApi } from "@gear-js/api";
import { decodeRequestPending, parsePayload } from "./event-parser.js";
import { dispatch } from "./dispatcher.js";
import { fulfillRequest, queryPending } from "./chain-writer.js";
import { config } from "./config.js";
import { withRetry } from "./retry.js";
import {
  getCursor,
  saveCursor,
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

export async function startSubscription(api: GearApi): Promise<void> {
  console.log(`[relay] subscribing to finalized heads on ${config.rpcWs}`);
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

  let lastProcessedBlock = cursor;

  await api.rpc.chain.subscribeFinalizedHeads(async (header) => {
    const blockNumber = header.number.toNumber();
    if (blockNumber <= lastProcessedBlock) return;

    try {
      await processBlock(api, blockNumber);
      lastProcessedBlock = blockNumber;
      saveCursor(blockNumber);
    } catch (err) {
      console.error(`[relay] block ${blockNumber} processing error:`, err);
    }
  });
}

async function processBlock(api: GearApi, blockNumber: number): Promise<void> {
  const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
  const events = await api.query.system.events.at(blockHash);

  let found = 0;
  for (const record of events) {
    const { event } = record;
    if (event.section !== "gear" || event.method !== "UserMessageSent") continue;

    const rawData = event.data as unknown as {
      message: {
        source: { toHex(): string };
        payload: { toHex(): string };
      };
    };
    const sourceHex = rawData.message.source.toHex();
    const payloadHex = rawData.message.payload.toHex();

    if (sourceHex !== config.bridgeProgramId) continue;

    found++;
    const decoded = decodeRequestPending(payloadHex);
    if (!decoded) continue;

    const payload = parsePayload(decoded.payload);
    if (!payload) {
      console.warn(`[relay] block ${blockNumber}: invalid BridgePayload schema`);
      continue;
    }

    const idStr = decoded.id.toString();
    if (sessionSeen.has(idStr)) continue;

    const req: InFlightRequest = {
      id: decoded.id,
      caller: decoded.caller,
      payload,
      status: "pending",
      retryCount: 0,
    };

    const inserted = insertRequest(req, config.bridgeProgramId, blockNumber);
    if (!inserted) continue; // DB INSERT OR IGNORE → already in DB from a prior run

    sessionSeen.add(idStr);
    console.log(`[relay] block ${blockNumber}: RequestPending id=${decoded.id} type=${payload.type}`);
    track(handleRequest(api, req));
  }

  if (found === 0 && blockNumber % 10 === 0) {
    console.log(`[relay] block ${blockNumber}: alive, no bridge events`);
  }
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
    updateRequestStatus(req.id, config.bridgeProgramId, "failed", req.retryCount);
    console.error(`[relay] id=${req.id}: all retries exhausted — dead-lettered`);
    return;
  }

  updateRequestStatus(req.id, config.bridgeProgramId, "submitting");
  console.log(`[relay] id=${req.id}: skopos ok, submitting fulfill_request`);

  try {
    await fulfillRequest(api, config.bridgeProgramId, req.id, result);
    updateRequestStatus(req.id, config.bridgeProgramId, "done");
    console.log(`[relay] id=${req.id}: DONE`);
  } catch (err) {
    updateRequestStatus(req.id, config.bridgeProgramId, "failed");
    console.error(`[relay] id=${req.id}: fulfill_request failed:`, err);
  }
}
