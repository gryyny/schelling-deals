# Schelling Deals

Independent buyer agents pool a purchase on NEAR without a platform operator. The deal terms determine the escrow address; nobody holds its keys.

**Testnet. The buyer agents are scripted (deterministic rules, no model).** Live page: https://gryyny.github.io/schelling-deals/ · Video: [video/schelling-deals.mp4](video/schelling-deals.mp4) (85 s, narrated, captions burned in; [captions](video/schelling-deals.srt)).

## The problem

A seller offers a volume price: 0.10 NEAR per unit if at least 10 units sell together. Four small buyers each need a few units. To pool their orders today they need someone to run the pool: a group-buy platform or a coordinator contract whose owner opens each round, holds the funds or can change the rules. That operator is a cost, a point of failure, and a party everyone must trust.

## What Schelling Deals does

1. The seller publishes an offer file once (item, price tiers, deadlines, and the hash of an immutable contract), then **stops running**.
2. Each buyer agent reads the offer and **derives the escrow address itself** from the exact terms ([NEP-616](https://github.com/near/NEPs/blob/master/neps/nep-0616.md) deterministic account: `0s` + keccak256(StateInit)[12..32]). Identical terms always give the same address; any change gives a different one.
3. A buyer that accepts sends **one transaction**: create the account if it does not exist yet (`DeterministicStateInit`, code referenced by global-contract hash) and pledge. Whoever arrives first creates it; if two arrive at once, the runtime refunds the second creation deposit and both pledges count.
4. When pledges reach the minimum, **anyone** can settle: the seller is paid exactly once. If the deadline passes below the minimum, or the payout fails, every buyer can **claim** an exact refund (refunds are claimable, not automatic).
5. Buyers then **redeem** their units (a 0.004 NEAR fee funds the record). The seller comes back online, delivers a signed access pass and records its sha256 on the deal account. The seller's **Quote Feed API** (a small local service in this repo) serves a buyer who presents a valid pass for this seller's own offer and refuses a tampered, expired or unrecorded pass, or one from another seller, deal or product.

The escrow account has **no access keys**, no owner, no admin method and no upgrade path. Its code is a global contract referenced by hash (`axfgbr7M92qkfNtSd8RP923HQmWLPynQp4qMjYUTcoG`), so it cannot change.

Buyers do share information: the published offer and the blockchain. What they do not need is direct messaging or a privileged coordinator.

## What it guarantees, and what it does not

| Guaranteed by the contract | Not guaranteed |
| --- | --- |
| The seller is paid only if the minimum is reached, and only once | That the seller delivers (delivery is recorded on-chain for accountability, not enforced) |
| Below the minimum at the deadline, or after a failed payout, each buyer can reclaim exactly what they paid | That someone calls `refund` (any account can, on any buyer's behalf; funds only go to the buyer) |
| A retried pledge cannot double-charge (pledges are absolute totals) | Price discovery: tiers are fixed by the seller |
| Every buyer's record, redemption and delivery digest is paid for by the fee that creates it; a write that would leave storage unfunded fails and its deposit returns | That the API keeps running: it is the seller's service |
| Terms cannot change after the first pledge (they are the address) | Sybil resistance among buyers |

## Try it

Read-only, no keys or funds (Node 24 + pnpm, Rust 1.97 for the contract):

```sh
git clone https://github.com/gryyny/schelling-deals && cd schelling-deals
cd contract && cargo test            # 19 tests: pledge/settle/refund/payout-failure/redeem state machine, storage funding bound
cd ../client && pnpm install
pnpm test                            # 19 tests: address derivation vs near-kit, fee-aware buyer budgets, pass checks and API responses
pnpm verify                          # reads testnet: both deal accounts, 0 access keys, published code hash, 32 recorded transactions
```

Expected: `cargo test` ends with `19 passed`; `pnpm verify` ends with `VERIFIED: all checks passed`.

Then open the [live page](https://gryyny.github.io/schelling-deals/): it re-derives each deal address in your browser from the offer terms and reads the deal from testnet. Toggle "Independent check", change any term (for example the minimum) and see the address change.

**Full run on testnet** (creates nothing on mainnet; needs six free faucet accounts named `<role>-<prefix>.testnet`, keys in `~/.near-credentials/testnet/`):

```sh
for r in seller ada bo cy dee; do near account create-account sponsor-by-faucet-service $r-$PREFIX.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create; done
SD_PREFIX=$PREFIX ./demo/showcase.sh   # seller publishes and exits; four agents act; tier B misses and refunds; Ada and Bo redeem; passes verified; Ada's pass used on the local API
```

The global contract is already published by hash on testnet; `client/bin/publish-code.ts` republishes the same wasm from your own account (it needs about 15 testnet NEAR of storage).

## Verify it

- `pnpm verify` (in `client/`): derives both deal addresses from [evidence/testnet/offer.json](evidence/testnet/offer.json), checks each account runs global contract `axfgbr7M92qkfNtSd8RP923HQmWLPynQp4qMjYUTcoG` and has no access keys, checks their status (tier A `Paid`, tier B below its minimum after the deadline), and checks all 32 recorded transactions' outcomes (success, or the expected rejection) over testnet RPC.
- If the default RPC (FastNEAR testnet) is unavailable, run the same check from `client/` against another provider:

  ```bash
  # Alternative provider if the default is unavailable (non-archival)
  SD_RPC_URL=https://near-testnet.drpc.org pnpm verify

  # Archival provider for historical transaction lookups (rate-limited: a 429 means rerun later)
  SD_RPC_URL=https://archival-rpc.testnet.near.org pnpm verify
  ```

  Both passed 38/38 at `9a57969` on 14 November; the archival endpoint also answered 429 in one run that day. See [NEAR's RPC providers](https://docs.near.org/api/rpc/providers). This note covers `pnpm verify` only; the live page keeps its own RPC fallback.
- `pnpm tsx bin/verify-pass.ts ../evidence/testnet/pass-ada.json`: the delivered pass's ed25519 signature, that the signing key is on the seller account, that its sha256 is recorded on the deal for that buyer and those units, and that it is within its validity.
- `pnpm tsx bin/api.ts --offer ../evidence/testnet/offer.json` then, in another shell, `pnpm tsx bin/api-demo.ts ../evidence/testnet/pass-ada.json --api http://127.0.0.1:8787`: the local Quote Feed API answers 200 to the valid pass and 401 to a tampered pass and to a request without one. The API trusts only the offer it was started with: it derives that offer's deal addresses itself and refuses passes from any other seller, deal or product before checking the chain (tested in `client/test/api.test.ts`).
- The code hash is the sha256 of `contract/target/near/schelling_deal.wasm` built with `cargo near build non-reproducible-wasm --no-abi` (toolchain pinned in `contract/rust-toolchain.toml`). The build is not certified reproducible; the deployed code is identified by the hash on-chain.

## Testnet evidence

All on NEAR testnet, 14 November 2026, contract code `axfgbr7M…`. Explorer: `https://testnet.nearblocks.io/txns/<hash>`. Every transaction with its outcome: [evidence/testnet/receipts.json](evidence/testnet/receipts.json) (`pnpm verify` rechecks them); agent logs: [evidence/testnet/showcase/](evidence/testnet/showcase/). An earlier build that under-funded storage for a second redemption is kept, unchanged, in [evidence/superseded/](evidence/superseded/).

| Step | Transaction | Result |
| --- | --- | --- |
| Global contract published by hash | [`AYo3tnsN…`](https://testnet.nearblocks.io/txns/AYo3tnsNLBH69YLogytE2UnXPtE2vMgnPMUkxC93uyJq) | code hash `axfgbr7M…` |
| Seller publishes the offer and its process exits | n/a (offer file) | [offer.json](evidence/testnet/offer.json) |
| Ada and Bo each create-and-pledge tier A at the same time | [`CpL4mv6w…`](https://testnet.nearblocks.io/txns/CpL4mv6wrJQnt1NvdV2xKvsMXsZWp5p3A829MBci2ThZ), [`A1zF55jX…`](https://testnet.nearblocks.io/txns/A1zF55jXbMTWtJHBisuxhPHFHYU2Fti4pjPQ9FeWMTho) | one keyless account, 10/10 units |
| Cy declines (price above its limit) | none | [Cy's log](evidence/testnet/showcase/2-cy.log) |
| Ada settles; seller paid 1 NEAR once | [`5GqSHBQD…`](https://testnet.nearblocks.io/txns/5GqSHBQDATevHhRGU5CjdwAbpcB6ZP2kbfXjiCp83pti) | `Paid` |
| Bo's settle a moment later | [`2KqNYAjP…`](https://testnet.nearblocks.io/txns/2KqNYAjPGfWRqsM35KNeEyZ9Kah8smVS19QhRwkpDorR) | rejected: deal is not open |
| Dee pledges 5 to tier B (min 30); it misses; Dee reclaims | [`A2neXS5D…`](https://testnet.nearblocks.io/txns/A2neXS5DsuyZxviEHsC924SgV8SWAgSB8RmvzSjfhgGn), [`EaqHGLnb…`](https://testnet.nearblocks.io/txns/EaqHGLnbSbYSkhb6nyx9zxbpCFYwgA5BzCmdJoQ4dBa2) | refunded 0.36 NEAR (5 × 0.07 + 0.01 fee) |
| Ada and Bo redeem (0.004 NEAR fee each) | [`FnjNzJL7…`](https://testnet.nearblocks.io/txns/FnjNzJL7fucLqbLH4xFoFDbHFhE6dPrQ8z8h7fkeoKaC), [`EUR7TgfK…`](https://testnet.nearblocks.io/txns/EUR7TgfKPRLNx9FeQBRJ6Z4ybTRrWG3sjr9WVDDkuzfN) | redemptions 0 and 1 |
| Seller delivers both passes and records their sha256 | [`CeE9v5Pp…`](https://testnet.nearblocks.io/txns/CeE9v5Ppm2UVgKbHWMj5EgpGFZqoxX7gKhnThqoQLm38), [`9PwiLiAE…`](https://testnet.nearblocks.io/txns/9PwiLiAEB84NDpywmNHgvvCkdj97nfB4CWWVJqg443Nu) | both passes VALID; deal storage 805 bytes, funded |
| Ada calls the Quote Feed API with her pass | local, no transaction | 200; tampered pass 401; no pass 401; a correctly signed pass for a deal outside the API's offer 401 ([log](evidence/testnet/showcase/6-api.log)) |

Failure cases, run separately on fresh deals, 9/9 passed ([scenario log](evidence/testnet/scenarios.log)): two buyers creating the same account concurrently (a); one changed yoctoNEAR gives a different address (b); a retried identical pledge is rejected and its deposit returned (c); a pledge after the deadline is rejected (d); settle below the minimum is rejected, settle exactly at the minimum pays the seller exactly once, a second settle is rejected (e); a refund before the deadline is rejected, after it the buyer gets exactly pledge + fee, a second refund is rejected (f); a payout to a non-existent seller fails, the deal becomes `PayoutFailed` and the buyer reclaims in full (g); deal accounts have no access keys and run the published code (h); two buyers redeem and the seller confirms both deliveries while storage passes the 770-byte allowance and stays funded (i: 837 bytes, 0.028 NEAR held, 0.00837 needed).

Not shown: mainnet, real money, a production API (the Quote Feed API runs locally and serves labelled sample quotes), sybil buyers, or a seller who refuses to deliver.

## How it is built

- `contract/`: Rust, near-sdk 5.29.1. One escrow state machine (`Open → Paying → Paid | PayoutFailed`), 19 unit tests (`cd contract && cargo test`). Fees: 0.01 NEAR per new buyer (returned with a refund), 0.004 NEAR per redemption (kept for storage).
- `client/`: TypeScript with near-kit 0.20.2: StateInit encoding and address derivation, scripted buyer agents (their budget includes both fees), seller publish/fulfil, pass verification, the Quote Feed API (`bin/api.ts`, `src/api.ts`), and the testnet scenario runner.
- `page/`: static page that re-derives each deal address in the browser and reads the deal from testnet RPC.
- `docs/SPEC.md`: the interface (state layout, methods, deposits, events).

## Disclosure

- Built during NEAR HACKATHON (November 2026) from an empty repository. Libraries: near-sdk, near-kit, @noble/curves, @noble/hashes, @scure/base, js-sha3 (page). Code was written with AI coding agents (Claude Code) under the author's direction.
- The same author also submitted **Bounded Mandate**, a separate project about revocable AI trading authority on NEAR Intents: https://github.com/gryyny/bounded-mandate. The two projects share no code.
- Narration: Kokoro-82M run locally (stock voice), no paid service.

## License

MIT, see [LICENSE](LICENSE).
