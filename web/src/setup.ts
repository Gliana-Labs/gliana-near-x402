/**
 * The setup page (`?new`): one wallet call to the factory (contract/factory) makes `<name>.<factory>`, the allowance
 * contract that holds the agent's Base wallet, and `agent-<name>.<factory>`, the agent's NEAR account. The agent's
 * key is made here, in the owner's browser, and only its public half is sent. The owner downloads the private half
 * before the create button unlocks: it is never stored, sent, or shown again.
 */
export type SetupDeps = {
  network: 'mainnet' | 'testnet';
  factory: string;
  esc: (s: unknown) => string;
  viewOf: <T>(account: string, method: string, args?: object) => Promise<T>;
  signedIn: () => string | null;
  /** Sends one function call from the connected wallet. Redirect wallets leave the page and come back to `back`. */
  sendTo: (receiver: string, method: string, args: object, deposit: bigint, back: string) => Promise<void>;
};

/** Sellers worth offering by default: both answer x402 on Base. */
const DEFAULT_SELLERS = ['0x7662e00f8ab4c362166e1ff649ff6c2a638c80ad', '0x6d6e695b09861467c7d462f5aaf31cf3540b9192'];
const STORAGE_NEAR = 2.5;
const YOCTO = 10n ** 24n;

let agentKey: { pub: string; secret: string } | null = null;
let savedFor = '';
let factoryUp: boolean | null = null;

function nearToYocto(n: string): bigint {
  const [whole, frac = ''] = n.trim().split('.');
  return BigInt(whole || '0') * YOCTO + BigInt((frac + '0'.repeat(24)).slice(0, 24));
}
const micro = (dollars: string) => Math.round(Number(dollars) * 1e6);

export async function drawSetup(d: SetupDeps) {
  const app = document.getElementById('app')!;
  const me = d.signedIn();
  if (factoryUp === null) factoryUp = await d.viewOf(d.factory, 'get_config').then(() => true, () => false);
  const intro = `<span class="eyebrow"><i></i>Set up · NEAR ${d.network}</span>
    <h1>Your own allowance</h1>
    <p class="pitch-say">One transaction from your wallet sets up the contract that holds your agent’s wallet on Base, and the agent’s own NEAR account. The contract is made with no key of its own, so nobody can change its code afterwards, us included.</p>`;
  const warn = d.network === 'mainnet'
    ? '<div class="note-bar fail"><span><b>Mainnet means real money.</b> The contract is experimental and hasn’t been audited. Fund it only with what you can afford to lose, or <a href="?new&network=testnet">try it on testnet</a> first.</span></div>'
    : '<div class="note-bar"><span>Testnet: free test NEAR, nothing real at stake. Get some at <a href="https://near-faucet.io">near-faucet.io</a>.</span></div>';
  let body: string;
  if (!factoryUp) {
    body = `<div class="note-bar"><span>Setup isn’t open on ${d.network} yet. <a href="?new&network=testnet">Try it on testnet</a>.</span></div>`;
  } else if (!me) {
    body = `<div class="sheet"><h2>Step 1</h2><p class="quiet">Connect your NEAR ${d.network} wallet with the buttons at the top. That account becomes the owner: the only one who can approve, change the rules, or cut the agent off.</p></div>`;
  } else {
    body = `<form id="setup" class="sheet setup-form" autocomplete="off">
      <h2>Owner: ${d.esc(me)}</h2>
      <label class="field"><span>Name</span><span class="with-suffix"><input name="name" required pattern="[a-z0-9]+(-[a-z0-9]+)*" minlength="2" maxlength="24" spellcheck="false" placeholder="my-agent"><em>.${d.esc(d.factory)}</em></span><small id="name-say" class="faint">a-z, 0-9 and dashes. The agent gets <code>agent-&lt;name&gt;.${d.esc(d.factory)}</code>.</small></label>
      <div class="two">
        <label class="field"><span>Most per payment ($)</span><input name="per" inputmode="decimal" value="0.01" required></label>
        <label class="field"><span>Most per day ($)</span><input name="day" inputmode="decimal" value="0.05" required></label>
      </div>
      <label class="field"><span>Sellers it may pay (one Base address per line)</span><textarea name="sellers" rows="3" spellcheck="false">${DEFAULT_SELLERS.join('\n')}</textarea><small class="faint">Filled in: GlianaAI and Exa. Anyone else is refused, and a seller added later waits before it can be paid.</small></label>
      <div class="two">
        <label class="field"><span>A new seller waits (hours)</span><input name="wait" inputmode="numeric" value="24" required></label>
        <label class="field"><span>NEAR for the agent’s gas</span><input name="gas" inputmode="decimal" value="0.5" required></label>
      </div>
      <p class="total" id="total"></p>
      <div class="steps">
        <button type="button" class="ghost" id="save-key">1. Download the agent’s key</button>
        <button type="submit" class="go" id="make" disabled>2. Create</button>
      </div>
      <p class="faint small">The agent’s key is made in this browser. Only its public half goes on chain. Keep the file: it’s the only copy, and your agent signs its payment requests with it.</p>
      <div id="setup-out" role="status"></div>
    </form>`;
  }
  app.innerHTML = `<div class="setup-page"><section class="pitch">${intro}</section>${warn}${body}</div>`;
  const form = document.getElementById('setup') as HTMLFormElement | null;
  if (!form || !me) return;

  const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const out = document.getElementById('setup-out')!;
  const say = (html: string) => (out.innerHTML = html);
  const make = document.getElementById('make') as HTMLButtonElement;
  const name = () => field('name').value.trim();
  const agentId = () => `agent-${name()}.${d.factory}`;
  const total = () => STORAGE_NEAR + Number(field('gas').value || 0);
  const ready = () => {
    document.getElementById('total')!.innerHTML = `You attach <b>${total().toFixed(2)} NEAR</b>: 2.50 locked as the contract’s storage, ${Number(field('gas').value || 0).toFixed(2)} to the agent.`;
    make.disabled = !(savedFor && savedFor === name() && form.checkValidity());
  };
  let check = 0;
  field('name').addEventListener('input', () => {
    ready();
    const n = name();
    const hint = document.getElementById('name-say')!;
    clearTimeout(check);
    if (!field('name').checkValidity() || n.length < 2 || n.startsWith('agent-')) return void (hint.textContent = 'a-z, 0-9 and single dashes, 2 to 24 long, not starting with agent-.');
    check = window.setTimeout(async () => {
      const taken = await d.viewOf<boolean>(d.factory, 'is_taken', { name: n }).catch(() => null);
      if (n === name()) hint.innerHTML = taken === null ? 'Couldn’t check the name just now. The factory refuses a taken one anyway.' : taken ? '<span class="bad-text">That name is taken.</span>' : `Free. The agent gets <code>${d.esc(agentId())}</code>.`;
    }, 350);
  });
  form.addEventListener('input', ready);
  ready();

  document.getElementById('save-key')!.addEventListener('click', async () => {
    if (!field('name').checkValidity()) return void field('name').reportValidity();
    const { KeyPair } = await import('@near-js/crypto');
    if (!agentKey) {
      const kp = KeyPair.fromRandom('ed25519');
      agentKey = { pub: kp.getPublicKey().toString(), secret: kp.toString() };
    }
    const file = new Blob([JSON.stringify({ account_id: agentId(), public_key: agentKey.pub, private_key: agentKey.secret }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: `${agentId()}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
    savedFor = name();
    (document.getElementById('save-key') as HTMLButtonElement).textContent = `1. Saved ${agentId()}.json ✓`;
    ready();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!agentKey || savedFor !== name()) return;
    const sellers = field('sellers').value.split(/\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const per = micro(field('per').value);
    const day = micro(field('day').value);
    const wait = Math.round(Number(field('wait').value) * 3600);
    const problem = !sellers.length ? 'List at least one seller.'
      : sellers.find((s) => !/^0x[0-9a-f]{40}$/.test(s)) ? `“${sellers.find((s) => !/^0x[0-9a-f]{40}$/.test(s))}” isn’t a Base address (0x and 40 hex digits).`
      : !(per > 0) || !(day >= per) ? 'The most per payment must be above $0 and no more than the most per day.'
      : !(wait >= 0 && wait <= 30 * 86400) ? 'A new seller’s wait is 0 to 720 hours.'
      : !(Number(field('gas').value) >= 0.5) ? 'Give the agent at least 0.5 NEAR for gas.' : '';
    if (problem) return say(`<p class="bad-text">${d.esc(problem)}</p>`);
    const child = `${name()}.${d.factory}`;
    const back = `${location.pathname}?contract=${encodeURIComponent(child)}&network=${d.network}&made=1`;
    make.disabled = true;
    say('<p class="quiet">Confirm in your wallet…</p>');
    try {
      await d.sendTo(d.factory, 'create', { name: name(), agent_key: agentKey.pub, rules: { per_payment_max: String(per), daily_limit: String(day), payees: sellers, payee_delay_s: String(wait) } }, nearToYocto(String(total())), back);
      location.href = back;
    } catch (e) {
      make.disabled = false;
      say(`<p class="bad-text">${d.esc(String((e as Error)?.message ?? e).slice(0, 200))}</p>`);
    }
  });
}
