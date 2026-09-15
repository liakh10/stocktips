/* Copies ABIs and bytecode for the site and /deploy into lib/abi. */
import fs from 'node:fs';
import path from 'node:path';
const dir = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(dir, '..', 'lib', 'abi');
fs.mkdirSync(out, { recursive: true });
for (const n of ['TipFactory', 'TipJar', 'TipBurner']) {
  const a = JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', n + '.json'), 'utf8'));
  fs.writeFileSync(path.join(out, n + '.json'), JSON.stringify({ contractName: n, compiler: a.compiler, abi: a.abi, bytecode: a.bytecode }));
}
console.log('exported');
