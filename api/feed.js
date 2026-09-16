/* The activity feed: what actually happened on chain, read from event logs.
   Archive log queries need the private endpoint (ROBINHOOD_RPC) — the public ones refuse ranges, which is
   why this lives on the server and not in the browser.
   GET /api/feed  -> { events: [{ kind, handle, token, wallet, amount, block, at }], head }
   Cached in Redis for a minute so a page full of visitors costs one scan, not one per visitor. */
import { parseAbiItem, formatEther, formatUnits } from 'viem';
import { redis } from '../lib/store.js';
import { json } from '../lib/http.js';
import { pub } from '../lib/server.js';
import { siteConfig } from '../lib/siteconfig.js';

const CACHE_KEY = 'st:feed:v1', CACHE_SECONDS = 60;
/* how far back to look: the chain runs ~4 blocks a second, so this is roughly the last day */
const WINDOW = 300_000n, CHUNK = 9_000n, MAX_EVENTS = 40;

const COIN_OPENED = parseAbiItem('event CoinOpened(address indexed token, address indexed jar, address indexed opener, string handle, string name, string symbol)');
const HARVESTED = parseAbiItem('event Harvested(uint256 claimed, uint256 toBurner, uint256 ethSpent, uint256 nvdaBought)');
const PAID = parseAbiItem('event Paid(address indexed wallet, uint256 nvda, uint256 eth)');
const WALLET_SET = parseAbiItem('event WalletSet(address indexed wallet)');

async function scan(address, event, fromBlock, toBlock) {
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += CHUNK + 1n) {
    const to = from + CHUNK > toBlock ? toBlock : from + CHUNK;
    const logs = await pub.getLogs({ address, event, fromBlock: from, toBlock: to }).catch(() => []);
    out.push(...logs);
  }
  return out;
}

export default async function handler(req, res) {
  let R = null;
  try { R = redis(); } catch {}
  if (R) {
    const hit = await R.get(CACHE_KEY).catch(() => null);
    if (hit) { res.setHeader('x-cache', 'hit'); return json(res, 200, JSON.parse(hit)); }
  }
  const cfg = await siteConfig(req);
  if (!cfg.factory) return json(res, 200, { events: [], head: null, note: 'not deployed yet' });

  try {
    const head = await pub.getBlockNumber();
    const from = head > WINDOW ? head - WINDOW : 0n;

    /* one pass over the factory tells us every jar worth looking at */
    const opened = await scan(cfg.factory, COIN_OPENED, from, head);
    const jars = [...new Set(opened.map(l => l.args.jar))];
    const handleOf = Object.fromEntries(opened.map(l => [l.args.jar.toLowerCase(), l.args.handle]));

    const [harvests, paids, wallets] = await Promise.all([
      jars.length ? scan(jars, HARVESTED, from, head) : [],
      jars.length ? scan(jars, PAID, from, head) : [],
      jars.length ? scan(jars, WALLET_SET, from, head) : []
    ]);

    const events = [
      ...opened.map(l => ({ kind: 'opened', block: Number(l.blockNumber), token: l.args.token, handle: l.args.handle, symbol: l.args.symbol })),
      ...harvests.filter(l => l.args.nvdaBought > 0n).map(l => ({ kind: 'harvest', block: Number(l.blockNumber), handle: handleOf[l.address.toLowerCase()] || null, nvda: formatUnits(l.args.nvdaBought, 18), burned: formatEther(l.args.toBurner) })),
      ...paids.map(l => ({ kind: 'paid', block: Number(l.blockNumber), handle: handleOf[l.address.toLowerCase()] || null, wallet: l.args.wallet, nvda: formatUnits(l.args.nvda, 18) })),
      ...wallets.map(l => ({ kind: 'claimed', block: Number(l.blockNumber), handle: handleOf[l.address.toLowerCase()] || null, wallet: l.args.wallet }))
    ].sort((a, b) => b.block - a.block).slice(0, MAX_EVENTS);

    /* one timestamp read per distinct block, not per event */
    const blocks = [...new Set(events.map(e => e.block))].slice(0, 12);
    const stamps = Object.fromEntries(await Promise.all(blocks.map(async b => [b, Number((await pub.getBlock({ blockNumber: BigInt(b) }).catch(() => ({ timestamp: 0n }))).timestamp)])));
    for (const e of events) e.at = stamps[e.block] || null;

    const payload = { events, head: Number(head) };
    if (R) await R.set(CACHE_KEY, JSON.stringify(payload), { ex: CACHE_SECONDS }).catch(() => {});
    res.setHeader('x-cache', 'miss');
    return json(res, 200, payload);
  } catch (e) {
    return json(res, 200, { events: [], head: null, error: e.shortMessage || e.message });
  }
}
