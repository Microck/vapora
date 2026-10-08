import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('out');
async function walk(dir, extension = '.html') {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) files.push(...await walk(path, extension));
    else if (item.name.endsWith(extension)) files.push(path);
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

const contentRoot = resolve('content/docs');
const documents = await walk(contentRoot, '.mdx');
const expectedUrls = documents.map((file) => '/docs' + file.slice(contentRoot.length).split(sep).join('/').replace(/\.mdx$/, '').replace(/\/index$/, '')).sort();
const index = await readFile(join(root, 'llms.txt'), 'utf8');
const indexedUrls = [...index.matchAll(/\]\((\/docs[^)]*)\)/g)].map((match) => match[1]).sort();
assert.deepEqual(indexedUrls, expectedUrls, 'The text index must list every docs page exactly once.');
const full = await readFile(join(root, 'llms-full.txt'), 'utf8');
for (const url of expectedUrls) assert(full.includes(`(${url})`), `Full text export is missing ${url}.`);
for (const command of ['Get-FileHash', 'sha256sum', 'shasum', 'export STEAM_API_KEY', '$env:STEAM_API_KEY']) {
  assert(full.includes(command), `Full text export lost a command tab: ${command}`);
}
for (const name of ['network', 'estimate', 'ranking', 'history', 'exports', 'inspector']) {
  const original = await readFile(`../docs/screenshots/${name}.png`);
  assert(original.equals(await readFile(join(root, 'screenshots', `${name}.png`))), `Exported screenshot is stale: ${name}`);
}
for (const [original, exported] of [['vapora.svg', 'vapora.svg'], ['vapora.ico', 'favicon.ico']]) {
  const asset = await readFile(`../assets/${original}`);
  assert(asset.equals(await readFile(join(root, exported))), `Exported branding is stale: ${exported}`);
}
console.log(`Text exports cover ${documents.length} docs pages and all command tabs; screenshots and branding match their sources.`);
