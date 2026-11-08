import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/instrument-sans/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './style.css';
import { loader } from './logo';
import { Buffer } from 'buffer';
import { DARE } from './dare-key';
import type { WalletSelector } from '@near-wallet-selector/core';
import { setupTheme } from './theme';
import { drawSetup } from './setup';
setupTheme();

// The wallet libraries expect Node's Buffer and `global` as they load, so both are in place before they're imported,
// further down. Without `global`, randombytes threw on load and the page fell back to read-only (seen 2026-11-08).
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
(globalThis as unknown as { global: typeof globalThis }).global = globalThis;

/**
 * Saku's owner page. Anyone can read a contract's budget and history. Approving, rejecting and revoking are
 * ordinary transactions the owner signs in their own wallet, and the contract refuses them from anyone else.
 * The wallet code loads after the page, and separately: if it ever fails, the budget and history still show.
 */
type Network = 'mainnet' | 'testnet';
type Policy = { owner: string; agent: string; from: string; signer: string; per_payment_max: string; daily_limit: string; spent_today: string; paused: boolean; payees: string[]; approval_max?: string; payee_delay_s?: string; waiting_payees?: [string, string][] };
type Held = { id: string; to: string; value: string; valid_before: string; why: string; asked_at: string; status: string };
type Entry = { at: string; what: string; to: string; value: string; note: string };

const q = new URLSearchParams(location.search);
const network: Network = q.get('network') === 'testnet' ? 'testnet' : 'mainnet';
const contract = q.get('contract') ?? (network === 'testnet' ? 'allowance.gliana-x402.testnet' : 'allowance.cocoanutx.near');
/**
 * Public NEAR RPCs, tried in turn, starting with whichever answered last. FastNEAR's free endpoints answered 429 to
 * most reads on 2026-11-08 and the page showed "Couldn't read …: undefined", so they come last. On testnet FastNEAR
 * answered and rpc.testnet.near.org took ~3 s a call, so there it's the other way round. All of them allow CORS.
 */
const RPCS = network === 'testnet' ? ['https://test.rpc.fastnear.com', 'https://near-testnet.drpc.org', 'https://rpc.testnet.near.org'] : ['https://near.drpc.org', 'https://rpc.mainnet.near.org', 'https://free.rpc.fastnear.com', 'https://rpc.mainnet.fastnear.com'];
const host = (u: string) => new URL(u).hostname.replace(/^(rpc|free\.rpc|rpc\.mainnet)\./, '');
/** The factory that sets up an allowance from one wallet call (contract/factory). Mainnet's is live once deployed. */
const FACTORY = network === 'testnet' ? 'saku-factory.testnet' : 'saku.cocoanutx.near';
const setupMode = q.has('new');
const EXPLORER = network === 'testnet' ? 'https://testnet.nearblocks.io' : 'https://nearblocks.io';
const GAS = '300000000000000';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const usd = (micro: string | number) => `$${(Number(micro) / 1e6).toFixed(3)}`;
const short = (a: string, most = 16) => (a.length > most ? `${a.slice(0, most - 9)}…${a.slice(-8)}` : a);
const when = (s: string) => new Date(Number(s) * 1000).toLocaleString();

/** Sellers worth naming. Anything else shows as its address. */
const KNOWN: Record<string, string> = { '0x6d6e695b09861467c7d462f5aaf31cf3540b9192': 'Exa', '0x7662e00f8ab4c362166e1ff649ff6c2a638c80ad': 'GlianaAI', '0x000000000000000000000000000000000000dead': '0x…dEaD' };
const seller = (a: string) => KNOWN[a.toLowerCase()] ?? short(a);
const baseLink = (a: string) => `<a href="https://basescan.org/address/${esc(a)}">${esc(seller(a))}</a>`;
function ago(s: string) {
  const d = Date.now() / 1000 - Number(s);
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(Number(s) * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function until(s: string) {
  const d = Number(s) - Date.now() / 1000;
  return d > 3600 ? `in ${Math.ceil(d / 3600)} h` : `in ${Math.max(1, Math.ceil(d / 60))} min`;
}
/** Real mainnet receipts, for the contract the demo runs on. */
const PROOF = contract === 'allowance.cocoanutx.near' ? [['Refuelled with NEAR Intents', 'https://basescan.org/tx/0xb383a32b84f02312f1a6f1382f1e047d39bda9788983b52b2f5fa48065943c76'], ['Paid an API over x402', 'https://basescan.org/tx/0x599308125359a2b3d269a0c0e0811547fd0b1023de16c8c08c57a425805c72c3'], ['Refused a $5 attack', 'https://nearblocks.io/txns/G4wPa1TFUXJ5hBMrzfXwPyouQPmRMGkFfx4bCjGg2vdS']] : [];

/** How the page last reached NEAR: shown in the bar, so a busy RPC reads as "retrying", never as a broken contract. */
const link = { ok: true, via: '', at: 0, why: '' };
let rpcAt = 0;
/** The contract itself answered with an error (wrong account, no such method): another RPC would say the same. */
class ContractError extends Error {}

const view = <T>(method: string, args: object = {}) => viewOf<T>(contract, method, args);
async function viewOf<T>(account: string, method: string, args: object = {}): Promise<T> {
  const r = await query<{ result: number[] }>({ request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}
/** A NEAR account's balance in NEAR, or null if it doesn't exist. */
async function nearBalance(account: string): Promise<number | null> {
  try {
    const r = await query<{ amount: string }>({ request_type: 'view_account', finality: 'final', account_id: account });
    return Number(BigInt(r.amount) / 10n ** 18n) / 1e6;
  } catch (e) {
    if (e instanceof ContractError) return null;
    throw e;
  }
}
async function query<T>(params: object): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params });
  const tried: string[] = [];
  for (let n = 0; n < RPCS.length; n++) {
    const i = (rpcAt + n) % RPCS.length;
    const name = host(RPCS[i]);
    try {
      const res = await fetch(RPCS[i], { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        tried.push(`${name} ${res.status === 429 ? 'busy' : res.status}`);
        continue;
      }
      const j = await res.json();
      if (j.result?.error) throw new ContractError(String(j.result.error));
      if (j.error) {
        const cause = String(j.error.cause?.name ?? '');
        const why = String(j.error.cause?.info?.error_message ?? j.error.data ?? j.error.message ?? cause);
        if (/UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|CONTRACT_EXECUTION_ERROR|INVALID_ACCOUNT/.test(cause)) throw new ContractError(why);
        tried.push(`${name} ${why.slice(0, 40)}`);
        continue;
      }
      if (!j.result) {
        tried.push(`${name} gave no answer`);
        continue;
      }
      rpcAt = i;
      Object.assign(link, { ok: true, via: name, at: Date.now(), why: '' });
      return j.result as T;
    } catch (e) {
      if (e instanceof ContractError) throw e;
      tried.push(`${name} ${(e as Error).name === 'TimeoutError' ? 'timed out' : 'unreachable'}`);
    }
  }
  throw new Error(`No NEAR RPC answered (${tried.join(', ')})`);
}

/** The USDC this contract's Base address holds. A nicety: if Base's public endpoint is down, the page just leaves it out. */
async function baseUsdc(from: string): Promise<number | null> {
  try {
    const data = `0x70a08231${from.replace(/^0x/, '').padStart(64, '0')}`;
    const res = await fetch('https://mainnet.base.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data }, 'latest'] }) });
    return Number(BigInt((await res.json()).result)) / 1e6;
  } catch {
    return null;
  }
}

let selector: WalletSelector | null = null;
let functionCall: ((method: string, args: object, gas: bigint, deposit: bigint) => unknown) | null = null;
const signedIn = () => selector?.store.getState().accounts.find((a) => a.active)?.accountId ?? null;

/** Every owner call attaches 1 yoctoNEAR: the contract asks for it, so a web wallet's sign-in key alone can't change anything. */
async function send(method: string, args: object, deposit = '1') {
  await sendTo(contract, method, args, BigInt(deposit), location.href);
  await refresh();
}
async function sendTo(receiver: string, method: string, args: object, deposit: bigint, back: string) {
  if (!selector || !functionCall) throw new Error('Connect a wallet first.');
  const wallet = await selector.wallet();
  // MyNearWallet leaves the page to sign and comes back to `back`; Meteor signs in a popup and returns here.
  await wallet.signAndSendTransaction({ receiverId: receiver, actions: [functionCall(method, args, BigInt(GAS), deposit)] as never, callbackUrl: new URL(back, location.href).href } as never);
}

const WORDS: Record<string, [string, string]> = {
  signed: ['Signed', 'ok'], held: ['Held', 'wait'], refused: ['Refused', 'bad'], approved: ['Approved', 'ok'], rejected: ['Rejected', 'bad'], sign_failed: ['Sign failed', 'bad'],
  revoked: ['Revoked', 'bad'], payee_added: ['Seller added', 'note'], payee_trusted: ['Seller trusted', 'note'], payee_removed: ['Seller removed', 'note'], limits_changed: ['Limits changed', 'note'], paused: ['Paused', 'bad'], resumed: ['Resumed', 'ok'],
};

function header(owner?: string) {
  const me = signedIn();
  const mine = me && owner === me;
  if (!selector) return;
  $('who').innerHTML = me
    ? `<span>${esc(me)}${setupMode ? '' : mine ? ' · owner' : ' · not the owner'}</span><button class="ghost" id="out">Disconnect</button>`
    : `<span>${setupMode ? 'Connect' : 'Owner? Connect'}</span><button class="ghost" id="connect-my">MyNearWallet</button><button class="ghost" id="connect-meteor">Meteor</button>`;
  $('who').querySelector('#out')?.addEventListener('click', async () => {
    await (await selector!.wallet()).signOut();
    void redraw();
  });
  for (const [id, wallet] of [['connect-my', 'my-near-wallet'], ['connect-meteor', 'meteor-wallet']] as const) {
    $('who').querySelector(`#${id}`)?.addEventListener('click', async () => {
      const w = (await selector!.wallet(wallet)) as unknown as { signIn: (o: { contractId: string; methodNames: string[] }) => Promise<unknown> };
      await w.signIn({ contractId: setupMode ? FACTORY : contract, methodNames: [] });
      void redraw();
    });
  }
}

const TERM_TEXT: Record<string, [string, string]> = {
  mpc: ['MPC', 'Many separate machines hold pieces of one key. 11 of NEAR’s 17 have to agree to sign, and no single machine can sign alone.'],
  x402: ['x402', 'A way to pay for an API per call: the seller answers “402 Payment Required” with a price, and the buyer pays in USDC and asks again.'],
  chainsig: ['Chain Signatures', 'NEAR’s way of signing for other chains. Here it lets a NEAR contract control a wallet on Base, with no Base private key stored anywhere.'],
};
const term = (id: string, label: string) => `<button type="button" class="term" popovertarget="t-${id}">${esc(label)}</button>`;
const TERMS = Object.entries(TERM_TEXT).map(([id, [name, text]]) => `<div id="t-${id}" popover class="term-pop"><b>${esc(name)}</b><p>${esc(text)}</p></div>`).join('');
const PITCH = `<section class="pitch"><span class="eyebrow"><i></i>Live on NEAR ${network}</span><h1>Give an AI agent a budget, <em>not a key.</em></h1><p class="pitch-say">The agent holds no key that can move money. A NEAR contract owns its wallet on Base through ${term('chainsig', 'Chain Signatures')}, and signs only within the owner’s rules. A stolen agent key is worth one day’s budget.</p><div class="jump"><a class="btn go" href="#gate">Try to break it</a>${PROOF.length ? '<a class="btn ghost" href="#dare">Steal with the real key</a>' : ''}</div><p class="setup-link"><a href="?new&network=${network}">Set up an allowance for your own agent →</a></p></section>`;
const QUESTIONS = `<section class="questions" aria-label="Questions">
  <details><summary>What if the agent’s key is stolen?</summary><p>The thief can only do what the agent can: ask. At most that’s one day’s budget, paid only to sellers the owner chose. Anything else is refused or waits for the owner.</p></details>
  <details><summary>And if the owner’s key is stolen?</summary><p>Then it isn’t safe: the owner can change the rules and pay anyone directly. Keep the owner key in a hardware wallet, never on the machine the agent runs on.</p></details>
  <details><summary>Can GlianaAI take the money?</summary><p>No. The money is in a wallet only this contract can sign for, and only its owner can change the rules. Whoever holds the contract account’s own key could replace its code, so in real use that key should be deleted. On this demo it’s still there, so we can improve it.</p></details>
  <details><summary>Is any of this real?</summary><p>Yes. The budget and history above come from a live mainnet contract, and the receipts are real payments. “Steal with it” runs on testnet, so nobody’s money is at stake.</p></details>
  <details><summary>What can’t it do yet?</summary><p>It pays on Base only, with more chains to come. The contract is experimental and hasn’t been audited, so don’t trust it with money you can’t lose.</p></details>
</section>`;
const DARE_HTML = `<section class="dare" id="dare" aria-label="Steal with a real key">
  <div class="dare-head"><h2>Here’s the agent’s key. Steal with it.</h2><p class="quiet">A real private key for a test agent, published on purpose. Each button sends a real transaction from your browser, on testnet.</p></div>
  <div class="dare-key"><code>${esc(DARE.key)}</code><button type="button" class="ghost" id="dare-copy">Copy</button></div>
  <div class="try-buttons"><button class="stop" data-steal="pay">Steal $5 with it</button><button class="ghost" data-steal="payee">Add yourself as a seller</button><button class="ghost" data-steal="drain">Take the agent’s NEAR</button></div>
  <div id="dare-out" class="dare-out" role="status"></div>
</section>`;

/** Really uses the published key, from this browser. Loaded on the press: most visitors never need the signing code. */
async function steal(what: string, button: HTMLButtonElement) {
  const out = $('dare-out');
  button.disabled = true;
  out.innerHTML = `<p>${loader('Sending to testnet…', 30)}</p>`;
  const say = (stamp: string, tone: string, text: string, tx?: string) => {
    out.innerHTML = `<span class="big-stamp ${tone}">${esc(stamp)}</span><p>${esc(text)}${tx ? ` <a href="https://testnet.nearblocks.io/txns/${esc(tx)}">See the transaction</a>` : ''}</p>`;
  };
  try {
    const [{ Account }, { KeyPair }, { JsonRpcProvider }, { KeyPairSigner }, { actionCreators }] = await Promise.all([import('@near-js/accounts'), import('@near-js/crypto'), import('@near-js/providers'), import('@near-js/signers'), import('@near-js/transactions')]);
    // Next RPC only when one is busy or unreachable. Not near-js's FailoverRpcProvider: it treats the network's own
    // refusal ("isn't allowed by the access key") as a dead RPC and answers "Exceeded 2 providers" (2026-11-08).
    const urls = ['https://rpc.testnet.near.org', 'https://test.rpc.fastnear.com'];
    const busy = (e: unknown) => /429|too many|failed to fetch|fetch failed|networkerror|load failed|timed? ?out|50[234]/i.test(String((e as Error)?.message ?? e));
    const signer = new KeyPairSigner(KeyPair.fromString(DARE.key as `ed25519:${string}`));
    const thief = {
      async signAndSendTransaction(tx: Parameters<InstanceType<typeof Account>['signAndSendTransaction']>[0]) {
        for (const [i, url] of urls.entries()) {
          try {
            return await new Account(DARE.account, new JsonRpcProvider({ url }), signer).signAndSendTransaction(tx);
          } catch (e) {
            if (!busy(e) || i === urls.length - 1) throw e;
          }
        }
        throw new Error('no testnet RPC answered');
      },
    };
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const GAS = 30_000_000_000_000n;
    if (what === 'pay') {
      const sent = await thief.signAndSendTransaction({ receiverId: DARE.contract, actions: [actionCreators.functionCall('pay', { to: '0x000000000000000000000000000000000000dEaD', value: '5000000', valid_after: String(now - 60), valid_before: String(now + 600), nonce }, GAS, 0n)] });
      const value = (sent.status as { SuccessValue?: string }).SuccessValue ?? '';
      const answer = JSON.parse(atob(value) || '{}') as { refused?: string };
      say('Refused', 'refused', `The key worked, and the contract still said no: “${answer.refused ?? 'refused'}”. You got $0.`, sent.transaction.hash);
    } else if (what === 'payee') {
      await thief.signAndSendTransaction({ receiverId: DARE.contract, actions: [actionCreators.functionCall('add_payee', { payee: '0x000000000000000000000000000000000000dEaD' }, GAS, 0n)] });
      say('Signed', 'signed', 'This should never happen. Please tell us.');
    } else {
      await thief.signAndSendTransaction({ receiverId: DARE.contract, actions: [actionCreators.transfer(10n ** 22n)] });
      say('Signed', 'signed', 'This should never happen. Please tell us.');
    }
  } catch (e) {
    const m = String((e as Error).message ?? e);
    const blocked = /isn.t allowed|more then one action|not allowed|access key|deposit/i.test(m);
    if (blocked) say('Blocked', 'refused', what === 'payee' ? 'The network refused before the contract even saw it: this key may only call pay, and only the owner can add sellers.' : 'The network refused: this key can’t move NEAR. It can only ask the contract for a payment.');
    else out.innerHTML = `<p class="quiet">Testnet didn’t answer that one: ${esc(m.slice(0, 120))}. Try again.</p>`;
  } finally {
    button.disabled = false;
  }
}

/** What the contract itself just said to a pretend payment. Anyone can ask, because `check` is a free view. */
let tried: { kind: string; label: string; answer: string | null; n: number } | null = null;
let presses = 0;
async function tryPayment(p: Policy, kind: string) {
  const now = Math.floor(Date.now() / 1000);
  const seller = p.payees[0];
  const asks: Record<string, [string, string, string]> = {
    attack: ['Send $5.00 to an attacker', '0x000000000000000000000000000000000000dEaD', '5000000'],
    unusual: ['$0.018 to a listed seller, over the limit', seller, '18000'],
    normal: ['$0.002 to a listed seller', seller, '2000'],
  };
  const [label, to, value] = asks[kind];
  const answer = await view<string | null>('check', { agent: p.agent, to, value, valid_after: String(now - 60), valid_before: String(now + 600) });
  tried = { kind, label, answer, n: ++presses };
  await refresh();
}

let lastOk = '';
let lastGate = '';
let lastToday = '';
let lastAsk = '';
let lastTools = '';

/** The owner's rule changes. Each is one wallet confirmation; the contract checks it's the owner and 1 yocto is attached. */
function bindTools(p: Policy) {
  const tell = (t: string, bad = false) => {
    const el = document.getElementById('tools-say');
    if (el) el.innerHTML = `<span class="${bad ? 'bad-text' : 'quiet'}">${esc(t)}</span>`;
  };
  const run = (method: string, args: object) => send(method, args).then(() => tell('Done.'), (e) => tell(message(e), true));
  document.getElementById('limits')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = ev.target as HTMLFormElement;
    const per = Math.round(Number((f.elements.namedItem('per') as HTMLInputElement).value) * 1e6);
    const day = Math.round(Number((f.elements.namedItem('day') as HTMLInputElement).value) * 1e6);
    if (!(per > 0) || !(day >= per)) return tell('Per payment must be above $0 and no more than per day.', true);
    if (p.approval_max && day > Number(p.approval_max)) return tell(`Per day can’t pass what the owner may approve (${usd(p.approval_max)}).`, true);
    void run('set_limits', { per_payment_max: String(per), daily_limit: String(day) });
  });
  document.getElementById('add-seller')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = ((ev.target as HTMLFormElement).elements.namedItem('payee') as HTMLInputElement).value.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(v)) return tell('A Base address is 0x and 40 hex digits.', true);
    void run('add_payee', { payee: v });
  });
  document.getElementById('pause')?.addEventListener('click', () => void run('set_paused', { paused: !p.paused }));
}

/** The connected account's allowances: the factory's list, plus `allowance.<account>` from the terminal setup. */
let mineFor = '';
async function drawMine() {
  const el = document.getElementById('mine');
  const me = signedIn();
  if (!el || mineFor === (me ?? '')) return;
  mineFor = me ?? '';
  if (!me) return void (el.innerHTML = '');
  const [made, legacy] = await Promise.all([viewOf<string[]>(FACTORY, 'get_allowances', { owner: me }).catch(() => [] as string[]), nearBalance(`allowance.${me}`).catch(() => null)]);
  const list = [...(legacy === null ? [] : [`allowance.${me}`]), ...made];
  el.innerHTML = `<section class="sheet mine"><h2>Your allowances</h2>${list.length ? list.map((a) => `<div class="line"><a href="?contract=${encodeURIComponent(a)}&network=${network}">${esc(a)}</a>${a === contract ? '<span class="faint small">open now</span>' : ''}</div>`).join('') : `<p class="quiet small">None on ${network} yet.</p>`}<a class="btn ghost mine-new" href="?new&network=${network}">Set up a new one</a></section>`;
}

function redraw() {
  if (setupMode) {
    header();
    return drawSetup({ network, factory: FACTORY, esc, viewOf, signedIn, sendTo });
  }
  mineFor = '#';
  lastOk = '';
  return refresh();
}
let triedOnLoad = false;
async function refresh(): Promise<boolean> {
  try {
    const policy = await view<Policy>('get_policy');
    const upgraded = policy.approval_max !== undefined;
    const revokedNow = policy.agent === contract;
    const [held, history, usdc, agentNear] = await Promise.all([upgraded ? view<Held[]>('list_held') : Promise.resolve([]), upgraded ? view<Entry[]>('get_history') : Promise.resolve([]), baseUsdc(policy.from), revokedNow ? Promise.resolve(null) : nearBalance(policy.agent).catch(() => null)]);
    header(policy.owner);
    const owner = signedIn() === policy.owner;
    const now = Date.now() / 1000;
    const revoked = policy.agent === contract;
    const waiting = held.filter((h) => h.status === 'waiting' && Number(h.valid_before) > now);
    const pct = Math.min(100, (Number(policy.spent_today) / Number(policy.daily_limit)) * 100);
    // In a background tab, the title is what tells the owner a payment is waiting.
    document.title = `${waiting.length ? `(${waiting.length}) ` : ''}Saku: an AI agent's budget, enforced on NEAR`;
    const spent = Number(policy.spent_today);
    const daily = Number(policy.daily_limit);
    const cap = Number(policy.per_payment_max);
    const cells = Math.min(20, Math.max(1, Math.round(daily / cap)));
    const off = revoked || policy.paused;
    const left = Math.max(0, daily - spent);
    const history2 = history.filter((e) => e.what !== 'held' || !waiting.some((h) => h.to === e.to.replace(/^0x/, '') && h.value === e.value && h.asked_at === e.at));
    // The page's one idea, played out: press a payment, and watch how far it gets.
    const outcome = !tried ? '' : !tried.answer ? 'signed' : tried.answer.startsWith('held:') ? 'held' : 'refused';
    const answerLine = !tried ? 'Press one. The live contract answers, and nothing is sent.' : outcome === 'signed' ? 'Inside the rules, so NEAR’s MPC would sign it and the wallet would pay.' : outcome === 'held' ? `Nothing is signed until the owner approves: ${esc(tried.answer!.replace('held: ', ''))}.` : `The contract’s own answer: “${esc(tried.answer)}”. Nothing was signed.`;
    const gateHtml = `
      <section class="gate" data-outcome="${outcome}" data-n="${tried?.n ?? 0}" aria-label="Who can move the money">
        ${upgraded && !revoked ? `<div class="gate-head">
          <h2>Try to break it</h2>
          <div class="try-buttons">
            <button class="stop ${tried?.kind === 'attack' ? 'pressed' : ''}" data-try="attack">Send $5 to an attacker</button>
            <button class="ghost ${tried?.kind === 'unusual' ? 'pressed' : ''}" data-try="unusual">$0.018, over the limit</button>
            <button class="ghost ${tried?.kind === 'normal' ? 'pressed' : ''}" data-try="normal">$0.002, inside the rules</button>
          </div>
        </div>` : ''}
        <div class="path-wrap">
        <ol class="path">
          <li><b>Agent</b><span class="does">${revoked ? 'cut off' : 'can only ask'}</span><span class="who-is" title="${esc(policy.agent)}">${revoked ? 'no agent' : esc(short(policy.agent, 24))}</span></li>
          <li class="the-gate"><b>Contract</b><span class="does">${outcome === 'held' ? 'waits for the owner' : outcome === 'refused' ? 'stops it here' : 'checks the owner’s rules'}</span><span class="who-is"><a href="${EXPLORER}/address/${esc(contract)}" title="${esc(contract)}">${esc(short(contract, 24))}</a></span></li>
          <li><b>NEAR MPC</b><span class="does">11 of 17 ${term('mpc', 'MPC')} nodes sign</span><span class="who-is">${esc(policy.signer)}</span></li>
          <li><b>Base wallet</b><span class="does">pays any ${term('x402', 'x402')} seller</span><span class="who-is"><a href="https://basescan.org/address/${esc(policy.from)}">${esc(short(policy.from))}</a></span></li>
        </ol>
        ${outcome === 'refused' || outcome === 'held' ? `<div class="slam ${outcome}" aria-hidden="true">${outcome === 'held' ? 'Held' : 'Refused'}</div>` : ''}
        </div>
        ${upgraded && !revoked ? `<div class="verdict" role="status">${outcome === 'signed' ? '<span class="big-stamp signed">Would sign</span>' : ''}<p><b>${tried ? esc(tried.label) : ''}</b> ${answerLine}</p></div>` : ''}
      </section>`;
    const askHtml = waiting.length ? `<section class="ask" aria-label="Waiting for the owner">
        <h2>${waiting.length === 1 ? 'A payment is' : `${waiting.length} payments are`} waiting for the owner</h2>
        <p class="quiet" style="font-size:14px">Nothing is signed until the owner decides.${owner ? '' : ' Connect the owner’s wallet to decide.'}</p>
        ${waiting.map((h) => `<div class="ask-row"><div><span class="ask-amount">${usd(h.value)}</span> to ${baseLink(`0x${h.to}`)}<div class="faint" style="font-size:13px">${esc(h.why)} · expires ${esc(until(h.valid_before))}${owner && h.why.includes('new seller') ? ' · trust the seller below so the next ones go through' : ''}</div></div><div class="ask-buttons"><button class="go" data-act="approve" data-id="${esc(h.id)}" ${owner ? '' : 'disabled'}>Approve</button><button class="ghost" data-act="reject" data-id="${esc(h.id)}" ${owner ? '' : 'disabled'}>Reject</button></div></div>`).join('')}
      </section>` : '';
    const todayHtml = `      <section class="today" aria-label="Today's budget">
        <div class="today-money">
          <h2>Spent today</h2>
          <div class="hero-spent"><strong>${usd(spent)}</strong><span>of ${usd(daily)}</span></div>
          <div class="cells" role="img" aria-label="${usd(spent)} of ${usd(daily)} spent">${Array.from({ length: cells }, (_, n) => `<i style="--fill:${Math.max(0, Math.min(1, spent / (daily / cells) - n)) * 100}%"></i>`).join('')}</div>
          <p class="cells-say">${usd(left)} left. Each block is ${usd(daily / cells)}.</p>
        </div>
        <dl class="facts">
          <div><dt>Status</dt><dd class="state ${off ? 'off' : 'on'}">${revoked ? 'Revoked' : policy.paused ? 'Paused' : 'Active'}</dd></div>
          ${usdc === null ? '' : `<div><dt>In the wallet</dt><dd class="money">$${usdc.toFixed(3)}</dd></div>`}
          <div><dt>Signs on its own up to</dt><dd class="money">${usd(cap)}</dd></div>
          ${upgraded ? `<div><dt>Owner can approve up to</dt><dd class="money">${usd(policy.approval_max!)}</dd></div>` : ''}
        </dl>
      </section>`;
    const html = `
      ${upgraded ? '' : '<div class="note-bar">This contract was deployed before approvals, new-seller waits and history. It still enforces its budget, shown below.</div>'}
<div class="split">
        <div class="stack">
        <section class="sheet">
          <h2>What happened</h2>
          ${upgraded ? (history2.length ? `<table class="ledger">${history2.slice(0, 14).map((e) => {
            const [word, tone] = WORDS[e.what] ?? [e.what, 'note'];
            return `<tr><td><span class="stamp ${tone}">${esc(word)}</span></td><td>${e.to ? baseLink(e.to) : ''}${e.note ? `<span class="why">${esc(e.note)}</span>` : ''}</td><td class="amt">${Number(e.value) ? usd(e.value) : ''}</td><td class="when"><a href="${EXPLORER}/address/${esc(contract)}" title="${esc(when(e.at))}. Check it on chain.">${esc(ago(e.at))}</a></td></tr>`;
          }).join('')}</table>` : '<p class="quiet">Nothing yet. Every payment the agent asks for lands here, refused ones too.</p>') : '<p class="quiet">This contract keeps no history yet.</p>'}
        </section>
          ${PROOF.length ? `<section class="sheet proof"><h2>Real receipts</h2>${PROOF.map(([what, url]) => `<div class="line"><span>${esc(what)}</span><a href="${esc(url)}">view</a></div>`).join('')}</section>` : ''}
        </div>
        <div class="stack">
          <section class="sheet fund">
            <h2>Add funds</h2>
            <p class="quiet small">Send USDC <b>on Base</b> to the address only this contract can sign for.</p>
            <div class="dare-key"><code title="${esc(policy.from)}">${esc(policy.from)}</code><button type="button" class="ghost" data-copy="${esc(policy.from)}">Copy</button></div>
            ${agentNear === null ? '' : `<p class="faint small">The agent pays NEAR gas to ask: <b class="${agentNear < 0.35 ? 'bad-text' : ''}">${agentNear.toFixed(2)} NEAR</b> on <a href="${EXPLORER}/address/${esc(policy.agent)}">${esc(short(policy.agent, 28))}</a>.${agentNear < 0.35 ? ' Send it some NEAR before it runs out.' : ''}</p>`}
          </section>
          <section class="sheet">
            <h2>Sellers it may pay</h2>
            ${policy.payees.map((p) => {
              const wait = policy.waiting_payees?.find(([w]) => w === p);
              return `<div class="line"><span>${baseLink(p)}</span><span class="line-end">${wait ? `<span class="soon" title="Payments to it wait for the owner until then">asks the owner, ${esc(until(wait[1]).replace('in ', 'for '))}</span>` : '<span class="ready">Payable</span>'}${owner && !revoked && wait ? `<button class="ghost tiny" type="button" data-trust="${esc(p)}" title="End the wait: its payments stop asking you">Trust now</button>` : ''}${owner && !revoked ? `<button class="ghost tiny" type="button" data-remove="${esc(p)}" aria-label="Remove ${esc(seller(p))}">Remove</button>` : ''}</span></div>`;
            }).join('')}
            ${upgraded ? `<p class="faint" style="font-size:13px;margin-top:10px">For ${Math.round(Number(policy.payee_delay_s) / 3600)} hours after a seller is added, every payment to it waits for the owner’s OK, so nothing reaches a new seller unseen.</p>` : ''}
          </section>
          ${upgraded ? `<section class="sheet">
            <h2>If something is wrong</h2>
            <p class="quiet" style="margin-bottom:14px">Cut the agent off in one transaction. Everything waiting is refused, and the money stays in the wallet.</p>
            <button class="stop" id="revoke" ${owner && !revoked ? '' : 'disabled'}>${revoked ? 'Agent revoked' : 'Revoke the agent'}</button>
            ${owner || revoked ? '' : '<p class="faint" style="font-size:13px;margin-top:10px">Only the owner’s wallet can do this.</p>'}
          </section>` : ''}
        </div>
      </div>`;
    if (!$('rest')) {
      $('app').innerHTML = `<div class="layout"><aside class="side">${PITCH}<div id="today"></div><div id="mine"></div>${QUESTIONS}</aside><div class="flow"><div id="notice" role="alert"></div><div id="asking"></div><div id="gate"></div>${upgraded && PROOF.length ? DARE_HTML : ''}<div id="rest" class="stack-rest"></div><div id="owner-tools"></div></div></div>${TERMS}`;
      // One listener for the buttons inside parts that redraw: copy, and the owner's per-seller remove.
      $('app').addEventListener('click', (ev) => {
        const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-copy], button[data-remove], button[data-trust]');
        if (!b) return;
        if (b.dataset.copy) {
          void navigator.clipboard?.writeText(b.dataset.copy);
          b.textContent = 'Copied';
          setTimeout(() => (b.textContent = 'Copy'), 1500);
        } else if (b.dataset.remove) void send('remove_payee', { payee: b.dataset.remove }).catch(show);
        else if (b.dataset.trust) void send('trust_payee', { payee: b.dataset.trust }).catch(show);
      });
      $('app').querySelectorAll<HTMLButtonElement>('button[data-steal]').forEach((b) => b.addEventListener('click', () => void steal(b.dataset.steal!, b)));
      $('dare-copy')?.addEventListener('click', () => void navigator.clipboard?.writeText(DARE.key));
    }
    if (todayHtml !== lastToday) {
      $('today').innerHTML = todayHtml;
      lastToday = todayHtml;
    }
    // Three parts, each redrawn only when it changes: the minute hand on the history mustn't replay the gate's animation.
    if (gateHtml !== lastGate) {
      $('gate').innerHTML = gateHtml;
      lastGate = gateHtml;
      $('gate').querySelectorAll<HTMLButtonElement>('button[data-try]').forEach((b) => b.addEventListener('click', () => void tryPayment(policy, b.dataset.try!).catch(show)));
    }
    if (askHtml !== lastAsk) {
      $('asking').innerHTML = askHtml;
      lastAsk = askHtml;
      $('asking').querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => b.addEventListener('click', () => void send(b.dataset.act!, { id: b.dataset.id }).catch(show)));
    }
    // Answered once on the first look, so the first thing anyone sees is the contract refusing an attacker.
    if (upgraded && !revoked && !tried && !triedOnLoad) {
      triedOnLoad = true;
      void tryPayment(policy, 'attack').catch(() => undefined);
    }
    const toolsHtml = owner && upgraded && !revoked ? `<section class="sheet tools" aria-label="Change the rules">
        <h2>Change the rules</h2>
        <form id="limits" class="row-form"><label class="field"><span>Most per payment ($)</span><input name="per" inputmode="decimal" value="${cap / 1e6}"></label><label class="field"><span>Most per day ($)</span><input name="day" inputmode="decimal" value="${daily / 1e6}"></label><button class="ghost">Save limits</button></form>
        <form id="add-seller" class="row-form"><label class="field grow"><span>Add a seller (Base address)</span><input name="payee" placeholder="0x…" spellcheck="false" autocomplete="off"></label><button class="ghost">Add</button></form>
        <div class="row-form"><p class="faint small grow">Payments to a new seller wait for your OK for ${Math.round(Number(policy.payee_delay_s) / 3600)} h. Each change opens your wallet to confirm.</p><button class="ghost" type="button" id="pause">${policy.paused ? 'Resume the agent' : 'Pause the agent'}</button></div>
        <p id="tools-say" class="small" role="status"></p>
      </section>` : '';
    if (toolsHtml !== lastTools) {
      $('owner-tools').innerHTML = toolsHtml;
      lastTools = toolsHtml;
      bindTools(policy);
    }
    void drawMine();
    if (html !== lastOk) {
      $('rest').innerHTML = html;
      lastOk = html;
      $('revoke')?.addEventListener('click', () => {
        if (confirm('Cut the agent off now? Everything waiting is refused.')) void send('revoke', {}).catch(show);
      });
    }
    drawLink();
    return true;
  } catch (e) {
    // A busy RPC while the page is up only turns the bar's pill amber: the numbers below are the last good read.
    if ($('rest') && !(e instanceof ContractError)) {
      Object.assign(link, { ok: false, why: message(e) });
      drawLink();
    } else show(e);
    return false;
  }
}

const message = (e: unknown) => String((e as Error)?.message ?? e ?? 'unknown error');
/**
 * A failed read or action. Once the page is drawn it stays: the last good numbers are still true, so the error goes in
 * a note above them (and the bar shows the RPC retrying). Only a page that never loaded is replaced by the error.
 */
function show(e: unknown) {
  if (!(e instanceof ContractError)) Object.assign(link, { ok: false, why: message(e) });
  drawLink();
  const text = e instanceof ContractError ? `The contract answered with an error: ${message(e)}` : message(e);
  if ($('rest')) {
    $('notice').innerHTML = `<div class="note-bar"><span>${esc(text)}</span><button class="ghost" type="button" id="notice-x" aria-label="Dismiss">Dismiss</button></div>`;
    $('notice-x').addEventListener('click', () => ($('notice').innerHTML = ''));
    return;
  }
  // Just back from the wallet after setting one up: the factory takes ~15 s, so the contract may not be there yet.
  if (q.has('made') && e instanceof ContractError) {
    $('app').innerHTML = `<p class="loading"><span class="saku-wait" role="status">${esc(contract)} is being set up. This takes about 15 seconds…</span></p>`;
    return;
  }
  $('app').innerHTML = `<div class="note-bar fail"><span>Couldn’t read <code>${esc(contract)}</code> on ${network}. ${esc(text)}.</span><button class="ghost" type="button" id="again">Try again</button></div>`;
  $('again').addEventListener('click', () => void poll());
}

/** Reads every 15 s while the tab is visible. After a failure it waits 10, 20, 40, then 60 s, so a busy RPC can recover. */
const POLL = 15_000;
let fails = 0;
let nextAt = 0;
let timer = 0;
async function poll() {
  clearTimeout(timer);
  nextAt = 0;
  const ok = await refresh();
  if (ok) $('notice')?.replaceChildren();
  fails = ok ? 0 : fails + 1;
  schedule(ok ? POLL : Math.min(60_000, 10_000 * 2 ** (fails - 1)));
}
function schedule(ms: number) {
  clearTimeout(timer);
  nextAt = Date.now() + ms;
  timer = window.setTimeout(() => (document.hidden ? schedule(POLL) : void poll()), ms);
  drawLink();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - link.at > POLL) void poll();
});

function drawLink() {
  const el = document.getElementById('link');
  if (!el) return;
  const wait = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
  const age = Math.max(0, Math.round((Date.now() - link.at) / 1000));
  if (!link.ok) {
    el.className = 'link busy';
    el.innerHTML = `<i></i>RPC busy<span> · ${nextAt ? `retry in ${wait}s` : 'retrying…'}</span>`;
    el.title = `${link.why}. Click to try again now.`;
  } else if (link.at) {
    el.className = 'link ok';
    el.innerHTML = `<i></i>Live<span> · ${age < 5 ? 'just now' : `${age}s ago`}</span><span class="via"> via ${esc(link.via)}</span>`;
    el.title = `Read from ${link.via}${nextAt ? `, next read in ${wait}s` : ''}. Click to read now.`;
  } else {
    el.className = 'link';
    el.innerHTML = '<i></i>Connecting…';
  }
}

void (async () => {
  $('where').innerHTML = `<b class="${network === 'testnet' ? 'test' : ''}">${network}</b>${esc(setupMode ? 'new allowance' : contract)}`;
  const form = document.querySelector<HTMLFormElement>('form.pick')!;
  (form.elements.namedItem('contract') as HTMLInputElement).value = contract;
  (form.elements.namedItem('network') as HTMLSelectElement).value = network;
  $('link').addEventListener('click', () => void (setupMode ? redraw() : poll()));
  setInterval(drawLink, 1000);
  if (setupMode) await drawSetup({ network, factory: FACTORY, esc, viewOf, signedIn, sendTo });
  else await poll();
  try {
    const [core, myNear, meteor] = await Promise.all([import('@near-wallet-selector/core'), import('@near-wallet-selector/my-near-wallet'), import('@near-wallet-selector/meteor-wallet')]);
    functionCall = core.actionCreators.functionCall as never;
    selector = await core.setupWalletSelector({ network, modules: [myNear.setupMyNearWallet(), meteor.setupMeteorWallet()] });
    let seen = signedIn();
    selector.store.observable.subscribe(() => {
      // Redraw only when the account changes: the store also ticks on things the page doesn't show.
      if (signedIn() === seen) return;
      seen = signedIn();
      void redraw();
    });
    header();
    void redraw();
  } catch (e) {
    console.error('wallets_unavailable', e);
    $('who').textContent = 'Read-only: wallets could not load.';
  }
})();
