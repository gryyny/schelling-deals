import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { createStateInit, serializeStateInit } from "near-kit";
import { describe, expect, it } from "vitest";
import { BorshWriter, type DealTerms, dealAccountId, dealStateInit, encodeInitialDealState, pledgeDeposit, REDEEM_FEE, STORAGE_FEE } from "../src/deal.ts";

const codeHash = base58.encode(new Uint8Array(32).map((_, i) => i + 1));
const terms: DealTerms = {
  codeHash,
  seller: "seller.testnet",
  item: "Quote Feed API access pass",
  offerId: "quotefeed-2026-11-14a",
  unitPrice: 100_000_000_000_000_000_000_000n,
  minUnits: 10,
  maxUnits: 20,
  deadlineNs: 1_800_000_000_000_000_000n,
};

function hex(b: Uint8Array): string {
  return bytesToHex(b);
}

describe("DealState borsh", () => {
  it("matches the SPEC layout byte for byte", () => {
    const enc = encodeInitialDealState(terms);
    const te = new TextEncoder();
    const parts: number[] = [];
    const str = (s: string) => {
      const b = te.encode(s);
      parts.push(b.length & 0xff, (b.length >> 8) & 0xff, 0, 0, ...b);
    };
    str("seller.testnet");
    str("Quote Feed API access pass");
    str("quotefeed-2026-11-14a");
    // 1e23 = 0x152d02c7e14af6800000 little-endian in 16 bytes
    parts.push(...[0x00, 0x00, 0x80, 0xf6, 0x4a, 0xe1, 0xc7, 0x02, 0x2d, 0x15, 0, 0, 0, 0, 0, 0]);
    parts.push(10, 0, 0, 0, 20, 0, 0, 0);
    // 1.8e18 = 0x18fae27693b40000
    parts.push(0x00, 0x00, 0xb4, 0x93, 0x76, 0xe2, 0xfa, 0x18);
    parts.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    expect(hex(enc)).toBe(hex(Uint8Array.from(parts)));
    expect(enc.length).toBe(4 + 14 + 4 + 26 + 4 + 21 + 16 + 4 + 4 + 8 + 4 + 4 + 1 + 4);
  });
});

describe("deal address derivation", () => {
  it("independent NEP-616 derivation equals near-kit deriveAccountId", () => {
    const state = encodeInitialDealState(terms);
    const key = new TextEncoder().encode("STATE");
    // StateInit::V1 { code: GlobalContractIdentifier::CodeHash(h), data: BTreeMap{STATE => state} }
    const manual = new BorshWriter().u8(0).u8(0).raw(base58.decode(codeHash)).u32(1).bytes(key).bytes(state).finish();
    const kit = serializeStateInit(createStateInit(dealStateInit(terms)));
    expect(hex(kit)).toBe(hex(manual));
    const id = `0s${hex(keccak_256(manual).slice(12, 32))}`;
    expect(dealAccountId(terms)).toBe(id);
    expect(id).toMatch(/^0s[0-9a-f]{40}$/);
  });

  it("any term change gives a different address", () => {
    const base = dealAccountId(terms);
    const variants: DealTerms[] = [
      { ...terms, unitPrice: terms.unitPrice + 1n },
      { ...terms, minUnits: 11 },
      { ...terms, maxUnits: 21 },
      { ...terms, deadlineNs: terms.deadlineNs + 1n },
      { ...terms, seller: "other.testnet" },
      { ...terms, item: `${terms.item}.` },
      { ...terms, offerId: "x" },
      { ...terms, codeHash: base58.encode(new Uint8Array(32).fill(9)) },
    ];
    const ids = new Set([base, ...variants.map(dealAccountId)]);
    expect(ids.size).toBe(variants.length + 1);
  });
});

describe("pledge deposit", () => {
  it("uses the contract fees", () => {
    expect(STORAGE_FEE).toBe(10_000_000_000_000_000_000_000n);
    expect(REDEEM_FEE).toBe(4_000_000_000_000_000_000_000n);
  });
  it("adds the storage fee only for a new buyer", () => {
    expect(pledgeDeposit(terms, 0, 4)).toBe(4n * terms.unitPrice + STORAGE_FEE);
    expect(pledgeDeposit(terms, 4, 6)).toBe(2n * terms.unitPrice);
  });
});
