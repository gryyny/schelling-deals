// tsx bin/verify-pass.ts <pass.json>
// Checks: signature valid; signing key is a current access key of the seller; the deal's seller matches;
// on-chain redemption digest equals sha256(pass); buyer and units match; within validity (1 unit = 30 days).
import { readFile } from "node:fs/promises";
import { makeNear, networkFromEnv } from "../src/env.ts";
import { nearChainReader, type SignedPass, verifyPass } from "../src/pass.ts";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: verify-pass.ts <pass.json>");
  const sp = JSON.parse(await readFile(file, "utf8")) as SignedPass;
  const v = await verifyPass(sp, nearChainReader(await makeNear(networkFromEnv())), Date.now());
  for (const [k, ok] of Object.entries(v.checks)) console.log(`${ok ? "ok  " : "FAIL"} ${k}`);
  console.log(v.ok ? `VALID pass for ${sp.pass.buyer}, ${sp.pass.units} units until ${v.validUntil}, deal ${sp.pass.deal}` : `INVALID pass: ${v.reason}`);
  if (!v.ok) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
