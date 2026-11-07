import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/instrument-sans/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import './style.css';
import { Buffer } from 'buffer';
import type { WalletSelector } from '@near-wallet-selector/core';

// The wallet libraries expect Node's Buffer as they load, so it's in place before they're imported, further down.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

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
const RPC = network === 'testnet' ? 'https://test.rpc.fastnear.com' : 'https://rpc.mainnet.fastnear.com';
const EXPLORER = network === 'testnet' ? 'https://testnet.nearblocks.io' : 'https://nearblocks.io';
const GAS = '300000000000000';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const usd = (micro: string | number) => `$${(Number(micro) / 1e6).toFixed(3)}`;
const short = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
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

async function view<T>(method: string, args: object = {}): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) } }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) throw new Error(String(j.error?.data ?? j.result?.error));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
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

async function send(method: string, args: object, deposit = '1') {
  if (!selector || !functionCall) return;
  const wallet = await selector.wallet();
  await wallet.signAndSendTransaction({ receiverId: contract, actions: [functionCall(method, args, BigInt(GAS), BigInt(deposit))] as never });
  await refresh();
}

const WORDS: Record<string, [string, string]> = {
  signed: ['Signed', 'ok'], held: ['Held', 'wait'], refused: ['Refused', 'bad'], approved: ['Approved', 'ok'], rejected: ['Rejected', 'bad'], sign_failed: ['Sign failed', 'bad'],
  revoked: ['Revoked', 'bad'], payee_added: ['Seller added', 'note'], payee_removed: ['Seller removed', 'note'], limits_changed: ['Limits changed', 'note'], paused: ['Paused', 'bad'], resumed: ['Resumed', 'ok'],
};

function header(owner?: string) {
  const me = signedIn();
  const mine = me && owner === me;
  if (!selector) return;
  $('who').innerHTML = me
    ? `<span>${esc(me)}${mine ? ' · owner' : ' · not the owner'}</span><button class="ghost" id="out">Disconnect</button>`
    : `<span>Owner? Connect</span><button class="ghost" id="connect-my">MyNearWallet</button><button class="ghost" id="connect-meteor">Meteor</button>`;
  $('who').querySelector('#out')?.addEventListener('click', async () => {
    await (await selector!.wallet()).signOut();
    void refresh();
  });
  for (const [id, wallet] of [['connect-my', 'my-near-wallet'], ['connect-meteor', 'meteor-wallet']] as const) {
    $('who').querySelector(`#${id}`)?.addEventListener('click', async () => {
      const w = (await selector!.wallet(wallet)) as unknown as { signIn: (o: { contractId: string; methodNames: string[] }) => Promise<unknown> };
      await w.signIn({ contractId: contract, methodNames: [] });
      void refresh();
    });
  }
}

/** What the contract itself just said to a pretend payment. Anyone can ask, because `check` is a free view. */
let tried: { label: string; answer: string | null } | null = null;
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
  tried = { label, answer };
  lastOk = '';
  await refresh();
}

let lastOk = '';
async function refresh() {
  try {
    const policy = await view<Policy>('get_policy');
    const upgraded = policy.approval_max !== undefined;
    const [held, history, usdc] = await Promise.all([upgraded ? view<Held[]>('list_held') : Promise.resolve([]), upgraded ? view<Entry[]>('get_history') : Promise.resolve([]), baseUsdc(policy.from)]);
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
    const html = `
      ${upgraded ? '' : '<div class="note-bar">This contract was deployed before approvals, new-seller waits and history. It still enforces its budget, shown below.</div>'}
      <section class="hero" aria-label="Today's budget">
        <div>
          <p class="hero-say">${revoked ? 'This agent has been cut off. The money is still in the wallet, and nothing can be signed for it.' : policy.paused ? 'Paused by the owner. Nothing can be signed until it’s resumed.' : 'This AI agent spends real money and holds no key that can move it. A NEAR contract signs for it, only within these limits.'}</p>
          <div class="hero-spent"><strong>${usd(spent)}</strong><span>spent of ${usd(daily)} today</span></div>
          <div class="cells" role="img" aria-label="${usd(spent)} of ${usd(daily)} spent">${Array.from({ length: cells }, (_, n) => `<i style="--fill:${Math.max(0, Math.min(1, spent / (daily / cells) - n)) * 100}%"></i>`).join('')}</div>
          <p class="cells-say">${usd(left)} left today. Each block is ${usd(daily / cells)}.</p>
        </div>
        <dl class="facts">
          <div><dt>Status</dt><dd class="state ${off ? 'off' : 'on'}">${revoked ? 'Revoked' : policy.paused ? 'Paused' : 'Active'}</dd></div>
          ${usdc === null ? '' : `<div><dt>In the wallet</dt><dd class="money">$${usdc.toFixed(3)} USDC</dd></div>`}
          <div><dt>Signs on its own up to</dt><dd class="money">${usd(cap)}</dd></div>
          ${upgraded ? `<div><dt>Owner can approve up to</dt><dd class="money">${usd(policy.approval_max!)}</dd></div>` : ''}
        </dl>
      </section>

      ${waiting.length ? `<section class="ask" aria-label="Waiting for the owner">
        <h2>${waiting.length === 1 ? 'A payment is' : `${waiting.length} payments are`} waiting for the owner</h2>
        <p class="quiet" style="font-size:14px">Nothing is signed until the owner decides.${owner ? '' : ' Connect the owner’s wallet to decide.'}</p>
        ${waiting.map((h) => `<div class="ask-row"><div><span class="ask-amount">${usd(h.value)}</span> to ${baseLink(`0x${h.to}`)}<div class="faint" style="font-size:13px">${esc(h.why)} · expires ${esc(until(h.valid_before))}</div></div><div class="ask-buttons"><button class="go" data-act="approve" data-id="${esc(h.id)}" ${owner ? '' : 'disabled'}>Approve</button><button class="ghost" data-act="reject" data-id="${esc(h.id)}" ${owner ? '' : 'disabled'}>Reject</button></div></div>`).join('')}
      </section>` : ''}

      ${upgraded && !revoked ? `<section class="sheet tryit">
        <h2>Try to break it</h2>
        <p class="quiet">Ask this contract, live on ${network}, what it would do. No wallet needed, and nothing is sent.</p>
        <div class="try-buttons">
          <button class="stop" data-try="attack">Send $5 to an attacker</button>
          <button class="ghost" data-try="unusual">$0.018, over the limit</button>
          <button class="ghost" data-try="normal">$0.002, inside the rules</button>
        </div>
        ${tried ? (() => {
          const a = tried.answer;
          const held = a?.startsWith('held:');
          return `<div class="try-answer" role="status"><span class="stamp ${!a ? 'ok' : held ? 'wait' : 'bad'}">${!a ? 'Would sign' : held ? 'Would hold' : 'Refused'}</span> <span>${esc(tried.label)}</span><span class="why">${!a ? 'Inside the rules, so NEAR’s MPC would sign it.' : held ? `Nothing is signed until the owner approves: ${esc(a!.replace('held: ', ''))}.` : `The contract’s own answer: “${esc(a)}”.`}</span></div>`;
        })() : ''}
      </section>` : ''}

      <section class="path" aria-label="Who can move the money">
        <div><b>Agent</b><span class="does">${revoked ? 'cut off' : 'can only ask'}</span><span class="who-is">${revoked ? 'no agent' : esc(policy.agent)}</span></div>
        <div class="rules-here"><b>Contract</b><span class="does">checks the owner’s rules</span><span class="who-is"><a href="${EXPLORER}/address/${esc(contract)}">${esc(contract)}</a></span></div>
        <div><b>NEAR MPC</b><span class="does">11 of 17 nodes sign</span><span class="who-is">${esc(policy.signer)}</span></div>
        <div><b>Base wallet</b><span class="does">pays any x402 seller</span><span class="who-is"><a href="https://basescan.org/address/${esc(policy.from)}">${esc(short(policy.from))}</a></span></div>
      </section>

      <div class="split">
        <div class="stack">
        <section class="sheet">
          <h2>What happened</h2>
          ${upgraded ? (history2.length ? `<table class="ledger">${history2.slice(0, 14).map((e) => {
            const [word, tone] = WORDS[e.what] ?? [e.what, 'note'];
            return `<tr><td><span class="stamp ${tone}">${esc(word)}</span></td><td>${e.to ? baseLink(e.to) : ''}${e.note ? `<span class="why">${esc(e.note)}</span>` : ''}</td><td class="amt">${Number(e.value) ? usd(e.value) : ''}</td><td class="when" title="${esc(when(e.at))}">${esc(ago(e.at))}</td></tr>`;
          }).join('')}</table>` : '<p class="quiet">Nothing yet. Every payment the agent asks for lands here, refused ones too.</p>') : '<p class="quiet">This contract keeps no history yet.</p>'}
        </section>
          ${PROOF.length ? `<section class="sheet proof"><h2>Real receipts</h2>${PROOF.map(([what, url]) => `<div class="line"><span>${esc(what)}</span><a href="${esc(url)}">view</a></div>`).join('')}</section>` : ''}
        </div>
        <div class="stack">
          <section class="sheet">
            <h2>Sellers it may pay</h2>
            ${policy.payees.map((p) => {
              const wait = policy.waiting_payees?.find(([w]) => w === p);
              return `<div class="line"><span>${baseLink(p)}</span>${wait ? `<span class="soon">payable ${esc(until(wait[1]))}</span>` : '<span class="ready">Payable</span>'}</div>`;
            }).join('')}
            ${upgraded ? `<p class="faint" style="font-size:13px;margin-top:10px">A new seller waits ${Math.round(Number(policy.payee_delay_s) / 3600)} hours, so a stolen owner key can’t add an attacker and spend at once.</p>` : ''}
          </section>
          ${upgraded ? `<section class="sheet">
            <h2>If something is wrong</h2>
            <p class="quiet" style="margin-bottom:14px">Cut the agent off in one transaction. Everything waiting is refused, and the money stays in the wallet.</p>
            <button class="stop" id="revoke" ${owner && !revoked ? '' : 'disabled'}>${revoked ? 'Agent revoked' : 'Revoke the agent'}</button>
            ${owner || revoked ? '' : '<p class="faint" style="font-size:13px;margin-top:10px">Only the owner’s wallet can do this.</p>'}
          </section>` : ''}
        </div>
      </div>`;
    if (html !== lastOk) {
      $('app').innerHTML = html;
      lastOk = html;
      $('app').querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => b.addEventListener('click', () => void send(b.dataset.act!, { id: b.dataset.id }).catch(show)));
      $('app').querySelectorAll<HTMLButtonElement>('button[data-try]').forEach((b) => b.addEventListener('click', () => void tryPayment(policy, b.dataset.try!).catch(show)));
      $('revoke')?.addEventListener('click', () => {
        if (confirm('Cut the agent off now? Everything waiting is refused.')) void send('revoke', {}).catch(show);
      });
    }
  } catch (e) {
    show(e);
  }
}

function show(e: unknown) {
  $('app').innerHTML = `<div class="note-bar">Couldn’t read <code>${esc(contract)}</code> on ${network}: ${esc((e as Error).message ?? e)}</div>`;
  lastOk = '';
}

void (async () => {
  $('where').innerHTML = `<b class="${network === 'testnet' ? 'test' : ''}">${network}</b>${esc(contract)}`;
  const form = document.querySelector<HTMLFormElement>('form.pick')!;
  (form.elements.namedItem('contract') as HTMLInputElement).value = contract;
  (form.elements.namedItem('network') as HTMLSelectElement).value = network;
  await refresh();
  setInterval(() => void refresh(), 5000);
  try {
    const [core, myNear, meteor] = await Promise.all([import('@near-wallet-selector/core'), import('@near-wallet-selector/my-near-wallet'), import('@near-wallet-selector/meteor-wallet')]);
    functionCall = core.actionCreators.functionCall as never;
    selector = await core.setupWalletSelector({ network, modules: [myNear.setupMyNearWallet(), meteor.setupMeteorWallet()] });
    selector.store.observable.subscribe(() => {
      lastOk = '';
      void refresh();
    });
    lastOk = '';
    void refresh();
  } catch (e) {
    console.error('wallets_unavailable', e);
    $('who').textContent = 'Read-only: wallets could not load.';
  }
})();
