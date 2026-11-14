// Scripted buyer agent (deterministic rules, no LLM).
// tsx bin/buyer.ts run    --profile ada --account <acct> --offer <path|url> [--no-wait]
// tsx bin/buyer.ts refund --account <acct> --offer <path|url> --tier 0
// tsx bin/buyer.ts redeem --account <acct> --offer <path|url> --tier 0 [--units N] [--note text]
import { decide, PROFILES } from "../src/agents.ts";
import {
  blockTimeNs,
  dealAccountId,
  formatNear,
  getDeal,
  getPledge,
  isStatus,
  join,
  loadOffer,
  redeem,
  refund,
  settle,
  statusName,
  termsFor,
  type TxRecord,
  waitForBlockTime,
} from "../src/deal.ts";
import { arg, flag, makeNear, networkFromEnv } from "../src/env.ts";

function show(tx: TxRecord): void {
  const ev = tx.events.map((e) => e.event).join(",") || "-";
  console.log(`  tx ${tx.hash} ${tx.ok ? "ok" : `FAILED: ${tx.error}`} events=${ev}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "run";
  const account = arg("account");
  const net = networkFromEnv();
  const near = await makeNear(net, [account]);
  const offer = await loadOffer(arg("offer"));

  if (cmd === "refund" || cmd === "redeem") {
    const t = termsFor(offer, Number(arg("tier", "0")));
    const dealId = dealAccountId(t);
    console.log(`deal ${dealId} (derived locally from offer ${offer.offerId})`);
    if (cmd === "refund") show(await refund(near, account, dealId, account));
    else {
      const pledge = await getPledge(near, dealId, account);
      const units = Number(arg("units", String((pledge?.units ?? 0) - (pledge?.redeemed ?? 0))));
      show(await redeem(near, account, dealId, units, arg("note", `access for ${account}`)));
    }
    return;
  }

  const profileKey = arg("profile");
  const profile = PROFILES[profileKey];
  if (!profile) throw new Error(`unknown profile ${profileKey}; one of ${Object.keys(PROFILES).join(", ")}`);
  console.log(`[${profile.name}] scripted agent (deterministic rules, no LLM), account ${account}`);
  console.log(`[${profile.name}] offer ${offer.offerId} from ${offer.seller}: ${offer.item}`);

  const existing = await Promise.all(offer.tiers.map((_, i) => getPledge(near, dealAccountId(termsFor(offer, i)), account)));
  const decision = decide(offer, profile, await blockTimeNs(near), (i) => existing[i] != null);
  for (const line of decision.reasoning) console.log(`[${profile.name}] ${line}`);
  if (decision.tierIndex === null) return;

  const t = termsFor(offer, decision.tierIndex);
  const dealId = dealAccountId(t);
  console.log(`[${profile.name}] derived deal address ${dealId} from code hash ${t.codeHash} + tier terms`);

  const res = await join(near, account, t, decision.units, `${profile.name} pledges ${decision.units}`);
  console.log(`[${profile.name}] pledge ${decision.units} units, deposit ${formatNear(res.deposit)} (had ${res.previousUnits})`);
  show(res.tx);
  if (!res.tx.ok) process.exitCode = 1;

  const after = await getDeal(near, dealId);
  if (!after) return;
  console.log(`[${profile.name}] deal: ${after.total_units}/${after.min_units} units, ${after.buyers} buyers, ${statusName(after.status)}`);
  if (isStatus(after.status, "Open") && after.total_units >= after.min_units) {
    console.log(`[${profile.name}] minimum reached; calling settle`);
    const s = await settle(near, account, dealId, `${profile.name} settles`);
    show(s);
    if (!s.ok && (s.error ?? "").includes("deal is not open")) console.log(`[${profile.name}] another buyer settled first (expected race; payment happens once)`);
  }
  if (flag("no-wait")) return;

  // Wait until paid, or until the deadline passes without the minimum, then reclaim.
  for (;;) {
    const d = await getDeal(near, dealId);
    if (!d) return;
    if (isStatus(d.status, "Paid")) {
      console.log(`[${profile.name}] deal paid; ${profile.needUnits} units available to redeem`);
      return;
    }
    if (isStatus(d.status, "PayoutFailed")) break;
    if (isStatus(d.status, "Open") && d.total_units >= d.min_units) {
      show(await settle(near, account, dealId, `${profile.name} settles`));
      continue;
    }
    const now = await blockTimeNs(near);
    if (now >= t.deadlineNs) break;
    console.log(`[${profile.name}] waiting: ${d.total_units}/${d.min_units} units, deadline in ${(t.deadlineNs - now) / 1_000_000_000n}s`);
    await waitForBlockTime(near, now + 10_000_000_000n < t.deadlineNs ? now + 10_000_000_000n : t.deadlineNs);
  }
  console.log(`[${profile.name}] deal missed; claiming my refund`);
  show(await refund(near, account, dealId, account, `${profile.name} reclaims`));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
