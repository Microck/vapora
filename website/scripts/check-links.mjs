import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve('out');
async function walk(dir) {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) files.push(...await walk(path));
    else if (item.name.endsWith('.html')) files.push(path);
  }
  return files;
}
const pages = await walk(root);
const cache = new Map();
const failures = [];
let checked = 0;
const decode = (value) => value.replaceAll('&amp;', '&').replaceAll('&#x27;', "'").replaceAll('&quot;', '"');
async function exists(path) { try { return (await stat(path)).isFile(); } catch { return false; } }
for (const file of pages) {
  const html = await readFile(file, 'utf8');
  const url = new URL(file.slice(root.length).replace(/index\.html$/, ''), 'https://docs.invalid');
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const raw = decode(match[1]);
    if (!raw || /^(https?:|mailto:|data:|tel:)/.test(raw)) continue;
    const target = new URL(raw, url);
    const path = decodeURIComponent(target.pathname);
    const candidates = [join(root, path), join(root, path, 'index.html'), join(root, `${path}.html`)];
    let found;
    for (const candidate of candidates) if (await exists(candidate)) { found = candidate; break; }
    checked++;
    if (!found) { failures.push(`${file.slice(root.length)}: missing ${raw}`); continue; }
    if (target.hash && found.endsWith('.html')) {
      let ids = cache.get(found);
      if (!ids) {
        const content = await readFile(found, 'utf8');
        ids = new Set([...content.matchAll(/id="([^"]+)"/g)].map((m) => decode(m[1])));
        cache.set(found, ids);
      }
      if (!ids.has(decodeURIComponent(target.hash.slice(1)))) failures.push(`${file.slice(root.length)}: missing anchor ${raw}`);
    }
  }
}
if (failures.length) { console.error([...new Set(failures)].join('\n')); process.exitCode = 1; }
else console.log(`Validated ${checked} internal page, asset and anchor links across ${pages.length} HTML files.`);
