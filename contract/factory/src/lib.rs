//! saku-factory — sets up a Saku allowance from one wallet call (2026-11-08).
//!
//! Until now an allowance was set up from a terminal (`npm run allowance:deploy`). The browser can't do the same
//! steps itself: MyNearWallet carries a transaction in its URL, and a 220 KB contract deploy doesn't fit. So the
//! owner's wallet makes one ordinary call here, with NEAR attached, and the factory does the rest:
//!
//!   1. asks the MPC signer for the key it would sign with for `<name>.<factory>`, and turns that into the Base
//!      address on-chain (keccak of the key, last 20 bytes). The browser never supplies the address, so a page bug
//!      can't make someone fund an address nobody controls;
//!   2. creates `<name>.<factory>`, funds its storage, deploys the allowance contract and runs `new` with the
//!      caller as owner;
//!   3. creates `agent-<name>.<factory>` with the agent's public key, which may only call `pay` on that allowance.
//!      The private key is made in the owner's browser and never leaves it.
//!
//! An allowance made this way has no key of its own, so nobody (not us, not the owner) can replace its code. The
//! README's "whoever holds the contract account's key can replace it" doesn't apply to these.
//!
//! If a step fails, what came back is kept for the owner to take with `claim_refund` rather than sent at once: the
//! refund of a failed batch reaches this account in its own receipt, and may land after `on_done` runs.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, require, AccountId, Allowance, Gas, NearToken, PanicOnDefault, Promise, PublicKey};

/// The allowance contract each new allowance gets, committed so the factory builds from a fresh clone and anyone can
/// check it: the `code_hash` of every allowance this factory makes is base58(sha256) of this file.
/// `npm run factory:build` rebuilds contract/ and copies it here first.
const ALLOWANCE_WASM: &[u8] = include_bytes!("../res/agent_allowance.wasm");
/// Locked as the allowance's storage: 1 NEAR per 100 KB, for ~220 KB of code plus its state. Given back only if the
/// account is ever deleted, which nothing here does.
pub const ALLOWANCE_NEAR: NearToken = NearToken::from_millinear(2_500);
/// The least the agent starts with. Each `pay` reserves gas at a pessimistic price (~0.31 NEAR, mostly refunded).
pub const MIN_AGENT_NEAR: NearToken = NearToken::from_millinear(500);
const KEY_GAS: Gas = Gas::from_tgas(10);
const INIT_GAS: Gas = Gas::from_tgas(30);
const DONE_GAS: Gas = Gas::from_tgas(15);
/// Lets a new seller in at once is the owner's call, but not for longer than a month.
const MOST_DELAY_S: u64 = 30 * 86_400;

#[ext_contract(ext_signer)]
#[allow(dead_code)]
trait MpcSigner {
    fn derived_public_key(&self, path: String, predecessor: Option<AccountId>, domain_id: Option<u32>) -> String;
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Rules {
    pub per_payment_max: U128,
    pub daily_limit: U128,
    pub payees: Vec<String>,
    pub approval_max: Option<U128>,
    pub payee_delay_s: Option<U64>,
}

#[near(serializers = [json])]
pub struct Config {
    pub signer: AccountId,
    pub path: String,
    pub allowance_near: U128,
    pub min_agent_near: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    signer: AccountId,
    path: String,
    /// name → owner. Taken in `create`, before anything is sent, so two calls can't race for one name.
    names: LookupMap<String, AccountId>,
    /// owner → the allowances it owns, in the order they were made.
    owned: LookupMap<AccountId, Vec<AccountId>>,
    refunds: LookupMap<AccountId, u128>,
}

#[near]
impl Factory {
    /// `signer`: `v1.signer` on mainnet, `v1.signer-prod.testnet` on testnet. `path`: the derivation path every
    /// allowance from this factory uses (each still gets its own address, since the account id is part of it).
    #[init]
    pub fn new(signer: AccountId, path: String) -> Self {
        Self { signer, path, names: LookupMap::new(b"n"), owned: LookupMap::new(b"o"), refunds: LookupMap::new(b"r") }
    }

    /// Attach at least 3 NEAR and 300 TGas: 2.5 NEAR becomes the allowance's storage, the rest goes to the agent.
    #[payable]
    pub fn create(&mut self, name: String, agent_key: PublicKey, rules: Rules) -> Promise {
        let owner = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        require!(valid_name(&name), "name: 2 to 24 of a-z, 0-9 and single dashes, not starting with agent-");
        require!(deposit >= ALLOWANCE_NEAR.saturating_add(MIN_AGENT_NEAR), "attach at least 3 NEAR: 2.5 for the contract's storage, the rest for the agent's gas");
        require!(env::prepaid_gas() >= Gas::from_tgas(250), "attach 300 TGas");
        require!(rules.per_payment_max.0 > 0 && rules.per_payment_max.0 <= rules.daily_limit.0, "per_payment_max must be 1..=daily_limit");
        require!(!rules.payees.is_empty() && rules.payees.len() <= 20, "list 1 to 20 sellers");
        require!(rules.payees.iter().all(|p| is_hex20(p)), "each seller is a 0x address of 40 hex digits");
        require!(rules.payee_delay_s.map_or(true, |d| d.0 <= MOST_DELAY_S), "a new seller's wait is at most 30 days");
        require!(self.names.get(&name).is_none(), "that name is taken");
        let allowance = self.child(&name);
        self.agent_of(&name); // panics now, not later, if the agent's id would be too long
        self.names.insert(name.clone(), owner.clone());
        ext_signer::ext(self.signer.clone())
            .with_static_gas(KEY_GAS)
            .derived_public_key(self.path.clone(), Some(allowance), Some(0))
            .then(Self::ext(env::current_account_id()).with_unused_gas_weight(1).on_key(owner, name, agent_key, rules, U128(deposit.as_yoctonear())))
    }

    #[private]
    pub fn on_key(&mut self, owner: AccountId, name: String, agent_key: PublicKey, rules: Rules, deposit: U128, #[callback_result] key: Result<String, near_sdk::PromiseError>) -> Promise {
        let Some(from) = key.ok().and_then(|k| evm_address(&k)) else {
            // Nothing was sent yet, so the deposit is in this account's balance: it can go straight back.
            self.names.remove(&name);
            return Promise::new(owner).transfer(NearToken::from_yoctonear(deposit.0));
        };
        let allowance = self.child(&name);
        let agent = self.agent_of(&name);
        let args = json!({
            "owner": owner, "agent": agent, "signer": self.signer, "path": self.path, "from": from,
            "per_payment_max": rules.per_payment_max, "daily_limit": rules.daily_limit, "payees": rules.payees,
            "approval_max": rules.approval_max, "payee_delay_s": rules.payee_delay_s,
        });
        let agent_near = NearToken::from_yoctonear(deposit.0).saturating_sub(ALLOWANCE_NEAR);
        let make_allowance = Promise::new(allowance.clone())
            .create_account()
            .transfer(ALLOWANCE_NEAR)
            .deploy_contract(ALLOWANCE_WASM.to_vec())
            .function_call("new".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(0), INIT_GAS);
        let make_agent = Promise::new(agent).create_account().transfer(agent_near).add_access_key_allowance(agent_key, Allowance::Unlimited, allowance, "pay");
        make_allowance
            .and(make_agent)
            .then(Self::ext(env::current_account_id()).with_static_gas(DONE_GAS).on_done(owner, name, U128(agent_near.as_yoctonear())))
    }

    #[private]
    pub fn on_done(&mut self, owner: AccountId, name: String, agent_near: U128) -> bool {
        let made_allowance = env::promise_result_checked(0, 1024).is_ok();
        let made_agent = env::promise_result_checked(1, 1024).is_ok();
        let mut back = 0u128;
        if made_allowance {
            let mut list = self.owned.get(&owner).cloned().unwrap_or_default();
            list.push(self.child(&name));
            self.owned.insert(owner.clone(), list);
        } else {
            back += ALLOWANCE_NEAR.as_yoctonear();
            // The name is free again only if nothing exists under it, so a half-made pair can't be overwritten.
            if !made_agent {
                self.names.remove(&name);
            }
        }
        // An allowance without its agent still works: the owner points it at any account with `set_agent`.
        if !made_agent {
            back += agent_near.0;
        }
        if back > 0 {
            let had = self.refunds.get(&owner).copied().unwrap_or(0);
            self.refunds.insert(owner, had + back);
        }
        made_allowance && made_agent
    }

    /// NEAR kept for the caller after a failed setup.
    pub fn claim_refund(&mut self) -> Promise {
        let owner = env::predecessor_account_id();
        let amount = self.refunds.remove(&owner).unwrap_or(0);
        require!(amount > 0, "nothing to refund");
        Promise::new(owner).transfer(NearToken::from_yoctonear(amount))
    }

    // ── views ────────────────────────────────────────────────────────────────

    pub fn get_allowances(&self, owner: AccountId) -> Vec<AccountId> {
        self.owned.get(&owner).cloned().unwrap_or_default()
    }
    pub fn get_refund(&self, owner: AccountId) -> U128 {
        U128(self.refunds.get(&owner).copied().unwrap_or(0))
    }
    pub fn is_taken(&self, name: String) -> bool {
        self.names.get(&name).is_some()
    }
    pub fn get_config(&self) -> Config {
        Config { signer: self.signer.clone(), path: self.path.clone(), allowance_near: U128(ALLOWANCE_NEAR.as_yoctonear()), min_agent_near: U128(MIN_AGENT_NEAR.as_yoctonear()) }
    }
}

impl Factory {
    fn child(&self, name: &str) -> AccountId {
        format!("{name}.{}", env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("that name makes an account id that is too long"))
    }
    fn agent_of(&self, name: &str) -> AccountId {
        format!("agent-{name}.{}", env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("that name makes an agent id that is too long"))
    }
}

/// a-z and 0-9, joined by single dashes, 2 to 24 long. `agent-` at the start is kept for the agents' own accounts.
pub fn valid_name(name: &str) -> bool {
    (2..=24).contains(&name.len())
        && name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
        && !name.starts_with("agent-")
}

fn is_hex20(s: &str) -> bool {
    let h = s.strip_prefix("0x").unwrap_or(s);
    h.len() == 40 && h.bytes().all(|c| c.is_ascii_hexdigit())
}

/// "secp256k1:<base58 of x||y>" from the MPC → the Ethereum address it signs for.
pub fn evm_address(key: &str) -> Option<String> {
    let raw = base58(key.strip_prefix("secp256k1:")?)?;
    if raw.len() != 64 {
        return None;
    }
    Some(format!("0x{}", hex::encode(&env::keccak256(&raw)[12..])))
}

fn base58(s: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut out: Vec<u8> = Vec::new(); // little-endian while building
    for c in s.bytes() {
        let mut carry = ALPHABET.iter().position(|&a| a == c)? as u32;
        for b in out.iter_mut() {
            carry += (*b as u32) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            out.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    out.extend(s.bytes().take_while(|&c| c == b'1').map(|_| 0));
    out.reverse();
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mpc_key_gives_the_address_the_live_contract_holds() {
        // v1.signer-prod.testnet, path gliana-x402, for allowance.gliana-x402.testnet (read 2026-11-08); that
        // contract's get_policy says from = 0xe328…8493.
        let key = "secp256k1:26JnvBPMVkezBTMoqRfvYFLp9zubNSeBwNctrF63MkpRX9C1JoD9y7Dk1zadqrqnxriooabG4mnJP2tFb4Mp5Fyo";
        assert_eq!(evm_address(key).as_deref(), Some("0xe32847b59d97cf36915d92064b99543743a88493"));
        assert_eq!(evm_address("ed25519:abc"), None);
        assert_eq!(evm_address("secp256k1:0OIl"), None);
    }

    #[test]
    fn names() {
        for ok in ["ab", "my-bot", "my-agent", "shop2", "a1-b2-c3"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["a", "My", "my_bot", "-a", "a-", "a--b", "x.y", "agent-bot", "abcdefghijklmnopqrstuvwxy"] {
            assert!(!valid_name(bad), "{bad}");
        }
    }
}
