import { readFile } from "node:fs/promises";
import { deriveAccountId, type Near, type TransactionBuilder } from "near-kit";

export const STORAGE_FEE = 10_000_000_000_000_000_000_000n; // 0.01 NEAR per new buyer, refunded with the pledge
export const REDEEM_FEE = 4_000_000_000_000_000_000_000n; // 0.004 NEAR per redemption, not refunded
export const STATE_KEY = new TextEncoder().encode("STATE");
export const EVENT_STANDARD = "schelling-deals";

export const DealStatus = { Open: 0, Paying: 1, Paid: 2, PayoutFailed: 3 } as const;
export const STATUS_NAMES = ["Open", "Paying", "Paid", "PayoutFailed"] as const;

export interface Tier {
  minUnits: number;
  maxUnits: number;
  unitPriceYocto: string;
  deadlineNs: string;
}

export interface Offer {
  offerId: string;
  codeHash: string;
  seller: string;
  item: string;
  tiers: Tier[];
}

/** Everything that fixes one deal's address: the offer header plus one tier. */
export interface DealTerms {
  codeHash: string;
  seller: string;
  item: string;
  offerId: string;
  unitPrice: bigint;
  minUnits: number;
  maxUnits: number;
  deadlineNs: bigint;
}

export function termsFor(offer: Offer, tierIndex: number): DealTerms {
  const tier = offer.tiers[tierIndex];
  if (!tier) throw new Error(`offer ${offer.offerId} has no tier ${tierIndex}`);
  return {
    codeHash: offer.codeHash,
    seller: offer.seller,
    item: offer.item,
    offerId: offer.offerId,
    unitPrice: BigInt(tier.unitPriceYocto),
    minUnits: tier.minUnits,
    maxUnits: tier.maxUnits,
    deadlineNs: BigInt(tier.deadlineNs),
  };
}

// ---------- borsh ----------

class BorshWriter {
  private readonly chunks: Uint8Array[] = [];

  u8(v: number): this {
    this.chunks.push(Uint8Array.of(v));
    return this;
  }

  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.chunks.push(b);
    return this;
  }

  u64(v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    this.chunks.push(b);
    return this;
  }

  u128(v: bigint): this {
    if (v < 0n || v >= 1n << 128n) throw new Error(`u128 out of range: ${v}`);
    const b = new Uint8Array(16);
    const dv = new DataView(b.buffer);
    dv.setBigUint64(0, v & 0xffff_ffff_ffff_ffffn, true);
    dv.setBigUint64(8, v >> 64n, true);
    this.chunks.push(b);
    return this;
  }

  bytes(v: Uint8Array): this {
    this.u32(v.length);
    this.chunks.push(v);
    return this;
  }

  string(v: string): this {
    return this.bytes(new TextEncoder().encode(v));
  }

  raw(v: Uint8Array): this {
    this.chunks.push(v);
    return this;
  }

  finish(): Uint8Array {
    const len = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

export { BorshWriter };

/** Initial DealState, field order per SPEC. */
export function encodeInitialDealState(t: DealTerms): Uint8Array {
  return new BorshWriter()
    .string(t.seller)
    .string(t.item)
    .string(t.offerId)
    .u128(t.unitPrice)
    .u32(t.minUnits)
    .u32(t.maxUnits)
    .u64(t.deadlineNs)
    .u32(0) // total_units
    .u32(0) // buyers
    .u8(DealStatus.Open)
    .u32(0) // redemptions
    .finish();
}

export interface DealStateInit {
  code: { codeHash: string };
  data: Map<Uint8Array, Uint8Array>;
}

export function dealStateInit(t: DealTerms): DealStateInit {
  return { code: { codeHash: t.codeHash }, data: new Map([[STATE_KEY, encodeInitialDealState(t)]]) };
}

export function dealAccountId(t: DealTerms): string {
  return deriveAccountId(dealStateInit(t));
}

// ---------- views ----------

export interface DealView {
  seller: string;
  item: string;
  offer_id: string;
  unit_price: string;
  min_units: number;
  max_units: number;
  deadline_ns: string;
  total_units: number;
  buyers: number;
  status: number | string;
  redemptions: number;
}

export interface PledgeView {
  units: number;
  redeemed: number;
}

export interface RedemptionView {
  buyer: string;
  units: number;
  note: string;
  digest: string | null;
}

export async function getDeal(near: Near, dealId: string): Promise<DealView | null> {
  if (!(await near.accountExists(dealId))) return null;
  return (await near.view<DealView>(dealId, "get_deal", {})) ?? null;
}

export async function getPledge(near: Near, dealId: string, buyer: string): Promise<PledgeView | null> {
  if (!(await near.accountExists(dealId))) return null;
  try {
    const p = await near.view<PledgeView | null>(dealId, "get_pledge", { buyer });
    return p && p.units > 0 ? p : null;
  } catch {
    return null; // contract may panic for unknown buyers
  }
}

export async function getRedemption(near: Near, dealId: string, id: number): Promise<RedemptionView | null> {
  try {
    return (await near.view<RedemptionView | null>(dealId, "get_redemption", { id })) ?? null;
  } catch {
    return null;
  }
}

export function statusName(s: number | string): string {
  return typeof s === "number" ? (STATUS_NAMES[s] ?? `unknown(${s})`) : s;
}

export function isStatus(s: number | string, want: keyof typeof DealStatus): boolean {
  return s === DealStatus[want] || s === want;
}

// ---------- transactions ----------

export interface ContractEvent {
  standard: string;
  version: string;
  event: string;
  data: unknown;
}

export interface TxRecord {
  label: string;
  hash: string;
  signer: string;
  receiver: string;
  ok: boolean;
  error?: string;
  failedReceipts: number;
  events: ContractEvent[];
  logs: string[];
}

interface RawOutcome {
  logs: string[];
  status: Record<string, unknown> | string;
}

interface RawTxStatus {
  transaction: { receiver_id: string };
  status: Record<string, unknown> | string;
  transaction_outcome: { outcome: RawOutcome };
  receipts_outcome: { outcome: RawOutcome }[];
}

export function parseEvents(logs: readonly string[]): ContractEvent[] {
  const prefix = "EVENT_JSON:";
  return logs.flatMap((l) => {
    if (!l.startsWith(prefix)) return [];
    try {
      const e = JSON.parse(l.slice(prefix.length)) as ContractEvent;
      return e.standard === EVENT_STANDARD ? [e] : [];
    } catch {
      return [];
    }
  });
}

function isFailure(status: RawOutcome["status"]): boolean {
  return typeof status === "object" && status !== null && "Failure" in status;
}

/** Sends a transaction, never throws on on-chain failure; returns the full outcome. */
export async function submit(near: Near, label: string, signer: string, builder: TransactionBuilder): Promise<TxRecord> {
  const signed = await builder.sign();
  const hash = signed.getHash();
  if (!hash) throw new Error(`${label}: no tx hash after signing`);
  let sendError: string | undefined;
  try {
    await signed.send({ waitUntil: "FINAL" });
  } catch (e) {
    sendError = e instanceof Error ? e.message : String(e);
  }
  let raw: RawTxStatus;
  try {
    raw = await near.rpc.call<RawTxStatus>("EXPERIMENTAL_tx_status", {
      tx_hash: hash,
      sender_account_id: signer,
      wait_until: "FINAL",
    });
  } catch (e) {
    // transaction never landed (e.g. rejected before inclusion)
    return {
      label,
      hash,
      signer,
      receiver: "",
      ok: false,
      error: sendError ?? (e instanceof Error ? e.message : String(e)),
      failedReceipts: 0,
      events: [],
      logs: [],
    };
  }
  const logs = raw.receipts_outcome.flatMap((r) => r.outcome.logs);
  const failed = raw.receipts_outcome.filter((r) => isFailure(r.outcome.status));
  const ok = !isFailure(raw.status);
  const firstFailure = failed[0]?.outcome.status;
  return {
    label,
    hash,
    signer,
    receiver: raw.transaction.receiver_id,
    ok,
    ...(ok ? {} : { error: sendError ?? JSON.stringify(firstFailure ?? raw.status) }),
    failedReceipts: failed.length,
    events: parseEvents(logs),
    logs,
  };
}

const GAS_PLEDGE = "30 Tgas" as const;
const GAS_PAYOUT = "100 Tgas" as const;

export function pledgeDeposit(t: DealTerms, currentUnits: number, units: number): bigint {
  const delta = BigInt(units - currentUnits);
  return delta * t.unitPrice + (currentUnits === 0 ? STORAGE_FEE : 0n);
}

/** Raw create-if-needed + pledge with an explicit deposit (used for retry/negative tests). */
export function pledgeTx(near: Near, buyer: string, t: DealTerms, units: number, deposit: bigint): TransactionBuilder {
  const dealId = dealAccountId(t);
  return near
    .transaction(buyer)
    .stateInit({ ...dealStateInit(t), deposit: 0n })
    .functionCall(dealId, "pledge", { units }, { gas: GAS_PLEDGE, attachedDeposit: deposit });
}

export interface JoinResult {
  dealId: string;
  previousUnits: number;
  deposit: bigint;
  tx: TxRecord;
}

/** One transaction: deploy the deal account if absent, then pledge `units` (absolute total). */
export async function join(near: Near, buyer: string, t: DealTerms, units: number, label = `pledge ${units} by ${buyer}`): Promise<JoinResult> {
  const dealId = dealAccountId(t);
  const previousUnits = (await getPledge(near, dealId, buyer))?.units ?? 0;
  const deposit = pledgeDeposit(t, previousUnits, units);
  const tx = await submit(near, label, buyer, pledgeTx(near, buyer, t, units, deposit));
  return { dealId, previousUnits, deposit, tx };
}

export function settle(near: Near, caller: string, dealId: string, label = `settle by ${caller}`): Promise<TxRecord> {
  return submit(near, label, caller, near.transaction(caller).functionCall(dealId, "settle", {}, { gas: GAS_PAYOUT }));
}

export function refund(near: Near, caller: string, dealId: string, buyer: string, label = `refund ${buyer} by ${caller}`): Promise<TxRecord> {
  return submit(near, label, caller, near.transaction(caller).functionCall(dealId, "refund", { buyer }, { gas: GAS_PAYOUT }));
}

export function redeem(near: Near, buyer: string, dealId: string, units: number, note: string): Promise<TxRecord> {
  return submit(near, `redeem ${units} by ${buyer}`, buyer, near.transaction(buyer).functionCall(dealId, "redeem", { units, note }, { gas: GAS_PLEDGE, attachedDeposit: REDEEM_FEE }));
}

export function confirmDelivery(near: Near, seller: string, dealId: string, id: number, digest: string): Promise<TxRecord> {
  return submit(
    near,
    `confirm_delivery ${id} by ${seller}`,
    seller,
    near.transaction(seller).functionCall(dealId, "confirm_delivery", { id, digest }, { gas: GAS_PLEDGE }),
  );
}

// ---------- chain time ----------

export async function blockTimeNs(near: Near): Promise<bigint> {
  const block = await near.rpc.getBlock({ finality: "final" });
  return BigInt(block.header.timestamp_nanosec);
}

export async function waitForBlockTime(near: Near, targetNs: bigint, onTick?: (remainingS: number) => void): Promise<void> {
  for (;;) {
    const now = await blockTimeNs(near);
    if (now >= targetNs) return;
    const remainingS = Number((targetNs - now) / 1_000_000_000n);
    onTick?.(remainingS);
    await new Promise((r) => setTimeout(r, Math.min(5000, Math.max(1000, remainingS * 1000))));
  }
}

// ---------- offer loading ----------

export async function loadOffer(source: string): Promise<Offer> {
  const text = /^https?:\/\//.test(source) ? await (await fetch(source)).text() : await readFile(source, "utf8");
  const o = JSON.parse(text) as Offer;
  if (typeof o.offerId !== "string" || typeof o.codeHash !== "string" || typeof o.seller !== "string" || !Array.isArray(o.tiers)) {
    throw new Error(`invalid offer file: ${source}`);
  }
  return o;
}

export const NEAR = 10n ** 24n;

export function formatNear(yocto: bigint): string {
  const neg = yocto < 0n;
  const v = neg ? -yocto : yocto;
  const whole = v / NEAR;
  const frac = (v % NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac.slice(0, 6)}` : ""} NEAR`;
}
