use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, RuntimeFeesConfig};

const PRICE: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
const DEADLINE: u64 = 1_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn deal() -> Deal {
    Deal {
        seller: acc("seller.testnet"),
        item: "pass".into(),
        offer_id: "o1".into(),
        unit_price: PRICE,
        min_units: 10,
        max_units: 20,
        deadline_ns: DEADLINE,
        total_units: 0,
        buyers: 0,
        status: OPEN,
        redemptions: 0,
    }
}

fn ctx(who: &str, deposit: u128, now: u64) {
    let c = VMContextBuilder::new()
        .current_account_id(acc("0s0000000000000000000000000000000000000000"))
        .predecessor_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now)
        .build();
    testing_env!(c);
}

fn callback(result: PromiseResult) {
    let c = VMContextBuilder::new()
        .current_account_id(acc("0s0000000000000000000000000000000000000000"))
        .predecessor_account_id(acc("0s0000000000000000000000000000000000000000"))
        .build();
    testing_env!(c, near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

fn fee() -> u128 {
    STORAGE_FEE.as_yoctonear()
}

fn pledge(d: &mut Deal, who: &str, units: u32, deposit: u128, now: u64) {
    ctx(who, deposit, now);
    d.pledge(units);
}

#[test]
fn pledges_accumulate_and_threshold_is_inclusive() {
    let mut d = deal();
    pledge(&mut d, "ada", 4, 4 * PRICE + fee(), 1);
    pledge(&mut d, "bo", 6, 6 * PRICE + fee(), 2);
    assert_eq!(d.total_units, 10);
    assert_eq!(d.buyers, 2);
    ctx("anyone", 0, 3);
    d.settle();
    assert_eq!(d.status, PAYING);
    callback(PromiseResult::Successful(vec![]));
    d.on_payout();
    assert_eq!(d.status, PAID);
}

#[test]
fn raising_a_pledge_charges_only_the_delta() {
    let mut d = deal();
    pledge(&mut d, "ada", 2, 2 * PRICE + fee(), 1);
    pledge(&mut d, "ada", 5, 3 * PRICE, 2);
    assert_eq!(d.total_units, 5);
    assert_eq!(d.buyers, 1);
}

#[test]
#[should_panic(expected = "already pledged")]
fn retried_identical_pledge_is_rejected() {
    let mut d = deal();
    pledge(&mut d, "ada", 4, 4 * PRICE + fee(), 1);
    pledge(&mut d, "ada", 4, 4 * PRICE + fee(), 2);
}

#[test]
#[should_panic(expected = "attached deposit must be")]
fn wrong_deposit_is_rejected() {
    let mut d = deal();
    pledge(&mut d, "ada", 4, 4 * PRICE, 1);
}

#[test]
#[should_panic(expected = "deadline passed")]
fn pledge_at_deadline_is_rejected() {
    let mut d = deal();
    pledge(&mut d, "ada", 4, 4 * PRICE + fee(), DEADLINE);
}

#[test]
#[should_panic(expected = "exceeds max units")]
fn pledge_over_cap_is_rejected() {
    let mut d = deal();
    pledge(&mut d, "ada", 21, 21 * PRICE + fee(), 1);
}

#[test]
#[should_panic(expected = "minimum not reached")]
fn settle_below_minimum_is_rejected() {
    let mut d = deal();
    pledge(&mut d, "ada", 9, 9 * PRICE + fee(), 1);
    ctx("anyone", 0, 2);
    d.settle();
}

#[test]
#[should_panic(expected = "deal is not open")]
fn second_settle_is_rejected() {
    let mut d = deal();
    pledge(&mut d, "ada", 10, 10 * PRICE + fee(), 1);
    ctx("anyone", 0, 2);
    d.settle();
    ctx("anyone", 0, 3);
    d.settle();
}

#[test]
#[should_panic(expected = "deal is not open")]
fn pledge_after_settle_is_rejected() {
    let mut d = deal();
    pledge(&mut d, "ada", 10, 10 * PRICE + fee(), 1);
    ctx("anyone", 0, 2);
    d.settle();
    pledge(&mut d, "bo", 1, PRICE + fee(), 3);
}

#[test]
#[should_panic(expected = "refunds are not open")]
fn refund_before_deadline_is_rejected() {
    let mut d = deal();
    pledge(&mut d, "ada", 4, 4 * PRICE + fee(), 1);
    ctx("anyone", 0, DEADLINE - 1);
    d.refund(acc("ada"));
}

#[test]
#[should_panic(expected = "refunds are not open")]
fn refund_after_successful_deal_is_rejected() {
    let mut d = deal();
    pledge(&mut d, "ada", 10, 10 * PRICE + fee(), 1);
    ctx("anyone", 0, 2);
    d.settle();
    callback(PromiseResult::Successful(vec![]));
    d.on_payout();
    ctx("ada", 0, DEADLINE + 1);
    d.refund(acc("ada"));
}

#[test]
fn missed_deal_refunds_exact_amount_once() {
    let mut d = deal();
    pledge(&mut d, "dee", 5, 5 * PRICE + fee(), 1);
    ctx("anyone", 0, DEADLINE);
    d.refund(acc("dee"));
    assert!(get_logs().iter().any(|l| l.contains(&format!("\"amount\":\"{}\"", 5 * PRICE + fee()))));
    assert_eq!(d.get_pledge(acc("dee")), Pledge::default());
    let second = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("anyone", 0, DEADLINE + 1);
        d.refund(acc("dee"));
    }));
    assert!(second.is_err());
}

#[test]
fn failed_refund_transfer_restores_the_pledge() {
    let mut d = deal();
    pledge(&mut d, "dee", 5, 5 * PRICE + fee(), 1);
    ctx("anyone", 0, DEADLINE);
    d.refund(acc("dee"));
    callback(PromiseResult::Failed);
    d.on_refund(acc("dee"), 5);
    assert_eq!(d.get_pledge(acc("dee")).units, 5);
}

#[test]
fn failed_payout_opens_full_refunds_and_blocks_resettle() {
    let mut d = deal();
    pledge(&mut d, "ada", 4, 4 * PRICE + fee(), 1);
    pledge(&mut d, "bo", 6, 6 * PRICE + fee(), 2);
    ctx("anyone", 0, 3);
    d.settle();
    callback(PromiseResult::Failed);
    d.on_payout();
    assert_eq!(d.status, PAYOUT_FAILED);
    ctx("anyone", 0, 4);
    d.refund(acc("ada"));
    let resettle = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("anyone", 0, 5);
        d.settle();
    }));
    assert!(resettle.is_err());
}

#[test]
fn redeem_and_delivery() {
    let mut d = deal();
    pledge(&mut d, "ada", 10, 10 * PRICE + fee(), 1);
    ctx("anyone", 0, 2);
    d.settle();
    callback(PromiseResult::Successful(vec![]));
    d.on_payout();
    ctx("ada", REDEEM_FEE.as_yoctonear(), 3);
    let id = d.redeem(3, "seat for ada".into());
    assert_eq!(d.get_pledge(acc("ada")).redeemed, 3);
    ctx("seller.testnet", 0, 4);
    d.confirm_delivery(id, "a".repeat(64));
    assert_eq!(d.get_redemption(id).unwrap().digest.unwrap(), "a".repeat(64));
    let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("seller.testnet", 0, 5);
        d.confirm_delivery(id, "b".repeat(64));
    }));
    assert!(again.is_err());
    let over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("ada", REDEEM_FEE.as_yoctonear(), 6);
        d.redeem(8, "too many".into());
    }));
    assert!(over.is_err());
}

#[test]
#[should_panic(expected = "only the seller")]
fn only_seller_confirms_delivery() {
    let mut d = deal();
    pledge(&mut d, "ada", 10, 10 * PRICE + fee(), 1);
    ctx("anyone", 0, 2);
    d.settle();
    callback(PromiseResult::Successful(vec![]));
    d.on_payout();
    ctx("ada", REDEEM_FEE.as_yoctonear(), 3);
    let id = d.redeem(1, "x".into());
    ctx("ada", 0, 4);
    d.confirm_delivery(id, "a".repeat(64));
}

#[test]
fn state_layout_matches_spec() {
    let bytes = borsh::to_vec(&deal()).unwrap();
    let mut expected = Vec::new();
    for s in ["seller.testnet", "pass", "o1"] {
        expected.extend((s.len() as u32).to_le_bytes());
        expected.extend(s.as_bytes());
    }
    expected.extend(PRICE.to_le_bytes());
    expected.extend(10u32.to_le_bytes());
    expected.extend(20u32.to_le_bytes());
    expected.extend(DEADLINE.to_le_bytes());
    expected.extend(0u32.to_le_bytes());
    expected.extend(0u32.to_le_bytes());
    expected.push(0);
    expected.extend(0u32.to_le_bytes());
    assert_eq!(bytes, expected);
}

#[test]
#[should_panic(expected = "attached deposit must be")]
fn redeem_requires_the_storage_fee() {
    let mut d = deal();
    pledge(&mut d, "ada", 10, 10 * PRICE + fee(), 1);
    ctx("anyone", 0, 2);
    d.settle();
    callback(PromiseResult::Successful(vec![]));
    d.on_payout();
    ctx("ada", 0, 3);
    d.redeem(1, "x".into());
}

/// Worst-case record sizes must stay within what the fees fund (1 byte = 1e19 yoctoNEAR).
#[test]
fn fees_cover_worst_case_storage() {
    const BYTE: u128 = 10_000_000_000_000_000_000;
    const OVERHEAD: u128 = 40; // per-record storage overhead charged by the protocol
    let longest = "a".repeat(64);
    let pledge_record = (1 + 64) as u128 + borsh::to_vec(&Pledge { units: u32::MAX, redeemed: u32::MAX }).unwrap().len() as u128 + OVERHEAD;
    let redemption = Redemption { buyer: longest.parse().unwrap(), units: u32::MAX, note: "n".repeat(MAX_NOTE), digest: Some("f".repeat(64)) };
    let redemption_record = (1 + 4) as u128 + borsh::to_vec(&redemption).unwrap().len() as u128 + OVERHEAD;
    let mut big = deal();
    big.seller = longest.parse().unwrap();
    big.item = "i".repeat(160);
    big.offer_id = "o".repeat(64);
    // contract state plus account record and global-contract reference; generous bound
    let base = borsh::to_vec(&big).unwrap().len() as u128 + 5 + OVERHEAD + 200;
    assert!(STORAGE_FEE.as_yoctonear() >= (base + pledge_record) * BYTE, "first buyer funds base + own record");
    assert!(STORAGE_FEE.as_yoctonear() >= pledge_record * BYTE);
    assert!(REDEEM_FEE.as_yoctonear() >= redemption_record * BYTE);
}
