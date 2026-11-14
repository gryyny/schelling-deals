import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Near, parseKey, type KeyPair } from "near-kit";

export interface Credential {
  account_id: string;
  public_key: string;
  private_key: string;
}

export interface NetworkSpec {
  networkId: string;
  rpcUrl?: string;
}

/** SD_NETWORK (default testnet) and optional SD_RPC_URL. */
export function networkFromEnv(): NetworkSpec {
  const networkId = process.env["SD_NETWORK"] ?? "testnet";
  // rpc.testnet.near.org is deprecated and rate-limits; FastNEAR is the default for testnet.
  const rpcUrl = process.env["SD_RPC_URL"] ?? (networkId === "testnet" ? "https://test.rpc.fastnear.com" : undefined);
  return rpcUrl ? { networkId, rpcUrl } : { networkId };
}

/** Reads a near-cli legacy keychain file. The key never leaves this process. */
export async function loadCredential(accountId: string, networkId = "testnet"): Promise<Credential> {
  const path = join(homedir(), ".near-credentials", networkId, `${accountId}.json`);
  const c = JSON.parse(await readFile(path, "utf8")) as Partial<Credential> & { secret_key?: string };
  const priv = c.private_key ?? c.secret_key;
  if (!priv || !c.public_key) throw new Error(`no key material in ${path}`);
  return { account_id: c.account_id ?? accountId, public_key: c.public_key, private_key: priv };
}

export async function loadKeyPair(accountId: string, networkId = "testnet"): Promise<KeyPair> {
  return parseKey((await loadCredential(accountId, networkId)).private_key);
}

/** Near client with signing keys for `signers` (others may be view-only). */
export async function makeNear(net: NetworkSpec, signers: readonly string[] = [], extraKeys: Record<string, string> = {}): Promise<Near> {
  const keys: Record<string, string> = { ...extraKeys };
  for (const s of signers) {
    if (!keys[s]) keys[s] = (await loadCredential(s, net.networkId)).private_key;
  }
  const network = net.rpcUrl ? { rpcUrl: net.rpcUrl, networkId: net.networkId } : (net.networkId as "testnet" | "mainnet");
  return new Near({ network, keyStore: keys, defaultWaitUntil: "FINAL" });
}

export function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v !== undefined) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
