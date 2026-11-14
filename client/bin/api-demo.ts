// tsx bin/api-demo.ts <pass.json> [--api http://127.0.0.1:8787]
// Three requests: valid pass -> 200, tampered pass (units changed) -> 401, no header -> 401.
import { readFile } from "node:fs/promises";
import { arg } from "../src/env.ts";
import { encodePassHeader, type SignedPass } from "../src/pass.ts";

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) throw new Error("usage: api-demo.ts <pass.json> [--api url]");
  const url = `${arg("api", "http://127.0.0.1:8787").replace(/\/$/, "")}/v1/quotes`;
  const sp = JSON.parse(await readFile(file, "utf8")) as SignedPass;
  const tampered: SignedPass = { ...sp, pass: { ...sp.pass, units: sp.pass.units + 1 } };
  const cases: [string, string | undefined, number][] = [
    ["valid pass", encodePassHeader(sp), 200],
    ["tampered pass (units changed)", encodePassHeader(tampered), 401],
    ["no Authorization header", undefined, 401],
  ];
  let allAsExpected = true;
  for (const [name, auth, expected] of cases) {
    const res = await fetch(url, auth ? { headers: { authorization: auth } } : {});
    const body = (await res.json()) as Record<string, unknown>;
    const as = res.status === expected;
    allAsExpected &&= as;
    console.log(`${as ? "ok  " : "FAIL"} ${name}: HTTP ${res.status} (expected ${expected}) ${JSON.stringify(body)}`);
  }
  if (!allAsExpected) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
