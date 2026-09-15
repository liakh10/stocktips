/* Keeper (GitHub Actions cron with CRON_SECRET, or a page poke at most every 10 minutes).
   Everything it does is permissionless: anyone can run their own keeper and the result is the same.
   1. sweep    coins still on their Pons curve that hold at least 0.002 ETH of creator tax plus curve fee
   2. harvest  jars holding at least 0.002 ETH in the Pons escrow: 15% to the burner, the rest into NVDA
   3. burn     once $STIPS is set on the burner and it holds at least 0.01 ETH, buy $STIPS and send it to dead
   The key is STIPS_OPERATOR_KEY and it only pays gas. It cannot move fees, NVDA or ETH out of any jar. */
import { createPublicClient, createWalletClient, http, fallback, parseAbi, parseEther, formatEther, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { redis } from '../lib/store.js';
import { json } from '../lib/http.js';
import { pub, chain, RPCS } from '../lib/server.js';
import { siteConfig } from '../lib/siteconfig.js';

const ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e', PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const ZERO = '0x0000000000000000000000000000000000000000';
const MIN_SWEEP = parseEther('0.002'), MIN_HARVEST = parseEther('0.002'), MIN_BURN = parseEther('0.01');
const BUDGET_MS = 45000, BATCH = 20;

const F = parseAbi([
  'function coinCount() view returns (uint256)',
  'function coins(uint256 from, uint256 count) view returns ((address token,address curve,address jar,address opener,uint64 createdAt)[])',
  'function sweepAndHarvest(address[] tokens)'
]);
const J = parseAbi(['function harvest() returns (uint256,uint256)']);
const B = parseAbi(['function stips() view returns (address)', 'function burn(uint256 ethIn, uint256 minOut)']);
const CURVE = parseAbi(['function creatorTaxBalance() view returns (uint256)', 'function quoteFeeBalance() view returns (uint256)']);
const ESC = parseAbi(['function balanceOf(address) view returns (uint256)']);
const PF = parseAbi(['function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))']);

function operator() {
  const key = process.env.STIPS_OPERATOR_KEY || '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw Error('The keeper wallet is not configured yet.');
  const account = privateKeyToAccount(key);
  return { account, address: account.address, wallet: createWalletClient({ account, chain, transport: fallback(RPCS.map(u => http(u, { timeout: 30000 }))) }) };
}
async function sendTx(o, tx) {
  const hash = await o.wallet.sendTransaction({ account: o.account, chain, ...tx });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 90000 });
  if (rc.status !== 'success') throw Error('Transaction reverted ' + hash);
  return hash;
}

async function allCoins(factory) {
  const n = Number(await pub.readContract({ address: factory, abi: F, functionName: 'coinCount' }).catch(() => 0n));
  let list = [];
  for (let i = 0; i < n; i += 200) list = list.concat(await pub.readContract({ address: factory, abi: F, functionName: 'coins', args: [BigInt(i), 200n] }));
  return list;
}

/* Coins whose curve is still holding fees, and jars whose escrow is worth a harvest. */
async function work(coins) {
  if (!coins.length) return { sweep: [], jars: [] };
  const r = await pub.multicall({ allowFailure: true, contracts: coins.flatMap(c => [
    { address: PONS, abi: PF, functionName: 'getLaunchedToken', args: [c.token] },
    { address: c.curve, abi: CURVE, functionName: 'creatorTaxBalance' },
    { address: c.curve, abi: CURVE, functionName: 'quoteFeeBalance' }
  ]) });
  const sweep = [];
  for (let i = 0; i < coins.length; i++) {
    const lt = r[i * 3].result;
    if (lt && Number(lt.phase) >= 2) continue;
    const unswept = (r[i * 3 + 1].result || 0n) + (r[i * 3 + 2].result || 0n);
    if (unswept >= MIN_SWEEP) sweep.push(coins[i].token);
  }
  const jarAddrs = [...new Set(coins.map(c => c.jar))];
  const esc = await pub.multicall({ allowFailure: true, contracts: jarAddrs.map(a => ({ address: ESCROW, abi: ESC, functionName: 'balanceOf', args: [a] })) });
  const sweptJars = new Set(coins.filter(c => sweep.includes(c.token)).map(c => c.jar));
  const jars = jarAddrs.filter((a, i) => !sweptJars.has(a) && (esc[i].result || 0n) >= MIN_HARVEST);
  return { sweep, jars };
}

async function burn(o, burner, log) {
  const [stips, balance] = await Promise.all([
    pub.readContract({ address: burner, abi: B, functionName: 'stips' }).catch(() => ZERO),
    pub.getBalance({ address: burner })
  ]);
  if (stips === ZERO) return log.push({ burn: 'waiting for $STIPS to be set on the burner' });
  if (balance < MIN_BURN) return log.push({ burn: 'under 0.01 ETH, waiting', balance: formatEther(balance) });
  const ethIn = balance > parseEther('0.25') ? parseEther('0.25') : balance;
  const hash = await sendTx(o, { to: burner, data: encodeFunctionData({ abi: B, functionName: 'burn', args: [ethIn, 0n] }) });
  log.push({ burned: formatEther(ethIn) + ' ETH of fees into $STIPS', tx: hash });
}

export default async function handler(req, res) {
  let R;
  try { R = redis(); } catch { return json(res, 200, { ok: false, skipped: 'storage is not connected yet' }); }
  const q = req.query || {}, secret = process.env.CRON_SECRET;
  const authed = secret && (req.headers.authorization === 'Bearer ' + secret || q.secret === secret);
  if (!authed && !(await R.set('st:poke', '1', { nx: true, ex: 600 }))) return json(res, 200, { ok: true, skipped: 'recent run' });
  let o;
  try { o = operator(); } catch (e) { return json(res, 200, { ok: false, skipped: e.message }); }
  const cfg = await siteConfig(req);
  if (!cfg.factory) return json(res, 200, { ok: false, skipped: 'the factory is not in config.js yet' });
  const lock = Math.random().toString(36).slice(2);
  if (!(await R.set('st:lock:keeper', lock, { nx: true, px: 58000 }))) return json(res, 200, { ok: true, skipped: 'keeper busy' });
  const log = [], started = Date.now();
  try {
    const coins = await allCoins(cfg.factory);
    const { sweep, jars } = await work(coins);
    for (let i = 0; i < sweep.length; i += BATCH) {
      if (Date.now() - started > BUDGET_MS) { log.push({ partial: 'out of time, the rest waits for the next run' }); break; }
      const batch = sweep.slice(i, i + BATCH);
      const hash = await sendTx(o, { to: cfg.factory, data: encodeFunctionData({ abi: F, functionName: 'sweepAndHarvest', args: [batch] }) });
      log.push({ sweptAndHarvested: batch.length, tx: hash });
    }
    for (const jar of jars) {
      if (Date.now() - started > BUDGET_MS) { log.push({ partial: 'out of time, the rest waits for the next run' }); break; }
      const hash = await sendTx(o, { to: jar, data: encodeFunctionData({ abi: J, functionName: 'harvest' }) }).catch(e => { log.push({ jar, harvestError: e.shortMessage || e.message }); return null; });
      if (hash) log.push({ harvested: jar, tx: hash });
    }
    if (cfg.burner) await burn(o, cfg.burner, log).catch(e => log.push({ burnError: e.shortMessage || e.message }));
    json(res, 200, { ok: true, coins: coins.length, keeper: o.address, log });
  } catch (e) {
    json(res, 200, { ok: false, error: e.shortMessage || e.message, log });
  } finally {
    if ((await R.get('st:lock:keeper')) === lock) await R.del('st:lock:keeper');
  }
}
