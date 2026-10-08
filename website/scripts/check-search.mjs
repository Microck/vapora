import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { staticClient } from 'fumadocs-core/search/client/orama-static';
const index = await readFile('out/api/search');
const server = createServer((request, response) => {
  if (request.url !== '/api/search') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(index);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const address = server.address();
  assert(address && typeof address === 'object');
  const client = staticClient({ from: `http://127.0.0.1:${address.port}/api/search` });
  for (const [query, path] of [['mutual', '/docs/reference/scoring'], ['port', '/docs/reference/cli'], ['SteamHistory', '/docs/guides/history']]) {
    const results = await client.search(query);
    assert(results.some((result) => result.url.split('#')[0] === path), `${query} did not return ${path}`);
    console.log(`Static search: ${query} → ${path}`);
  }
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
