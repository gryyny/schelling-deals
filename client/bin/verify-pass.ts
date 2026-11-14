// tsx bin/verify-pass.ts <pass.json>
// Checks: signature valid; signing key is a current access key of the seller; the deal's seller matches;
// on-chain redemption digest equals sha256(pass); buyer and units match.
import { readFile } from "node:fs/promises";
import { getDeal, getRedemption } from "../src/deal.ts";
import { makeNear, networkFromEnv } from "../src/env.ts";
import { passDigest, type SignedPass, verifyPassSignature } from "../src/pass.ts";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: verify-pass.ts <pass.json>");
  const sp = JSON.parse(await readFile(file, "utf8")) as SignedPass;
  const near = await makeNear(networkFromEnv());
  const keys = await near.rpc.getAccessKeys(sp.seller);
  const deal = await getDeal(near, sp.pass.deal);
  const red = await getRedemption(near, sp.pass.deal, sp.pass.redemptionId);
  const digest = passDigest(sp.pass);
  const checks: Record<string, boolean> = {
    signatureValid: verifyPassSignature(sp),
    keyOnSellerAccount: keys.keys.some((k) => k.public_key === sp.publicKey),
    dealSellerMatches: deal?.seller === sp.seller,
    digestMatchesFile: digest === sp.digest,
    digestOnChain: red?.digest === digest,
    buyerAndUnitsMatch: red?.buyer === sp.pass.buyer && red.units === sp.pass.units,
  };
  for (const [k, v] of Object.entries(checks)) console.log(`${v ? "ok  " : "FAIL"} ${k}`);
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? `VALID pass for ${sp.pass.buyer}, ${sp.pass.units} units, deal ${sp.pass.deal}` : "INVALID pass");
  if (!ok) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
