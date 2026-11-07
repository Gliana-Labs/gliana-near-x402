/**
 * Tells the owner when the contract is holding a payment for them. Without this they only find out by having the web
 * page open, and a held payment waits on nobody else.
 *
 *   ALLOWANCE=allowance.you.near npm run allowance:watch
 *
 * Prints to the terminal. With TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID set it also sends a Telegram message, which needs
 * nothing that can sign: this reads the contract and holds no NEAR key at all. ONCE=1 checks a single time, for cron.
 */
import { pathToFileURL } from 'node:url';
import { JsonRpcProvider } from '@near-js/providers';
import { rpcUrl, type NearNetwork } from './x402-payer.js';

export type HeldPayment = { id: string; to: string; value: string; why: string; status: string };

/** The ones still waiting that haven't been announced. Adds them to `seen`, so each is announced once. */
export function newlyHeld(list: HeldPayment[], seen: Set<string>): HeldPayment[] {
  const fresh = list.filter((h) => h.status === 'waiting' && !seen.has(h.id));
  for (const h of fresh) seen.add(h.id);
  return fresh;
}

export function describeHeld(h: HeldPayment, contract: string): string {
  const dollars = (Number(h.value) / 1e6).toFixed(Number(h.value) < 10_000 ? 4 : 2);
  return `Saku is holding a payment on ${contract}: $${dollars} to ${h.to} (${h.why}). Approve or reject it: npm run allowance:owner -- approve ${h.id}`;
}

async function main() {
  const contract = process.env.ALLOWANCE;
  const network = (process.env.NEAR_NETWORK ?? 'mainnet') as NearNetwork;
  const everyMs = Math.max(5, Number(process.env.WATCH_EVERY_S ?? 30)) * 1000;
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat, ONCE: once } = process.env;
  if (!contract) {
    console.error('Set ALLOWANCE to the contract to watch.');
    process.exit(1);
  }
  const provider = new JsonRpcProvider({ url: rpcUrl(network) });
  const seen = new Set<string>();
  const tell = async (text: string) => {
    console.log(text);
    if (!token || !chat) return;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) });
    // Status only: the URL has the bot token in it.
    if (!res.ok) console.error(`Telegram said ${res.status}`);
  };
  console.log(`Watching ${contract} on ${network}${token && chat ? ', with Telegram' : ''}.`);
  for (;;) {
    try {
      const list = (await provider.callFunction(contract, 'list_held', {})) as HeldPayment[];
      for (const h of newlyHeld(list ?? [], seen)) await tell(describeHeld(h, contract));
    } catch (e) {
      // A bad moment at the RPC isn't news. The next check will see anything it missed.
      console.error(`Couldn't read the contract: ${(e as Error).message.slice(0, 120)}`);
    }
    if (once) return;
    await new Promise((done) => setTimeout(done, everyMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
