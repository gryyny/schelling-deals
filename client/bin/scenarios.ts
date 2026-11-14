// On-chain checks of the deal contract. Writes out/receipts.json.
// SD_CODE_HASH=<base58> SD_SELLER=<acct> SD_BUYERS=<b1>,<b2> tsx bin/scenarios.ts [--only a,b,...]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Near } from "near-kit";
import {
  blockTimeNs,
  dealAccountId,
  type DealTerms,
  formatNear,
  getDeal,
  isStatus,
  join,
  NEAR,
  pledgeTx,
  refund,
  settle,
  STORAGE_FEE,
  submit,
  type TxRecord,
  waitForBlockTime,
} from "../src/deal.ts";
import { arg, makeNear, networkFromEnv } from "../src/env.ts";

interface ScenarioResult {
  id: string;
  title: string;
  pass: boolean;
  checks: Record<string, unknown>;
  txs: TxRecord[];
}

const OUT = new URL("../out/receipts.json", import.meta.url);
const net = networkFromEnv();
const codeHash = process.env["SD_CODE_HASH"] ?? arg("code-hash");
const seller = process.env["SD_SELLER"] ?? arg("seller");
const [b1, b2] = (process.env["SD_BUYERS"] ?? arg("buyers")).split(",") as [string, string];
if (!b1 || !b2) throw new Error("need two buyers");
const only = new Set((process.argv.includes("--only") ? arg("only") : "a,b,c,d,e,f,g,h").split(","));
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
const PRICE = 10n * (NEAR / 1000n); // 0.01 NEAR
const results: ScenarioResult[] = [];

async function balance(near: Near, id: string): Promise<bigint> {
  return BigInt((await near.rpc.getAccount(id)).amount);
}

async function terms(near: Near, tag: string, o: Partial<DealTerms> & { deadlineS: number }): Promise<DealTerms> {
  const { deadlineS, ...rest } = o;
  return {
    codeHash,
    seller,
    item: "Quote Feed API access pass: 1 unit = 1 month of one API seat",
    offerId: `scn-${runId}-${tag}`,
    unitPrice: PRICE,
    minUnits: 3,
    maxUnits: 10,
    deadlineNs: (await blockTimeNs(near)) + BigInt(deadlineS) * 1_000_000_000n,
    ...rest,
  };
}

async function record(r: ScenarioResult): Promise<void> {
  results.push(r);
  console.log(`\n[${r.pass ? "PASS" : "FAIL"}] (${r.id}) ${r.title}`);
  console.log(JSON.stringify(r.checks, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));
  for (const t of r.txs) console.log(`  ${t.label}: ${t.hash} ${t.ok ? "ok" : `failed: ${t.error?.slice(0, 160)}`}`);
  await mkdir(new URL("../out/", import.meta.url), { recursive: true });
  let prior: { runs: unknown[] } = { runs: [] };
  try {
    prior = JSON.parse(await readFile(OUT, "utf8")) as { runs: unknown[] };
  } catch {
    /* first run */
  }
  const run = { runId, network: net.networkId, codeHash, seller, buyers: [b1, b2], scenarios: results };
  const runs = prior.runs.filter((x) => (x as { runId?: string }).runId !== runId);
  await writeFile(OUT, `${JSON.stringify({ runs: [...runs, run] }, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
}

const failedWith = (t: TxRecord, msg: string) => !t.ok && (t.error ?? "").includes(msg);

async function main(): Promise<void> {
  const near = await makeNear(net, [b1, b2, seller]);
  console.log(`run ${runId} on ${net.networkId}; code ${codeHash}; seller ${seller}; buyers ${b1}, ${b2}`);

  // D2: a deal that will miss its minimum (scenarios d, f). Started first so its deadline runs meanwhile.
  let d2: DealTerms | undefined;
  const d2Txs: TxRecord[] = [];
  if (only.has("d") || only.has("f")) {
    d2 = await terms(near, "miss", { minUnits: 100, maxUnits: 200, deadlineS: 75 });
    d2Txs.push((await join(near, b1, d2, 2, "b1 pledges 2 to the deal that will miss")).tx);
    d2Txs.push(await refund(near, b2, dealAccountId(d2), b1, "refund before deadline (expect reject)"));
  }

  // (a) concurrent create + pledge
  const d1 = await terms(near, "main", { deadlineS: 600 });
  const d1Id = dealAccountId(d1);
  if (only.has("a")) {
    const existedBefore = await near.accountExists(d1Id);
    const [r1, r2] = await Promise.all([join(near, b1, d1, 1, "b1 create+pledge 1"), join(near, b2, d1, 1, "b2 create+pledge 1")]);
    const deal = await getDeal(near, d1Id);
    const keys = await near.rpc.getAccessKeys(d1Id);
    const acct = await near.rpc.getAccount(d1Id);
    await record({
      id: "a",
      title: "two buyers create+pledge the same fresh deal concurrently",
      pass: !existedBefore && r1.tx.ok && r2.tx.ok && deal?.total_units === 2 && deal.buyers === 2,
      checks: { dealId: d1Id, existedBefore, getDeal: deal, accessKeys: keys.keys.length, viewAccount: acct },
      txs: [r1.tx, r2.tx],
    });
  }

  if (only.has("b")) {
    const altered = dealAccountId({ ...d1, unitPrice: d1.unitPrice + 1n });
    await record({
      id: "b",
      title: "altered terms (price +1 yocto) derive a different address",
      pass: altered !== d1Id && !(await near.accountExists(altered)),
      checks: { original: d1Id, alteredPricePlus1Yocto: altered },
      txs: [],
    });
  }

  if (only.has("c") && only.has("a")) {
    const before = await balance(near, b1);
    const deposit = PRICE + STORAGE_FEE; // identical to b1's first pledge
    const tx = await submit(near, "b1 retries identical pledge 1 (expect reject)", b1, pledgeTx(near, b1, d1, 1, deposit));
    const after = await balance(near, b1);
    const spent = before - after;
    const deal = await getDeal(near, d1Id);
    await record({
      id: "c",
      title: "retried identical pledge is rejected and its deposit returned",
      pass: failedWith(tx, "already pledged") && spent < deposit / 4n && deal?.total_units === 2,
      checks: { deposit: formatNear(deposit), netSpentGas: formatNear(spent), totalUnitsAfter: deal?.total_units },
      txs: [tx],
    });
  }

  if (only.has("e") && only.has("a")) {
    const txs: TxRecord[] = [];
    const below = await settle(near, b2, d1Id, "settle at 2/3 (expect reject)");
    txs.push(below);
    const top = await join(near, b1, d1, 2, "b1 raises pledge to 2 (total 3 = min)");
    txs.push(top.tx);
    const sellerBefore = await balance(near, seller);
    const paid = await settle(near, b2, d1Id, "settle at 3/3");
    txs.push(paid);
    const sellerAfter = await balance(near, seller);
    const deal = await getDeal(near, d1Id);
    const again = await settle(near, b2, d1Id, "second settle (expect reject)");
    txs.push(again);
    const expected = 3n * PRICE;
    await record({
      id: "e",
      title: "settle below min rejected; at min pays seller exactly once",
      pass:
        failedWith(below, "minimum not reached") &&
        top.deposit === PRICE &&
        paid.ok &&
        sellerAfter - sellerBefore === expected &&
        !!deal &&
        isStatus(deal.status, "Paid") &&
        failedWith(again, "not open"),
      checks: { topUpDeposit: formatNear(top.deposit), sellerDelta: formatNear(sellerAfter - sellerBefore), expected: formatNear(expected), status: deal?.status, events: paid.events },
      txs,
    });
  }

  if (only.has("h") && only.has("a")) {
    const keys = await near.rpc.getAccessKeys(d1Id);
    const acct = await near.rpc.getAccount(d1Id);
    await record({
      id: "h",
      title: "deal account has no access keys and runs the published code hash",
      pass: keys.keys.length === 0 && acct.global_contract_hash === codeHash,
      checks: { dealId: d1Id, accessKeys: keys.keys.length, code_hash: acct.code_hash, global_contract_hash: acct.global_contract_hash, global_contract_account_id: acct.global_contract_account_id },
      txs: [],
    });
  }

  if (only.has("g")) {
    const ghost = `nobody-${randomBytes(4).toString("hex")}.${net.networkId === "testnet" ? "testnet" : seller.split(".").slice(1).join(".")}`;
    const d3 = { ...(await terms(near, "ghost", { minUnits: 1, maxUnits: 5, deadlineS: 600 })), seller: ghost };
    const d3Id = dealAccountId(d3);
    const txs: TxRecord[] = [];
    const p = await join(near, b1, d3, 1, "b1 pledges 1 to a deal whose seller does not exist");
    txs.push(p.tx);
    const s = await settle(near, b2, d3Id, "settle (payout must fail)");
    txs.push(s);
    const afterSettle = await getDeal(near, d3Id);
    const before = await balance(near, b1);
    const r = await refund(near, b2, d3Id, b1, "refund b1 after PayoutFailed");
    txs.push(r);
    const after = await balance(near, b1);
    await record({
      id: "g",
      title: "failed payout to a non-existent seller lets buyers reclaim in full",
      pass: p.tx.ok && !!afterSettle && isStatus(afterSettle.status, "PayoutFailed") && r.ok && after - before === PRICE + STORAGE_FEE,
      checks: { dealId: d3Id, ghostSeller: ghost, statusAfterSettle: afterSettle?.status, settleEvents: s.events, refunded: formatNear(after - before), expected: formatNear(PRICE + STORAGE_FEE) },
      txs,
    });
  }

  if (d2) {
    const d2Id = dealAccountId(d2);
    await waitForBlockTime(near, d2.deadlineNs, (s) => console.log(`waiting for deadline of ${d2Id}: ${s}s`));
    if (only.has("d")) {
      const late = await join(near, b2, d2, 1, "b2 pledges after deadline (expect reject)");
      const deal = await getDeal(near, d2Id);
      await record({
        id: "d",
        title: "late pledge after the deadline is rejected",
        pass: failedWith(late.tx, "deadline passed") && deal?.total_units === 2,
        checks: { dealId: d2Id, totalUnits: deal?.total_units, buyers: deal?.buyers },
        txs: [late.tx],
      });
    }
    if (only.has("f")) {
      const before = await balance(near, b1);
      const r = await refund(near, b2, d2Id, b1, "refund b1 after deadline (called by b2)");
      const after = await balance(near, b1);
      const again = await refund(near, b2, d2Id, b1, "second refund (expect reject)");
      const expected = 2n * PRICE + STORAGE_FEE;
      const early = d2Txs[1];
      await record({
        id: "f",
        title: "missed deal: refund only after deadline, exactly pledge+fee, once",
        pass: !!early && failedWith(early, "refunds are not open") && r.ok && after - before === expected && failedWith(again, "nothing to refund"),
        checks: { dealId: d2Id, refunded: formatNear(after - before), expected: formatNear(expected), earlyRefundError: early?.error },
        txs: [...d2Txs, r, again],
      });
    }
  }

  const failed = results.filter((r) => !r.pass).map((r) => r.id);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.join(",")}` : ""}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
