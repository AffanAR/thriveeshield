//! ThriveeShield vault.
//!
//! The vault account holds funds. An AI agent holds a *function-call access key*
//! on the vault account, limited to `request_payment` and `report_address`.
//! A human owner (a different account) holds the owner methods.
//!
//! Every payment request gets one of three verdicts, enforced on-chain, so a
//! compromised agent cannot skip any of them:
//!
//! * ALLOW: receiver is allowlisted, not reported, and within limits. Pays.
//! * WARN:  receiver is unknown or has unconfirmed reports. The payment is held
//!          as pending until the owner approves or rejects it.
//! * BLOCK: receiver is on the confirmed blocklist, or the payment breaks a
//!          limit, or the vault is paused. Nothing is paid and the attempt is logged.
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, IterableSet, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

const MS_PER_DAY: u64 = 86_400_000;
const MAX_EVIDENCE_LEN: usize = 512;
const MAX_REPORTS_PER_TARGET: usize = 20;
const MAX_VIEW_LIMIT: u64 = 100;
/// A stolen agent key cannot grow the pending queue past this.
const MAX_PENDING: u32 = 50;
const CALLBACK_GAS: Gas = Gas::from_tgas(5);

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Allowlist,
    Blocklist,
    Pending,
    Stats,
    Reports,
    Attempts,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "UPPERCASE")]
pub enum Verdict {
    Allow,
    Warn,
    Block,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Outcome {
    pub verdict: Verdict,
    pub reason: String,
    pub pending_id: Option<u64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Pending {
    pub id: u64,
    pub receiver: AccountId,
    pub amount: U128,
    pub memo: Option<String>,
    pub reason: String,
    pub requested_at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct ReceiverStats {
    pub paid_count: u32,
    pub total_paid: U128,
    pub last_paid_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Report {
    pub reporter: AccountId,
    pub evidence: String,
    pub at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Attempt {
    pub index: u64,
    pub receiver: AccountId,
    pub amount: U128,
    pub verdict: Verdict,
    pub reason: String,
    pub at_ms: u64,
}

#[near(serializers = [json])]
pub struct PolicyView {
    pub owner: AccountId,
    pub paused: bool,
    pub per_tx_limit: U128,
    pub daily_limit: U128,
    pub spent_today: U128,
    pub allowlist: Vec<AccountId>,
    pub pending_count: u64,
    pub blocklist_count: u64,
    pub available_balance: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    paused: bool,
    per_tx_limit: u128,
    daily_limit: u128,
    spent_today: u128,
    day_index: u64,
    allowlist: IterableSet<AccountId>,
    blocklist: IterableSet<AccountId>,
    pending: IterableMap<u64, Pending>,
    next_pending_id: u64,
    stats: LookupMap<AccountId, ReceiverStats>,
    reports: IterableMap<AccountId, Vec<Report>>,
    attempts: Vector<Attempt>,
}

#[near]
impl Vault {
    #[init]
    #[private]
    pub fn new(owner: AccountId, per_tx_limit: U128, daily_limit: U128) -> Self {
        require!(!env::state_exists(), "already initialised");
        require!(per_tx_limit.0 <= daily_limit.0, "per-tx limit cannot exceed the daily limit");
        Self {
            owner,
            paused: false,
            per_tx_limit: per_tx_limit.0,
            daily_limit: daily_limit.0,
            spent_today: 0,
            day_index: env::block_timestamp_ms() / MS_PER_DAY,
            allowlist: IterableSet::new(Key::Allowlist),
            blocklist: IterableSet::new(Key::Blocklist),
            pending: IterableMap::new(Key::Pending),
            next_pending_id: 1,
            stats: LookupMap::new(Key::Stats),
            reports: IterableMap::new(Key::Reports),
            attempts: Vector::new(Key::Attempts),
        }
    }

    /// Anyone can top up the vault.
    #[payable]
    pub fn deposit(&mut self) {
        self.event("deposit", json!({ "from": env::predecessor_account_id(), "amount": env::attached_deposit().as_yoctonear().to_string() }));
    }

    // ---------------------------------------------------------------- agent

    /// Called by the agent's function-call key. The contract decides the verdict.
    /// BLOCK and WARN do not panic, so the attempt log and the pending entry are kept.
    ///
    /// `hold = true` is how the agent wrapper passes on an off-chain WARN: a payment the contract
    /// would ALLOW is held for the human instead. `hold` can only make the verdict stricter.
    pub fn request_payment(&mut self, receiver: AccountId, amount: U128, memo: Option<String>, hold: Option<bool>) -> Outcome {
        self.assert_vault_key();
        self.roll_day();
        let now = env::block_timestamp_ms();
        let (mut verdict, mut reason) = self.evaluate(&receiver, amount.0);
        if verdict == Verdict::Allow && hold.unwrap_or(false) {
            verdict = Verdict::Warn;
            reason = "held for human review at the wrapper's request (off-chain risk signal)".into();
        }
        if verdict == Verdict::Warn && self.pending.len() >= MAX_PENDING {
            verdict = Verdict::Block;
            reason = "the pending queue is full, the owner must review it first".into();
        }
        self.log_attempt(&receiver, amount, verdict, &reason, now);

        match verdict {
            Verdict::Allow => {
                self.pay(&receiver, amount.0, now);
                self.event("paid", json!({ "receiver": receiver, "amount": amount.0.to_string(), "memo": memo }));
                Outcome { verdict, reason, pending_id: None }
            }
            Verdict::Warn => {
                let id = self.next_pending_id;
                self.next_pending_id += 1;
                self.pending.insert(id, Pending { id, receiver: receiver.clone(), amount, memo, reason: reason.clone(), requested_at_ms: now });
                self.event("held", json!({ "id": id, "receiver": receiver, "amount": amount.0.to_string(), "reason": reason }));
                Outcome { verdict, reason, pending_id: Some(id) }
            }
            Verdict::Block => {
                self.event("blocked", json!({ "receiver": receiver, "amount": amount.0.to_string(), "reason": reason }));
                Outcome { verdict, reason, pending_id: None }
            }
        }
    }

    /// Anyone can report an address with evidence. One report only raises WARN;
    /// it becomes a BLOCK after the owner calls `confirm_report`.
    pub fn report_address(&mut self, target: AccountId, evidence: String) {
        require!(target != env::current_account_id(), "cannot report the vault itself");
        require!(target != self.owner, "cannot report the vault owner");
        require!(!evidence.trim().is_empty(), "evidence is required");
        require!(evidence.len() <= MAX_EVIDENCE_LEN, "evidence is too long (max 512 bytes)");
        let reporter = env::predecessor_account_id();
        let mut list = self.reports.get(&target).cloned().unwrap_or_default();
        require!(list.iter().all(|r| r.reporter != reporter), "this reporter already reported that address");
        require!(list.len() < MAX_REPORTS_PER_TARGET, "report limit reached for this address");
        list.push(Report { reporter: reporter.clone(), evidence, at_ms: env::block_timestamp_ms() });
        self.reports.insert(target.clone(), list);
        self.event("reported", json!({ "target": target, "reporter": reporter }));
    }

    // ---------------------------------------------------------------- owner

    pub fn approve_pending(&mut self, id: u64) -> Outcome {
        self.assert_owner();
        self.roll_day();
        let p = self.pending.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such pending payment"));
        let now = env::block_timestamp_ms();
        let (verdict, reason) = self.evaluate(&p.receiver, p.amount.0);
        // The owner overrides WARN, never BLOCK.
        if verdict == Verdict::Block {
            // A temporary block (limit, balance, pause) keeps the payment pending so it can be
            // approved later. A blocklisted receiver removes it for good.
            if !self.blocklist.contains(&p.receiver) {
                env::panic_str(&format!("cannot approve now: {reason}"));
            }
            self.pending.remove(&id);
            self.log_attempt(&p.receiver, p.amount, Verdict::Block, &format!("approval refused: {reason}"), now);
            self.event("approval_refused", json!({ "id": id, "reason": reason }));
            return Outcome { verdict, reason, pending_id: None };
        }
        self.pending.remove(&id);
        self.pay(&p.receiver, p.amount.0, now);
        self.event("approved", json!({ "id": id, "receiver": p.receiver, "amount": p.amount.0.to_string() }));
        Outcome { verdict: Verdict::Allow, reason: "approved by owner".into(), pending_id: None }
    }

    pub fn reject_pending(&mut self, id: u64) {
        self.assert_owner();
        require!(self.pending.remove(&id).is_some(), "no such pending payment");
        self.event("rejected", json!({ "id": id }));
    }

    /// Turns a reported address into a confirmed BLOCK.
    pub fn confirm_report(&mut self, target: AccountId) {
        self.assert_owner();
        require!(self.reports.get(&target).map(|r| !r.is_empty()).unwrap_or(false), "no reports for this address");
        self.blocklist.insert(target.clone());
        self.allowlist.remove(&target);
        self.event("block_confirmed", json!({ "target": target }));
    }

    /// Clears the reports for an address (false report) and removes it from the blocklist.
    pub fn dismiss_report(&mut self, target: AccountId) {
        self.assert_owner();
        self.reports.remove(&target);
        self.blocklist.remove(&target);
        self.event("report_dismissed", json!({ "target": target }));
    }

    pub fn allowlist_add(&mut self, account: AccountId) {
        self.assert_owner();
        require!(!self.blocklist.contains(&account), "address is on the blocklist");
        self.allowlist.insert(account);
    }

    pub fn allowlist_remove(&mut self, account: AccountId) {
        self.assert_owner();
        self.allowlist.remove(&account);
    }

    pub fn set_limits(&mut self, per_tx_limit: U128, daily_limit: U128) {
        self.assert_owner();
        require!(per_tx_limit.0 <= daily_limit.0, "per-tx limit cannot exceed the daily limit");
        self.per_tx_limit = per_tx_limit.0;
        self.daily_limit = daily_limit.0;
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        self.event(if paused { "paused" } else { "resumed" }, json!({}));
    }

    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 <= self.available_balance(), "amount exceeds the available balance");
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ---------------------------------------------------------------- views

    pub fn policy(&self) -> PolicyView {
        PolicyView {
            owner: self.owner.clone(),
            paused: self.paused,
            per_tx_limit: U128(self.per_tx_limit),
            daily_limit: U128(self.daily_limit),
            spent_today: U128(if self.day_index == env::block_timestamp_ms() / MS_PER_DAY { self.spent_today } else { 0 }),
            allowlist: self.allowlist.iter().cloned().collect(),
            pending_count: self.pending.len() as u64,
            blocklist_count: self.blocklist.len() as u64,
            available_balance: U128(self.available_balance()),
        }
    }

    pub fn get_pending(&self) -> Vec<Pending> {
        self.pending.values().cloned().collect()
    }

    pub fn get_blocklist(&self) -> Vec<AccountId> {
        self.blocklist.iter().cloned().collect()
    }

    pub fn is_blocked(&self, account: AccountId) -> bool {
        self.blocklist.contains(&account)
    }

    pub fn get_reports(&self, account: AccountId) -> Vec<Report> {
        self.reports.get(&account).cloned().unwrap_or_default()
    }

    pub fn receiver_stats(&self, account: AccountId) -> ReceiverStats {
        self.stats.get(&account).cloned().unwrap_or_default()
    }

    pub fn get_attempts(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Attempt> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(MAX_VIEW_LIMIT).min(MAX_VIEW_LIMIT);
        (from..(self.attempts.len() as u64).min(from.saturating_add(limit)))
            .filter_map(|i| self.attempts.get(i as u32).cloned())
            .collect()
    }

    /// Callback after every payout. If the transfer failed (for example the receiver account does
    /// not exist) the NEAR came back to the vault, so the limit and the stats are rolled back.
    #[private]
    pub fn on_paid(&mut self, receiver: AccountId, amount: U128, day_index: u64, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_ok() {
            return;
        }
        if self.day_index == day_index {
            self.spent_today = self.spent_today.saturating_sub(amount.0);
        }
        if let Some(mut s) = self.stats.get(&receiver).cloned() {
            s.paid_count = s.paid_count.saturating_sub(1);
            s.total_paid = U128(s.total_paid.0.saturating_sub(amount.0));
            self.stats.insert(receiver.clone(), s);
        }
        self.event("payment_failed", json!({ "receiver": receiver, "amount": amount.0.to_string() }));
    }

    /// What verdict would this payment get right now? Used by the off-chain risk service.
    pub fn preview_payment(&self, receiver: AccountId, amount: U128) -> Outcome {
        let (verdict, reason) = self.evaluate(&receiver, amount.0);
        Outcome { verdict, reason, pending_id: None }
    }
}

impl Vault {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can call this method");
    }

    /// Only the vault's own keys (the agent's function-call key) may request payments.
    fn assert_vault_key(&self) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "request_payment must be signed by the vault's agent key"
        );
    }

    fn available_balance(&self) -> u128 {
        let reserved = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        env::account_balance().as_yoctonear().saturating_sub(reserved)
    }

    fn roll_day(&mut self) {
        let day = env::block_timestamp_ms() / MS_PER_DAY;
        if day != self.day_index {
            self.day_index = day;
            self.spent_today = 0;
        }
    }

    fn evaluate(&self, receiver: &AccountId, amount: u128) -> (Verdict, String) {
        let spent = if self.day_index == env::block_timestamp_ms() / MS_PER_DAY { self.spent_today } else { 0 };
        if self.paused {
            return (Verdict::Block, "the vault is paused".into());
        }
        if self.blocklist.contains(receiver) {
            return (Verdict::Block, "receiver is on the confirmed blocklist".into());
        }
        if amount == 0 {
            return (Verdict::Block, "amount must be greater than zero".into());
        }
        if amount > self.per_tx_limit {
            return (Verdict::Block, "amount is over the per-transaction limit".into());
        }
        if spent.saturating_add(amount) > self.daily_limit {
            return (Verdict::Block, "amount would exceed the daily limit".into());
        }
        if amount > self.available_balance() {
            return (Verdict::Block, "insufficient vault balance".into());
        }
        if let Some(r) = self.reports.get(receiver) {
            if !r.is_empty() {
                return (Verdict::Warn, format!("receiver has {} unconfirmed report(s)", r.len()));
            }
        }
        if self.allowlist.contains(receiver) {
            (Verdict::Allow, "receiver is allowlisted and within limits".into())
        } else {
            (Verdict::Warn, "receiver is not on the allowlist".into())
        }
    }

    fn pay(&mut self, receiver: &AccountId, amount: u128, now: u64) {
        self.spent_today += amount;
        let mut s = self.stats.get(receiver).cloned().unwrap_or_default();
        s.paid_count += 1;
        s.total_paid = U128(s.total_paid.0 + amount);
        s.last_paid_ms = now;
        self.stats.insert(receiver.clone(), s);
        let _ = Promise::new(receiver.clone()).transfer(NearToken::from_yoctonear(amount)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_paid(receiver.clone(), U128(amount), self.day_index),
        );
    }

    fn log_attempt(&mut self, receiver: &AccountId, amount: U128, verdict: Verdict, reason: &str, at_ms: u64) {
        let index = self.attempts.len() as u64;
        self.attempts.push(Attempt { index, receiver: receiver.clone(), amount, verdict, reason: reason.to_string(), at_ms });
    }

    fn event(&self, name: &str, data: near_sdk::serde_json::Value) {
        env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "thriveeshield", "version": "1.0.0", "event": name, "data": data })));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    fn id(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str, ms: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(id("vault.testnet"))
            .predecessor_account_id(id(predecessor))
            .signer_account_id(id(predecessor))
            .account_balance(NearToken::from_near(100))
            .block_timestamp(ms * 1_000_000);
        b
    }

    fn setup() -> Vault {
        testing_env!(ctx("owner.testnet", 1_000).build());
        let mut v = Vault::new(id("owner.testnet"), U128(2 * NEAR), U128(5 * NEAR));
        v.allowlist_add(id("friend.testnet"));
        v
    }

    fn as_agent(ms: u64) {
        testing_env!(ctx("vault.testnet", ms).build());
    }

    fn as_owner(ms: u64) {
        testing_env!(ctx("owner.testnet", ms).build());
    }

    fn as_other(who: &str, ms: u64) {
        testing_env!(ctx(who, ms).build());
    }

    #[test]
    fn allow_pays_an_allowlisted_receiver() {
        let mut v = setup();
        as_agent(2_000);
        let o = v.request_payment(id("friend.testnet"), U128(NEAR), None, None);
        assert_eq!(o.verdict, Verdict::Allow);
        assert!(!get_created_receipts().is_empty());
        assert_eq!(v.receiver_stats(id("friend.testnet")).paid_count, 1);
        assert_eq!(v.policy().spent_today.0, NEAR);
    }

    #[test]
    fn warn_holds_an_unknown_receiver_as_pending() {
        let mut v = setup();
        as_agent(2_000);
        let o = v.request_payment(id("stranger.testnet"), U128(NEAR), Some("invoice 7".into()), None);
        assert_eq!(o.verdict, Verdict::Warn);
        assert_eq!(o.pending_id, Some(1));
        assert!(get_created_receipts().is_empty(), "no funds may move on WARN");
        assert_eq!(v.get_pending().len(), 1);
    }

    #[test]
    fn owner_can_approve_a_pending_payment() {
        let mut v = setup();
        as_agent(2_000);
        v.request_payment(id("stranger.testnet"), U128(NEAR), None, None);
        as_owner(3_000);
        let o = v.approve_pending(1);
        assert_eq!(o.verdict, Verdict::Allow);
        assert!(!get_created_receipts().is_empty());
        assert!(v.get_pending().is_empty());
        assert_eq!(v.receiver_stats(id("stranger.testnet")).paid_count, 1);
    }

    #[test]
    fn owner_can_reject_a_pending_payment() {
        let mut v = setup();
        as_agent(2_000);
        v.request_payment(id("stranger.testnet"), U128(NEAR), None, None);
        as_owner(3_000);
        v.reject_pending(1);
        assert!(get_created_receipts().is_empty());
        assert!(v.get_pending().is_empty());
    }

    #[test]
    fn one_report_only_raises_warn_even_for_an_allowlisted_receiver() {
        let mut v = setup();
        as_other("watcher.testnet", 2_000);
        v.report_address(id("friend.testnet"), "tx 123 drained a wallet".into());
        as_agent(3_000);
        let o = v.request_payment(id("friend.testnet"), U128(NEAR), None, None);
        assert_eq!(o.verdict, Verdict::Warn);
        assert!(!v.is_blocked(id("friend.testnet")));
    }

    #[test]
    fn confirmed_report_blocks_and_logs_the_attempt() {
        let mut v = setup();
        as_other("watcher.testnet", 2_000);
        v.report_address(id("scam.testnet"), "phishing, see tx abc".into());
        as_owner(3_000);
        v.confirm_report(id("scam.testnet"));
        as_agent(4_000);
        let o = v.request_payment(id("scam.testnet"), U128(NEAR), None, None);
        assert_eq!(o.verdict, Verdict::Block);
        assert!(get_created_receipts().is_empty());
        let log = v.get_attempts(None, None);
        assert_eq!(log.last().unwrap().verdict, Verdict::Block);
        assert_eq!(log.last().unwrap().receiver, id("scam.testnet"));
        assert!(get_logs().iter().any(|l| l.contains("\"blocked\"")));
    }

    #[test]
    fn owner_cannot_approve_a_pending_payment_after_the_receiver_was_blocked() {
        let mut v = setup();
        as_agent(2_000);
        v.request_payment(id("late.testnet"), U128(NEAR), None, None);
        as_other("watcher.testnet", 2_500);
        v.report_address(id("late.testnet"), "rug".into());
        as_owner(3_000);
        v.confirm_report(id("late.testnet"));
        let o = v.approve_pending(1);
        assert_eq!(o.verdict, Verdict::Block);
        assert!(get_created_receipts().is_empty());
    }

    #[test]
    fn per_tx_limit_blocks() {
        let mut v = setup();
        as_agent(2_000);
        let o = v.request_payment(id("friend.testnet"), U128(3 * NEAR), None, None);
        assert_eq!(o.verdict, Verdict::Block);
        assert!(o.reason.contains("per-transaction"));
    }

    #[test]
    fn daily_limit_blocks_and_resets_the_next_day() {
        let mut v = setup();
        as_agent(2_000);
        for _ in 0..2 {
            assert_eq!(v.request_payment(id("friend.testnet"), U128(2 * NEAR), None, None).verdict, Verdict::Allow);
        }
        assert_eq!(v.request_payment(id("friend.testnet"), U128(NEAR), None, None).verdict, Verdict::Allow);
        let o = v.request_payment(id("friend.testnet"), U128(NEAR), None, None);
        assert_eq!(o.verdict, Verdict::Block);
        assert!(o.reason.contains("daily"));
        as_agent(2_000 + MS_PER_DAY);
        assert_eq!(v.request_payment(id("friend.testnet"), U128(NEAR), None, None).verdict, Verdict::Allow);
    }

    #[test]
    fn paused_vault_blocks_everything() {
        let mut v = setup();
        as_owner(2_000);
        v.set_paused(true);
        as_agent(3_000);
        assert_eq!(v.request_payment(id("friend.testnet"), U128(NEAR), None, None).verdict, Verdict::Block);
    }

    #[test]
    fn insufficient_balance_blocks() {
        let mut v = setup();
        testing_env!(ctx("vault.testnet", 2_000).account_balance(NearToken::from_millinear(1)).build());
        assert_eq!(v.request_payment(id("friend.testnet"), U128(NEAR), None, None).verdict, Verdict::Block);
    }

    #[test]
    #[should_panic(expected = "request_payment must be signed by the vault's agent key")]
    fn the_owner_account_cannot_use_the_agent_method() {
        let mut v = setup();
        as_owner(2_000);
        v.request_payment(id("friend.testnet"), U128(NEAR), None, None);
    }

    #[test]
    #[should_panic(expected = "request_payment must be signed by the vault's agent key")]
    fn a_stranger_cannot_use_the_agent_method() {
        let mut v = setup();
        as_other("mallory.testnet", 2_000);
        v.request_payment(id("mallory.testnet"), U128(NEAR), None, None);
    }

    #[test]
    #[should_panic(expected = "only the owner can call this method")]
    fn agent_key_cannot_approve_pending() {
        let mut v = setup();
        as_agent(2_000);
        v.request_payment(id("stranger.testnet"), U128(NEAR), None, None);
        v.approve_pending(1);
    }

    #[test]
    #[should_panic(expected = "only the owner can call this method")]
    fn agent_key_cannot_withdraw() {
        let mut v = setup();
        as_agent(2_000);
        let _ = v.withdraw(U128(NEAR));
    }

    #[test]
    #[should_panic(expected = "only the owner can call this method")]
    fn agent_key_cannot_confirm_a_report() {
        let mut v = setup();
        as_other("watcher.testnet", 2_000);
        v.report_address(id("scam.testnet"), "x".into());
        as_agent(3_000);
        v.confirm_report(id("scam.testnet"));
    }

    #[test]
    #[should_panic(expected = "already reported")]
    fn the_same_reporter_cannot_report_twice() {
        let mut v = setup();
        as_other("watcher.testnet", 2_000);
        v.report_address(id("scam.testnet"), "first".into());
        v.report_address(id("scam.testnet"), "second".into());
    }

    #[test]
    #[should_panic(expected = "evidence is required")]
    fn a_report_needs_evidence() {
        let mut v = setup();
        as_other("watcher.testnet", 2_000);
        v.report_address(id("scam.testnet"), "   ".into());
    }

    #[test]
    #[should_panic(expected = "no reports for this address")]
    fn confirm_needs_a_prior_report() {
        let mut v = setup();
        as_owner(2_000);
        v.confirm_report(id("scam.testnet"));
    }

    #[test]
    fn dismissing_a_report_clears_the_block() {
        let mut v = setup();
        as_other("watcher.testnet", 2_000);
        v.report_address(id("friend.testnet"), "mistaken".into());
        as_owner(3_000);
        v.confirm_report(id("friend.testnet"));
        assert!(v.is_blocked(id("friend.testnet")));
        v.dismiss_report(id("friend.testnet"));
        assert!(!v.is_blocked(id("friend.testnet")));
        assert!(v.get_reports(id("friend.testnet")).is_empty());
    }

    #[test]
    fn preview_matches_the_real_verdict_and_changes_nothing() {
        let v = setup();
        as_agent(2_000);
        assert_eq!(v.preview_payment(id("friend.testnet"), U128(NEAR)).verdict, Verdict::Allow);
        assert_eq!(v.preview_payment(id("stranger.testnet"), U128(NEAR)).verdict, Verdict::Warn);
        assert!(v.get_attempts(None, None).is_empty());
    }

    #[test]
    fn hold_flag_turns_an_allow_into_a_pending_payment() {
        let mut v = setup();
        as_agent(2_000);
        let o = v.request_payment(id("friend.testnet"), U128(NEAR), None, Some(true));
        assert_eq!(o.verdict, Verdict::Warn);
        assert_eq!(o.pending_id, Some(1));
        assert!(get_created_receipts().is_empty());
    }

    #[test]
    fn hold_flag_cannot_soften_a_block() {
        let mut v = setup();
        as_agent(2_000);
        let o = v.request_payment(id("friend.testnet"), U128(3 * NEAR), None, Some(false));
        assert_eq!(o.verdict, Verdict::Block);
    }

    #[test]
    fn pending_queue_is_capped() {
        let mut v = setup();
        as_agent(2_000);
        for _ in 0..MAX_PENDING {
            assert_eq!(v.request_payment(id("stranger.testnet"), U128(1), None, None).verdict, Verdict::Warn);
        }
        let o = v.request_payment(id("stranger.testnet"), U128(1), None, None);
        assert_eq!(o.verdict, Verdict::Block);
        assert!(o.reason.contains("pending queue is full"));
        assert_eq!(v.get_pending().len() as u32, MAX_PENDING);
    }

    #[test]
    #[should_panic(expected = "cannot approve now: amount would exceed the daily limit")]
    fn approving_over_the_daily_limit_fails_and_keeps_the_payment_pending() {
        let mut v = setup();
        as_agent(2_000);
        v.request_payment(id("stranger.testnet"), U128(2 * NEAR), None, None);
        for _ in 0..2 {
            v.request_payment(id("friend.testnet"), U128(2 * NEAR), None, None);
        }
        as_owner(3_000);
        v.approve_pending(1);
    }

    #[test]
    fn a_failed_transfer_rolls_back_the_limit_and_the_stats() {
        let mut v = setup();
        as_agent(2_000);
        v.request_payment(id("friend.testnet"), U128(NEAR), None, None);
        assert_eq!(v.policy().spent_today.0, NEAR);
        let day = 2_000 / MS_PER_DAY;
        v.on_paid(id("friend.testnet"), U128(NEAR), day, Err(PromiseError::Failed));
        assert_eq!(v.policy().spent_today.0, 0);
        assert_eq!(v.receiver_stats(id("friend.testnet")).paid_count, 0);
        assert!(get_logs().iter().any(|l| l.contains("payment_failed")));
    }

    #[test]
    fn a_successful_transfer_callback_changes_nothing() {
        let mut v = setup();
        as_agent(2_000);
        v.request_payment(id("friend.testnet"), U128(NEAR), None, None);
        v.on_paid(id("friend.testnet"), U128(NEAR), 2_000 / MS_PER_DAY, Ok(()));
        assert_eq!(v.policy().spent_today.0, NEAR);
        assert_eq!(v.receiver_stats(id("friend.testnet")).paid_count, 1);
    }

    #[test]
    fn owner_can_withdraw() {
        let mut v = setup();
        as_owner(2_000);
        let _ = v.withdraw(U128(NEAR));
        assert_eq!(get_created_receipts().len(), 1);
    }

    #[test]
    #[should_panic(expected = "per-tx limit cannot exceed the daily limit")]
    fn limits_must_be_consistent() {
        testing_env!(ctx("owner.testnet", 1_000).build());
        Vault::new(id("owner.testnet"), U128(6 * NEAR), U128(5 * NEAR));
    }
}
