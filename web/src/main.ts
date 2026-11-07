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
  signed: ['Signed', 'ok'], held: ['Held for the owner', 'wait'], refused: ['Refused', 'bad'], approved: ['Owner approved', 'ok'], rejected: ['Owner rejected', 'bad'], sign_failed: ['Signing failed', 'bad'],
  revoked: ['Agent revoked', 'bad'], payee_added: ['Seller added', 'wait'], payee_removed: ['Seller removed', 'muted'], limits_changed: ['Limits changed', 'muted'], paused: ['Paused', 'bad'], resumed: ['Resumed', 'ok'],
};

function header(owner?: string) {
  const me = signedIn();
  const mine = me && owner === me;
  if (!selector) return;
  $('who').innerHTML = me
    ? `<span class="${mine ? 'ok' : 'muted'}">${esc(me)}${mine ? ' · owner' : ' · not the owner'}</span> <button id="out">Disconnect</button>`
    : `<button class="go" id="connect-my">MyNearWallet</button> <button class="go" id="connect-meteor">Meteor</button>`;
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
    const html = `
      ${upgraded ? '' : '<div class="note">This contract was deployed before approvals, new-seller waits and history. It still enforces its budget, shown below.</div>'}
      <div class="grid">
        <section class="card">
          <h2>Today</h2>
          <div class="big">${usd(policy.spent_today)} <span class="muted" style="font-size:16px;font-weight:600">of ${usd(policy.daily_limit)}</span></div>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <div class="row"><span class="muted">Status</span><span>${revoked ? '<span class="pill bad">Agent revoked</span>' : policy.paused ? '<span class="pill bad">Paused</span>' : '<span class="pill ok">Active</span>'}</span></div>
          <div class="row"><span class="muted">Each payment, at most</span><span>${usd(policy.per_payment_max)}</span></div>
          ${upgraded ? `<div class="row"><span class="muted">Owner can approve up to</span><span>${usd(policy.approval_max!)}</span></div>` : ''}
          ${usdc === null ? '' : `<div class="row"><span class="muted">USDC in the wallet</span><span>$${usdc.toFixed(3)}</span></div>`}
        </section>
        <section class="card">
          <h2>Who holds what</h2>
          <div class="row"><span class="muted">Contract</span><span><a class="mono" href="${EXPLORER}/address/${esc(contract)}">${esc(contract)}</a></span></div>
          <div class="row"><span class="muted">Owner</span><span class="mono">${esc(policy.owner)}</span></div>
          <div class="row"><span class="muted">Agent (can only ask)</span><span class="mono">${revoked ? 'none' : esc(policy.agent)}</span></div>
          <div class="row"><span class="muted">Base wallet</span><span><a class="mono" href="https://basescan.org/address/${esc(policy.from)}">${esc(short(policy.from))}</a></span></div>
          <div class="row"><span class="muted">Signed by</span><span class="mono">${esc(policy.signer)}</span></div>
        </section>
        <section class="card">
          <h2>Sellers it may pay</h2>
          ${policy.payees.map((p) => {
            const wait = policy.waiting_payees?.find(([w]) => w === p);
            return `<div class="row"><a class="mono" href="https://basescan.org/address/${esc(p)}">${esc(short(p))}</a><span>${wait ? `<span class="pill wait">payable ${esc(when(wait[1]))}</span>` : '<span class="pill ok">Payable</span>'}</span></div>`;
          }).join('')}
        </section>
      </div>
      ${upgraded ? `
      <section class="card">
        <h2>Waiting for the owner (${waiting.length})</h2>
        ${waiting.length ? waiting.map((h) => `<div class="held"><div><b>${usd(h.value)}</b> to <a class="mono" href="https://basescan.org/address/0x${esc(h.to)}">${esc(short(`0x${h.to}`))}</a><div class="muted">${esc(h.why)} · expires ${esc(when(h.valid_before))}</div></div><div class="actions"><button class="go" data-act="approve" data-id="${esc(h.id)}" ${owner ? '' : 'disabled'}>Approve</button><button data-act="reject" data-id="${esc(h.id)}" ${owner ? '' : 'disabled'}>Reject</button></div></div>`).join('') : '<p class="muted" style="margin:0">Nothing is waiting. Unusual payments stop here until the owner decides.</p>'}
        ${waiting.length && !owner ? '<p class="muted" style="margin:10px 0 0">Connect the owner’s wallet to decide.</p>' : ''}
      </section>
      <section class="card">
        <h2>What the agent did</h2>
        ${history.length ? `<div class="scroll"><table><tr><th>When</th><th>What</th><th>Amount</th><th>To</th><th>Why</th></tr>${history.map((e) => {
          const [word, tone] = WORDS[e.what] ?? [e.what, 'muted'];
          return `<tr><td class="muted">${esc(when(e.at))}</td><td class="${tone}"><b>${esc(word)}</b></td><td>${Number(e.value) ? usd(e.value) : ''}</td><td class="mono">${e.to ? esc(short(e.to)) : ''}</td><td class="muted">${esc(e.note)}</td></tr>`;
        }).join('')}</table></div>` : '<p class="muted" style="margin:0">Nothing yet.</p>'}
      </section>
      <section class="card">
        <h2>If something is wrong</h2>
        <p class="muted" style="margin-top:0">Revoking cuts the agent off in one transaction and refuses everything waiting. The money stays in the wallet, and coming back takes a new agent account.</p>
        <button class="stop" id="revoke" ${owner && !revoked ? '' : 'disabled'}>${revoked ? 'Agent revoked' : 'Revoke the agent'}</button>
      </section>` : ''}
      <section class="card">
        <h2>Look at another allowance</h2>
        <form class="pick"><input name="contract" value="${esc(contract)}" aria-label="Contract account" /><select name="network" aria-label="Network"><option ${network === 'mainnet' ? 'selected' : ''}>mainnet</option><option ${network === 'testnet' ? 'selected' : ''}>testnet</option></select><button>Open</button></form>
      </section>`;
    if (html !== lastOk) {
      $('app').innerHTML = html;
      lastOk = html;
      $('app').querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => b.addEventListener('click', () => void send(b.dataset.act!, { id: b.dataset.id }).catch(show)));
      $('revoke')?.addEventListener('click', () => {
        if (confirm('Cut the agent off now? Everything waiting is refused.')) void send('revoke', {}).catch(show);
      });
    }
  } catch (e) {
    show(e);
  }
}

function show(e: unknown) {
  $('app').innerHTML = `<div class="note">Couldn’t read <code>${esc(contract)}</code> on ${network}: ${esc((e as Error).message ?? e)}</div>`;
  lastOk = '';
}

void (async () => {
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
