import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import type { Page } from "puppeteer-core";
import { Schema } from "effect";
import * as Server from "../src/server.js";
import * as Contracts from "../src/contracts.js";
import { steamFixture, seed, second, key } from "./fixtures.js";

const userAgent = "OpenAI File Downloader, XaiImageApiFetch/1.0";
async function fill(page: Page, selector: string, value: string) {
  await page.$eval(selector, (input) => { if (!(input instanceof HTMLInputElement)) throw new Error("Expected an input"); input.value = ""; });
  await page.type(selector, value);
}
async function visibleText(page: Page, selector: string) {
  return page.$eval(selector, (element) => element.textContent);
}
async function keyForm(page: Page, value: string) {
  await page.click('[data-screen="settings"]'); await fill(page, "#key", value); await page.click('#key-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("#key")?.value === "");
  await page.click('[data-screen="scan"]');
}

// This suite drives real Chromium, HTTP endpoints, provider fixtures and filesystem checkpoints.
// Keep it separate from the headless domain suite: it requires an explicit installed browser.
test("browser recovers identity after denied keys, cancels/resumes, persists settings and imports history", { timeout: 120000 }, async (context) => {
  const executablePath = process.env.VAPORA_BROWSER;
  assert.ok(executablePath, "Set VAPORA_BROWSER to an installed Chrome/Chromium executable before running test:e2e.");
  const shutdown: (() => Promise<void>)[] = [];
  let root: string | undefined;
  context.after(async () => {
    const outcomes = await Promise.allSettled(shutdown.map((close) => close()));
    if (root) await rm(root, { recursive: true, force: true });
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  });
  const fixture = await steamFixture(); shutdown.push(() => fixture.close());
  root = await mkdtemp(join(tmpdir(), "vapora-browser-e2e-"));
  const downloadDirectory = join(root, "downloads"); await mkdir(downloadDirectory);
  const browser = await puppeteer.launch({ executablePath, headless: true, downloadBehavior: { policy: "allow", downloadPath: downloadDirectory }, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  shutdown.push(() => browser.close());
  let server = await Server.start({ root, key: "b".repeat(32), port: 0, steamBaseUrl: fixture.url, retryBaseMs: 1 });
  shutdown.push(() => server.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on("pageerror", (error) => errors.push(String(error)));
  const state = async () => Schema.decodeUnknownSync(Contracts.State)(await (await fetch(`${server.origin}/api/state`, { headers: { "user-agent": userAgent } })).json());
  await page.setUserAgent(userAgent); await page.setViewport({ width: 1078, height: 599 }); await page.goto(server.origin);
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#scan-button")?.disabled);
  await fill(page, "#target", seed); await fill(page, "#maxNodes", "4"); await page.click("#scan-button");
  await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "failed");
  assert.match(await visibleText(page, "#report-error") ?? "", /denied access/);
  await keyForm(page, key); await page.click("#lookup-target");
  // A failed checkpoint has no summary. The fresh lookup must replace its placeholder identity.
  await page.waitForFunction(() => document.querySelector("#target-name")?.textContent === "Player 29");
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>("#target-avatar")?.src.includes("/avatars/") && (document.querySelector<HTMLImageElement>("#target-avatar")?.naturalWidth ?? 0) > 0);
  await fill(page, "#target", "another-account"); assert.equal(await visibleText(page, "#target-name"), "");
  await fill(page, "#target", seed); await page.click('[data-depth="5"]'); await page.click("#skip-private");
  await page.click("#apply-settings"); await page.waitForFunction(() => document.querySelector("#notice")?.textContent?.includes("Saved default"));
  await page.reload(); await page.waitForFunction(() => document.querySelector<HTMLInputElement>("#depth")?.value === "5");
  assert.equal(await page.$eval("#skip-private", (input) => input instanceof HTMLInputElement && input.checked), true);
  await page.click('[data-screen="scan"]');
  await fill(page, "#target", seed); const held = fixture.hold("/ISteamUser/GetFriendList/v1/", second); await page.click("#scan-button"); await held;
  await page.click('[data-screen="settings"]'); assert.equal(await page.$eval("#progress-section", (element) => element instanceof HTMLElement && element.hidden), false);
  await page.click("#cancel-button"); await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "cancelled");
  fixture.release("/ISteamUser/GetFriendList/v1/", second); const cancelled = await state(); const id = cancelled.job.id; assert.ok(id);
  assert.equal(cancelled.job.status, "cancelled"); const seedRequests = fixture.requests.filter((request) => request.path.includes("GetFriendList") && request.id === seed).length;
  await server.close(); server = await Server.start({ root, key, port: 0, steamBaseUrl: fixture.url, retryBaseMs: 1 });
  await page.goto(`${server.origin}/#${id}`); await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "cancelled");
  await page.click("#resume-button"); await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "complete");
  assert.equal(fixture.requests.filter((request) => request.path.includes("GetFriendList") && request.id === seed).length, seedRequests);
  await page.click('[data-view="ranking"]'); const requestCount = fixture.requests.length; await fill(page, "#ranking-mutual", "3");
  await page.click("#save-ranking"); await page.waitForFunction(() => document.querySelector("#notice")?.textContent?.includes("Saved ranking"));
  assert.equal(fixture.requests.length, requestCount);
  const history = join(root, "history-current.json"); const now = Math.floor(Date.now() / 1000);
  await writeFile(history, JSON.stringify({ steamID64: seed, name: "Current fixture", lastChecked: now, historic: { friends: [{ Friend: second, FriendDate: now - 1000 }] } }));
  await page.click('[data-screen="history"]'); const upload = await page.$("input#history-file"); assert.ok(upload); await upload.uploadFile(history);
  await page.click("#attach-history"); await page.click('#history-form button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector<HTMLElement>("#history-download")?.hidden);
  await page.reload(); await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "complete");
  await page.click("#open-history"); assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 1);
  await page.click('[data-screen="results"]'); await page.click('[data-view="exports"]');
  const downloads = await page.$$eval("#downloads a", (links) => links.map((link) => { if (!(link instanceof HTMLAnchorElement)) throw new Error("Expected a download link"); return link.href; })); assert.equal(downloads.length, 7);
  for (const url of downloads) { const response = await fetch(url, { headers: { "user-agent": userAgent } }); assert.equal(response.status, 200); assert.ok((await response.arrayBuffer()).byteLength); }
  for (const file of ["analysis.json", "gephi-nodes.csv", "history.json"]) {
    await page.click(`#downloads a[href*="${file.replace("gephi-", "")}"]`);
    // Read the final filename, which Chrome exposes only once the download is complete.
    let contents: string | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { contents = await readFile(join(downloadDirectory, file), "utf8"); break; }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        await delay(100);
      }
    }
    assert.ok(contents, `Browser did not save ${file}`);
    if (file.endsWith(".json")) assert.ok(JSON.parse(contents)); else assert.match(contents, /Id/);
  }
  const scan = JSON.parse(await readFile(join(root, "outputs", id, "scan.json"), "utf8")); assert.equal(scan.settings.weights.mutual, 3);
  await page.setViewport({ width: 320, height: 800 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.deepEqual(errors, []);
});
