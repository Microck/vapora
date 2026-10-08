import { cp, mkdir } from 'node:fs/promises';
await mkdir('public/screenshots', { recursive: true });
await cp('../assets/vapora.svg', 'public/vapora.svg');
for (const name of ['network', 'estimate', 'ranking', 'history', 'exports', 'inspector']) {
  await cp(`../docs/screenshots/${name}.png`, `public/screenshots/${name}.png`);
}
