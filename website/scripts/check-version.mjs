import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const { version } = JSON.parse(await read('../../package.json'));
const index = await read('../content/docs/index.mdx');
const releases = await read('../content/docs/project/releases.mdx');
const installation = await read('../content/docs/getting-started/installation.mdx');
assert(index.includes(`**Version:** ${version},`), 'Documentation overview version must match the app');
assert(releases.includes(`These docs describe ${version};`), 'Release documentation version must match the app');
assert(releases.includes(`/docs/releases/${version}.md)`), 'Current release notes must be linked');
await read(`../../docs/releases/${version}.md`);
const examples = [...installation.matchAll(/vapora-(\d+\.\d+\.\d+)-/g)];
assert(examples.length > 0, 'Installation instructions must include download filename examples');
for (const [, exampleVersion] of examples) assert.equal(exampleVersion, version, 'Installation filename version must match the app');
assert(installation.includes(`Asset names above describe ${version};`), 'Installation version note must match the app');
console.log(`Documentation version and download examples match ${version}`);
