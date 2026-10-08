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
import { steamFixture, historyFixture, seed, second, key } from "./fixtures.js";

const userAgent = "OpenAI File Downloader, XaiImageApiFetch/1.0";
async function fill(page: Page, selector: string, value: string) {
  const dateInput = await page.$eval(selector, (input, value) => {
    if (!(input instanceof HTMLInputElement)) throw new Error("Expected an input");
    if (input.type === "date") { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); return true; }
    input.value = ""; return false;
  }, value);
  if (!dateInput) await page.type(selector, value);
}
async function visibleText(page: Page, selector: string) {
  return page.$eval(selector, (element) => element.textContent);
}
async function checkUndatedRecords(page: Page) {
  for (const tab of ["persona", "realName", "url", "pfp"]) {
    await page.click(`[data-history="${tab}"]`); await fill(page, "#history-search", "Timestamp check");
    const dates = await page.$$eval("#history-rows tr td:nth-child(2)", (cells) => cells.map((cell) => cell.textContent));
    assert.equal(dates.length, 3); assert.equal(dates.filter((date) => date === "Undated").length, 2);
    assert.equal(dates.some((date) => date?.includes("Invalid Date")), false);
    await fill(page, "#history-from", "1970-01-01"); await fill(page, "#history-to", "1970-01-01");
    assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 1);
    assert.match(await visibleText(page, "#history-rows") ?? "", /Timestamp check Epoch/);
    await fill(page, "#history-from", ""); await fill(page, "#history-to", "");
  }
}
async function checkIndependentDetails(page: Page) {
  // A second details window keeps the first record intact and leaves the viewer interactive.
  await page.$eval("#history-rows button", (button) => { if (!(button instanceof HTMLButtonElement)) throw new Error("Expected details button"); button.click(); });
  assert.equal((await page.$$(".details-window")).length, 2);
  const heading = await page.$eval(".details-window h2", (element) => { const box = element.getBoundingClientRect(); return { x: box.x + 30, y: box.y + 8 }; });
  await page.mouse.move(heading.x, heading.y); await page.mouse.down(); await page.mouse.move(100, 100); await page.mouse.up();
  assert.equal(await page.$eval(".details-window", (panel) => panel.getBoundingClientRect().left < 100), true);
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "history-multiple-details.png") });

  const before = await page.$eval(".details-window", (panel) => { if (!(panel instanceof HTMLElement)) throw new Error("Expected details window"); return panel.offsetLeft; });
  await page.focus(".details-window h2"); await page.keyboard.press("ArrowLeft");
  assert.equal(await page.$eval(".details-window", (panel) => { if (!(panel instanceof HTMLElement)) throw new Error("Expected details window"); return panel.offsetLeft; }), before - 16);
  await page.keyboard.press("Escape"); assert.equal((await page.$$(".details-window")).length, 1);
  assert.match(await visibleText(page, ".details-record"), /Alice Example/);
  await page.setViewport({ width: 320, height: 800 });
  await page.waitForFunction(() => { const box = document.querySelector(".details-window")?.getBoundingClientRect(); return box && box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight; });
  assert.equal(await page.$eval(".details-window", (panel) => { const box = panel.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight; }), true);
  await page.setViewport({ width: 1078, height: 599 });
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "history-details.png") });
}
async function checkProfileDetails(page: Page) {
  await page.click('[data-view="friends"]');
  await page.$$eval("#friend-rows tr button", (buttons) => {
    for (const button of buttons.slice(0, 2)) if (button instanceof HTMLButtonElement) button.click();
  });
  const profiles = await page.$$eval(".details-window", (panels) => panels.map((panel) => {
    if (!(panel instanceof HTMLElement)) throw new Error("Expected profile window"); return panel.dataset.profile;
  }));
  assert.equal(profiles.length, 2); assert.notEqual(profiles[0], profiles[1]);
  await page.$eval('[data-view="network"]', (button) => { if (!(button instanceof HTMLButtonElement)) throw new Error("Expected network tab"); button.click(); });
  const headings = await page.$$(".details-window h2");
  for (const [index, left] of [36, 520].entries()) {
    const title = headings[index]; assert.ok(title);
    const heading = await title.evaluate((element) => {
      const box = element.getBoundingClientRect(); const panel = element.closest(".details-window")?.getBoundingClientRect();
      if (!panel) throw new Error("Expected details window");
      return { x: box.x + box.width / 2, y: box.y + 8, dx: box.x + box.width / 2 - panel.x, dy: box.y + 8 - panel.y };
    });
    await page.mouse.move(heading.x, heading.y); await page.mouse.down(); await page.mouse.move(left + heading.dx, 90 + heading.dy); await page.mouse.up();
  }
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "profile-details.png") });
  await page.$$eval(".details-close", (buttons) => { for (const button of buttons) if (button instanceof HTMLButtonElement) button.click(); });
}
async function keyForm(page: Page, value: string) {
  await page.click('#open-key'); await fill(page, "#key", value); await page.click('#key-form button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("#key-dialog")?.open);
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
  const historyProvider = await historyFixture(); historyProvider.setStatus(403); shutdown.push(() => historyProvider.close());
  root = await mkdtemp(join(tmpdir(), "vapora-browser-e2e-"));
  const downloadDirectory = join(root, "downloads"); await mkdir(downloadDirectory);
  const browser = await puppeteer.launch({ executablePath, headless: true, downloadBehavior: { policy: "allow", downloadPath: downloadDirectory }, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  shutdown.push(() => browser.close());
  let server = await Server.start({ root, key: "b".repeat(32), port: 0, steamBaseUrl: fixture.url, historyBaseUrl: historyProvider.url, historySession: historyProvider.session, retryBaseMs: 1 });
  shutdown.push(() => server.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on("pageerror", (error) => errors.push(String(error)));
  const runRequests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/runs/")) runRequests.push(request.url()); });
  const screenshot = async (name: string) => {
    if (!process.env.VAPORA_BROWSER_SCREENSHOTS) return;
    if (name === "exports") await page.setViewport({ width: 1078, height: 800 });
    const clip = name === "exports" ? await page.$eval("body", (body) => ({ x: 0, y: 0, width: innerWidth, height: body.getBoundingClientRect().height })) : undefined;
    await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, `${name}.png`), ...(clip ? { clip } : {}) });
    if (name === "exports") await page.setViewport({ width: 1078, height: 599 });
  };
  const state = async () => Schema.decodeUnknownSync(Contracts.State)(await (await fetch(`${server.origin}/api/state`, { headers: { "user-agent": userAgent } })).json());
  await page.setUserAgent(userAgent); await page.setViewport({ width: 1078, height: 599 }); await page.goto(server.origin);
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#scan-button")?.disabled);
  const help = '[aria-label="About node limit"]';
  await page.hover(help);
  await page.waitForSelector('#app-tooltip:popover-open');
  assert.match(await visibleText(page, "#app-tooltip") ?? "", /0 removes the cap/);
  assert.equal(await page.$eval(help, (element) => element.hasAttribute("title")), false);
  await page.hover("#app-tooltip"); await delay(150);
  assert.equal(await page.$eval("#app-tooltip", (element) => element.matches(":popover-open")), true);
  await page.keyboard.press("Escape"); await page.waitForSelector('#app-tooltip:popover-open', { hidden: true });
  await page.focus(help); await page.waitForSelector('#app-tooltip:popover-open');
  assert.equal(await page.$eval(help, (element) => element.getAttribute("aria-describedby")), "app-tooltip");
  await page.keyboard.press("Escape"); await page.waitForSelector('#app-tooltip:popover-open', { hidden: true });
  await page.click(help); await page.hover("#target"); await delay(150);
  assert.equal(await page.$eval("#app-tooltip", (element) => element.matches(":popover-open")), true);
  await page.click("#target"); assert.match(await visibleText(page, "#app-tooltip") ?? "", /Steam ID/);
  await page.click("#target-name"); await page.waitForSelector('#app-tooltip:popover-open', { hidden: true });
  await page.click(help); await page.keyboard.press("Tab");
  await page.waitForSelector('#app-tooltip:popover-open', { hidden: true });
  await page.click("#output-folder");
  assert.match(await visibleText(page, "#notice") ?? "", /Open a saved run/);
  assert.equal(await page.$eval("#scan-screen", (element) => element instanceof HTMLElement && element.hidden), false);
  await page.click('[data-screen="results"]'); await page.click("#output-folder");
  assert.match(await visibleText(page, "#notice") ?? "", /Open a saved run/);
  assert.equal(await page.$eval("#run-library", (element) => element instanceof HTMLElement && element.hidden), false);
  await page.click('[data-screen="scan"]');
  await fill(page, "#target", seed); await fill(page, "#maxNodes", "4"); await page.click("#scan-button");
  await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "failed");
  assert.match(await visibleText(page, "#report-error") ?? "", /denied access/);
  await page.click("#open-key"); assert.equal(await page.$eval("#app-tooltip", (element) => element.matches(":popover-open")), false);
  assert.equal(await page.$eval("#remember-key-label", (element) => element instanceof HTMLElement && element.hidden), true);
  await screenshot("browser-key");
  await fill(page, "#key", "bad"); await page.click("#use-key");
  await page.waitForSelector("#key-error:not([hidden])"); assert.match(await visibleText(page, "#key-error") ?? "", /32-character/);
  await fill(page, "#key", "b".repeat(32)); await page.click("#show-key");
  assert.equal(await page.$eval("#key", (input) => input instanceof HTMLInputElement && input.type), "text");
  await page.click("#use-key"); await page.waitForFunction(() => document.querySelector("#key-error")?.textContent?.includes("denied access"));
  assert.equal((await state()).hasKey, true);
  await page.click("#cancel-key");
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>("#key")?.value === "");
  assert.equal(await page.$eval("#key", (input) => input instanceof HTMLInputElement && input.value), "");
  await keyForm(page, `  ${key}  `); await page.click("#lookup-target");
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
  assert.equal(await page.$eval("#open-key", (element) => element instanceof HTMLButtonElement && element.disabled), true);
  await page.click('[data-screen="results"]'); await page.click('[data-screen="scan"]'); await page.click("#target-history");
  assert.equal(await page.$eval("#progress-section", (element) => element instanceof HTMLElement && element.hidden), false);
  await page.click("#cancel-button"); await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "cancelled").catch(async (error) => {
    console.error("Cancellation failure", { job: (await state()).job, notice: await visibleText(page, "#notice"), report: await visibleText(page, "#report-error"), pageErrors: errors });
    throw error;
  });
  fixture.release("/ISteamUser/GetFriendList/v1/", second); const cancelled = await state(); const id = cancelled.job.id; assert.ok(id);
  assert.equal(cancelled.job.status, "cancelled"); const seedRequests = fixture.requests.filter((request) => request.path.includes("GetFriendList") && request.id === seed).length;
  await server.close(); server = await Server.start({ root, key, port: 0, steamBaseUrl: fixture.url, historyBaseUrl: historyProvider.url, historySession: historyProvider.session, retryBaseMs: 1 });
  await page.goto(`${server.origin}/#${id}`); await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "cancelled").catch(async (error) => {
    const savedResponse = await fetch(`${server.origin}/api/runs/${id}`, { headers: { "user-agent": userAgent } });
    console.error("Cancelled run reopen failure", { job: (await state()).job, notice: await visibleText(page, "#notice"), reportStatus: await visibleText(page, "#report-status"), responseStatus: savedResponse.status, response: await savedResponse.text(), pageErrors: errors });
    throw error;
  });
  await page.click("#resume-button"); await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "complete");
  assert.equal(fixture.requests.filter((request) => request.path.includes("GetFriendList") && request.id === seed).length, seedRequests);
  assert.equal(await page.$eval("#graph", (graph) => graph.children.length), 0);
  await page.click('[data-screen="scan"]'); await fill(page, "#target", "another-account");
  const railRequests = runRequests.length;
  const steamRequests = fixture.requests.filter((request) => !request.path.startsWith("/avatars/")).length;
  await page.click("#recent button");
  assert.equal(await page.$eval("#scan-screen", (element) => element instanceof HTMLElement && element.hidden), false);
  assert.equal(await page.$eval("#target", (input) => input instanceof HTMLInputElement && input.value), seed);
  assert.equal(await visibleText(page, "#target-name"), "Player 29");
  assert.equal(await page.$eval("#maxNodes", (input) => input instanceof HTMLInputElement && input.value), "4");
  assert.equal(runRequests.length, railRequests);
  assert.equal(fixture.requests.filter((request) => !request.path.startsWith("/avatars/")).length, steamRequests);
  await screenshot("scan");
  await page.click("#estimate-button"); await page.waitForSelector(".estimate-facts");
  assert.equal(await page.$eval(".estimate-facts", (facts) => facts.children.length), 6);
  await screenshot("estimate");
  await page.click('[aria-label="About this estimate"]'); await page.waitForSelector('#app-tooltip:popover-open');
  assert.match(await visibleText(page, "#app-tooltip") ?? "", /first two levels, not the full depth 5/);
  await page.keyboard.press("Escape");
  await page.setViewport({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await screenshot("estimate-narrow"); await page.setViewport({ width: 1078, height: 599 });
  await page.click('[data-screen="results"]');
  await page.click('[data-view="network"]'); await page.waitForSelector("#graph [data-node-id]");
  const graphNode = await page.$("#graph [data-node-id]"); assert.ok(graphNode);
  const originalZoom = await page.$eval("#graph", (graph) => graph.getAttribute("viewBox"));
  await page.click("#zoom-in"); const zoomed = await page.$eval("#graph", (graph) => graph.getAttribute("viewBox"));
  await page.click('[data-view="friends"]'); await page.click('[data-view="network"]');
  assert.equal(await graphNode.evaluate((node) => node.isConnected), true);
  assert.equal(await page.$eval("#graph", (graph) => graph.getAttribute("viewBox")), zoomed);
  await page.click("#zoom-reset");
  assert.equal(await page.$eval("#graph", (graph) => graph.getAttribute("viewBox")), originalZoom);
  assert.equal(await graphNode.evaluate((node) => node.isConnected), true);
  await screenshot("network"); await checkProfileDetails(page);
  await page.click('[data-view="ranking"]'); const requestCount = fixture.requests.length; await fill(page, "#ranking-mutual", "3");
  await page.click("#save-ranking"); await page.waitForFunction(() => document.querySelector("#notice")?.textContent?.includes("Saved ranking"));
  assert.equal(fixture.requests.length, requestCount); await screenshot("ranking");
  const history = join(root, "history-current.json"); const now = Math.floor(Date.now() / 1000);
  await writeFile(history, JSON.stringify({ steamID64: seed, name: "Current fixture", lastChecked: now, historic: { friends: [{ Friend: second, FriendDate: now - 1000 }] } }));
  await page.click('[data-screen="scan"]'); await page.click("#target-history"); await page.click("#open-history-import"); const upload = await page.$("input#history-file"); assert.ok(upload); await upload.uploadFile(history);
  await page.click("#attach-history"); await page.click('#history-form button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector<HTMLElement>("#history-download")?.hidden);
  await page.reload(); await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "complete");
  await page.click("#open-history"); assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 1);
  await page.click('[data-screen="results"]'); await page.click("#toggle-runs"); await page.click("#output-folder");
  assert.equal(await page.$eval("#run-library", (element) => element instanceof HTMLElement && element.hidden), true);
  assert.equal(await page.$eval("#exports-view", (element) => element instanceof HTMLElement && element.hidden), false);
  const downloads = await page.$$eval("#downloads a", (links) => links.map((link) => { if (!(link instanceof HTMLAnchorElement)) throw new Error("Expected a download link"); return link.href; })); assert.equal(downloads.length, 8);
  const checkpointPath = join(root, "outputs", id, "scan.json"); const checkpoint = await readFile(checkpointPath);
  const providerCalls = fixture.requests.filter((request) => !request.path.startsWith("/avatars/")).length;
  await writeFile(join(root, "outputs", id, "analysis.json"), "outdated export");
  assert.equal(await page.$eval("#rebuild-exports", (button) => button instanceof HTMLButtonElement && button.disabled), false);
  await page.click("#rebuild-exports"); await page.waitForFunction(() => document.querySelector("#notice")?.textContent?.includes("Rebuilt exports"));
  assert.deepEqual(await readFile(checkpointPath), checkpoint);
  assert.equal(fixture.requests.filter((request) => !request.path.startsWith("/avatars/")).length, providerCalls);
  await screenshot("exports");
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
  // Starting without a key must keep the workspace and resume the requested action after validation.
  await server.close(); server = await Server.start({ root, key: "", port: 0, steamBaseUrl: fixture.url, historyBaseUrl: historyProvider.url, historySession: historyProvider.session, retryBaseMs: 1 });
  await page.goto(server.origin); await page.waitForFunction(() => document.querySelector<HTMLElement>("#key-indicator")?.dataset.key === "missing");
  await fill(page, "#target", seed); await fill(page, "#maxNodes", "0"); await fill(page, "#rpm", "0"); await page.click("#apply-settings");
  await page.waitForFunction(() => document.querySelector("#notice")?.textContent?.includes("Saved default"));
  await page.reload(); await page.waitForFunction(() => document.querySelector<HTMLInputElement>("#rpm")?.value === "0");
  assert.equal(await page.$eval("#maxNodes", (input) => input instanceof HTMLInputElement && input.value), "0");
  await fill(page, "#target", seed); await page.click("#lookup-target"); await page.waitForSelector("#key-dialog[open]");
  assert.equal(await page.$eval("#scan-screen", (element) => element instanceof HTMLElement && element.hidden), false);
  await page.setViewport({ width: 320, height: 800 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await fill(page, "#key", key); await page.click("#use-key"); await page.waitForSelector("#key-dialog[open]", { hidden: true });
  await page.waitForFunction(() => document.querySelector("#target-name")?.textContent === "Player 29");
  await page.click(help); await page.waitForSelector('#app-tooltip:popover-open');
  assert.equal(await page.$eval("#app-tooltip", (element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 7 && bounds.right <= innerWidth - 7 && bounds.top >= 0 && bounds.bottom <= innerHeight;
  }), true);
  await page.keyboard.press("Escape");
  await page.setViewport({ width: 1078, height: 599 }); await page.click("#scan-button");
  await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "complete").catch(async (error) => {
    console.error("Uncapped scan failure", { job: (await state()).job, notice: await visibleText(page, "#notice"), report: await visibleText(page, "#report-error") });
    throw error;
  });
  const uncapped = (await state()).runs[0]; assert.ok(uncapped); assert.equal(uncapped.nodes, 5);
  await page.click('[data-view="friends"]');
  assert.match(await visibleText(page, "#friend-rows") ?? "", /Off/);
  assert.match(await visibleText(page, "#friend-rows") ?? "", /Private/);
  assert.deepEqual(errors, []);
});

test("history account selection, all viewer tabs, filters, original downloads and blocked refresh work end to end", { timeout: 90000 }, async (context) => {
  const executablePath = process.env.VAPORA_BROWSER; assert.ok(executablePath);
  const shutdown: (() => Promise<void>)[] = []; let root: string | undefined;
  context.after(async () => {
    const outcomes = await Promise.allSettled(shutdown.map((close) => close()));
    if (root) await rm(root, { recursive: true, force: true });
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  });
  const fixture = await steamFixture(); const history = await historyFixture();
  shutdown.push(() => fixture.close(), () => history.close());
  root = await mkdtemp(join(tmpdir(), "vapora-history-browser-")); const downloadDirectory = join(root, "downloads"); await mkdir(downloadDirectory);
  const server = await Server.start({ root, key, port: 0, steamBaseUrl: fixture.url, historyBaseUrl: history.url, historySession: history.session, retryBaseMs: 1 });
  shutdown.push(() => server.close());
  const browser = await puppeteer.launch({ executablePath, headless: true, downloadBehavior: { policy: "allow", downloadPath: downloadDirectory }, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  shutdown.push(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on("pageerror", (error) => errors.push(String(error)));
  await page.setUserAgent(userAgent); await page.setViewport({ width: 1078, height: 599 }); await page.goto(server.origin);
  await fill(page, "#target", seed); assert.equal(history.requests(), 0);
  await page.click("#lookup-target"); await page.waitForFunction(() => document.querySelector("#target-history-status")?.textContent === "History ready");
  assert.equal(history.requests(), 8); await page.click("#target-history");
  assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 2);
  await page.click('[data-history="ranking"]'); assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 4);
  const reference = await visibleText(page, "#history-scope");
  const score = await page.$eval("#history-rows tr:nth-child(3) td:last-child", (cell) => cell.textContent);
  await page.select("#history-status", "former"); assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 1);
  assert.equal(await visibleText(page, "#history-scope"), reference);
  assert.equal(await page.$eval("#history-rows tr td:last-child", (cell) => cell.textContent), score);
  await page.select("#history-status", "all");
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "history-comment-ranking.png") });
  for (const [tab, count] of [["comments", 4], ["persona", 2], ["realName", 1], ["url", 1], ["pfp", 1], ["profile", 1], ["locations", 1]] as const) {
    await page.click(`[data-history="${tab}"]`); assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), count);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  await page.click('[data-history="realName"]');
  assert.match(await visibleText(page, "#history-rows"), /Alice Example/);
  await fill(page, "#history-search", "not in this capture"); assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 0);
  await fill(page, "#history-search", "Alice Example"); assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 1);
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "history-real-names.png") });
  await page.click("#history-rows button"); assert.match(await visibleText(page, ".details-record"), /Alice Example/);
  await checkIndependentDetails(page);
  await page.click(".details-close"); await fill(page, "#history-search", "");
  await page.click('[data-history="profile"]'); await page.click("#history-rows button");
  assert.match(await visibleText(page, ".details-record") ?? "", /customField/); await page.click(".details-close");
  await page.click('[data-history="comments"]'); await fill(page, "#history-search", "Former friend");
  assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 1); await fill(page, "#history-search", "");
  await fill(page, "#history-from", "2026-10-06"); await fill(page, "#history-to", "2026-10-08");
  assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 3);
  await page.click('[data-history="profile"]');
  assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 1);
  await fill(page, "#history-to", "2026-10-06");
  assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 0);
  await fill(page, "#history-from", ""); await fill(page, "#history-to", "");
  await page.click("#history-sources button");
  let original: string | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { original = await readFile(join(downloadDirectory, `history-${seed}-1.json`), "utf8"); break; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; await delay(100); }
  }
  assert.ok(original);
  const capture = JSON.parse(original);
  assert.equal(capture.type, "SteamHistoryCapture");
  assert.equal(capture.steamID64, seed);
  assert.equal(capture.pages.length, 7);
  assert.match(capture.profile.contents, /customField/);
  history.counts.set("comments", 8); await page.click("#history-refresh");
  await page.waitForFunction(() => document.querySelector("#target-history-status")?.textContent === "History partial");
  assert.match(await visibleText(page, "#history-warnings") ?? "", /supporter access/);
  assert.equal(await page.$eval("#history-warnings", (element) => element.getBoundingClientRect().bottom <= innerHeight), true);
  assert.equal(await page.$eval("#history-fetch-status", (element) => element instanceof HTMLElement && element.hidden), true);
  await page.click('[data-history="comments"]');
  assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 4);
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "history-partial-comments.png") });
  history.setStatus(403); await page.click("#history-refresh"); await page.waitForFunction(() => document.querySelector("#history-fetch-status")?.textContent?.includes("blocked"));
  assert.equal(await page.$eval("#history-result", (element) => element instanceof HTMLElement && element.hidden), false);
  await page.click("#history-retry"); await page.waitForFunction(() => !document.querySelector<HTMLElement>("#history-retry")?.hidden);
  await page.setViewport({ width: 320, height: 800 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.setViewport({ width: 1078, height: 599 }); await page.click('[data-screen="scan"]');
  await fill(page, "#rpm", "0"); await fill(page, "#maxNodes", "2"); await page.click("#scan-button");
  await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "complete");
  const run = Schema.decodeUnknownSync(Contracts.State)(await (await fetch(`${server.origin}/api/state`, { headers: { "user-agent": userAgent } })).json());
  assert.ok(run.job.id);
  const attached = await readFile(join(root, "outputs", run.job.id, "history.json"), "utf8"); assert.ok(JSON.parse(attached).sources.length);
  await page.click('[data-view="friends"]');
  await page.$$eval("#friend-rows tr", (rows) => rows.find((row) => row.textContent?.includes("Outside graph"))?.querySelector("button")?.click());
  assert.match(await visibleText(page, ".details-facts") ?? "", /Outside admitted graph/);
  await page.click(".details-close");
  const calls = history.requests(); await page.click('[data-screen="scan"]'); await page.click("#recent button");
  await page.waitForFunction(() => document.querySelector("#target-history-status")?.textContent === "History unavailable");
  assert.equal(history.requests(), calls); // A known failed refresh is retried explicitly, not on every navigation.
  await page.click("#target-history"); await page.click("#open-history-import");
  const pagedFile = join(root, "history-pages.json");
  const recordDates = [{ label: "Null", Timestamp: null }, { label: "Invalid", Timestamp: "not a date" }, { label: "Epoch", Timestamp: 0 }];
  const names = recordDates.map(({ label, Timestamp }) => ({ Name: `Timestamp check ${label}`, Timestamp }));
  await writeFile(pagedFile, JSON.stringify({ ...history.document, historic: { ...history.document.historic,
    persona: [...Array.from({ length: 201 }, (_, index) => ({ Name: `History name ${index}`, Timestamp: 1791360000 })), ...names],
    realName: names,
    url: recordDates.map(({ label, Timestamp }) => ({ URL: `Timestamp check ${label}`, Timestamp })),
    pfp: recordDates.map(({ label, Timestamp }) => ({ AvatarHash: `Timestamp check ${label}`, Timestamp })),
  } }));
  const file = await page.$("input#history-file"); assert.ok(file); await file.uploadFile(pagedFile);
  await page.click('#history-form button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("#history-import-dialog")?.open);
  await page.click('[data-history="persona"]');
  assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 100);
  assert.match(await visibleText(page, "#history-count") ?? "", /1–100 of 208/);
  await page.click("#history-next"); assert.match(await visibleText(page, "#history-count") ?? "", /101–200 of 208/);
  await page.click("#history-next"); assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 8);
  await fill(page, "#history-search", "History name 200");
  assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 1);
  assert.equal(await page.$eval("#history-next", (button) => button instanceof HTMLButtonElement && button.disabled), true);
  await page.click('[data-screen="scan"]'); await page.click("#target-history");
  assert.match(await visibleText(page, "#history-rows") ?? "", /History name 200/);
  assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 1);
  assert.match(await visibleText(page, "#history-count") ?? "", /of 1/);
  await checkUndatedRecords(page);
  // A recovered refresh must update the open run, its attachment and its download without reopening it.
  await page.click('[data-screen="results"]'); await page.click("#open-history");
  await page.click("#history-refresh");
  await page.waitForFunction(() => document.querySelector("#history-fetch-status")?.textContent?.includes("blocked"));
  history.rows.set("comments", [...history.document.historic.comments, { ID: "recovered", Commenter: second, Message: "Recovered attached comment", Timestamp: 1791360000 }]);
  history.counts.set("comments", 5); history.setStatus(200);
  await fill(page, "#history-search", ""); await page.click('[data-history="comments"]');
  await page.click("#history-retry");
  await page.waitForFunction(() => document.querySelector("#history-rows")?.textContent?.includes("Recovered attached comment"));
  const attachmentUrl = await page.$eval("#history-download", (link) => {
    if (link instanceof HTMLElement && link.hidden) throw new Error("Run download disappeared after retry");
    return link instanceof HTMLAnchorElement ? link.href : "";
  });
  const download = await fetch(attachmentUrl, { headers: { "user-agent": userAgent } });
  assert.equal(download.status, 200); assert.match(await download.text(), /Recovered attached comment/);
  assert.match(await readFile(join(root, "outputs", run.job.id, "history.json"), "utf8"), /Recovered attached comment/);
  await page.click('[data-screen="results"]'); await page.click("#open-history");
  assert.match(await visibleText(page, "#history-rows") ?? "", /Recovered attached comment/);
  history.setStatus(403); await page.click("#history-refresh");
  await page.waitForFunction(() => document.querySelector("#history-fetch-status")?.textContent?.includes("blocked"));
  await page.click('[data-screen="scan"]');
  history.rows.set("comments", [...history.document.historic.comments, { ID: "target-recovered", Commenter: second, Message: "Recovered from target panel", Timestamp: 1791360000 }]);
  history.setStatus(200); await page.click("#target-history-retry");
  await page.waitForFunction(() => document.querySelector("#target-history-status")?.textContent === "History ready");
  await page.click('[data-screen="results"]'); await page.click("#open-history");
  assert.match(await visibleText(page, "#history-rows") ?? "", /Recovered from target panel/);
  assert.match(await readFile(join(root, "outputs", run.job.id, "history.json"), "utf8"), /Recovered from target panel/);
  await rm(join(root, "history", `${seed}.json`)); history.setStatus(403);
  const requestsBeforeReopen = history.requests();
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#target-history-status")?.textContent === "History ready");
  await page.click("#open-history"); await page.click('[data-history="comments"]');
  assert.match(await visibleText(page, "#history-rows") ?? "", /Recovered from target panel/);
  assert.equal(history.requests(), requestsBeforeReopen);
  assert.deepEqual(errors, []);
});
