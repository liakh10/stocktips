/* Proving an X handle without the X API.
   POST { action: 'code', handle, wallet } returns a one-hour code and the exact post to publish from that handle.
   POST { action: 'verify', handle, wallet, url } reads the public post through fxtwitter (vxtwitter as a fallback), checks
   the author, the code, the wallet and the age of the post, then the oracle signs (jar, handle, wallet, nonce, deadline).
   The browser submits that signature to the jar, which still waits 48 hours before the wallet can receive anything.
   The oracle key lives only in STIPS_ORACLE_KEY. */
import crypto from 'node:crypto';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { redis } from '../lib/store.js';
import { json, ipOf, body } from '../lib/http.js';
import { pub, FACTORY_ABI, JAR_ABI, isAddr, validHandle, limit } from '../lib/server.js';
import { siteConfig } from '../lib/siteconfig.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const postText = (handle, wallet, code) => `Claiming the Stock Tips jar of @${handle}\nwallet ${wallet.toLowerCase()}\ncode ${code}`;

async function readPost(id) {
  const tries = [
    async () => { const j = await (await fetch(`https://api.fxtwitter.com/status/${id}`, { headers: { 'user-agent': 'stocktips-verifier' } })).json(); const t = j && j.tweet; return t && { text: t.text || '', author: (t.author && t.author.screen_name) || '', createdAt: Number(t.created_timestamp || 0) }; },
    async () => { const j = await (await fetch(`https://api.vxtwitter.com/Twitter/status/${id}`, { headers: { 'user-agent': 'stocktips-verifier' } })).json(); return j && j.text != null && { text: j.text || '', author: j.user_screen_name || '', createdAt: Number(j.date_epoch || 0) }; }
  ];
  for (const t of tries) { try { const r = await t(); if (r && r.author) return r; } catch {} }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  let R;
  try { R = redis(); } catch { return json(res, 503, { error: 'Claims are not connected yet' }); }
  try {
    const b = body(req);
    const handle = String(b.handle || '').replace(/^@/, '').toLowerCase();
    if (!validHandle(handle)) return json(res, 400, { error: 'Enter an X handle: letters, numbers and underscore, up to 15' });
    if (!isAddr(b.wallet)) return json(res, 400, { error: 'Connect the wallet that should receive the jar' });
    const wallet = getAddress(b.wallet);
    const key = `st:code:${handle}:${wallet.toLowerCase()}`;

    if (b.action === 'code') {
      if (!(await limit(R, 'st:rl:code:' + ipOf(req), 20, 600))) return json(res, 429, { error: 'Too many requests, try again in a few minutes' });
      let code = await R.get(key);
      if (!code) {
        code = crypto.randomBytes(4).toString('hex').toUpperCase();
        await R.set(key, code, { ex: 3600 });
      }
      const text = postText(handle, wallet, code);
      return json(res, 200, { code, text, intent: 'https://x.com/intent/post?text=' + encodeURIComponent(text), expiresIn: 3600 });
    }

    if (b.action === 'verify') {
      if (!(await limit(R, 'st:rl:verify:' + ipOf(req), 12, 600))) return json(res, 429, { error: 'Too many checks, try again in a few minutes' });
      const code = await R.get(key);
      if (!code) return json(res, 400, { error: 'Get a new code first, the old one expired' });
      const m = /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/.exec(String(b.url || ''));
      if (!m) return json(res, 400, { error: 'Paste the link to your post' });
      const post = await readPost(m[2]);
      if (!post) return json(res, 425, { error: 'The post could not be read yet, try again in a minute' });
      if (post.author.toLowerCase() !== handle) return json(res, 403, { error: `That post is from @${post.author}, not @${handle}` });
      const text = post.text.toLowerCase();
      if (!text.includes(code.toLowerCase()) || !text.includes(wallet.toLowerCase())) return json(res, 403, { error: 'The post must contain the code and the full wallet address' });
      if (post.createdAt && Date.now() / 1000 - post.createdAt > 7200) return json(res, 403, { error: 'The post is older than two hours, publish a new one' });

      const key2 = process.env.STIPS_ORACLE_KEY || '';
      if (!/^0x[0-9a-fA-F]{64}$/.test(key2)) return json(res, 503, { error: 'The Stock Tips oracle is not configured yet' });
      const { factory } = await siteConfig(req);
      if (!factory) return json(res, 503, { error: 'The Stock Tips factory is not deployed yet' });
      const oracle = privateKeyToAccount(key2);
      const [jar, onchainOracle] = await Promise.all([
        pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'jarFor', args: [handle] }),
        pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'oracle' })
      ]);
      if (jar === ZERO) return json(res, 404, { error: `@${handle} has no jar yet, open a coin for it first` });
      if (onchainOracle.toLowerCase() !== oracle.address.toLowerCase()) return json(res, 503, { error: 'The oracle key does not match the factory' });
      const nonce = await pub.readContract({ address: jar, abi: JAR_ABI, functionName: 'nonce' });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const digest = await pub.readContract({ address: jar, abi: JAR_ABI, functionName: 'bindDigest', args: [wallet, nonce, deadline] });
      const signature = await oracle.sign({ hash: digest });
      await R.del(key);
      await R.lpush('st:verified', JSON.stringify({ handle, wallet, post: m[2], at: Date.now() }));
      await R.ltrim('st:verified', 0, 499);
      return json(res, 200, { jar, wallet, nonce: nonce.toString(), deadline: deadline.toString(), signature });
    }
    return json(res, 400, { error: 'Unknown action' });
  } catch (e) {
    return json(res, 500, { error: e.shortMessage || e.message || 'Server error' });
  }
}
