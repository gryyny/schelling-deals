//! A keyless pooled-purchase escrow. Its terms live in its initial state, so the
//! account id (NEP-616) commits to them: no owner, no admin, no upgrade path.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult};

/// Paid by each new buyer, returned with a refund. Covers the buyer's pledge record and,
/// with at least one buyer, the deal's own state once it exceeds the zero-balance allowance.
pub const STORAGE_FEE: NearToken = NearToken::from_millinear(10);
/// Paid per redemption and kept: funds the redemption record and the seller's delivery digest.
pub const REDEEM_FEE: NearToken = NearToken::from_millinear(4);
const MAX_NOTE: usize = 120;
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

pub const OPEN: u8 = 0;
pub const PAYING: u8 = 1;
pub const PAID: u8 = 2;
pub const PAYOUT_FAILED: u8 = 3;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Deal {
    seller: AccountId,
    item: String,
    offer_id: String,
    unit_price: u128,
    min_units: u32,
    max_units: u32,
    deadline_ns: u64,
    total_units: u32,
    buyers: u32,
    status: u8,
    redemptions: u32,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Clone, Copy, Default, PartialEq, Debug)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct Pledge {
    pub units: u32,
    pub redeemed: u32,
}

#[derive(BorshSerialize, BorshDeserialize, Serialize, Clone)]
#[borsh(crate = "near_sdk::borsh")]
#[serde(crate = "near_sdk::serde")]
pub struct Redemption {
    pub buyer: AccountId,
    pub units: u32,
    pub note: String,
    pub digest: Option<String>,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct DealView {
    pub seller: AccountId,
    pub item: String,
    pub offer_id: String,
    pub unit_price: U128,
    pub min_units: u32,
    pub max_units: u32,
    pub deadline_ns: String,
    pub total_units: u32,
    pub buyers: u32,
    pub status: &'static str,
    pub redemptions: u32,
    pub now_ns: String,
}

fn pledge_key(buyer: &AccountId) -> Vec<u8> {
    [b"p".as_slice(), buyer.as_bytes()].concat()
}

fn redemption_key(id: u32) -> Vec<u8> {
    [b"r".as_slice(), &id.to_le_bytes()].concat()
}

fn read_pledge(buyer: &AccountId) -> Option<Pledge> {
    env::storage_read(&pledge_key(buyer)).map(|b| Pledge::try_from_slice(&b).expect("pledge"))
}

fn write_pledge(buyer: &AccountId, p: &Pledge) {
    env::storage_write(&pledge_key(buyer), &borsh::to_vec(p).expect("pledge"));
}

fn read_redemption(id: u32) -> Option<Redemption> {
    env::storage_read(&redemption_key(id)).map(|b| Redemption::try_from_slice(&b).expect("redemption"))
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({"standard": "schelling-deals", "version": "1.0.0", "event": event, "data": data})
    ));
}

use near_sdk::borsh;

/// Storage the account may use without holding a balance (NEP-448 zero-balance allowance).
const ZBA_BYTES: u64 = 770;

/// Fail with a clear message (the deposit then returns) instead of leaving a write unfunded.
fn assert_storage_funded() {
    let used = env::storage_usage();
    if used > ZBA_BYTES {
        let need = env::storage_byte_cost().as_yoctonear() * used as u128;
        require!(env::account_balance().as_yoctonear() >= need, format!("storage not funded: {used} bytes need {need} yoctoNEAR"));
    }
}

fn status_name(s: u8) -> &'static str {
    match s {
        OPEN => "Open",
        PAYING => "Paying",
        PAID => "Paid",
        _ => "PayoutFailed",
    }
}

#[near]
impl Deal {
    /// `units` is the caller's absolute total commitment, so a retried call cannot double-pledge.
    #[payable]
    pub fn pledge(&mut self, units: u32) {
        require!(self.status == OPEN, "deal is not open");
        require!(env::block_timestamp() < self.deadline_ns, "deadline passed");
        let buyer = env::predecessor_account_id();
        let current = read_pledge(&buyer);
        let had = current.map_or(0, |p| p.units);
        require!(units > had, "already pledged");
        let delta = units - had;
        let total = self.total_units.checked_add(delta).expect("overflow");
        require!(total <= self.max_units, "exceeds max units");
        let fee = if current.is_none() { STORAGE_FEE.as_yoctonear() } else { 0 };
        let expected = self.unit_price.checked_mul(delta as u128).expect("overflow") + fee;
        require!(
            env::attached_deposit().as_yoctonear() == expected,
            format!("attached deposit must be {expected} yoctoNEAR")
        );
        if current.is_none() {
            self.buyers += 1;
        }
        self.total_units = total;
        write_pledge(&buyer, &Pledge { units, redeemed: 0 });
        assert_storage_funded();
        emit("pledge", serde_json::json!({"buyer": buyer, "units": units, "total_units": total}));
    }

    /// Anyone may settle once the minimum is reached; the payout happens at most once.
    pub fn settle(&mut self) -> Promise {
        require!(self.status == OPEN, "deal is not open");
        require!(self.total_units >= self.min_units, "minimum not reached");
        self.status = PAYING;
        let amount = NearToken::from_yoctonear(self.unit_price * self.total_units as u128);
        emit("settle", serde_json::json!({"seller": self.seller, "amount": amount.as_yoctonear().to_string(), "units": self.total_units}));
        Promise::new(self.seller.clone())
            .transfer(amount)
            .then(Promise::new(env::current_account_id()).function_call(
                "on_payout",
                vec![],
                NearToken::from_yoctonear(0),
                CALLBACK_GAS,
            ))
    }

    #[private]
    pub fn on_payout(&mut self) {
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        self.status = if ok { PAID } else { PAYOUT_FAILED };
        emit("payout", serde_json::json!({"ok": ok}));
    }

    /// Claimable by anyone on the buyer's behalf; funds only ever go to the buyer.
    pub fn refund(&mut self, buyer: AccountId) -> Promise {
        let missed = self.status == OPEN
            && env::block_timestamp() >= self.deadline_ns
            && self.total_units < self.min_units;
        require!(missed || self.status == PAYOUT_FAILED, "refunds are not open");
        let pledge = read_pledge(&buyer).expect("nothing to refund");
        env::storage_remove(&pledge_key(&buyer));
        let amount = NearToken::from_yoctonear(
            self.unit_price * pledge.units as u128 + STORAGE_FEE.as_yoctonear(),
        );
        emit("refund", serde_json::json!({"buyer": buyer, "units": pledge.units, "amount": amount.as_yoctonear().to_string()}));
        Promise::new(buyer.clone()).transfer(amount).then(
            Promise::new(env::current_account_id()).function_call(
                "on_refund",
                serde_json::to_vec(&serde_json::json!({"buyer": buyer, "units": pledge.units})).unwrap(),
                NearToken::from_yoctonear(0),
                CALLBACK_GAS,
            ),
        )
    }

    #[private]
    pub fn on_refund(&mut self, buyer: AccountId, units: u32) {
        if !matches!(env::promise_result(0), PromiseResult::Successful(_)) {
            write_pledge(&buyer, &Pledge { units, redeemed: 0 });
            emit("refund_failed", serde_json::json!({"buyer": buyer, "units": units}));
        }
    }

    #[payable]
    pub fn redeem(&mut self, units: u32, note: String) -> u32 {
        require!(self.status == PAID, "deal is not paid");
        require!(note.len() <= MAX_NOTE, "note too long");
        require!(
            env::attached_deposit() == REDEEM_FEE,
            format!("attached deposit must be {} yoctoNEAR", REDEEM_FEE.as_yoctonear())
        );
        let buyer = env::predecessor_account_id();
        let mut p = read_pledge(&buyer).expect("not a buyer");
        require!(units > 0 && units <= p.units - p.redeemed, "not enough credits");
        p.redeemed += units;
        write_pledge(&buyer, &p);
        let id = self.redemptions;
        self.redemptions += 1;
        let r = Redemption { buyer: buyer.clone(), units, note, digest: None };
        env::storage_write(&redemption_key(id), &borsh::to_vec(&r).expect("redemption"));
        assert_storage_funded();
        emit("redeem", serde_json::json!({"id": id, "buyer": buyer, "units": units}));
        id
    }

    pub fn confirm_delivery(&mut self, id: u32, digest: String) {
        require!(env::predecessor_account_id() == self.seller, "only the seller");
        require!(digest.len() == 64 && digest.bytes().all(|c| c.is_ascii_hexdigit()), "sha256 hex expected");
        let mut r = read_redemption(id).expect("unknown redemption");
        require!(r.digest.is_none(), "already delivered");
        r.digest = Some(digest.clone());
        env::storage_write(&redemption_key(id), &borsh::to_vec(&r).expect("redemption"));
        assert_storage_funded();
        emit("delivery", serde_json::json!({"id": id, "buyer": r.buyer, "digest": digest}));
    }

    pub fn get_deal(&self) -> DealView {
        DealView {
            seller: self.seller.clone(),
            item: self.item.clone(),
            offer_id: self.offer_id.clone(),
            unit_price: U128(self.unit_price),
            min_units: self.min_units,
            max_units: self.max_units,
            deadline_ns: self.deadline_ns.to_string(),
            total_units: self.total_units,
            buyers: self.buyers,
            status: status_name(self.status),
            redemptions: self.redemptions,
            now_ns: env::block_timestamp().to_string(),
        }
    }

    pub fn get_pledge(&self, buyer: AccountId) -> Pledge {
        read_pledge(&buyer).unwrap_or_default()
    }

    pub fn get_redemption(&self, id: u32) -> Option<Redemption> {
        read_redemption(id)
    }
}

#[cfg(test)]
mod tests;
