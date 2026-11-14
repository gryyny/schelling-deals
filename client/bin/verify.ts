// Read-only check of the published testnet evidence. Needs no keys and no funds.
// tsx bin/verify.ts [--evidence ../evidence/testnet]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dealAccountId, getDeal, loadOffer, termsFor } from "../src/deal.ts";
import { arg, makeNear, networkFromEnv } from "../src/env.ts";

interface Row { label: string; tx: string; outcome: string; signer: string }
interface RpcResult<T> { result?: T; error?: unknown }
interface TxStatus { status: Record<string, unknown>; receipts_outcome: { outcome: { status: Record<string, unknown> } }[] }

const dir = arg("evidence", "../evidence/testnet");
const rpcUrl = process.env["SD_RPC_URL"] ?? "https://test.rpc.fastnear.com";
let failures = 0;
const check = (ok: boolean, what: string): void => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
};

async function rpc<T>(method: string, params: unknown, attempt = 0): Promise<T> {
  try {
    return await rpcOnce<T>(method, params);
  } catch (e) {
    if (attempt >= 3) throw e;
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    return rpc<T>(method, params, attempt + 1);
  }
}

async function rpcOnce<T>(method: string, params: unknown): Promise<T> {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as RpcResult<T>;
  if (!j.result) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const offer = await loadOffer(join(dir, "offer.json"));
const near = await makeNear(networkFromEnv());
const expected = ["Paid", "Open"];
for (const [i, tier] of offer.tiers.entries()) {
  const id = dealAccountId(termsFor(offer, i));
  console.log(`tier ${i}: ${id} (derived here from offer.json)`);
  const acct = await rpc<{ global_contract_hash?: string }>("query", { request_type: "view_account", finality: "final", account_id: id });
  check(acct.global_contract_hash === offer.codeHash, `runs the global contract ${offer.codeHash}`);
  const keys = await rpc<{ keys: unknown[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: id });
  check(keys.keys.length === 0, "has no access keys");
  const deal = await getDeal(near, id);
  check(deal !== null && String(deal.status) === expected[i], `status ${deal?.status} (expected ${expected[i]}), ${deal?.total_units}/${tier.minUnits} units`);
}

const receipts = JSON.parse(readFileSync(join(dir, "receipts.json"), "utf8")) as { rows: Row[] };
for (const row of receipts.rows) {
  const tx = await rpc<TxStatus>("tx", { tx_hash: row.tx, sender_account_id: row.signer, wait_until: "NONE" }).catch(() => null);
  if (!tx) { check(false, `${row.tx} not found: ${row.label}`); continue; }
  // The first receipt is the call on the deal account; a seller transfer may fail by design (PayoutFailed).
  const first = tx.receipts_outcome[0];
  const failed = first !== undefined && "Failure" in first.outcome.status;
  const anyFailed = tx.receipts_outcome.some((r) => "Failure" in r.outcome.status);
  const wantFail = row.outcome.startsWith("rejected");
  const payoutFailed = row.outcome.includes("PayoutFailed");
  check(failed === wantFail && (payoutFailed ? anyFailed : true), `${row.outcome.padEnd(32)} ${row.label}`);
}
console.log(failures === 0 ? "VERIFIED: all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
