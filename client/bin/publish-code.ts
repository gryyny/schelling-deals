// tsx bin/publish-code.ts --account <deployer> --wasm ../contract/target/near/schelling_deal.wasm
// Publishes the wasm as an immutable global contract identified by its hash (no-op if already published).
import { readFile } from "node:fs/promises";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { submit } from "../src/deal.ts";
import { arg, makeNear, networkFromEnv } from "../src/env.ts";

async function main(): Promise<void> {
  const account = arg("account");
  const code = new Uint8Array(await readFile(arg("wasm")));
  const codeHash = base58.encode(sha256(code));
  const near = await makeNear(networkFromEnv(), [account]);
  if (await near.globalContractExists({ codeHash })) {
    console.log(`already published: ${codeHash}`);
    return;
  }
  const tx = await submit(near, "publish global contract by hash", account, near.transaction(account).publishContract(code, { identifiedBy: "hash" }));
  if (!tx.ok) throw new Error(`publish failed (${tx.hash}): ${tx.error}`);
  console.log(`published by ${account} in tx ${tx.hash}`);
  console.log(codeHash);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
