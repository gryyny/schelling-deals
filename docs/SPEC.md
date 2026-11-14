# Schelling Deals: interface (coordinator-owned)

Independent buyer agents pool a purchase without a platform operator. The deal terms determine the escrow address; nobody holds its keys.

## Offer

A seller publishes an offer file (`offer.json`): the global contract code hash, the seller account, the item, and a price ladder. Each tier is its own deal. After publishing, the seller's process exits; funding, settlement and refunds never need it again. Delivery does (the seller must come back to deliver what was paid for).

```json
{
  "offerId": "quotefeed-2026-11-14a",
  "codeHash": "<base58 sha256 of contract wasm, published as an immutable global contract by hash>",
  "seller": "seller.testnet",
  "item": "Quote Feed API access pass: 1 unit = 1 month of one API seat",
  "tiers": [
    { "minUnits": 10, "maxUnits": 20, "unitPriceYocto": "100000000000000000000000", "deadlineNs": "..." },
    { "minUnits": 30, "maxUnits": 60, "unitPriceYocto": "70000000000000000000000", "deadlineNs": "..." }
  ]
}
```

## Deal account derivation (NEP-616)

`StateInit::V1 { code: CodeHash(codeHash), data: { b"STATE" => borsh(DealState) } }`.
Account id: `"0s" + hex(keccak256(borsh(state_init))[12..32])`. near-kit `deriveAccountId` / `.stateInit()` implements this.

Initial `DealState` (borsh, field order fixed):

| field | type | initial value |
| --- | --- | --- |
| seller | string (u32 LE length + utf8) | offer.seller |
| item | string | offer.item |
| offer_id | string | offer.offerId |
| unit_price | u128 LE | tier.unitPriceYocto |
| min_units | u32 LE | tier.minUnits |
| max_units | u32 LE | tier.maxUnits |
| deadline_ns | u64 LE | tier.deadlineNs |
| total_units | u32 LE | 0 |
| buyers | u32 LE | 0 |
| status | u8 | 0 (Open) |
| redemptions | u32 LE | 0 |

Status: 0 Open, 1 Paying, 2 Paid, 3 PayoutFailed. Any change to any term gives a different address.

## Methods

Every buyer joins with one transaction to the derived account: `stateInit({code:{codeHash}, data, deposit})` followed by `pledge`. If the account already exists, the runtime refunds the stateInit deposit in full, so concurrent creators are safe. The state fits the zero-balance-account allowance, so `deposit` may be 0.

- `pledge({ units: u32 })`, payable. `units` is the buyer's absolute total commitment. Requires Open and `block_timestamp < deadline_ns`; `units` greater than the buyer's current pledge; `total_units + delta <= max_units`. Attached deposit must equal `delta * unit_price`, plus `STORAGE_FEE` (0.002 NEAR) when the buyer is new. A retried identical pledge panics (`already pledged`) and the runtime returns its deposit.
- `settle()`: anyone. Requires Open and `total_units >= min_units` (before or after the deadline). Sets Paying and transfers `total_units * unit_price` to the seller; callback sets Paid, or PayoutFailed when the transfer fails (funds return to the deal account). A second settle fails.
- `refund({ buyer: AccountId })`: anyone may call; funds go only to `buyer`. Allowed when (Open and `block_timestamp >= deadline_ns` and `total_units < min_units`) or PayoutFailed. Removes the pledge, sends `units * unit_price + STORAGE_FEE` to the buyer; the callback restores the pledge if the transfer fails. A second refund fails (`nothing to refund`). Refunds are claimable, not automatic.
- `redeem({ units: u32, note: String })`: buyer only, requires Paid and units <= remaining credits. Records redemption `id` and emits event `redeem`.
- `confirm_delivery({ id: u32, digest: String })`: seller only, requires Paid; stores the sha256 hex of what was delivered for that redemption; once only.
- Views: `get_deal()` -> state JSON (amounts as strings); `get_pledge({ buyer })` -> `{ units, redeemed }`; `get_redemption({ id })` -> `{ buyer, units, note, digest | null }`.

Events: NEP-297 `EVENT_JSON:{"standard":"schelling-deals","version":"1.0.0","event":"pledge|settle|payout|refund|redeem|delivery","data":{...}}`.

No owner, no admin method, no upgrade, no access keys; the code is referenced by hash, so it cannot change.

## Delivery and guarantee boundary

The contract guarantees: the seller is paid only when the minimum is reached, the payment happens once, and otherwise each buyer can reclaim exactly what they paid. It does not force the seller to deliver. Delivery here is a seller-signed access pass (ed25519 signature by a key on the seller account over the pass JSON); its sha256 is recorded on-chain with `confirm_delivery`, and anyone can verify the pass against the seller's on-chain key and the buyer's pledge.
