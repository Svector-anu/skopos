export type QueryType = "price" | "risk" | "yield" | "markets" | "quote" | "portfolio";

export interface BridgePayload {
  v: "1";
  type: QueryType;
  params: Record<string, unknown>;
}

export interface BridgeResult {
  v: "1";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  ts: number;
}

export interface RequestPendingEvent {
  id: bigint;
  caller: string;
  payload: string;
}

export interface InFlightRequest {
  id: bigint;
  caller: string;
  payload: BridgePayload;
  status: "pending" | "querying" | "submitting" | "done" | "failed";
  retryCount: number;
}
