import { generateKey } from "near-kit";
import { describe, expect, it } from "vitest";
import { handleApiRequest } from "../src/api.ts";
import { type ChainReader, encodePassHeader, MONTH_MS, type Pass, passDigest, signPass } from "../src/pass.ts";

const key = generateKey();
const issuedAt = "2026-11-14T00:00:00.000Z";
const pass: Pass = { deal: "0sdeal", buyer: "ada.testnet", units: 2, redemptionId: 0, item: "Quote Feed", issuedAt };
const sp = signPass(pass, "seller.testnet", key);
const now = Date.parse(issuedAt) + 1000;

function chain(over: Partial<{ keys: string[]; seller: string | null; digest: string | null; units: number }> = {}): ChainReader {
  return {
    accessKeys: async () => over.keys ?? [key.publicKey.toString()],
    dealSeller: async () => (over.seller === undefined ? "seller.testnet" : over.seller),
    redemption: async () => ({ buyer: "ada.testnet", units: over.units ?? 2, note: "", digest: over.digest === undefined ? passDigest(pass) : over.digest }),
  };
}
const get = (authorization: string | undefined, c = chain(), t = now) => handleApiRequest({ method: "GET", path: "/v1/quotes", authorization }, c, t);

describe("Quote Feed API", () => {
  it("serves a valid pass", async () => {
    const r = await get(encodePassHeader(sp));
    expect(r.status).toBe(200);
    expect(r.body["seat"]).toBe("ada.testnet");
    expect(r.body["validUntil"]).toBe(new Date(Date.parse(issuedAt) + 2 * MONTH_MS).toISOString());
    expect(r.body["dataLabel"]).toBe("sample data");
  });
  it("rejects missing, malformed and tampered passes", async () => {
    expect((await get(undefined)).status).toBe(401);
    expect((await get("Pass !!!")).body["error"]).toBe("malformed pass");
    const t = await get(encodePassHeader({ ...sp, pass: { ...pass, units: 3 } }));
    expect(t.status).toBe(401);
    expect(t.body["error"]).toBe("signatureValid");
  });
  it("rejects on each chain mismatch", async () => {
    expect((await get(encodePassHeader(sp), chain({ keys: [] }))).body["error"]).toBe("keyOnSellerAccount");
    expect((await get(encodePassHeader(sp), chain({ seller: "other.testnet" }))).body["error"]).toBe("dealSellerMatches");
    expect((await get(encodePassHeader(sp), chain({ digest: null }))).body["error"]).toBe("digestOnChain");
    expect((await get(encodePassHeader(sp), chain({ units: 1 }))).body["error"]).toBe("buyerAndUnitsMatch");
  });
  it("enforces the validity window (1 unit = 30 days)", async () => {
    const end = Date.parse(issuedAt) + 2 * MONTH_MS;
    expect((await get(encodePassHeader(sp), chain(), end - 1)).status).toBe(200);
    expect((await get(encodePassHeader(sp), chain(), end)).body["error"]).toBe("withinValidity");
  });
  it("404s other routes", async () => {
    expect((await handleApiRequest({ method: "GET", path: "/", authorization: undefined }, chain(), now)).status).toBe(404);
  });
});
