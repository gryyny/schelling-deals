import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import type { KeyPair, Near } from "near-kit";
import { getDeal, getRedemption, type RedemptionView } from "./deal.ts";

export interface Pass {
  deal: string;
  buyer: string;
  units: number;
  redemptionId: number;
  item: string;
  issuedAt: string;
}

export interface SignedPass {
  pass: Pass;
  seller: string;
  publicKey: string; // ed25519:<base58>
  signature: string; // ed25519:<base58>
  digest: string; // sha256 hex of canonicalPassBytes(pass)
}

/** Fixed key order, no whitespace: the bytes that are signed and hashed. */
export function canonicalPassBytes(p: Pass): Uint8Array {
  const ordered: Pass = {
    deal: p.deal,
    buyer: p.buyer,
    units: p.units,
    redemptionId: p.redemptionId,
    item: p.item,
    issuedAt: p.issuedAt,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

export function passDigest(p: Pass): string {
  return bytesToHex(sha256(canonicalPassBytes(p)));
}

export function signPass(pass: Pass, seller: string, key: KeyPair): SignedPass {
  const sig = key.sign(canonicalPassBytes(pass));
  return {
    pass,
    seller,
    publicKey: key.publicKey.toString(),
    signature: `ed25519:${base58.encode(sig.data)}`,
    digest: passDigest(pass),
  };
}

function ed25519Bytes(s: string): Uint8Array {
  if (!s.startsWith("ed25519:")) throw new Error(`not an ed25519 value: ${s}`);
  return base58.decode(s.slice("ed25519:".length));
}

export function verifyPassSignature(sp: SignedPass): boolean {
  return ed25519.verify(ed25519Bytes(sp.signature), canonicalPassBytes(sp.pass), ed25519Bytes(sp.publicKey));
}

export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** The on-chain facts a pass is checked against. */
export interface ChainReader {
  accessKeys(accountId: string): Promise<string[]>;
  dealSeller(dealId: string): Promise<string | null>;
  redemption(dealId: string, id: number): Promise<RedemptionView | null>;
}

export function nearChainReader(near: Near): ChainReader {
  return {
    accessKeys: async (accountId) => (await near.rpc.getAccessKeys(accountId)).keys.map((k) => k.public_key),
    dealSeller: async (dealId) => (await getDeal(near, dealId))?.seller ?? null,
    redemption: (dealId, id) => getRedemption(near, dealId, id),
  };
}

export interface PassVerdict {
  ok: boolean;
  /** First failed check, in check order; undefined when ok. */
  reason?: string;
  checks: Record<string, boolean>;
  validUntil: string | null;
}

export function passValidUntil(p: Pass): Date | null {
  const issued = Date.parse(p.issuedAt);
  return Number.isFinite(issued) && Number.isInteger(p.units) && p.units > 0 ? new Date(issued + p.units * MONTH_MS) : null;
}

function safeSignatureCheck(sp: SignedPass): boolean {
  try {
    return verifyPassSignature(sp);
  } catch {
    return false;
  }
}

/** Signature, seller key, deal seller, on-chain digest, buyer/units, validity window (1 unit = 30 days). */
export async function verifyPass(sp: SignedPass, chain: ChainReader, nowMs: number): Promise<PassVerdict> {
  const digest = passDigest(sp.pass);
  const [keys, seller, red] = await Promise.all([
    chain.accessKeys(sp.seller).catch((): string[] => []),
    chain.dealSeller(sp.pass.deal).catch(() => null),
    chain.redemption(sp.pass.deal, sp.pass.redemptionId).catch(() => null),
  ]);
  const until = passValidUntil(sp.pass);
  const checks: Record<string, boolean> = {
    signatureValid: safeSignatureCheck(sp),
    keyOnSellerAccount: keys.includes(sp.publicKey),
    dealSellerMatches: seller !== null && seller === sp.seller,
    digestOnChain: red?.digest === digest,
    buyerAndUnitsMatch: red?.buyer === sp.pass.buyer && red.units === sp.pass.units,
    withinValidity: until !== null && Date.parse(sp.pass.issuedAt) <= nowMs && nowMs < until.getTime(),
  };
  const reason = Object.entries(checks).find(([, v]) => !v)?.[0];
  return { ok: reason === undefined, ...(reason ? { reason } : {}), checks, validUntil: until?.toISOString() ?? null };
}

export function encodePassHeader(sp: SignedPass): string {
  return `Pass ${Buffer.from(JSON.stringify(sp)).toString("base64url")}`;
}

export function decodePassHeader(header: string | undefined): SignedPass | null {
  const m = /^Pass ([A-Za-z0-9_-]+)$/.exec(header?.trim() ?? "");
  if (!m?.[1]) return null;
  try {
    const sp = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as SignedPass;
    const p = sp.pass;
    const valid =
      typeof sp.seller === "string" &&
      typeof sp.publicKey === "string" &&
      typeof sp.signature === "string" &&
      typeof p === "object" &&
      p !== null &&
      typeof p.deal === "string" &&
      typeof p.buyer === "string" &&
      typeof p.units === "number" &&
      typeof p.redemptionId === "number" &&
      typeof p.item === "string" &&
      typeof p.issuedAt === "string";
    return valid ? sp : null;
  } catch {
    return null;
  }
}
