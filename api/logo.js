/* Stores a token logo (webp/png/jpeg data URL, square, made in the browser) and returns the https URL that goes on chain.
   Entries never change: a URL always shows the logo it was launched with. */
import { redis } from '../lib/store.js';
import { json, ipOf, body } from '../lib/http.js';
import { hostOf, limit } from '../lib/server.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  let R;
  try { R = redis(); } catch { return json(res, 503, { error: 'Logo storage is not connected yet' }); }
  try {
    if (!(await limit(R, 'st:rl:logo:' + ipOf(req), 12, 600))) return json(res, 429, { error: 'Too many uploads, try again in a few minutes' });
    const { image } = body(req);
    const m = /^data:(image\/(?:webp|png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
    if (!m) return json(res, 400, { error: 'Send a webp, png or jpeg image' });
    if (m[2].length > 200_000) return json(res, 413, { error: 'Logo is too large' });
    const id = Array.from({ length: 10 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
    await R.set('st:img:' + id, image);
    return json(res, 200, { url: `https://${hostOf(req)}/api/img?id=${id}` });
  } catch (e) {
    return json(res, 500, { error: e.message || 'Server error' });
  }
}
