/* Server-side chain access for the Stock Tips API. */
import { createPublicClient, http, fallback, parseAbi } from 'viem';

/* A private endpoint (QuickNode) is used only here, on the server, and only from an env var.
   It must never reach lib/chains.js: that file ships to the browser and the token would be public. */
const RPC = [process.env.ROBINHOOD_RPC, 'https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'].filter(Boolean);
export const chain = { id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: RPC } }, contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } } };
export const RPCS = RPC;
export const pub = createPublicClient({ chain, transport: fallback(RPC.map(u => http(u, { timeout: 15000 }))) });

export const FACTORY_ABI = parseAbi([
  'function jarFor(string handle) view returns (address)',
  'function oracle() view returns (address)',
  'function coinCount() view returns (uint256)',
  'function coins(uint256 from, uint256 count) view returns ((address token,address curve,address jar,address opener,uint64 createdAt)[])',
  'function sweep(address[] tokens)'
]);
export const JAR_ABI = parseAbi([
  'function nonce() view returns (uint256)',
  'function wallet() view returns (address)',
  'function pendingWallet() view returns (address)',
  'function bindDigest(address to, uint256 bindNonce, uint256 deadline) view returns (bytes32)',
  'function harvest() returns (uint256 claimed, uint256 bought)'
]);

export const hostOf = req => String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
export const isHash = v => /^0x[0-9a-fA-F]{64}$/.test(v || '');
export const isAddr = v => /^0x[0-9a-fA-F]{40}$/.test(v || '');
export const validHandle = h => /^[a-z0-9_]{1,15}$/.test(h || '');

export async function limit(R, key, max, seconds) {
  const n = await R.incr(key);
  if (n === 1) await R.expire(key, seconds);
  return n <= max;
}
