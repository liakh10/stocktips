/* Wallet connection for Inferno. EIP-6963 discovery with a window.ethereum fallback, Robinhood Chain only.
   switches between Robinhood Chain and Base on demand: every write names the chain it belongs to. */
import { createPublicClient, createWalletClient, custom, http, fallback } from 'https://cdn.jsdelivr.net/npm/viem@2.21.55/+esm';
import { CHAINS, CHAIN_IDS, viemChain } from './chains.js';

export const pubs = Object.fromEntries(CHAIN_IDS.map(id => [id, createPublicClient({ chain: viemChain(id), transport: fallback(CHAINS[id].rpc.map(u => http(u))) })]));

const found = new Map();
addEventListener('eip6963:announceProvider', e => { const d = e.detail; if (d && d.info && d.provider) found.set(d.info.uuid, d); });
dispatchEvent(new Event('eip6963:requestProvider'));

const W = { provider: null, info: null, address: null, chainId: null, client: null, listeners: new Set() };
const emit = () => W.listeners.forEach(fn => { try { fn(state()); } catch {} });
export const state = () => ({ address: W.address, chainId: W.chainId, wallet: W.info ? W.info.name : null });
export const onChange = fn => { W.listeners.add(fn); return () => W.listeners.delete(fn); };

export function wallets() {
  const list = [...found.values()].map(d => ({ id: d.info.uuid, name: d.info.name, icon: d.info.icon, rdns: d.info.rdns }));
  if (!list.length && window.ethereum) list.push({ id: 'injected', name: 'Browser wallet', icon: '', rdns: 'injected' });
  return list;
}

function bind(provider, info) {
  if (W.provider && W.provider.removeListener) { W.provider.removeListener('accountsChanged', onAccounts); W.provider.removeListener('chainChanged', onChain); }
  W.provider = provider; W.info = info;
  W.client = createWalletClient({ transport: custom(provider) });
  if (provider.on) { provider.on('accountsChanged', onAccounts); provider.on('chainChanged', onChain); }
}
function onAccounts(a) { W.address = a && a[0] ? a[0] : null; if (!W.address) { try { localStorage.removeItem('stocktips:wallet'); } catch {} } emit(); }
function onChain(id) { W.chainId = Number(id); emit(); }

export async function connect(id) {
  const d = id && id !== 'injected' ? found.get(id) : [...found.values()][0];
  const provider = d ? d.provider : window.ethereum;
  if (!provider) throw Error('No wallet found. Install MetaMask or Rabby, or open this page in your wallet app browser.');
  bind(provider, d ? d.info : { name: 'Browser wallet', uuid: 'injected' });
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  W.address = accounts[0] || null;
  W.chainId = Number(await provider.request({ method: 'eth_chainId' }));
  try { localStorage.setItem('stocktips:wallet', d ? d.info.rdns : 'injected'); } catch {}
  emit();
  return state();
}

export async function restore() {
  let rdns = null; try { rdns = localStorage.getItem('stocktips:wallet'); } catch {}
  if (!rdns) return state();
  await new Promise(r => setTimeout(r, 250));
  const d = [...found.values()].find(x => x.info.rdns === rdns);
  const provider = d ? d.provider : rdns === 'injected' ? window.ethereum : null;
  if (!provider) return state();
  bind(provider, d ? d.info : { name: 'Browser wallet', uuid: 'injected' });
  const accounts = await provider.request({ method: 'eth_accounts' }).catch(() => []);
  W.address = accounts[0] || null;
  W.chainId = Number(await provider.request({ method: 'eth_chainId' }).catch(() => 0));
  emit();
  return state();
}

export function disconnect() {
  W.address = null; try { localStorage.removeItem('stocktips:wallet'); } catch {}
  emit();
}

export async function switchChain(id) {
  const c = CHAINS[id], hex = '0x' + id.toString(16);
  try {
    await W.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    if (e && (e.code === 4902 || /unrecognized|not added|unknown chain/i.test(e.message || ''))) {
      await W.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: c.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: c.rpc, blockExplorerUrls: [c.explorer] }] });
    } else throw e;
  }
  W.chainId = id; emit();
}

async function ensure(chainId) {
  if (!W.address) throw Error('Connect a wallet first.');
  if (W.chainId !== chainId) await switchChain(chainId);
}

/* simulates a contract call on its chain, then sends it from the connected wallet */
export async function send(chainId, { address, abi, functionName, args = [], value = 0n }) {
  await ensure(chainId);
  const pub = pubs[chainId];
  const { request } = await pub.simulateContract({ account: W.address, address, abi, functionName, args, value });
  const hash = await W.client.writeContract({ ...request, account: W.address, chain: viemChain(chainId) });
  return { hash, wait: () => pub.waitForTransactionReceipt({ hash }) };
}

/* raw transaction, used by /deploy for the CREATE2 deployer */
export async function sendTx(chainId, { to, data, value = 0n }) {
  await ensure(chainId);
  const hash = await W.client.sendTransaction({ account: W.address, chain: viemChain(chainId), to, data, value });
  return { hash, wait: () => pubs[chainId].waitForTransactionReceipt({ hash }) };
}

export async function sign(message) {
  if (!W.address) throw Error('Connect a wallet first.');
  return W.client.signMessage({ account: W.address, message });
}
export const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
