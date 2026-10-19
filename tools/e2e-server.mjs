import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../dist/src/server.js';
import { steamFixture, historyFixture, key } from '../dist/test/fixtures.js';
const root = await mkdtemp(join(tmpdir(), 'vapora-deterministic-e2e-'));
const steam = await steamFixture();
const history = await historyFixture();
const server = await start({root, key, port:4178, steamBaseUrl:steam.url, historyBaseUrl:history.url, historySession:history.session, retryBaseMs:1});
console.log(server.origin);
let closing;
function close() {
 if (closing) return closing;
 closing = (async () => {
  const results = await Promise.allSettled([
   Promise.resolve().then(() => server.close()),
   Promise.resolve().then(() => steam.close()),
   Promise.resolve().then(() => history.close()),
  ]);
  try { await rm(root, {recursive:true, force:true}); }
  catch (error) { results.push({status:'rejected', reason:error}); }
  const failures = results.filter(result => result.status === 'rejected');
  for (const failure of failures) console.error('E2E cleanup failed:', failure.reason);
  if (failures.length) process.exitCode = 1;
 })();
 return closing;
}
process.once('SIGINT', () => { void close().catch(error => { console.error(error); process.exitCode = 1; }); });
process.once('SIGTERM', () => { void close().catch(error => { console.error(error); process.exitCode = 1; }); });
