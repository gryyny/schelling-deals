import { generateKey } from "near-kit";
import { describe, expect, it } from "vitest";
import { decide, PROFILES } from "../src/agents.ts";
import type { Offer } from "../src/deal.ts";
import { type Pass, passDigest, signPass, verifyPassSignature } from "../src/pass.ts";

const offer: Offer = {
  offerId: "o",
  codeHash: "11111111111111111111111111111111",
  seller: "s.testnet",
  item: "x",
  tiers: [
    { minUnits: 10, maxUnits: 20, unitPriceYocto: "100000000000000000000000", deadlineNs: "2000" },
    { minUnits: 30, maxUnits: 60, unitPriceYocto: "70000000000000000000000", deadlineNs: "2000" },
  ],
};

describe("scripted buyer decisions", () => {
  it("matches the demo profiles", () => {
    const pick = (k: string) => decide(offer, PROFILES[k]!, 1000n).tierIndex;
    expect(pick("ada")).toBe(0);
    expect(pick("bo")).toBe(0);
    expect(pick("cy")).toBeNull();
    expect(pick("dee")).toBe(1);
    expect(decide(offer, PROFILES["ada"]!, 3000n).tierIndex).toBeNull();
  });
});

describe("access pass", () => {
  it("signs, verifies and rejects tampering", () => {
    const key = generateKey();
    const pass: Pass = { deal: "0sabc", buyer: "b.testnet", units: 4, redemptionId: 0, item: "x", issuedAt: "2026-11-14T00:00:00Z" };
    const sp = signPass(pass, "s.testnet", key);
    expect(verifyPassSignature(sp)).toBe(true);
    expect(sp.digest).toBe(passDigest(pass));
    expect(sp.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPassSignature({ ...sp, pass: { ...pass, units: 5 } })).toBe(false);
  });
});
