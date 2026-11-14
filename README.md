# Schelling Deals

Independent buyer agents pool a purchase on NEAR without a platform operator. The deal terms determine the escrow address; nobody holds its keys.

**Testnet. The buyer agents are scripted (deterministic rules, no model).** Live page: https://gryyny.github.io/schelling-deals/ · Video: see the X post linked from the hackathon entry.

## The problem

A seller offers a volume price: 0.10 NEAR per unit if at least 10 units sell together. Four small buyers each need a few units. To pool their orders today they need someone to run the pool: a group-buy platform or a coordinator contract whose owner opens each round, holds the funds or can change the rules. That operator is a cost, a point of failure, and a party everyone must trust.

## What Schelling Deals does

1. The seller publishes an offer file once (item, price tiers, deadlines, and the hash of an immutable contract), then **stops running**.
2. Each buyer agent reads the offer and **derives the escrow address itself** from the exact terms ([NEP-616](https://github.com/near/NEPs/blob/master/neps/nep-0616.md) deterministic account: `0s` + keccak256(StateInit)[12..32]). Identical terms always give the same address; any change gives a different one.
3. A buyer that accepts sends **one transaction**: create the account if it does not exist yet (`DeterministicStateInit`, code referenced by global-contract hash) and pledge. Whoever arrives first creates it; if two arrive at once, the runtime refunds the second creation deposit and both pledges count.
4. When pledges reach the minimum, **anyone** can settle: the seller is paid exactly once. If the deadline passes below the minimum, or the payout fails, every buyer can **claim** an exact refund (refunds are claimable, not automatic).
5. Buyers then **redeem** their units. The seller comes back online, delivers a signed access pass and records its sha256 on the deal account; anyone can verify the pass against the seller's on-chain key.

The escrow account has **no access keys**, no owner, no admin method and no upgrade path. Its code is a global contract referenced by hash (`ADKfksXSef9h37xY3WBRZk2CPBmpZLokTEeQHiFuB28`), so it cannot change.

Buyers do share information: the published offer and the blockchain. What they do not need is direct messaging or a privileged coordinator.

## What it guarantees, and what it does not

| Guaranteed by the contract | Not guaranteed |
| --- | --- |
| The seller is paid only if the minimum is reached, and only once | That the seller delivers (delivery is recorded on-chain for accountability, not enforced) |
| Below the minimum at the deadline, or after a failed payout, each buyer can reclaim exactly what they paid | That someone calls `refund` (any account can, on any buyer's behalf; funds only go to the buyer) |
| A retried pledge cannot double-charge (pledges are absolute totals) | Price discovery: tiers are fixed by the seller |
| Terms cannot change after the first pledge (they are the address) | Sybil resistance among buyers |

## Try it

Read-only, no keys or funds (Node 24 + pnpm, Rust 1.97 for the contract):

```sh
git clone https://github.com/gryyny/schelling-deals && cd schelling-deals
cd contract && cargo test            # 17 tests: pledge/settle/refund/payout-failure/redeem state machine
cd ../client && pnpm install
pnpm test                            # address derivation cross-checked against near-kit; any changed term -> new address
pnpm verify                          # reads testnet: both deal accounts, 0 access keys, published code hash, 23 recorded transactions
```

Expected: `cargo test` ends with `17 passed`; `pnpm verify` ends with `VERIFIED: all checks passed`.

Then open the [live page](https://gryyny.github.io/schelling-deals/): it re-derives each deal address in your browser from the offer terms and reads the deal from testnet. Toggle "Independent check", change any term (for example the minimum) and see the address change.

**Full run on testnet** (creates nothing on mainnet; needs six free faucet accounts named `<role>-<prefix>.testnet`, keys in `~/.near-credentials/testnet/`):

```sh
for r in seller ada bo cy dee; do near account create-account sponsor-by-faucet-service $r-$PREFIX.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create; done
SD_PREFIX=$PREFIX ./demo/showcase.sh   # seller publishes and exits; four agents act; tier B misses and refunds; Ada redeems; pass verified
```

The global contract is already published by hash on testnet; `client/bin/publish-code.ts` republishes the same wasm from your own account (it needs about 15 testnet NEAR of storage).

## Verify it

- `pnpm verify` (in `client/`): derives both deal addresses from [evidence/testnet/offer.json](evidence/testnet/offer.json), checks each account runs global contract `ADKfksXSef9h37xY3WBRZk2CPBmpZLokTEeQHiFuB28` and has no access keys, checks their status (tier A `Paid`, tier B below its minimum after the deadline), and checks every recorded transaction's outcome (success, or the expected rejection) over testnet RPC.
- `pnpm tsx bin/verify-pass.ts ../evidence/testnet/pass-ada.json`: the delivered pass's ed25519 signature, that the signing key is on the seller account, and that its sha256 is recorded on the deal.
- The code hash is the sha256 of `contract/target/near/schelling_deal.wasm` built with `cargo near build non-reproducible-wasm --no-abi` (toolchain pinned in `contract/rust-toolchain.toml`). The build is not certified reproducible; the deployed code is identified by the hash on-chain.

## Testnet evidence

All on NEAR testnet, 14 November 2026. Explorer: `https://testnet.nearblocks.io/txns/<hash>`. Full list with outcomes: [evidence/testnet/receipts.json](evidence/testnet/receipts.json); agent logs: [evidence/testnet/showcase/](evidence/testnet/showcase/).

| Step | Transaction | Result |
| --- | --- | --- |
| Global contract published by hash | [`Feznfs6p…`](https://testnet.nearblocks.io/txns/Feznfs6pMMopG3irUVDnoHjKUgwu3zH7xEykTiNMM4y8) | code hash `ADKfksXS…` |
| Seller publishes the offer and exits | n/a (offer file) | [offer.json](evidence/testnet/offer.json) |
| Ada and Bo each create-and-pledge tier A at the same time | [`6aqTDZb9…`](https://testnet.nearblocks.io/txns/6aqTDZb9UGs4zJoc3f8wzUE3Tr6FbzTfhSMtxxMyLGCE), [`4nfFCjnz…`](https://testnet.nearblocks.io/txns/4nfFCjnz6FNKN1puMQ8XHnJjvyxySAHXXs3e84Azm7mj) | one account `0s90060430…`, 10/10 units |
| Cy declines (price above its limit) | none | see [Cy's log](evidence/testnet/showcase/2-cy.log) |
| Ada settles; seller paid 1 NEAR once | [`49gee1C7…`](https://testnet.nearblocks.io/txns/49gee1C7PM6GH1mTXPqYr2mPKV2P17VywXzemZE5PTZ7) | `Paid` |
| Bo's settle in the same race | [`5fzwYfpA…`](https://testnet.nearblocks.io/txns/5fzwYfpAUJWFRkWnrBwneLAFvjMztYVnL7C6Qq3fm2nv) | rejected: deal is not open |
| Dee pledges 5 to tier B (min 30); it misses; Dee reclaims | [`51nJemaR…`](https://testnet.nearblocks.io/txns/51nJemaRKssHFCkmwBjACSepFvtsGtLbaz18N5A1bPXh), [`BUdB68iA…`](https://testnet.nearblocks.io/txns/BUdB68iA6CPciajcfzL5XMxFPnBScAL6kFNz1ry513Qk) | refunded 0.352 NEAR |
| Ada redeems 4 units; seller delivers a signed pass | [`HSpDVPck…`](https://testnet.nearblocks.io/txns/HSpDVPckccbeKvD4si7WGwzhSu66RrGUKWjC3ZhwNkNC), [`4ffT8XTB…`](https://testnet.nearblocks.io/txns/4ffT8XTBFyp1HgpgvqXpeQVrnyPgSZZQSj7WarQzrVfQ) | pass sha256 on-chain, `verify-pass` VALID |

Failure cases, run separately on fresh deals ([scenario log](evidence/testnet/scenarios.log)): two buyers creating the same account concurrently (a); one changed yoctoNEAR gives a different address (b); a retried identical pledge is rejected and its deposit returned (c); a pledge after the deadline is rejected (d); settle below the minimum is rejected, settle exactly at the minimum pays the seller exactly once, a second settle is rejected (e); a refund before the deadline is rejected, after it the buyer gets exactly pledge + fee, a second refund is rejected (f); a payout to a non-existent seller fails, the deal becomes `PayoutFailed` and the buyer reclaims in full (g); deal accounts have no access keys and run the published code (h).

Not shown: mainnet, real money, real API delivery (the pass is a signed file), sybil buyers, or a seller who refuses to deliver.

## How it is built

- `contract/`: Rust, near-sdk 5.29.1. One escrow state machine (`Open → Paying → Paid | PayoutFailed`), 17 unit tests (`cd contract && cargo test`).
- `client/`: TypeScript with near-kit 0.20.2: StateInit encoding and address derivation, scripted buyer agents, seller publish/fulfil, pass verification, and the testnet scenario runner.
- `page/`: static page that re-derives each deal address in the browser and reads the deal from testnet RPC.
- `docs/SPEC.md`: the interface (state layout, methods, deposits, events).

## Disclosure

- Built during NEAR HACKATHON (November 2026) from an empty repository. Libraries: near-sdk, near-kit, @noble/curves, @noble/hashes, @scure/base, js-sha3 (page). Code was written with AI coding agents (Claude Code) under the author's direction.
- The same author also submitted **Bounded Mandate**, a separate project about revocable AI trading authority on NEAR Intents: https://github.com/gryyny/bounded-mandate. The two projects share no code.
- Narration: Kokoro-82M run locally (stock voice), no paid service.

## License

MIT, see [LICENSE](LICENSE).
