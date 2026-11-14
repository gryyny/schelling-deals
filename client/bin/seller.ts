// tsx bin/seller.ts publish --seller <acct> --code-hash <base58> [--offer-id id] [--deadline-a 120] [--deadline-b 120] [--out offer.json]
// tsx bin/seller.ts fulfil  --offer offer.json
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  blockTimeNs,
  confirmDelivery,
  dealAccountId,
  getDeal,
  getRedemption,
  isStatus,
  loadOffer,
  NEAR,
  type Offer,
  statusName,
  termsFor,
} from "../src/deal.ts";
import { arg, loadKeyPair, makeNear, networkFromEnv } from "../src/env.ts";
import { type Pass, signPass } from "../src/pass.ts";

const net = networkFromEnv();

async function publish(): Promise<void> {
  const seller = arg("seller");
  const near = await makeNear(net);
  const now = await blockTimeNs(near);
  const s = (n: string) => now + BigInt(Number(n)) * 1_000_000_000n;
  const milli = NEAR / 1000n;
  const offer: Offer = {
    offerId: arg("offer-id", `quotefeed-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`),
    codeHash: arg("code-hash"),
    seller,
    item: "Quote Feed API access pass: 1 unit = 1 month of one API seat",
    tiers: [
      { minUnits: 10, maxUnits: 20, unitPriceYocto: (BigInt(arg("price-a-milli", "100")) * milli).toString(), deadlineNs: s(arg("deadline-a", "120")).toString() },
      { minUnits: 30, maxUnits: 60, unitPriceYocto: (BigInt(arg("price-b-milli", "70")) * milli).toString(), deadlineNs: s(arg("deadline-b", "120")).toString() },
    ],
  };
  const out = arg("out", "offer.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(offer, null, 2)}\n`);
  console.log(`offer ${offer.offerId} written to ${out}`);
  offer.tiers.forEach((_, i) => console.log(`  tier ${String.fromCharCode(65 + i)} deal address ${dealAccountId(termsFor(offer, i))}`));
  console.log("seller process exits now; funding, settlement and refunds do not need it");
}

async function fulfil(): Promise<void> {
  const offer = await loadOffer(arg("offer"));
  const near = await makeNear(net, [offer.seller]);
  const key = await loadKeyPair(offer.seller, net.networkId);
  const outDir = arg("out-dir", "out/passes");
  await mkdir(outDir, { recursive: true });
  for (let i = 0; i < offer.tiers.length; i++) {
    const dealId = dealAccountId(termsFor(offer, i));
    const deal = await getDeal(near, dealId);
    console.log(`tier ${String.fromCharCode(65 + i)} ${dealId}: ${deal ? statusName(deal.status) : "not created"}`);
    if (!deal || !isStatus(deal.status, "Paid")) continue;
    for (let id = 0; id < deal.redemptions; id++) {
      const r = await getRedemption(near, dealId, id);
      if (!r || r.digest) continue;
      const pass: Pass = { deal: dealId, buyer: r.buyer, units: r.units, redemptionId: id, item: offer.item, issuedAt: new Date().toISOString() };
      const signed = signPass(pass, offer.seller, key);
      const file = `${outDir}/${dealId}-${id}.json`;
      await writeFile(file, `${JSON.stringify(signed, null, 2)}\n`);
      const tx = await confirmDelivery(near, offer.seller, dealId, id, signed.digest);
      console.log(`  redemption ${id} for ${r.buyer} (${r.units} units): pass ${file}, digest ${signed.digest}`);
      console.log(`  confirm_delivery tx ${tx.hash} ${tx.ok ? "ok" : `FAILED: ${tx.error}`}`);
    }
  }
}

const cmd = process.argv[2];
(cmd === "publish" ? publish() : cmd === "fulfil" ? fulfil() : Promise.reject(new Error("usage: seller.ts publish|fulfil ..."))).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
