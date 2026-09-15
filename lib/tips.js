/* Stock Tips data layer: coins and jars from the factory, jar balances in NVDA, Chainlink prices, Pons curve progress,
   and every action. Loaded as an ES module next to wallet.js. */
import { pubs, state as wallet, send } from './wallet.js';
import { parseAbi, formatUnits } from 'https://cdn.jsdelivr.net/npm/viem@2.21.55/+esm';

const valid = v => /^0x[0-9a-fA-F]{40}$/.test(v || '') ? v : null;
export const FACTORY = valid(window.STIPS_FACTORY);
export const BURNER = valid(window.STIPS_BURNER);
export const CHAIN = 4663;
export const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
export const EXPLORER = 'https://robinhoodchain.blockscout.com';
const ETH_USD = '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9', NVDA_USD = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15';
const pub = pubs[CHAIN];
const FEED = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const ERC20 = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)']);
const PF = parseAbi(['function launchFee() view returns (uint256)', 'function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))']);
const CURVE = parseAbi(['function realQuoteReserve() view returns (uint256)', 'function graduationThreshold() view returns (uint256)', 'function creatorTaxBalance() view returns (uint256)', 'function quoteFeeBalance() view returns (uint256)']);
const ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e';
const ESC = parseAbi(['function balanceOf(address) view returns (uint256)']);

let A = null;
export async function abis() {
  if (A) return A;
  const get = async n => { for (let i = 0; i < 3; i++) { try { const r = await fetch('/lib/abi/' + n + '.json?v=1'); if (r.ok) return (await r.json()).abi; } catch {} await new Promise(r => setTimeout(r, 400 * (i + 1))); } throw Error('Could not load ' + n); };
  const [F, J, B] = await Promise.all(['TipFactory', 'TipJar', 'TipBurner'].map(get));
  A = { F, J, B };
  return A;
}

export const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
export const eth = wei => Number(wei || 0n) / 1e18;
export const shares = wei => Number(wei || 0n) / 1e18;
export const fmtUsd = v => v == null ? '·' : '$' + (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
export const fmtNum = (v, d = 4) => Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: d });
export const cleanHandle = h => String(h || '').trim().replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//i, '').split(/[/?#]/)[0].toLowerCase();
export const validHandle = h => /^[a-z0-9_]{1,15}$/.test(h);

export async function prices() {
  const r = await pub.multicall({ allowFailure: true, contracts: [ETH_USD, NVDA_USD].map(a => ({ address: a, abi: FEED, functionName: 'latestRoundData' })) });
  return { eth: r[0].result ? Number(r[0].result[1]) / 1e8 : null, nvda: r[1].result ? Number(r[1].result[1]) / 1e8 : null };
}

/* every coin and every jar, jars sorted by value */
export async function loadAll() {
  if (!FACTORY) return { coins: [], jars: [] };
  const { F, J } = await abis();
  const n = Number(await pub.readContract({ address: FACTORY, abi: F, functionName: 'coinCount' }));
  let coins = [];
  for (let i = 0; i < n; i += 200) coins = coins.concat(await pub.readContract({ address: FACTORY, abi: F, functionName: 'coins', args: [BigInt(i), 200n] }));
  if (!coins.length) return { coins: [], jars: [] };
  const meta = await pub.multicall({ allowFailure: true, contracts: coins.flatMap(c => [
    { address: c.token, abi: ERC20, functionName: 'name' }, { address: c.token, abi: ERC20, functionName: 'symbol' },
    { address: PONS, abi: PF, functionName: 'getLaunchedToken', args: [c.token] },
    { address: c.curve, abi: CURVE, functionName: 'realQuoteReserve' }, { address: c.curve, abi: CURVE, functionName: 'graduationThreshold' },
    { address: c.curve, abi: CURVE, functionName: 'creatorTaxBalance' }, { address: c.curve, abi: CURVE, functionName: 'quoteFeeBalance' }
  ]) });
  coins = coins.map((c, i) => {
    const g = k => meta[i * 7 + k].result;
    const lt = g(2), raised = g(3), thr = g(4);
    return { ...c, createdAt: Number(c.createdAt), name: g(0) || '', symbol: g(1) || '', phase: lt ? Number(lt.phase) : 0, raised: raised || 0n, threshold: thr || 0n,
      progress: lt && Number(lt.phase) >= 2 ? 1 : thr ? Math.min(1, Number(raised || 0n) / Number(thr)) : 0, unswept: (g(5) || 0n) + (g(6) || 0n) };
  });
  const jarAddrs = [...new Set(coins.map(c => c.jar))];
  const js = await pub.multicall({ allowFailure: true, contracts: jarAddrs.flatMap(a => [
    { address: a, abi: J, functionName: 'state' }, { address: a, abi: J, functionName: 'totalNvdaBought' }, { address: a, abi: J, functionName: 'totalPaidNvda' }, { address: a, abi: J, functionName: 'totalClaimed' }
  ]) });
  const px = await prices();
  const jars = jarAddrs.map((a, i) => {
    const s = js[i * 4].result || [];
    const j = { jar: a, handle: s[0] || '', wallet: s[1], pending: s[2], readyAt: Number(s[3] || 0n), nvda: s[4] || 0n, eth: s[5] || 0n, escrowed: s[6] || 0n,
      totalNvda: js[i * 4 + 1].result || 0n, paidNvda: js[i * 4 + 2].result || 0n, totalClaimed: js[i * 4 + 3].result || 0n, coins: coins.filter(c => c.jar === a) };
    j.usd = px.nvda ? shares(j.nvda) * px.nvda + (px.eth ? eth(j.eth + j.escrowed) * px.eth : 0) : null;
    j.lifetimeUsd = px.nvda ? shares(j.totalNvda) * px.nvda : null;
    return j;
  }).sort((x, y) => (y.usd || 0) - (x.usd || 0));
  return { coins, jars, px };
}

export async function launchFee() {
  return pub.readContract({ address: PONS, abi: PF, functionName: 'launchFee' });
}

// ---------------------------------------------------------------- actions

const me = () => { const w = wallet(); if (!w.address) throw Error('Connect a wallet first'); return w.address; };
async function run(call, onStep) {
  onStep && onStep('Confirm in your wallet');
  const t = await send(CHAIN, call);
  onStep && onStep('Waiting for Robinhood Chain');
  const rc = await t.wait();
  if (rc.status !== 'success') throw Error('Transaction reverted');
  return rc;
}

export async function openCoin({ handle, name, symbol, logo, description }, onStep) {
  if (!FACTORY) throw Error('Stock Tips is not deployed yet');
  const { F } = await abis();
  me();
  const fee = await launchFee();
  return run({ address: FACTORY, abi: F, functionName: 'openCoin', args: [handle, name, symbol, logo, description], value: fee }, onStep);
}
export const sweep = async (tokens, onStep) => run({ address: FACTORY, abi: (await abis()).F, functionName: 'sweep', args: [tokens] }, onStep);
export const sweepAndHarvest = async (tokens, onStep) => run({ address: FACTORY, abi: (await abis()).F, functionName: 'sweepAndHarvest', args: [tokens] }, onStep);
export const harvest = async (jar, onStep) => run({ address: jar, abi: (await abis()).J, functionName: 'harvest' }, onStep);
export const bind = async (jar, to, deadline, signature, onStep) => run({ address: jar, abi: (await abis()).J, functionName: 'bind', args: [to, BigInt(deadline), signature] }, onStep);
export const confirm = async (jar, onStep) => run({ address: jar, abi: (await abis()).J, functionName: 'confirm' }, onStep);
export const payout = async (jar, onStep) => run({ address: jar, abi: (await abis()).J, functionName: 'payout' }, onStep);

export async function burnerStats() {
  if (!BURNER) return null;
  const { B } = await abis();
  const r = await pub.multicall({ allowFailure: true, contracts: ['totalReceived', 'burnedEth', 'burnedTokens'].map(f => ({ address: BURNER, abi: B, functionName: f })) });
  return { received: r[0].result || 0n, burnedEth: r[1].result || 0n, burnedTokens: r[2].result || 0n, balance: await pub.getBalance({ address: BURNER }).catch(() => 0n) };
}

async function postJSON(path, data) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || 'Request failed');
  return j;
}
export const claimCode = (handle, wallet) => postJSON('/api/claim', { action: 'code', handle, wallet });
export const claimVerify = (handle, wallet, url) => postJSON('/api/claim', { action: 'verify', handle, wallet, url });
export const uploadLogo = image => postJSON('/api/logo', { image }).then(j => j.url);

export function toWebp(file, size = 256) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(Error('Pick an image file'));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const x = c.getContext('2d'), s = Math.min(img.width, img.height);
      x.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/webp', 0.88));
    };
    img.onerror = () => reject(Error('That image could not be read'));
    img.src = URL.createObjectURL(file);
  });
}
export const escrowOf = jar => pub.readContract({ address: ESCROW, abi: ESC, functionName: 'balanceOf', args: [jar] }).catch(() => 0n);
export { formatUnits };
