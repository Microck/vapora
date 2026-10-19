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
let closing = false;
async function close() {
 if (closing) return; closing = true;
 try { await server.close(); await steam.close(); await history.close(); }
 finally { await rm(root, {recursive:true, force:true}); }
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
