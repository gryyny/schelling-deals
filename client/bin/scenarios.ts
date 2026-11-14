// On-chain checks of the deal contract. Writes out/receipts.json.
// SD_CODE_HASH=<base58> SD_SELLER=<acct> SD_BUYERS=<b1>,<b2> tsx bin/scenarios.ts [--only a,b,...]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Near } from "near-kit";
import {
  blockTimeNs,
  confirmDelivery,
  dealAccountId,
  type DealTerms,
  formatNear,
  getDeal,
  getRedemption,
  isStatus,
  join,
  NEAR,
  pledgeTx,
  redeem,
  REDEEM_FEE,
  refund,
  settle,
  STORAGE_FEE,
  submit,
  type TxRecord,
  waitForBlockTime,
} from "../src/deal.ts";
import { arg, loadKeyPair, makeNear, networkFromEnv } from "../src/env.ts";
import { nearChainReader, type Pass, signPass, verifyPass } from "../src/pass.ts";

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
const only = new Set((process.argv.includes("--only") ? arg("only") : "a,b,c,d,e,f,g,h,i").split(","));
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

  if (only.has("i")) {
    // Zero-balance-account rule: up to 770 bytes are free; beyond that the balance must cover storage at 1e19 yocto/byte.
    const ZBA_FREE_BYTES = 770;
    const BYTE_COST = 10_000_000_000_000_000_000n;
    const d4 = await terms(near, "redeem", { minUnits: 2, maxUnits: 10, deadlineS: 600 });
    const d4Id = dealAccountId(d4);
    const sellerKey = await loadKeyPair(seller, net.networkId);
    const steps: { step: string; storageUsage: number; amount: string; funded: boolean }[] = [];
    const snap = async (step: string): Promise<void> => {
      const a = await near.rpc.getAccount(d4Id);
      const funded = a.storage_usage <= ZBA_FREE_BYTES || BigInt(a.amount) >= BigInt(a.storage_usage) * BYTE_COST;
      steps.push({ step, storageUsage: a.storage_usage, amount: formatNear(BigInt(a.amount)), funded });
    };
    const txs: TxRecord[] = [];
    txs.push((await join(near, b1, d4, 1, "b1 pledges 1")).tx);
    await snap("b1 pledged");
    txs.push((await join(near, b2, d4, 1, "b2 pledges 1 (min reached)")).tx);
    await snap("b2 pledged");
    txs.push(await settle(near, b1, d4Id, "settle at 2/2"));
    await snap("settled");
    const redemptionIds: number[] = [];
    for (const b of [b1, b2]) {
      const r = await redeem(near, b, d4Id, 1, `seat for ${b}`.slice(0, 120));
      txs.push(r);
      const ev = r.events.find((e) => e.event === "redeem")?.data as { id?: number } | undefined;
      if (typeof ev?.id === "number") redemptionIds.push(ev.id);
      await snap(`${b} redeemed (fee ${formatNear(REDEEM_FEE)})`);
    }
    const verdicts: Record<string, string> = {};
    for (const id of redemptionIds) {
      const red = await getRedemption(near, d4Id, id);
      if (!red) continue;
      const pass: Pass = { deal: d4Id, buyer: red.buyer, units: red.units, redemptionId: id, item: d4.item, issuedAt: new Date().toISOString() };
      const signed = signPass(pass, seller, sellerKey);
      await mkdir(new URL("../out/passes/", import.meta.url), { recursive: true });
      await writeFile(new URL(`../out/passes/${d4Id}-${id}.json`, import.meta.url), `${JSON.stringify(signed, null, 2)}\n`);
      txs.push(await confirmDelivery(near, seller, d4Id, id, signed.digest));
      await snap(`delivery ${id} confirmed`);
      const v = await verifyPass(signed, nearChainReader(near), Date.now());
      verdicts[red.buyer] = v.ok ? "valid" : `invalid: ${v.reason}`;
    }
    const deal = await getDeal(near, d4Id);
    await record({
      id: "i",
      title: "two buyers redeem with the fee, seller confirms both deliveries, storage stays funded",
      pass:
        txs.every((t) => t.ok) &&
        redemptionIds.length === 2 &&
        Object.values(verdicts).filter((v) => v === "valid").length === 2 &&
        steps.every((s) => s.funded) &&
        !!deal &&
        isStatus(deal.status, "Paid") &&
        deal.redemptions === 2,
      checks: { dealId: d4Id, storageSteps: steps, redemptionIds, passVerdicts: verdicts, redemptions: deal?.redemptions },
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
