/* Stock Tips against a fork of Robinhood Chain mainnet (ethereumjs VM + RPCStateManager): the real Pons V2 factory, curve
   and fee escrow, Chainlink ETH/USD and NVDA/USD, the Uniswap V3 WETH/NVDA pool and a graduated Pons token in its v4 pool.
   The oracle key is generated inside the test. No real keys are involved. */
import fs from 'node:fs';
import path from 'node:path';
import { VM } from '@ethereumjs/vm';
import { RPCStateManager } from '@ethereumjs/statemanager';
import { Common, Hardfork } from '@ethereumjs/common';
import { Block } from '@ethereumjs/block';
import { Address, Account, bytesToHex, hexToBytes, setLengthLeft } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, decodeErrorResult, decodeEventLog, encodeDeployData, parseAbi, formatEther, formatUnits, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const RPC = 'https://robinhood-rpc.publicnode.com';
const realFetch = globalThis.fetch;
let rpcRetries = 0, rpcCalls = 0, rpcMethods = {};
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith(RPC)) return realFetch(url, opts);
  rpcCalls++;
  try { const m = JSON.parse(opts.body).method; rpcMethods[m] = (rpcMethods[m] || 0) + 1; } catch {}
  let last;
  for (let i = 0; i < 8; i++) {
    try { const text = await (await realFetch(url, opts)).text(); const j = JSON.parse(text); if (j.result !== undefined) return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } }); last = JSON.stringify(j.error || j); } catch (e) { last = e.message; }
    rpcRetries++;
    await new Promise(r => setTimeout(r, 250 * 2 ** i));
  }
  throw Error('RPC failed: ' + last);
};

const dir = path.dirname(new URL(import.meta.url).pathname);
const art = n => JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', n + '.json'), 'utf8'));
const JAR = art('TipJar'), FAC = art('TipFactory'), BUR = art('TipBurner');
const ALL = [...JAR.abi, ...FAC.abi, ...BUR.abi].filter((x, i, a) => x.type !== 'event' || a.findIndex(y => y.type === 'event' && y.name === x.name) === i);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const ESC = parseAbi(['function balanceOf(address) view returns (uint256)']);
const FEED = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const PF = parseAbi(['function launchFee() view returns (uint256)', 'function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))', 'function getLaunchFeePolicy(address) view returns ((address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps))']);
const CURVE = parseAbi(['function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)', 'function creatorTaxBalance() view returns (uint256)', 'function quoteFeeBalance() view returns (uint256)']);
const PONS = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e', DEAD = '0x000000000000000000000000000000000000dEaD';
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', ETH_USD = '0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9', NVDA_USD = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15';
const GRADUATED = '0xCc50404bd4219245eaE40415D6BAb679180f7F7E';
const E = n => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const addr = n => getAddress('0x' + n.toString(16).padStart(40, '0'));
let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) pass++; else { fail++; console.log('  FAIL', label, extra); } };

class ForkState extends RPCStateManager {
  constructor(o) { super(o); this._codeStack = []; }
  async checkpoint() { await super.checkpoint(); this._codeStack.push(new Map(this._contractCache)); }
  async commit() { this._accountCache.commit(); this._storageCache.commit(); this._codeStack.pop(); }
  async revert() { this._accountCache.revert(); this._storageCache.revert(); const snap = this._codeStack.pop(); if (snap) this._contractCache = snap; }
}
const head = (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }) })).json()).result;
const common = Common.custom({ chainId: 4663, networkId: 4663 }, { hardfork: Hardfork.Cancun });
const stateManager = new ForkState({ provider: RPC, blockTag: BigInt(head.number) });
stateManager._blockTag = 'latest';
const vm = await VM.create({ common, stateManager });
let now = BigInt(head.timestamp) + 12n;
const block = () => Block.fromBlockData({ header: { number: BigInt(head.number) + 1n, timestamp: now, gasLimit: 30_000_000n, baseFeePerGas: 0n } }, { common });

async function exec(from, to, data, value = 0n) {
  const r = await vm.evm.runCall({ caller: Address.fromString(from), to: to ? Address.fromString(to) : undefined, data: hexToBytes(data), gasLimit: 30_000_000n, value, block: block() });
  const e = r.execResult; let reason = null;
  if (e.exceptionError) { try { const d = decodeErrorResult({ abi: ALL, data: bytesToHex(e.returnValue) }); reason = d.args ? String(d.args[0]) : d.errorName; } catch { reason = e.exceptionError.error + ' ' + bytesToHex(e.returnValue).slice(0, 80); } }
  const logs = (e.logs || []).map(([a, topics, d]) => { try { return { address: getAddress(bytesToHex(a)), ...decodeEventLog({ abi: ALL, topics: topics.map(bytesToHex), data: bytesToHex(d) }) }; } catch { return null; } }).filter(Boolean);
  return { reverted: !!e.exceptionError, reason, logs, ret: bytesToHex(e.returnValue), gas: e.executionGasUsed, created: r.createdAddress ? getAddress(r.createdAddress.toString()) : null };
}
async function tx(from, to, abi, functionName, args = [], value = 0n) {
  const r = await exec(from, to, encodeFunctionData({ abi, functionName, args }), value);
  if (!r.reverted) try { r.result = decodeFunctionResult({ abi, functionName, data: r.ret }); } catch {}
  return r;
}
async function must(from, to, abi, fn, args, label, value = 0n) { const r = await tx(from, to, abi, fn, args, value); ok(!r.reverted, label, r.reason || ''); return r; }
async function reverts(from, to, abi, fn, args, expect, label, value = 0n) { const r = await tx(from, to, abi, fn, args, value); ok(r.reverted && (!expect || String(r.reason).includes(expect)), label, `reverted=${r.reverted} reason=${r.reason}`); }
const view = async (to, abi, fn, args = []) => { const r = await tx(addr(1), to, abi, fn, args); if (r.reverted) throw Error(fn + ' reverted: ' + r.reason); return r.result; };
const giveEth = async (who, wei) => { const a = Address.fromString(who), acct = (await vm.stateManager.getAccount(a)) ?? new Account(); acct.balance = wei; await vm.stateManager.putAccount(a, acct); };
const ethBal = async who => (await vm.stateManager.getAccount(Address.fromString(who)))?.balance ?? 0n;
const bal = (token, who) => view(token, ERC20, 'balanceOf', [who]);
async function deploy(from, a, args = []) {
  const r = await exec(from, null, args.length ? encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) : a.bytecode);
  if (r.reverted) throw Error('deploy failed ' + a.contractName + ' ' + r.reason);
  const who = Address.fromString(from), acct = (await vm.stateManager.getAccount(who)) ?? new Account();
  acct.nonce += 1n; await vm.stateManager.putAccount(who, acct);
  return r.created;
}

const guardian = addr(0xd0), alice = addr(0xa1), bob = addr(0xb0), carol = addr(0xc0), dave = addr(0xda), eve = addr(0xee);
for (const w of [guardian, alice, bob, carol, dave, eve]) await giveEth(w, E(20));
const oracleAcct = privateKeyToAccount(generatePrivateKey());
const rogue = privateKeyToAccount(generatePrivateKey());
console.log('fork block', Number(head.number), `· sizes factory ${FAC.deployedSize}, jar ${JAR.deployedSize}, burner ${BUR.deployedSize}`);

const jarImpl = await deploy(guardian, JAR);
const B = await deploy(guardian, BUR);
const F = await deploy(guardian, FAC, [jarImpl, oracleAcct.address, B]);
ok((await view(F, FAC.abi, 'guardian')) === guardian && (await view(F, FAC.abi, 'oracle')) === oracleAcct.address && (await view(F, FAC.abi, 'burner')) === B, 'factory wired');
await reverts(eve, jarImpl, JAR.abi, 'initialize', ['x'], 'init', 'jar implementation is locked');

// ------------------------------------------------------------------ opening coins
const fee = await view(PONS, PF, 'launchFee');
console.log('  pons launch fee', formatEther(fee));
ok(!(await view(F, FAC.abi, 'validHandle', ['Elon'])) && !(await view(F, FAC.abi, 'validHandle', ['a'.repeat(16)])) && (await view(F, FAC.abi, 'validHandle', ['vlad_tenev1'])), 'handle rules: lowercase a-z 0-9 _, up to 15');
await reverts(alice, F, FAC.abi, 'openCoin', ['Elon', 'Elon Tips', 'ELON', '', 'tips'], 'handle', 'uppercase handle refused', fee);
await reverts(alice, F, FAC.abi, 'openCoin', ['vladtenev', 'Vlad Tips', 'VLAD', '', 'tips'], 'launch fee', 'exact Pons launch fee required', fee + 1n);
const o1 = await must(alice, F, FAC.abi, 'openCoin', ['vladtenev', 'Vlad Tips', 'VLAD', 'https://stocktips.example/logo.png', 'tips for vlad'], 'alice opens a coin for @vladtenev', fee);
const ev1 = o1.logs.find(l => l.eventName === 'CoinOpened');
const T1 = ev1 && ev1.args.token, J = ev1 && ev1.args.jar;
console.log(`  openCoin gas ${o1.gas} · token ${T1} · jar ${J}`);
ok(J === (await view(F, FAC.abi, 'jarFor', ['vladtenev'])) && (await view(F, FAC.abi, 'jarCount')) === 1n, 'jar created for the handle');
const lt1 = await view(PONS, PF, 'getLaunchedToken', [T1]);
ok(lt1.exists && lt1.deployer === F && lt1.creatorFeeRecipient === J && lt1.creatorTaxBps === 300 && lt1.phase === 0 && lt1.pairToken === '0x0000000000000000000000000000000000000000', 'Pons launch: factory deploys, the jar receives fees, 3% tax', `tax ${lt1.creatorTaxBps}`);
ok((await view(J, JAR.abi, 'handle')) === 'vladtenev', 'jar knows its handle');
const o2 = await must(bob, F, FAC.abi, 'openCoin', ['vladtenev', 'Vlad Stock', 'VSTK', '', 'second coin'], 'bob opens a second coin for the same handle', fee);
const T2 = o2.logs.find(l => l.eventName === 'CoinOpened').args.token;
ok((await view(F, FAC.abi, 'jarCount')) === 1n && (await view(F, FAC.abi, 'coinsOf', ['vladtenev'])).length === 2 && (await view(F, FAC.abi, 'coinCount')) === 2n, 'both coins share one jar');
await reverts(eve, F, FAC.abi, 'setPaused', [true], 'guardian', 'only the guardian pauses');
await must(guardian, F, FAC.abi, 'setPaused', [true], 'guardian pauses');
await reverts(alice, F, FAC.abi, 'openCoin', ['someone', 'X', 'XX', '', ''], 'paused', 'paused factory opens nothing', fee);
await must(guardian, F, FAC.abi, 'setPaused', [false], 'guardian unpauses');

// ------------------------------------------------------------------ trading, sweep, harvest
now += 120n;
for (const [w, t] of [[alice, T1], [bob, T1], [carol, T2]]) {
  const curve = (await view(PONS, PF, 'getLaunchedToken', [t])).curve;
  const r = await tx(w, curve, CURVE, 'buy', [E(0.5), 1n, w], E(0.5));
  ok(!r.reverted, 'a trader buys on the curve', r.reason || '');
}
const policy = await view(PONS, PF, 'getLaunchFeePolicy', [T1]);
let expectedEscrow = 0n;
for (const t of [T1, T2]) {
  const curve = (await view(PONS, PF, 'getLaunchedToken', [t])).curve;
  const tax = await view(curve, CURVE, 'creatorTaxBalance'), qf = await view(curve, CURVE, 'quoteFeeBalance');
  expectedEscrow += tax + qf * BigInt(10000 - policy.protocolFeeShareBps) / 10000n;
}
ok((await view(ESCROW, ESC, 'balanceOf', [J])) === 0n, 'nothing in the escrow before the sweep');
{
  const SWEEP = parseAbi(['function sweepFees(uint256 minBuybackTokensOut)']);
  const rogueSweep = await exec(eve, lt1.curve, encodeFunctionData({ abi: SWEEP, functionName: 'sweepFees', args: [0n] }));
  ok(rogueSweep.reverted, 'Pons lets only the jar sweep its curve');
  await reverts(eve, J, JAR.abi, 'sweepCurve', [lt1.curve], 'factory', 'only the factory asks the jar to sweep');
}
const sw = await must(eve, F, FAC.abi, 'sweep', [[T1, T2, addr(0x1234)]], 'anyone sweeps both coins');
ok(sw.logs.filter(l => l.eventName === 'Swept' && l.args.ok).length === 2, 'both curve sweeps succeed because the factory is the deployer');
const escrowed = await view(ESCROW, ESC, 'balanceOf', [J]);
ok(escrowed > 0n && (escrowed === expectedEscrow || (escrowed > expectedEscrow ? escrowed - expectedEscrow : expectedEscrow - escrowed) <= 3n), 'the jar is owed the creator tax plus the creator share of the curve fee', `${formatEther(escrowed)} vs ${formatEther(expectedEscrow)}`);
console.log(`  jar owed ${formatEther(escrowed)} ETH from 1.5 ETH of buys (${(Number(escrowed * 10000n / E(1.5)) / 100).toFixed(2)}%)`);

const b0 = await ethBal(B);
const h1 = await must(eve, J, JAR.abi, 'harvest', [], 'anyone harvests the jar');
const hv = h1.logs.find(l => l.eventName === 'Harvested');
const [, ethAns] = await view(ETH_USD, FEED, 'latestRoundData');
const [, nvdaAns] = await view(NVDA_USD, FEED, 'latestRoundData');
ok(hv && hv.args.claimed === escrowed && hv.args.toBurner === escrowed * 1500n / 10000n && (await ethBal(B)) - b0 === hv.args.toBurner, '15% of the claim went to the burner');
const expectedNvda = hv.args.ethSpent * ethAns / nvdaAns;
const devBps = hv.args.nvdaBought > 0n ? Number((hv.args.nvdaBought - expectedNvda) * 10000n / expectedNvda) : null;
ok(hv.args.ethSpent === escrowed - hv.args.toBurner && hv.args.nvdaBought > 0n && Math.abs(devBps) < 200, 'the other 85% became NVDA within 2% of Chainlink', `${formatUnits(hv.args.nvdaBought, 18)} NVDA · ${devBps} bps · gas ${h1.gas}`);
ok((await bal(NVDA, J)) === hv.args.nvdaBought && (await ethBal(J)) === 0n, 'the NVDA waits in the jar');
await reverts(eve, J, JAR.abi, 'uniswapV3SwapCallback', [1n, 0n, '0x'], 'pool', 'swap callback only from the active pool');
await reverts(eve, J, JAR.abi, 'payout', [], 'no wallet', 'nothing is paid before the handle binds a wallet');

// ------------------------------------------------------------------ binding
const sign = async (acct, to, n, deadline) => acct.sign({ hash: await view(J, JAR.abi, 'bindDigest', [to, n, deadline]) });
const deadline = now + 3600n;
await reverts(eve, J, JAR.abi, 'bind', [carol, deadline, await sign(rogue, carol, 0n, deadline)], 'oracle', 'a signature from anyone but the oracle is refused');
await reverts(eve, J, JAR.abi, 'bind', [carol, now - 1n, await sign(oracleAcct, carol, 0n, now - 1n)], 'deadline', 'an expired signature is refused');
const sig0 = await sign(oracleAcct, carol, 0n, deadline);
const bd = await must(eve, J, JAR.abi, 'bind', [carol, deadline, sig0], 'anyone submits the oracle signature for carol');
ok(bd.logs.some(l => l.eventName === 'BindStarted') && (await view(J, JAR.abi, 'pendingWallet')) === carol && (await view(J, JAR.abi, 'nonce')) === 1n, 'binding pending for 48 hours');
await reverts(eve, J, JAR.abi, 'bind', [carol, deadline, sig0], 'oracle', 'the same signature cannot be replayed');
await reverts(carol, J, JAR.abi, 'confirm', [], 'wait', 'confirm waits 48 hours');
await reverts(eve, J, JAR.abi, 'cancelBind', [], 'guardian', 'a stranger cannot cancel');
await must(guardian, J, JAR.abi, 'cancelBind', [], 'the guardian cancels a suspicious binding');
ok((await view(J, JAR.abi, 'pendingWallet')) === '0x0000000000000000000000000000000000000000', 'binding cleared');
const sig1 = await sign(oracleAcct, carol, 1n, deadline);
await must(eve, J, JAR.abi, 'bind', [carol, deadline, sig1], 'carol binds again with a fresh signature');
now += 48n * 3600n + 1n;
await must(eve, J, JAR.abi, 'confirm', [], 'anyone confirms after 48 hours');
ok((await view(J, JAR.abi, 'wallet')) === carol, 'carol is the jar wallet');
const c0 = await bal(NVDA, carol), jarNvda = await bal(NVDA, J);
await must(eve, J, JAR.abi, 'payout', [], 'anyone pays the jar out');
ok((await bal(NVDA, carol)) - c0 === jarNvda && (await bal(NVDA, J)) === 0n, 'carol received every NVDA in the jar', formatUnits(jarNvda, 18));

// later fees go straight to carol on harvest
for (const w of [dave, eve]) { const r = await tx(w, lt1.curve, CURVE, 'buy', [E(0.3), 1n, w], E(0.3)); ok(!r.reverted, 'more trading', r.reason || ''); }
await must(eve, F, FAC.abi, 'sweep', [[T1]], 'sweep again');
const c1 = await bal(NVDA, carol);
const h2 = await must(eve, J, JAR.abi, 'harvest', [], 'harvest after binding');
ok((await bal(NVDA, carol)) > c1 && (await bal(NVDA, J)) === 0n && (await ethBal(J)) === 0n, 'the harvest pays carol directly');

// the wallet itself can cancel a new binding to someone else
const sig2 = await sign(oracleAcct, dave, 2n, now + 3600n);
await must(eve, J, JAR.abi, 'bind', [dave, now + 3600n, sig2], 'a new binding to dave starts');
await must(carol, J, JAR.abi, 'cancelBind', [], 'carol cancels it as the current wallet');
ok((await view(J, JAR.abi, 'wallet')) === carol, 'carol stays the wallet');

// stale prices: ETH waits instead of reverting
await giveEth(J, E(0.01));
now += 6n * 86400n;
const h3 = await must(eve, J, JAR.abi, 'harvest', [], 'harvest with stale Chainlink prices does not revert');
const hv3 = h3.logs.find(l => l.eventName === 'Harvested');
ok(hv3 && hv3.args.nvdaBought === 0n, 'no NVDA bought on stale prices');
now -= 6n * 86400n;

// ------------------------------------------------------------------ oracle rotation
await reverts(eve, F, FAC.abi, 'proposeOracle', [eve], 'guardian', 'only the guardian proposes an oracle');
await must(guardian, F, FAC.abi, 'proposeOracle', [rogue.address], 'guardian proposes a new oracle');
await reverts(eve, F, FAC.abi, 'activateOracle', [], 'wait', 'a new oracle waits 48 hours');
now += 48n * 3600n + 1n;
await must(eve, F, FAC.abi, 'activateOracle', [], 'anyone activates it after the notice');
ok((await view(F, FAC.abi, 'oracle')) === rogue.address, 'oracle rotated');

// ------------------------------------------------------------------ burner
await reverts(eve, B, BUR.abi, 'burn', [E(0.01), 1n], 'stips not set', 'burner waits for $STIPS');
await reverts(eve, B, BUR.abi, 'setStips', [T2], 'owner', 'only the owner sets $STIPS');
await must(guardian, B, BUR.abi, 'setStips', [T2], 'owner sets a stand-in $STIPS');
await reverts(guardian, B, BUR.abi, 'setStips', [T1], 'set', '$STIPS is set once');
await exec(alice, B, '0x', E(0.3));
await reverts(eve, B, BUR.abi, 'burn', [E(0.01), 0n], 'min out', 'burn needs a minimum output');
await reverts(eve, B, BUR.abi, 'burn', [E(0.3), 1n], 'amount', 'burn is capped at 0.25 ETH');
{
  const d0 = await bal(T2, DEAD);
  const r = await must(eve, B, BUR.abi, 'burn', [E(0.05), 1n], 'anyone burns on the Pons curve');
  const ev = r.logs.find(l => l.eventName === 'Burned');
  ok(ev && ev.args.onCurve && (await bal(T2, DEAD)) - d0 === ev.args.tokens && ev.args.tokens > 0n, 'curve buy landed on the dead address', ev && formatEther(ev.args.tokens));
}
await vm.stateManager.putContractStorage(Address.fromString(B), hexToBytes('0x' + '1'.padStart(64, '0')), setLengthLeft(hexToBytes(GRADUATED), 32));
ok((await view(B, BUR.abi, 'stips')) === GRADUATED, 'stand-in swapped to a graduated Pons token');
{
  const d0 = await bal(GRADUATED, DEAD);
  const r = await must(eve, B, BUR.abi, 'burn', [E(0.05), 1n], 'anyone burns a graduated token in its v4 pool');
  const ev = r.logs.find(l => l.eventName === 'Burned');
  ok(ev && !ev.args.onCurve && (await bal(GRADUATED, DEAD)) - d0 === ev.args.tokens && ev.args.tokens > 0n, 'v4 buy landed on the dead address', ev && formatEther(ev.args.tokens));
}
await reverts(eve, B, BUR.abi, 'unlockCallback', ['0x'], 'pool manager', 'v4 callback only from the PoolManager');
ok(![...JAR.abi, ...FAC.abi, ...BUR.abi].some(x => x.type === 'function' && /withdraw|rescue|sweepEth|recover/i.test(x.name)), 'no function takes fees, NVDA or ETH anywhere else');

console.log(`\n${pass} passed, ${fail} failed · rpc retries ${rpcRetries}`);
console.log(`rpc calls this run: ${rpcCalls} · ${Object.entries(rpcMethods).sort((a, b) => b[1] - a[1]).map(([m, n]) => m + ' ' + n).join(', ')}`);
process.exit(fail ? 1 : 0);
