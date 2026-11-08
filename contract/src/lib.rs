//! agent-allowance — a NEAR contract that holds an AI agent's Base address and
//! signs its USDC payments only within a budget, through Chain Signatures.
//!
//! The Base address is derived from THIS contract's account id and a path, so
//! the only thing that can get a payment from it signed is this contract. The
//! agent holds a NEAR key that may call `pay`, nothing more: it sends the
//! payment's terms, and the contract rebuilds the EIP-3009
//! `transferWithAuthorization` digest itself — the agent cannot slip a different
//! payment past the checks — then enforces the policy before asking `v1.signer`
//! to sign:
//!
//!   - the payee is on the owner's list
//!   - the amount is at most `per_payment_max`
//!   - the day's total stays within `daily_limit` (a failed signature gives it back)
//!   - the authorization expires within an hour, so no long-lived signature exists
//!
//! A leaked agent key therefore costs at most one day's budget, paid only to
//! sellers the owner chose — and the owner can pause the contract or swap the
//! agent account at any time. The owner can also move funds without the limits
//! (`owner_pay`), so nothing is ever stuck.
//!
//! Three more rules for when something looks wrong (2026-11-07):
//!
//!   - A payment that is unusual but plausible (a listed payee, over the per-payment
//!     cap or the day's budget, up to `approval_max`) isn't refused, it waits. Nothing
//!     is signed until the owner calls `approve`. The agent reads the signature back
//!     from `get_held`.
//!   - A payment to a payee added less than `payee_delay_s` ago waits for the owner too,
//!     however small. A seller added by mistake (or at a hijacked agent's request) gets
//!     nothing the owner didn't see. Until 2026-11-09 these were refused outright for a
//!     day; holding them lets the owner say yes at once instead of waiting it out.
//!   - `revoke` cuts the agent off in one call and refuses everything waiting.
//!
//! Every decision goes in a short on-chain history (`get_history`), so what the agent
//! tried can be read from the contract with no indexer, including what was refused.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{env, near, require, AccountId, Gas, GasWeight, NearToken, PanicOnDefault, PromiseError};

/// Gas kept back for `on_signed`; all the rest of what is attached goes to the MPC (by weight).
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const DAY_NS: u64 = 86_400 * 1_000_000_000;
/// Longest an authorization may stay valid. The signature is a bearer
/// instrument until `validBefore`; an hour is plenty for an x402 round trip.
pub const MAX_VALIDITY_S: u64 = 3_600;
/// Payments waiting for the owner at once. A stolen agent key can fill this and no more.
const MOST_WAITING: usize = 10;
/// Decided payments kept for the agent to read back, oldest dropped first.
const MOST_HELD: usize = 30;
/// Decisions kept in `get_history`, oldest dropped first.
const MOST_HISTORY: usize = 40;

#[near(serializers = [json])]
pub struct Policy {
    pub owner: AccountId,
    pub agent: AccountId,
    pub signer: AccountId,
    pub path: String,
    pub from: String,
    pub per_payment_max: U128,
    pub daily_limit: U128,
    pub spent_today: U128,
    pub paused: bool,
    pub payees: Vec<String>,
    pub approval_max: U128,
    pub payee_delay_s: U64,
    /// Payees added but not payable yet, with when they become payable (seconds).
    pub waiting_payees: Vec<(String, U64)>,
}

/// A payment waiting for the owner, or the record of what they decided.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Held {
    pub id: U64,
    pub to: String,
    pub value: U128,
    pub valid_after: U64,
    pub valid_before: U64,
    pub nonce: String,
    pub why: String,
    pub asked_at: U64,
    /// waiting, signing, signed, rejected
    pub status: String,
    /// The MPC's answer as JSON, once signed.
    pub signature: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Entry {
    pub at: U64,
    /// signed, held, refused, approved, rejected, sign_failed, revoked, payee_added, payee_removed, limits_changed, paused, resumed
    pub what: String,
    pub to: String,
    pub value: U128,
    pub note: String,
}

enum Verdict {
    Sign,
    Hold(&'static str),
    Refuse(&'static str),
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Allowance {
    owner: AccountId,
    agent: AccountId,
    /// `v1.signer` on mainnet, `v1.signer-prod.testnet` on testnet.
    signer: AccountId,
    path: String,
    /// The Base address this contract controls (derived offline for this account + path).
    from: [u8; 20],
    domain_separator: [u8; 32],
    per_payment_max: u128,
    daily_limit: u128,
    spent_day: u64,
    spent_today: u128,
    paused: bool,
    /// Allowed payees: lowercase hex, no 0x.
    payees: IterableSet<String>,
    approval_max: u128,
    payee_delay_s: u64,
    /// When a payee added later becomes payable (seconds). No entry: payable since the start.
    payee_ready: LookupMap<String, u64>,
    held: IterableMap<u64, Held>,
    next_held: u64,
    history: Vec<Entry>,
}

/// The contract as deployed before `migrate`.
#[near(serializers = [borsh])]
struct AllowanceV1 {
    owner: AccountId,
    agent: AccountId,
    signer: AccountId,
    path: String,
    from: [u8; 20],
    domain_separator: [u8; 32],
    per_payment_max: u128,
    daily_limit: u128,
    spent_day: u64,
    spent_today: u128,
    paused: bool,
    payees: IterableSet<String>,
}

#[near]
impl Allowance {
    /// `token` defaults to native USDC on Base (chain 8453), with its EIP-712 domain {name: "USD Coin", version: "2"}.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        signer: AccountId,
        path: String,
        from: String,
        per_payment_max: U128,
        daily_limit: U128,
        payees: Vec<String>,
        chain_id: Option<U64>,
        token: Option<String>,
        token_name: Option<String>,
        token_version: Option<String>,
        approval_max: Option<U128>,
        payee_delay_s: Option<U64>,
    ) -> Self {
        require!(per_payment_max.0 > 0 && per_payment_max.0 <= daily_limit.0, "per_payment_max must be 1..=daily_limit");
        let mut set = IterableSet::new(b"p");
        for p in payees {
            set.insert(hex20(&p).1);
        }
        Self {
            owner,
            agent,
            signer,
            path,
            from: hex20(&from).0,
            domain_separator: domain_separator(
                token_name.as_deref().unwrap_or("USD Coin"),
                token_version.as_deref().unwrap_or("2"),
                chain_id.map(|c| c.0).unwrap_or(8453),
                &hex20(token.as_deref().unwrap_or("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).0,
            ),
            per_payment_max: per_payment_max.0,
            daily_limit: daily_limit.0,
            spent_day: 0,
            spent_today: 0,
            paused: false,
            payees: set,
            approval_max: approval_max.map(|v| v.0).unwrap_or(1_000_000).max(daily_limit.0),
            payee_delay_s: payee_delay_s.map(|v| v.0).unwrap_or(86_400),
            payee_ready: LookupMap::new(b"r"),
            held: IterableMap::new(b"h"),
            next_held: 1,
            history: Vec::new(),
        }
    }

    /// Moves a contract deployed before these rules onto them. Same account, so the same Base address.
    /// Everyone already on the payee list stays payable.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(approval_max: U128, payee_delay_s: U64) -> Self {
        let old: AllowanceV1 = env::state_read().unwrap_or_else(|| env::panic_str("nothing to migrate"));
        require!(approval_max.0 >= old.daily_limit, "approval_max must be at least the daily limit");
        Self {
            owner: old.owner,
            agent: old.agent,
            signer: old.signer,
            path: old.path,
            from: old.from,
            domain_separator: old.domain_separator,
            per_payment_max: old.per_payment_max,
            daily_limit: old.daily_limit,
            spent_day: old.spent_day,
            spent_today: old.spent_today,
            paused: old.paused,
            payees: old.payees,
            approval_max: approval_max.0,
            payee_delay_s: payee_delay_s.0,
            payee_ready: LookupMap::new(b"r"),
            held: IterableMap::new(b"h"),
            next_held: 1,
            history: Vec::new(),
        }
    }

    /// The agent's one power: ask for a payment. Inside the rules it's signed; unusual, it waits for the owner;
    /// anything else is refused and written down. Answers {"held": id} or {"refused": why} when there's no signature.
    /// Attach 300 TGas. A deposit is optional: a key limited to this one method can't attach one.
    #[payable]
    pub fn pay(&mut self, to: String, value: U128, valid_after: U64, valid_before: U64, nonce: String) {
        let (to_bytes, to_key) = hex20(&to);
        let caller = env::predecessor_account_id();
        let nonce_bytes = hex32(&nonce);
        match self.verdict(&caller, &to, value.0, valid_after.0, valid_before.0) {
            Verdict::Refuse(why) => {
                // Only the agent's attempts are worth keeping: anyone at all can call this, and must not be able to wash the history out.
                if caller == self.agent {
                    self.record("refused", &to_key, value.0, why);
                }
                env::value_return(json!({ "refused": why }).to_string().as_bytes());
            }
            Verdict::Hold(why) => {
                let waiting = self.held.values().filter(|h| h.status == "waiting").count();
                if waiting >= MOST_WAITING {
                    let why = "too many payments are waiting for the owner";
                    self.record("refused", &to_key, value.0, why);
                    env::value_return(json!({ "refused": why }).to_string().as_bytes());
                    return;
                }
                let id = self.next_held;
                self.next_held += 1;
                self.held.insert(id, Held { id: U64(id), to: to_key.clone(), value, valid_after, valid_before, nonce, why: why.to_string(), asked_at: U64(now_s()), status: "waiting".to_string(), signature: None });
                self.prune_held();
                self.record("held", &to_key, value.0, why);
                env::value_return(json!({ "held": U64(id) }).to_string().as_bytes());
            }
            Verdict::Sign => {
                self.roll_day();
                // Counted now, before the signature exists; given back if signing fails (on_signed).
                self.spent_today += value.0;
                self.record("signed", &to_key, value.0, "");
                let digest = self.digest(&to_bytes, value.0, valid_after.0, valid_before.0, &nonce_bytes);
                self.request_signature(digest, value.0)
            }
        }
    }

    /// The owner says yes to a waiting payment. The 1 yoctoNEAR means a limited key can't do it, only a full-access one.
    /// It doesn't count against the agent's budget: it's the owner's own decision.
    #[payable]
    pub fn approve(&mut self, id: U64) {
        self.only_owner();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach at least 1 yoctoNEAR");
        let mut h = self.held.get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such payment"));
        require!(h.status == "waiting", "that payment isn't waiting");
        require!(h.valid_before.0 > now_s(), "that payment's authorization has expired");
        let digest = self.digest(&hex20(&h.to).0, h.value.0, h.valid_after.0, h.valid_before.0, &hex32(&h.nonce));
        h.status = "signing".to_string();
        self.record("approved", &h.to, h.value.0, "");
        self.held.insert(id.0, h);
        self.request_held_signature(digest, id.0)
    }

    #[payable]
    pub fn reject(&mut self, id: U64) {
        self.only_owner();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach at least 1 yoctoNEAR");
        let mut h = self.held.get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such payment"));
        require!(h.status == "waiting", "that payment isn't waiting");
        h.status = "rejected".to_string();
        self.record("rejected", &h.to, h.value.0, "");
        self.held.insert(id.0, h);
    }

    /// Cuts the agent off in one call: nobody can pay, and everything waiting is refused.
    /// To carry on: `set_agent` with a new account, then `set_paused(false)`.
    #[payable]
    pub fn revoke(&mut self) {
        self.only_owner();
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach at least 1 yoctoNEAR");
        self.paused = true;
        // This contract never calls itself as the agent, so nobody can pay as this account.
        self.agent = env::current_account_id();
        let waiting: Vec<u64> = self.held.iter().filter(|(_, h)| h.status == "waiting").map(|(k, _)| *k).collect();
        for id in waiting {
            if let Some(h) = self.held.get_mut(&id) {
                h.status = "rejected".to_string();
            }
        }
        self.record("revoked", "", 0, "");
    }

    /// The owner moves funds out without the agent's limits (any payee, any amount).
    #[payable]
    pub fn owner_pay(&mut self, to: String, value: U128, valid_after: U64, valid_before: U64, nonce: String) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        let digest = self.digest(&hex20(&to).0, value.0, valid_after.0, valid_before.0, &hex32(&nonce));
        self.request_signature(digest, 0)
    }

    #[private]
    pub fn on_held_signed(&mut self, #[callback_result] result: Result<Value, PromiseError>, id: U64) {
        let Some(mut h) = self.held.get(&id.0).cloned() else { return };
        match result {
            Ok(sig) => {
                h.status = "signed".to_string();
                h.signature = Some(sig.to_string());
            }
            Err(_) => {
                // The owner said yes and the network didn't answer: it waits again, for another try.
                h.status = "waiting".to_string();
                self.record("sign_failed", &h.to, h.value.0, "");
            }
        }
        self.held.insert(id.0, h);
    }

    #[private]
    pub fn on_signed(&mut self, #[callback_result] result: Result<Value, PromiseError>, day: U64, value: U128) -> Option<Value> {
        match result {
            Ok(sig) => Some(sig),
            Err(_) => {
                // No signature, no payment: the budget goes back (same day only).
                if day.0 == self.spent_day {
                    self.spent_today = self.spent_today.saturating_sub(value.0);
                }
                self.record("sign_failed", "", value.0, "");
                None
            }
        }
    }

    // ── owner ────────────────────────────────────────────────────────────────

    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.only_owner();
        self.paused = paused;
        self.record(if paused { "paused" } else { "resumed" }, "", 0, "");
    }
    /// Rotate the agent account — e.g. after its key may have leaked.
    #[payable]
    pub fn set_agent(&mut self, agent: AccountId) {
        self.only_owner();
        self.agent = agent;
    }
    #[payable]
    pub fn set_limits(&mut self, per_payment_max: U128, daily_limit: U128) {
        self.only_owner();
        require!(per_payment_max.0 > 0 && per_payment_max.0 <= daily_limit.0, "per_payment_max must be 1..=daily_limit");
        require!(daily_limit.0 <= self.approval_max, "daily_limit can't pass approval_max");
        self.per_payment_max = per_payment_max.0;
        self.daily_limit = daily_limit.0;
        self.record("limits_changed", "", 0, "");
    }
    #[payable]
    pub fn add_payee(&mut self, payee: String) {
        self.only_owner();
        let key = hex20(&payee).1;
        // Already payable stays payable: only someone new has to wait.
        if self.payees.insert(key.clone()) {
            self.payee_ready.insert(key.clone(), now_s() + self.payee_delay_s);
            self.record("payee_added", &key, 0, "");
        }
    }
    #[payable]
    pub fn remove_payee(&mut self, payee: String) {
        self.only_owner();
        let key = hex20(&payee).1;
        self.payees.remove(&key);
        self.payee_ready.remove(&key);
        self.record("payee_removed", &key, 0, "");
    }

    // ── views ────────────────────────────────────────────────────────────────

    pub fn get_policy(&self) -> Policy {
        let today = env::block_timestamp() / DAY_NS;
        Policy {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            signer: self.signer.clone(),
            path: self.path.clone(),
            from: format!("0x{}", hex::encode(self.from)),
            per_payment_max: U128(self.per_payment_max),
            daily_limit: U128(self.daily_limit),
            spent_today: U128(if self.spent_day == today { self.spent_today } else { 0 }),
            paused: self.paused,
            payees: self.payees.iter().map(|p| format!("0x{p}")).collect(),
            approval_max: U128(self.approval_max),
            payee_delay_s: U64(self.payee_delay_s),
            waiting_payees: self.payees.iter().filter_map(|p| self.payee_ready.get(p).filter(|at| **at > now_s()).map(|at| (format!("0x{p}"), U64(*at)))).collect(),
        }
    }

    /// Newest first.
    pub fn get_history(&self) -> Vec<Entry> {
        self.history.iter().rev().cloned().collect()
    }

    pub fn get_held(&self, id: U64) -> Option<Held> {
        self.held.get(&id.0).cloned()
    }

    /// Newest first: what's waiting, and what was decided lately.
    pub fn list_held(&self) -> Vec<Held> {
        let mut all: Vec<Held> = self.held.values().cloned().collect();
        all.sort_by_key(|h| std::cmp::Reverse(h.id.0));
        all
    }

    /// The digest `pay` would ask the MPC to sign, so a client can check it matches its own.
    /// The same rules `pay` enforces, as a free view: None = it would be signed, else why not.
    /// Clients ask this first (2026-10-29), so a refused payment costs no gas and no
    /// transaction — it took 11.6 s on mainnet to learn a refusal from `pay` itself.
    /// A payment that would wait for the owner answers "held: why", so a client can tell it from a refusal.
    /// Advisory only: `pay` re-checks everything on chain.
    pub fn check(&self, agent: AccountId, to: String, value: U128, valid_after: U64, valid_before: U64) -> Option<String> {
        match self.verdict(&agent, &to, value.0, valid_after.0, valid_before.0) {
            Verdict::Sign => None,
            Verdict::Hold(why) => Some(format!("held: {why}")),
            Verdict::Refuse(why) => Some(why.to_string()),
        }
    }

    pub fn preview_digest(&self, to: String, value: U128, valid_after: U64, valid_before: U64, nonce: String) -> String {
        format!("0x{}", hex::encode(self.digest(&hex20(&to).0, value.0, valid_after.0, valid_before.0, &hex32(&nonce))))
    }
}

impl Allowance {
    /// Every owner call needs 1 yoctoNEAR attached. A web wallet's sign-in key is a function-call key, which can't
    /// attach a deposit, so a stolen browser session can't change the rules: the owner's wallet has to confirm each
    /// change (2026-11-08, before the site could edit rules).
    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach at least 1 yoctoNEAR");
    }

    /// Every rule of the policy, in one place for `pay` and `check`. Reads the day's spend
    /// as `roll_day` would leave it, without writing.
    fn verdict(&self, caller: &AccountId, to: &str, value: u128, valid_after: u64, valid_before: u64) -> Verdict {
        let now = now_s();
        let spent = if env::block_timestamp() / DAY_NS == self.spent_day { self.spent_today } else { 0 };
        let key = hex20(to).1;
        if self.paused {
            Verdict::Refuse("paused by the owner")
        } else if *caller != self.agent {
            Verdict::Refuse("only the agent account may pay")
        } else if !self.payees.contains(&key) {
            Verdict::Refuse("payee is not on the owner's list")
        } else if value == 0 {
            Verdict::Refuse("amount must be more than zero")
        } else if value > self.approval_max {
            Verdict::Refuse("amount is more than the owner can approve")
        } else if valid_before <= now || valid_before > now + MAX_VALIDITY_S {
            Verdict::Refuse("valid_before must be within the next hour")
        } else if valid_after >= valid_before {
            Verdict::Refuse("valid_after must be before valid_before")
        } else if self.payee_ready.get(&key).is_some_and(|at| *at > now) {
            Verdict::Hold("a new seller, still in its wait")
        } else if value > self.per_payment_max {
            Verdict::Hold("over the per-payment limit")
        } else if spent + value > self.daily_limit {
            Verdict::Hold("over the daily limit")
        } else {
            Verdict::Sign
        }
    }

    fn record(&mut self, what: &str, to: &str, value: u128, note: &str) {
        if self.history.len() >= MOST_HISTORY {
            self.history.remove(0);
        }
        let to = if to.is_empty() { String::new() } else { format!("0x{to}") };
        self.history.push(Entry { at: U64(now_s()), what: what.to_string(), to, value: U128(value), note: note.to_string() });
    }

    /// Drops the oldest decided payments once there are too many. Anything still waiting stays.
    fn prune_held(&mut self) {
        while self.held.len() as usize > MOST_HELD {
            let oldest = self.held.iter().filter(|(_, h)| h.status == "signed" || h.status == "rejected").map(|(k, _)| *k).min();
            match oldest {
                Some(id) => {
                    self.held.remove(&id);
                }
                None => break,
            }
        }
    }

    fn roll_day(&mut self) {
        let today = env::block_timestamp() / DAY_NS;
        if today != self.spent_day {
            self.spent_day = today;
            self.spent_today = 0;
        }
    }

    fn digest(&self, to: &[u8; 20], value: u128, valid_after: u64, valid_before: u64, nonce: &[u8; 32]) -> [u8; 32] {
        transfer_digest(&self.domain_separator, &self.from, to, value, valid_after, valid_before, nonce)
    }

    fn request_signature(&mut self, digest: [u8; 32], value: u128) {
        let callback_args = json!({ "day": U64(self.spent_day), "value": U128(value) });
        self.sign_then(digest, "on_signed", callback_args)
    }

    fn request_held_signature(&mut self, digest: [u8; 32], id: u64) {
        self.sign_then(digest, "on_held_signed", json!({ "id": U64(id) }))
    }

    fn sign_then(&mut self, digest: [u8; 32], callback_name: &str, callback_args: Value) {
        // The MPC's fee is 1 yoctoNEAR. The contract covers it if the caller attached nothing, because a key limited to
        // calling `pay` can't attach a deposit, and that limited key is the safest thing for an agent to hold.
        let fee = env::attached_deposit().max(NearToken::from_yoctonear(1));
        let args = json!({ "request": { "payload_v2": { "Ecdsa": hex::encode(digest) }, "path": self.path, "domain_id": 0 } });
        // Low-level promise calls on purpose (2026-10-29): near-sdk 5.30's `Promise` builder links
        // every action host function, including testnet-only ones (gas keys,
        // universal_state_init), and mainnet refused the wasm with "Link Error: unknown or
        // invalid import". These two calls link only what they use.
        let sign = env::promise_batch_create(&self.signer);
        // Static 0 + weight 1: the runtime hands the sign call every unused gas unit, after
        // the callback's fixed share — no hand arithmetic to get wrong.
        env::promise_batch_action_function_call_weight(sign, "sign", args.to_string().as_bytes(), fee, Gas::from_gas(0), GasWeight(1));
        let callback = env::promise_batch_then(sign, &env::current_account_id());
        env::promise_batch_action_function_call(callback, callback_name, callback_args.to_string().as_bytes(), NearToken::from_yoctonear(0), CALLBACK_GAS);
        env::promise_return(callback);
    }
}

fn now_s() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

// ── EIP-712, exactly as USDC's transferWithAuthorization verifies it ─────────

fn keccak(data: &[u8]) -> [u8; 32] {
    env::keccak256_array(data)
}

fn word_u(n: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&n.to_be_bytes());
    w
}

fn word_addr(a: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

pub fn domain_separator(name: &str, version: &str, chain_id: u64, token: &[u8; 20]) -> [u8; 32] {
    let mut enc = Vec::with_capacity(32 * 5);
    enc.extend(keccak(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
    enc.extend(keccak(name.as_bytes()));
    enc.extend(keccak(version.as_bytes()));
    enc.extend(word_u(chain_id as u128));
    enc.extend(word_addr(token));
    keccak(&enc)
}

pub fn transfer_digest(domain: &[u8; 32], from: &[u8; 20], to: &[u8; 20], value: u128, valid_after: u64, valid_before: u64, nonce: &[u8; 32]) -> [u8; 32] {
    let mut enc = Vec::with_capacity(32 * 7);
    enc.extend(keccak(b"TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"));
    enc.extend(word_addr(from));
    enc.extend(word_addr(to));
    enc.extend(word_u(value));
    enc.extend(word_u(valid_after as u128));
    enc.extend(word_u(valid_before as u128));
    enc.extend(nonce);
    let struct_hash = keccak(&enc);
    let mut msg = Vec::with_capacity(66);
    msg.extend([0x19, 0x01]);
    msg.extend(domain);
    msg.extend(struct_hash);
    keccak(&msg)
}

/// An EVM address as bytes and as the set's key (lowercase hex, no 0x). Panics on anything else.
fn hex20(s: &str) -> ([u8; 20], String) {
    let h = s.trim().trim_start_matches("0x").to_ascii_lowercase();
    let v = hex::decode(&h).unwrap_or_else(|_| env::panic_str("address is not hex"));
    require!(v.len() == 20, "address must be 20 bytes");
    let mut a = [0u8; 20];
    a.copy_from_slice(&v);
    (a, h)
}

fn hex32(s: &str) -> [u8; 32] {
    let v = hex::decode(s.trim().trim_start_matches("0x")).unwrap_or_else(|_| env::panic_str("nonce is not hex"));
    require!(v.len() == 32, "nonce must be 32 bytes");
    let mut a = [0u8; 32];
    a.copy_from_slice(&v);
    a
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const GLIANA: &str = "0x7662E00f8Ab4C362166e1FF649Ff6c2A638c80AD";
    const FROM: &str = "0xf46587a7eF3CBd1467686cA8Aa05Bc51a21E670c";
    const NONCE: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";

    fn ctx(predecessor: AccountId, now_s: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("allowance.near".parse().unwrap())
            .predecessor_account_id(predecessor)
            .block_timestamp(now_s * 1_000_000_000)
            .attached_deposit(NearToken::from_yoctonear(1))
            .prepaid_gas(Gas::from_tgas(300))
            .build());
    }

    fn contract() -> Allowance {
        ctx(accounts(0), 1_700_000_000);
        Allowance::new(accounts(0), accounts(1), "v1.signer".parse().unwrap(), "gliana-x402".into(), FROM.into(), U128(10_000), U128(25_000), vec![GLIANA.into()], None, None, None, None, Some(U128(1_000_000)), Some(U64(86_400)))
    }

    /// Reference values computed with viem's hashDomain / hashTypedData — the same
    /// code the TypeScript client signs with (src/x402-payer.ts).
    #[test]
    fn digest_matches_viem_byte_for_byte() {
        let c = contract();
        assert_eq!(hex::encode(c.domain_separator), "02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f");
        assert_eq!(
            c.preview_digest(GLIANA.into(), U128(2000), U64(1_700_000_000), U64(1_700_000_600), NONCE.into()),
            "0xbf43c46dcfa82556b2316d7f9e57d047cd6e46eb0bbf8e81dc9a20452f017531"
        );
    }

    #[test]
    fn the_agent_pays_within_the_policy_and_the_budget_is_counted() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        let _ = c.pay(GLIANA.into(), U128(2000), U64(1_699_999_940), U64(1_700_000_600), NONCE.into());
        assert_eq!(c.get_policy().spent_today, U128(2000));
    }

    /// The free view gives the same answer `pay` would, before any transaction.
    #[test]
    fn check_answers_like_pay_without_a_transaction() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        let ok = |c: &Allowance, to: &str, v: u128| c.check(accounts(1), to.into(), U128(v), U64(1_699_999_940), U64(1_700_000_600));
        assert_eq!(ok(&c, GLIANA, 2000), None);
        assert_eq!(ok(&c, "0x000000000000000000000000000000000000dEaD", 2000).as_deref(), Some("payee is not on the owner's list"));
        assert_eq!(ok(&c, GLIANA, 10_001).as_deref(), Some("held: over the per-payment limit"));
        assert_eq!(ok(&c, GLIANA, 1_000_001).as_deref(), Some("amount is more than the owner can approve"));
        assert_eq!(c.check(accounts(2), GLIANA.into(), U128(2000), U64(1_699_999_940), U64(1_700_000_600)).as_deref(), Some("only the agent account may pay"));
        assert_eq!(c.check(accounts(1), GLIANA.into(), U128(2000), U64(1_699_999_940), U64(1_700_000_000 + 7200)).as_deref(), Some("valid_before must be within the next hour"));
        let _ = c.pay(GLIANA.into(), U128(10_000), U64(1_699_999_940), U64(1_700_000_600), NONCE.into());
        let _ = c.pay(GLIANA.into(), U128(10_000), U64(1_699_999_940), U64(1_700_000_600), NONCE.into());
        assert_eq!(ok(&c, GLIANA, 10_000).as_deref(), Some("held: over the daily limit"));
        // The next day the spend reads as zero, though nothing has written the roll yet.
        ctx(accounts(1), 1_700_000_000 + 86_400);
        assert_eq!(c.check(accounts(1), GLIANA.into(), U128(10_000), U64(1_700_086_340), U64(1_700_087_000)), None);
    }

    const LATER: u64 = 1_700_000_600;
    fn ask(c: &mut Allowance, to: &str, value: u128) {
        c.pay(to.into(), U128(value), U64(1_699_999_940), U64(LATER), NONCE.into());
    }
    fn last(c: &Allowance) -> (String, String) {
        let h = c.get_history();
        (h[0].what.clone(), h[0].note.clone())
    }

    #[test]
    fn nobody_else_can_pay_and_cant_write_in_the_history() {
        let mut c = contract();
        ctx(accounts(2), 1_700_000_000);
        ask(&mut c, GLIANA, 2000);
        assert_eq!(c.get_policy().spent_today, U128(0));
        assert!(c.get_history().is_empty());
    }

    #[test]
    fn an_unlisted_payee_is_refused_and_written_down() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        ask(&mut c, "0x000000000000000000000000000000000000dEaD", 2000);
        assert_eq!(last(&c), ("refused".to_string(), "payee is not on the owner's list".to_string()));
        assert_eq!(c.get_policy().spent_today, U128(0));
        assert!(c.list_held().is_empty());
    }

    #[test]
    fn over_the_cap_waits_for_the_owner_and_nothing_is_counted() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        ask(&mut c, GLIANA, 10_001);
        let h = c.get_held(U64(1)).unwrap();
        assert_eq!(h.status, "waiting");
        assert_eq!(h.signature, None);
        assert_eq!(c.get_policy().spent_today, U128(0));
    }

    #[test]
    fn over_what_the_owner_can_approve_is_refused_outright() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        ask(&mut c, GLIANA, 1_000_001);
        assert_eq!(last(&c).0, "refused");
        assert!(c.list_held().is_empty());
    }

    #[test]
    fn the_day_cannot_exceed_the_budget_without_the_owner() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        for _ in 0..2 {
            ask(&mut c, GLIANA, 10_000);
        }
        ask(&mut c, GLIANA, 10_000);
        assert_eq!(c.get_policy().spent_today, U128(20_000));
        assert_eq!(c.get_held(U64(1)).unwrap().why, "over the daily limit");
    }

    #[test]
    fn approving_signs_it_and_the_agent_reads_the_signature_back() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        ask(&mut c, GLIANA, 20_000);
        ctx(accounts(0), 1_700_000_100);
        c.approve(U64(1));
        assert_eq!(c.get_held(U64(1)).unwrap().status, "signing");
        c.on_held_signed(Ok(json!({ "s": { "scalar": "ab" } })), U64(1));
        let h = c.get_held(U64(1)).unwrap();
        assert_eq!(h.status, "signed");
        assert!(h.signature.unwrap().contains("ab"));
        assert_eq!(c.get_policy().spent_today, U128(0));
    }

    #[test]
    fn a_failed_signature_goes_back_to_waiting() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        ask(&mut c, GLIANA, 20_000);
        ctx(accounts(0), 1_700_000_100);
        c.approve(U64(1));
        c.on_held_signed(Err(PromiseError::Failed), U64(1));
        assert_eq!(c.get_held(U64(1)).unwrap().status, "waiting");
    }

    #[test]
    #[should_panic(expected = "attach at least 1 yoctoNEAR")]
    fn a_rule_change_without_a_deposit_is_refused_even_from_the_owner() {
        // A web wallet's sign-in key can't attach a deposit: this is what stops a stolen browser session.
        let mut c = contract();
        testing_env!(VMContextBuilder::new()
            .current_account_id("allowance.near".parse().unwrap())
            .predecessor_account_id(accounts(0))
            .block_timestamp(1_700_000_000 * 1_000_000_000)
            .build());
        c.add_payee("0x2222222222222222222222222222222222222222".into());
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn the_agent_cannot_approve_its_own_payment() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        ask(&mut c, GLIANA, 20_000);
        c.approve(U64(1));
    }

    #[test]
    #[should_panic(expected = "authorization has expired")]
    fn an_expired_payment_cannot_be_approved() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        ask(&mut c, GLIANA, 20_000);
        ctx(accounts(0), LATER + 1);
        c.approve(U64(1));
    }

    #[test]
    #[should_panic(expected = "isn't waiting")]
    fn a_rejected_payment_stays_rejected() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        ask(&mut c, GLIANA, 20_000);
        ctx(accounts(0), 1_700_000_100);
        c.reject(U64(1));
        assert_eq!(c.get_held(U64(1)).unwrap().status, "rejected");
        c.approve(U64(1));
    }

    #[test]
    fn a_stolen_key_can_only_fill_the_queue_so_far() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        for _ in 0..(MOST_WAITING + 3) {
            ask(&mut c, GLIANA, 20_000);
        }
        assert_eq!(c.list_held().len(), MOST_WAITING);
        assert_eq!(last(&c).1, "too many payments are waiting for the owner");
    }

    #[test]
    fn a_new_payee_needs_the_owner_for_a_day_and_an_old_one_doesnt() {
        const NEW: &str = "0x1111111111111111111111111111111111111111";
        let mut c = contract();
        ctx(accounts(0), 1_700_000_000);
        c.add_payee(NEW.into());
        c.add_payee(GLIANA.into());
        assert_eq!(c.get_policy().waiting_payees.len(), 1);
        ctx(accounts(1), 1_700_000_000);
        ask(&mut c, NEW, 2000);
        assert_eq!(last(&c), ("held".to_string(), "a new seller, still in its wait".to_string()));
        assert_eq!(c.list_held()[0].status, "waiting");
        ask(&mut c, GLIANA, 2000);
        assert_eq!(last(&c).0, "signed");
        ctx(accounts(1), 1_700_000_000 + 86_401);
        assert_eq!(c.check(accounts(1), NEW.into(), U128(2000), U64(1_700_086_340), U64(1_700_087_000)), None);
        assert!(c.get_policy().waiting_payees.is_empty());
    }

    #[test]
    fn removing_and_adding_a_payee_back_restarts_its_wait() {
        let mut c = contract();
        ctx(accounts(0), 1_700_000_000);
        c.remove_payee(GLIANA.into());
        c.add_payee(GLIANA.into());
        assert_eq!(c.get_policy().waiting_payees.len(), 1);
    }

    #[test]
    fn revoking_cuts_the_agent_off_and_refuses_what_was_waiting() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        ask(&mut c, GLIANA, 20_000);
        ctx(accounts(0), 1_700_000_100);
        c.revoke();
        assert_eq!(c.get_held(U64(1)).unwrap().status, "rejected");
        ctx(accounts(1), 1_700_000_200);
        ask(&mut c, GLIANA, 2000);
        assert_eq!(c.get_policy().spent_today, U128(0));
        assert!(c.get_policy().paused);
        // Coming back takes a new agent as well as unpausing, so the leaked key stays useless.
        ctx(accounts(0), 1_700_000_300);
        c.set_paused(false);
        assert_eq!(c.check(accounts(1), GLIANA.into(), U128(2000), U64(1_700_000_000), U64(1_700_000_900)).as_deref(), Some("only the agent account may pay"));
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn the_agent_cannot_revoke_or_unrevoke() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        c.revoke();
    }

    #[test]
    fn a_key_that_cant_attach_a_deposit_can_still_ask() {
        let mut c = contract();
        testing_env!(VMContextBuilder::new()
            .current_account_id("allowance.near".parse().unwrap())
            .predecessor_account_id(accounts(1))
            .block_timestamp(1_700_000_000 * 1_000_000_000)
            .attached_deposit(NearToken::from_yoctonear(0))
            .prepaid_gas(Gas::from_tgas(300))
            .build());
        ask(&mut c, GLIANA, 2000);
        assert_eq!(last(&c).0, "signed");
    }

    #[test]
    fn the_history_stays_short() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        for _ in 0..(MOST_HISTORY + 5) {
            ask(&mut c, "0x000000000000000000000000000000000000dEaD", 2000);
        }
        assert_eq!(c.get_history().len(), MOST_HISTORY);
    }

    #[test]
    fn the_budget_resets_the_next_day_and_a_failed_signature_gives_it_back() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        let _ = c.pay(GLIANA.into(), U128(10_000), U64(1_699_999_940), U64(1_700_000_600), NONCE.into());
        c.on_signed(Err(PromiseError::Failed), U64(c.spent_day), U128(10_000));
        assert_eq!(c.get_policy().spent_today, U128(0));
        let _ = c.pay(GLIANA.into(), U128(10_000), U64(1_699_999_940), U64(1_700_000_600), NONCE.into());
        ctx(accounts(1), 1_700_000_000 + 86_400);
        assert_eq!(c.get_policy().spent_today, U128(0));
        let _ = c.pay(GLIANA.into(), U128(10_000), U64(1_700_086_340), U64(1_700_087_000), NONCE.into());
        assert_eq!(c.get_policy().spent_today, U128(10_000));
    }

    #[test]
    fn no_long_lived_signature() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        c.pay(GLIANA.into(), U128(2000), U64(1_699_999_940), U64(1_700_000_000 + 7_200), NONCE.into());
        assert_eq!(last(&c).1, "valid_before must be within the next hour");
    }

    #[test]
    fn the_owner_can_pause_it() {
        let mut c = contract();
        ctx(accounts(0), 1_700_000_000);
        c.set_paused(true);
        ctx(accounts(1), 1_700_000_000);
        ask(&mut c, GLIANA, 2000);
        assert_eq!(last(&c).1, "paused by the owner");
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn the_agent_cannot_change_the_rules() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        c.set_limits(U128(1_000_000), U128(1_000_000));
    }
}
