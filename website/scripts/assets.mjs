import { cp, mkdir } from 'node:fs/promises';
await mkdir('public/screenshots', { recursive: true });
await cp('../assets/vapora.svg', 'public/vapora.svg');
await cp('../assets/vapora.ico', 'public/favicon.ico');
for (const name of ['network', 'estimate', 'ranking', 'history', 'exports', 'inspector']) {
  await cp(`../docs/screenshots/${name}.png`, `public/screenshots/${name}.png`);
}
