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

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::IterableSet;
use near_sdk::{env, near, require, AccountId, Gas, GasWeight, NearToken, PanicOnDefault, PromiseError};

/// Gas kept back for `on_signed`; all the rest of what is attached goes to the MPC (by weight).
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const DAY_NS: u64 = 86_400 * 1_000_000_000;
/// Longest an authorization may stay valid. The signature is a bearer
/// instrument until `validBefore`; an hour is plenty for an x402 round trip.
pub const MAX_VALIDITY_S: u64 = 3_600;

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
        }
    }

    /// The agent's one power: get a payment signed, within the policy.
    /// Attach at least 1 yoctoNEAR (the MPC's fee, forwarded) and 300 TGas.
    #[payable]
    pub fn pay(&mut self, to: String, value: U128, valid_after: U64, valid_before: U64, nonce: String) {
        if let Some(why) = self.refusal(&env::predecessor_account_id(), &to, value.0, valid_after.0, valid_before.0) {
            env::panic_str(why);
        }
        let (to_bytes, _) = hex20(&to);
        self.roll_day();
        // Counted now, before the signature exists; given back if signing fails (on_signed).
        self.spent_today += value.0;
        let digest = self.digest(&to_bytes, value.0, valid_after.0, valid_before.0, &hex32(&nonce));
        self.request_signature(digest, value.0)
    }

    /// The owner moves funds out without the agent's limits (any payee, any amount).
    #[payable]
    pub fn owner_pay(&mut self, to: String, value: U128, valid_after: U64, valid_before: U64, nonce: String) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        let digest = self.digest(&hex20(&to).0, value.0, valid_after.0, valid_before.0, &hex32(&nonce));
        self.request_signature(digest, 0)
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
                None
            }
        }
    }

    // ── owner ────────────────────────────────────────────────────────────────

    pub fn set_paused(&mut self, paused: bool) {
        self.only_owner();
        self.paused = paused;
    }
    /// Rotate the agent account — e.g. after its key may have leaked.
    pub fn set_agent(&mut self, agent: AccountId) {
        self.only_owner();
        self.agent = agent;
    }
    pub fn set_limits(&mut self, per_payment_max: U128, daily_limit: U128) {
        self.only_owner();
        require!(per_payment_max.0 > 0 && per_payment_max.0 <= daily_limit.0, "per_payment_max must be 1..=daily_limit");
        self.per_payment_max = per_payment_max.0;
        self.daily_limit = daily_limit.0;
    }
    pub fn add_payee(&mut self, payee: String) {
        self.only_owner();
        self.payees.insert(hex20(&payee).1);
    }
    pub fn remove_payee(&mut self, payee: String) {
        self.only_owner();
        self.payees.remove(&hex20(&payee).1);
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
        }
    }

    /// The digest `pay` would ask the MPC to sign, so a client can check it matches its own.
    /// The same rules `pay` enforces, as a free view: None = it would be signed, else why not.
    /// Clients ask this first (2026-10-29), so a refused payment costs no gas and no
    /// transaction — it took 11.6 s on mainnet to learn a refusal from `pay` itself.
    /// Advisory only: `pay` re-checks everything on chain.
    pub fn check(&self, agent: AccountId, to: String, value: U128, valid_after: U64, valid_before: U64) -> Option<String> {
        self.refusal(&agent, &to, value.0, valid_after.0, valid_before.0).map(str::to_string)
    }

    pub fn preview_digest(&self, to: String, value: U128, valid_after: U64, valid_before: U64, nonce: String) -> String {
        format!("0x{}", hex::encode(self.digest(&hex20(&to).0, value.0, valid_after.0, valid_before.0, &hex32(&nonce))))
    }
}

impl Allowance {
    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    /// Every rule of the policy, in one place for `pay` and `check`. Reads the day's spend
    /// as `roll_day` would leave it, without writing.
    fn refusal(&self, caller: &AccountId, to: &str, value: u128, valid_after: u64, valid_before: u64) -> Option<&'static str> {
        let now_s = env::block_timestamp() / 1_000_000_000;
        let spent = if env::block_timestamp() / DAY_NS == self.spent_day { self.spent_today } else { 0 };
        if self.paused {
            Some("paused by the owner")
        } else if *caller != self.agent {
            Some("only the agent account may pay")
        } else if !self.payees.contains(&hex20(to).1) {
            Some("payee is not on the owner's list")
        } else if value == 0 || value > self.per_payment_max {
            Some("amount is over the per-payment limit")
        } else if valid_before <= now_s || valid_before > now_s + MAX_VALIDITY_S {
            Some("valid_before must be within the next hour")
        } else if valid_after >= valid_before {
            Some("valid_after must be before valid_before")
        } else if spent + value > self.daily_limit {
            Some("daily limit reached")
        } else {
            None
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
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach at least 1 yoctoNEAR for the MPC fee");
        let args = json!({ "request": { "payload_v2": { "Ecdsa": hex::encode(digest) }, "path": self.path, "domain_id": 0 } });
        // Low-level promise calls on purpose (2026-10-29): near-sdk 5.30's `Promise` builder links
        // every action host function, including testnet-only ones (gas keys,
        // universal_state_init), and mainnet refused the wasm with "Link Error: unknown or
        // invalid import". These two calls link only what they use.
        let sign = env::promise_batch_create(&self.signer);
        // Static 0 + weight 1: the runtime hands the sign call every unused gas unit, after
        // the callback's fixed share — no hand arithmetic to get wrong.
        env::promise_batch_action_function_call_weight(sign, "sign", args.to_string().as_bytes(), env::attached_deposit(), Gas::from_gas(0), GasWeight(1));
        let callback = env::promise_batch_then(sign, &env::current_account_id());
        let callback_args = json!({ "day": U64(self.spent_day), "value": U128(value) });
        env::promise_batch_action_function_call(callback, "on_signed", callback_args.to_string().as_bytes(), NearToken::from_yoctonear(0), CALLBACK_GAS);
        env::promise_return(callback);
    }
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
        Allowance::new(accounts(0), accounts(1), "v1.signer".parse().unwrap(), "gliana-x402".into(), FROM.into(), U128(10_000), U128(25_000), vec![GLIANA.into()], None, None, None, None)
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
        assert_eq!(ok(&c, GLIANA, 10_001).as_deref(), Some("amount is over the per-payment limit"));
        assert_eq!(c.check(accounts(2), GLIANA.into(), U128(2000), U64(1_699_999_940), U64(1_700_000_600)).as_deref(), Some("only the agent account may pay"));
        assert_eq!(c.check(accounts(1), GLIANA.into(), U128(2000), U64(1_699_999_940), U64(1_700_000_000 + 7200)).as_deref(), Some("valid_before must be within the next hour"));
        let _ = c.pay(GLIANA.into(), U128(10_000), U64(1_699_999_940), U64(1_700_000_600), NONCE.into());
        let _ = c.pay(GLIANA.into(), U128(10_000), U64(1_699_999_940), U64(1_700_000_600), NONCE.into());
        assert_eq!(ok(&c, GLIANA, 10_000).as_deref(), Some("daily limit reached"));
        // The next day the spend reads as zero, though nothing has written the roll yet.
        ctx(accounts(1), 1_700_000_000 + 86_400);
        assert_eq!(c.check(accounts(1), GLIANA.into(), U128(10_000), U64(1_700_086_340), U64(1_700_087_000)), None);
    }

    #[test]
    #[should_panic(expected = "only the agent account may pay")]
    fn nobody_else_can_pay() {
        let mut c = contract();
        ctx(accounts(2), 1_700_000_000);
        let _ = c.pay(GLIANA.into(), U128(2000), U64(1_699_999_940), U64(1_700_000_600), NONCE.into());
    }

    #[test]
    #[should_panic(expected = "payee is not on the owner's list")]
    fn an_unlisted_payee_is_refused() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        let _ = c.pay("0x000000000000000000000000000000000000dEaD".into(), U128(2000), U64(1_699_999_940), U64(1_700_000_600), NONCE.into());
    }

    #[test]
    #[should_panic(expected = "amount is over the per-payment limit")]
    fn one_payment_cannot_exceed_the_cap() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        let _ = c.pay(GLIANA.into(), U128(10_001), U64(1_699_999_940), U64(1_700_000_600), NONCE.into());
    }

    #[test]
    #[should_panic(expected = "daily limit reached")]
    fn the_day_cannot_exceed_the_budget() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        for _ in 0..3 {
            let _ = c.pay(GLIANA.into(), U128(10_000), U64(1_699_999_940), U64(1_700_000_600), NONCE.into());
        }
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
    #[should_panic(expected = "valid_before must be within the next hour")]
    fn no_long_lived_signature() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        let _ = c.pay(GLIANA.into(), U128(2000), U64(1_699_999_940), U64(1_700_000_000 + 7_200), NONCE.into());
    }

    #[test]
    #[should_panic(expected = "paused by the owner")]
    fn the_owner_can_pause_it() {
        let mut c = contract();
        ctx(accounts(0), 1_700_000_000);
        c.set_paused(true);
        ctx(accounts(1), 1_700_000_000);
        let _ = c.pay(GLIANA.into(), U128(2000), U64(1_699_999_940), U64(1_700_000_600), NONCE.into());
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn the_agent_cannot_change_the_rules() {
        let mut c = contract();
        ctx(accounts(1), 1_700_000_000);
        c.set_limits(U128(1_000_000), U128(1_000_000));
    }
}
