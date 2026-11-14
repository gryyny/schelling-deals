import { generateKey } from "near-kit";
import { describe, expect, it } from "vitest";
import { type BuyerProfile, decide, PROFILES, tierCost } from "../src/agents.ts";
import { type Offer, REDEEM_FEE, STORAGE_FEE } from "../src/deal.ts";
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

describe("budget boundary", () => {
  const price = 100_000_000_000_000_000_000_000n;
  const cost = 4n * price + STORAGE_FEE + REDEEM_FEE;
  const prof = (budgetYocto: bigint): BuyerProfile => ({ name: "T", needUnits: 4, maxUnitPriceYocto: price, budgetYocto, patient: false });
  const oneTier: Offer = { ...offer, tiers: [offer.tiers[0]!] };

  it("cost includes storage and redeem fees", () => {
    expect(tierCost(price, 4, false).total).toBe(cost);
    expect(tierCost(price, 4, true).total).toBe(cost - STORAGE_FEE);
  });
  it("accepts when budget equals cost exactly", () => {
    expect(decide(oneTier, prof(cost), 1000n).tierIndex).toBe(0);
  });
  it("declines at 1 yocto below cost", () => {
    expect(decide(oneTier, prof(cost - 1n), 1000n).tierIndex).toBeNull();
  });
  it("an existing buyer does not pay the storage fee again", () => {
    expect(decide(oneTier, prof(cost - STORAGE_FEE), 1000n, () => true).tierIndex).toBe(0);
    expect(decide(oneTier, prof(cost - STORAGE_FEE), 1000n).tierIndex).toBeNull();
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
