/* Local dev server: static files, the /p/<slug> rewrite and the Vercel functions in api/. --memory keeps storage in memory. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
if (process.argv.includes('--memory')) process.env.STIPS_MEMORY = '1';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local');
  try {
    if (u.pathname.startsWith('/api/')) {
      const mod = await import(pathToFileURL(path.join(root, 'api', u.pathname.slice(5).replace(/\/$/, '') + '.js')).href);
      req.query = Object.fromEntries(u.searchParams);
      let data = '';
      for await (const c of req) data += c;
      req.body = data;
      return await mod.default(req, res);
    }
    let p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
    if (/^\/@[A-Za-z0-9_]+\/?$/.test(p)) p = "/jar.html";
    if (!path.extname(p)) p += '.html';
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', types[path.extname(f)] || 'application/octet-stream');
    fs.createReadStream(f).pipe(res);
  } catch (e) { res.statusCode = 500; res.end(String(e.stack || e)); }
}).listen(Number(process.env.PORT || 8798), () => console.log('stocktips dev on', process.env.PORT || 8798));
