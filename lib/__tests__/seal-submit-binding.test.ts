import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The claim this file exists to prove: a Seal's order is rebuilt server-side
// from the stored policy, and the browser cannot name a single field of it.
//
// That claim is the product. /api/flash/submit forwards whatever a client sends
// (issue #83), which is survivable when the client typed the order and not
// survivable once the policy came from a stranger — so "the submit is bound"
// needs to be an assertion, not a comment.
//
// Redis and Flash are both stubbed. This repo has no fetch mocks anywhere and
// its vitest config is deliberately "pure logic, no network"; these two stubs
// stay inside that spirit — nothing here reaches a socket, and the thing under
// test is our own field derivation, not Flash's behaviour.

const store = new Map<string, string>();

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string, opts?: { nx?: boolean }) => {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    del: async (key: string) => { store.delete(key); return 1; },
    incr: async (key: string) => {
      const next = Number(store.get(key) ?? "0") + 1;
      store.set(key, String(next));
      return next;
    },
  }),
}));

const submitted = vi.fn();
vi.mock("@/lib/flash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/flash")>();
  return {
    ...actual,
    submitFlashOrder: async (req: unknown) => {
      submitted(req);
      return { orderId: "ord_test_1" };
    },
  };
});

const { POST } = await import("@/app/api/seal/[id]/submit/route");
const { putPendingOrder, putSeal } = await import("@/lib/sealStore");

const SIG = `0x${"ab".repeat(32)}`;
const BRACKET_SIG = `0x${"cd".repeat(32)}`;

function submitRequest(body: unknown) {
  return new NextRequest("https://www.tryskopos.xyz/api/seal/x/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const parkedSubmit = {
  targetChain: "base" as const, contraChain: "base" as const,
  targetAsset: "0xtarget", contraAsset: "0xcontra",
  side: "buy" as const, qty: "500", orderType: "limit" as const,
  funderAddress: "0xfunder", quoteId: "q-1",
  flashIntegratorFeeBps: "10",
  evmOrderTypedData: "{}",
  limitNotionalPrice: "200",
};

async function seedSeal() {
  const written = await putSeal({
    title: "NVDA dip buy",
    creator: "0x1111111111111111111111111111111111111111",
    side: "buy", orderType: "limit", token: "NVDA", chain: "base",
    priceLevel: "200",
    sizing: { min: "50", max: "5000", suggested: "500" },
  });
  if (!written.ok) throw new Error("seed failed");
  return written.policy.id;
}

beforeEach(() => {
  store.clear();
  submitted.mockClear();
});

describe("POST /api/seal/[id]/submit", () => {
  it("should send Flash the parked order, not anything the client said", async () => {
    // #given a Seal whose order was derived at quote time and parked
    const id = await seedSeal();
    await putPendingOrder("q-1", {
      sealId: id, size: "500", funderAddress: "0xfunder",
      submit: parkedSubmit, bracket: null,
    });

    // #when a client submits — and throws in every order field it would like
    const res = await POST(
      submitRequest({
        quoteId: "q-1", userSignature: SIG,
        qty: "999999", targetAsset: "0xattacker", side: "sell", limitNotionalPrice: "1",
      }),
      { params: Promise.resolve({ id }) },
    );

    // #then Flash receives the parked fields and the signature, and none of the
    // client's. an extra key here means a browser can name an order field.
    expect(res.status).toBe(200);
    expect(submitted).toHaveBeenCalledWith({ ...parkedSubmit, userSignature: SIG });
  });

  it("should count the instantiation only once the order is accepted", async () => {
    // #given a parked order
    const id = await seedSeal();
    await putPendingOrder("q-1", {
      sealId: id, size: "500", funderAddress: "0xfunder", submit: parkedSubmit, bracket: null,
    });

    // #when it is submitted
    await POST(submitRequest({ quoteId: "q-1", userSignature: SIG }), { params: Promise.resolve({ id }) });

    // #then the counter moved — a quote is a look, an order is a use
    expect(store.get(`seal:count:${id}`)).toBe("1");
  });

  it("should refuse a second submit of the same quote", async () => {
    // #given a quote that has already produced an order
    const id = await seedSeal();
    await putPendingOrder("q-1", {
      sealId: id, size: "500", funderAddress: "0xfunder", submit: parkedSubmit, bracket: null,
    });
    await POST(submitRequest({ quoteId: "q-1", userSignature: SIG }), { params: Promise.resolve({ id }) });
    submitted.mockClear();

    // #when the same quoteId is replayed
    const res = await POST(submitRequest({ quoteId: "q-1", userSignature: SIG }), { params: Promise.resolve({ id }) });

    // #then nothing reaches Flash a second time
    expect(res.status).toBe(409);
    expect(submitted).not.toHaveBeenCalled();
  });

  it("should refuse a quote parked for a different Seal", async () => {
    // #given an order derived from one Seal
    const mine = await seedSeal();
    const other = await seedSeal();
    await putPendingOrder("q-1", {
      sealId: other, size: "500", funderAddress: "0xfunder", submit: parkedSubmit, bracket: null,
    });

    // #when it is submitted against a different Seal's page
    const res = await POST(submitRequest({ quoteId: "q-1", userSignature: SIG }), { params: Promise.resolve({ id: mine }) });

    // #then it is refused — otherwise a permissive Seal's quote could be
    // counted, and displayed, as a stricter one's
    expect(res.status).toBe(409);
    expect(submitted).not.toHaveBeenCalled();
  });

  it("should refuse an expired quote rather than re-deriving one", async () => {
    // #given a quote whose parked order has aged out of its TTL
    const id = await seedSeal();

    // #when it is submitted
    const res = await POST(submitRequest({ quoteId: "gone", userSignature: SIG }), { params: Promise.resolve({ id }) });

    // #then it is refused. re-quoting here would mint a new quoteId, and the
    // user already signed the old one — this is also the quote-freshness rule
    // the chat path has never enforced
    expect(res.status).toBe(409);
    expect(submitted).not.toHaveBeenCalled();
  });

  it("should never submit a protected entry with only one signature", async () => {
    // #given a bracketed order
    const id = await seedSeal();
    await putPendingOrder("q-1", {
      sealId: id, size: "500", funderAddress: "0xfunder", submit: parkedSubmit,
      bracket: {
        wire: { takeProfit: { notionalPrice: "240" }, stopLoss: { notionalPrice: "180" } },
        deadline: "99", signedMaxFromAmount: "1", salt: null,
      },
    });

    // #when only the entry is signed
    const res = await POST(submitRequest({ quoteId: "q-1", userSignature: SIG }), { params: Promise.resolve({ id }) });

    // #then nothing is sent. submitting the entry alone would place a
    // completely unprotected order for someone who chose protection
    expect(res.status).toBe(400);
    expect(submitted).not.toHaveBeenCalled();
  });

  it("should echo the bracket's signed values verbatim alongside its signature", async () => {
    // #given a bracketed order with the three values baked into its signature
    const id = await seedSeal();
    await putPendingOrder("q-1", {
      sealId: id, size: "500", funderAddress: "0xfunder", submit: parkedSubmit,
      bracket: {
        wire: { takeProfit: { notionalPrice: "240" }, stopLoss: { notionalPrice: "180" } },
        deadline: "99", signedMaxFromAmount: "0.017", salt: "0xsalt",
      },
    });

    // #when both signatures are supplied
    await POST(
      submitRequest({ quoteId: "q-1", userSignature: SIG, bracketSignature: BRACKET_SIG }),
      { params: Promise.resolve({ id }) },
    );

    // #then the pair arrives with the values it was signed over. recomputing any
    // of these would invalidate the signature
    expect(submitted).toHaveBeenCalledWith(expect.objectContaining({
      attachedBracket: {
        takeProfit: { notionalPrice: "240" },
        stopLoss:   { notionalPrice: "180" },
        userSignature: BRACKET_SIG,
        deadline: "99",
        signedMaxFromAmount: "0.017",
        salt: "0xsalt",
      },
    }));
  });

  it("should refuse a body with no signature at all", async () => {
    const id = await seedSeal();
    const res = await POST(submitRequest({ quoteId: "q-1" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
    expect(submitted).not.toHaveBeenCalled();
  });
});
