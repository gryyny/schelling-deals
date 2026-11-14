import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import type { KeyPair } from "near-kit";

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
