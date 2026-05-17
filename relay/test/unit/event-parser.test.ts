import { describe, it, expect } from "vitest";
import { decodeRequestPending, parsePayload } from "../../src/event-parser.js";
import { buildRequestPendingHex } from "../helpers.js";

describe("decodeRequestPending", () => {
  it("decodes a valid RequestPending payload", () => {
    const hex = buildRequestPendingHex({ id: 1n });
    const result = decodeRequestPending(hex);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1n);
    expect(result!.caller).toBe("0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d");
    expect(JSON.parse(result!.payload)).toMatchObject({ v: "1", type: "price" });
  });

  it("decodes id=0 and large ids correctly", () => {
    expect(decodeRequestPending(buildRequestPendingHex({ id: 0n }))!.id).toBe(0n);
    expect(decodeRequestPending(buildRequestPendingHex({ id: 999999n }))!.id).toBe(999999n);
    expect(decodeRequestPending(buildRequestPendingHex({ id: 2n ** 32n }))!.id).toBe(2n ** 32n);
  });

  it("returns null for wrong GM magic bytes", () => {
    const hex = buildRequestPendingHex();
    const bytes = Buffer.from(hex.slice(2), "hex");
    bytes[0] = 0x00;
    expect(decodeRequestPending("0x" + bytes.toString("hex"))).toBeNull();
  });

  it("returns null for wrong interface_id", () => {
    const wrongId = Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(decodeRequestPending(buildRequestPendingHex({ interfaceId: wrongId }))).toBeNull();
  });

  it("returns null for wrong entry_id (e.g. RequestFulfilled=0)", () => {
    // entry_id=0 is RequestFulfilled — should not decode as RequestPending
    expect(decodeRequestPending(buildRequestPendingHex({ entryId: 0 }))).toBeNull();
  });

  it("returns null for wrong route_idx", () => {
    expect(decodeRequestPending(buildRequestPendingHex({ routeIdx: 0 }))).toBeNull();
    expect(decodeRequestPending(buildRequestPendingHex({ routeIdx: 2 }))).toBeNull();
  });

  it("returns null for truncated payload (too short for header + id + caller)", () => {
    const hex = buildRequestPendingHex();
    const truncated = "0x" + hex.slice(2, 10); // only 4 bytes
    expect(decodeRequestPending(truncated)).toBeNull();
  });

  it("returns null for payload string truncated mid-string", () => {
    const hex = buildRequestPendingHex();
    // Drop last 10 bytes (cuts into the UTF-8 payload)
    const truncated = "0x" + hex.slice(2, -20);
    expect(decodeRequestPending(truncated)).toBeNull();
  });

  it("returns null for non-hex input", () => {
    expect(decodeRequestPending("not hex at all")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(decodeRequestPending("0x")).toBeNull();
  });
});

describe("parsePayload", () => {
  it("parses a valid price payload", () => {
    const result = parsePayload('{"v":"1","type":"price","params":{"symbol":"ETH"}}');
    expect(result).toMatchObject({ v: "1", type: "price", params: { symbol: "ETH" } });
  });

  it("parses all supported query types", () => {
    for (const type of ["price", "risk", "yield", "markets", "quote", "portfolio"]) {
      const result = parsePayload(JSON.stringify({ v: "1", type, params: {} }));
      expect(result).not.toBeNull();
      expect(result!.type).toBe(type);
    }
  });

  it("returns null for wrong schema version", () => {
    expect(parsePayload('{"v":"2","type":"price","params":{}}')).toBeNull();
    expect(parsePayload('{"type":"price","params":{}}')).toBeNull();
  });

  it("returns null for missing type", () => {
    expect(parsePayload('{"v":"1","params":{}}')).toBeNull();
  });

  it("returns null for missing params", () => {
    expect(parsePayload('{"v":"1","type":"price"}')).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parsePayload("{bad json")).toBeNull();
    expect(parsePayload("")).toBeNull();
  });
});
