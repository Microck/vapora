import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import type { Page, ScreenshotOptions, HTTPRequest } from "puppeteer-core";
import { Schema } from "effect";
import * as Server from "../src/server.js";
import * as Contracts from "../src/contracts.js";
import * as History from "../src/history.js";
import { steamFixture, historyFixture, seed, second, key, player, scan, denseScan, checkNodePicture } from "./fixtures.js";

const userAgent = "OpenAI File Downloader, XaiImageApiFetch/1.0";
async function fill(page: Page, selector: string, value: string) {
  const dateInput = await page.$eval(selector, (input, value) => {
    if (!(input instanceof HTMLInputElement)) throw new Error("Expected an input");
    if (input.type === "date") { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); return true; }
    input.value = ""; return false;
  }, value);
  if (!dateInput) await page.type(selector, value);
  // Search input is coalesced into a frame; act only after its final update has rendered.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function visibleText(page: Page, selector: string) {
  return page.$eval(selector, (element) => element.textContent);
}
async function readDownload(path: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { return await readFile(path, "utf8"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; await delay(100); }
  }
  throw new Error(`Download did not complete: ${path}; files: ${JSON.stringify(await readdir(dirname(path)))}`);
}
async function checkAdjacentHelp(page: Page, selector: string) {
  await page.waitForSelector("#app-tooltip:popover-open");
  assert.equal(await page.$eval(selector, (anchor) => {
    const trigger = anchor.getBoundingClientRect();
    const box = document.querySelector("#app-tooltip")?.getBoundingClientRect();
    if (!box?.width || !box.height) return false;
    const horizontalGap = Math.max(0, box.left - trigger.right, trigger.left - box.right);
    const verticalGap = Math.max(0, box.top - trigger.bottom, trigger.top - box.bottom);
    return horizontalGap <= 7 && verticalGap <= 7
      && (box.right <= trigger.left || box.left >= trigger.right || box.bottom <= trigger.top || box.top >= trigger.bottom)
      && box.left >= 8 && box.right <= innerWidth - 8 && box.top >= 8 && box.bottom <= innerHeight - 8;
  }), true, "Help must stay beside its trigger and inside the viewport");
}
async function checkSavedHistoryDiagnostics(page: Page, root: string, downloadDirectory: string) {
  const runId = await page.evaluate(() => location.hash.slice(1)); assert.ok(runId);
  const attached = Schema.decodeUnknownSync(Schema.fromJsonString(History.HistoryReport))(await readFile(join(root, "outputs", runId, "history.json"), "utf8"));
  const latest = attached.sources.at(-1); assert.ok(latest);
  const capture = Schema.decodeUnknownSync(Schema.fromJsonString(History.Document))(latest.contents);
  const comments = capture.coverage.find((section) => section.section === "comments"); assert.ok(comments);
  const diagnostic = `comments: SteamHistory's profile summary lists 8 comments records; this session returned ${comments.captured}. Deleted comments require SteamHistory supporter access; the summary may also be outdated.`;
  const contents = JSON.stringify({ ...capture, capturedAt: new Date(Date.parse(capture.capturedAt) + 1000).toISOString(),
    coverage: capture.coverage.map((section) => section.section === "comments" ? { ...section, status: "partial", expected: 8, error: diagnostic } : section) });
  const path = join(root, "saved-diagnostic.json"); await writeFile(path, contents);
  await page.click("#open-history-import");
  const file = await page.$("input#history-file"); assert.ok(file); await file.uploadFile(path);
  await page.click('#history-form button[type="submit"]'); await page.waitForSelector("#history-import-dialog[open]", { hidden: true });
  assert.doesNotMatch(await visibleText(page, "#history-warnings") ?? "", /steamhistory/i);
  assert.match(await visibleText(page, "#history-warnings") ?? "", /Comments:/);
  const details = await page.$$eval("#history-warnings [data-tooltip]", (items) => items.map((item) => item.getAttribute("data-tooltip")).join("\n"));
  assert.ok(details.includes(`8 comments records; this session returned ${comments.captured}`));
  assert.doesNotMatch(details, /steamhistory/i);
  const cachePath = join(root, "history", `${seed}.json`);
  const saved = Schema.decodeUnknownSync(Schema.fromJsonString(History.HistoryReport))(await readFile(cachePath, "utf8"));
  await writeFile(cachePath, JSON.stringify({ ...saved, warnings: [diagnostic] }));
  // Reopen from disk: neutral UI copy must not depend on fetching a fresh capture.
  await page.reload(); await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#scan-button")?.disabled);
  await page.click('[data-screen="scan"]');
  await fill(page, "#target", seed); await page.click("#lookup-target");
  await page.waitForFunction(() => document.querySelector("#target-history-status")?.textContent === "History partial");
  await page.hover("#target-history-status"); await checkAdjacentHelp(page, "#target-history-status");
  assert.doesNotMatch(await visibleText(page, "#app-tooltip") ?? "", /steamhistory/i);
  assert.match(await visibleText(page, "#app-tooltip") ?? "", /supporter access/);
  await page.keyboard.press("Escape"); await page.click("#target-history");
  await page.waitForSelector("#history-result", { visible: true });
  assert.doesNotMatch(await visibleText(page, "#history-warnings") ?? "", /steamhistory/i);
  const index = await page.$$eval("#history-sources button", (buttons) => buttons.length);
  const downloadPath = join(downloadDirectory, `history-${seed}-${index}.json`);
  // Earlier steps may have downloaded the same ordinal from a different capture list.
  await rm(downloadPath, { force: true });
  await page.click("#history-sources button:last-child");
  assert.equal(await readDownload(downloadPath), contents);
  assert.match(await readFile(join(root, "history", `${seed}.json`), "utf8"), /SteamHistory's profile summary/);
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
  const originalButton = await page.$("#history-rows button"); assert.ok(originalButton);
  const captured = await visibleText(page, ".details-record");
  await fill(page, "#history-search", "Alice");
  assert.equal(await originalButton.evaluate((button) => button.isConnected), false);
  assert.equal(await visibleText(page, ".details-record"), captured);
  await page.focus(".details-window"); await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("#history-rows button")), true);
  await page.keyboard.press("Enter");
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
async function checkDuplicateHistoryOpeners(page: Page, root: string) {
  // Identical retained records need separate focus targets within and across captures.
  const repeated = { steamID64: seed, lastChecked: 1791360000, name: "Duplicate opener fixture", historic: { persona: [{ Name: "Repeated alias", Timestamp: 1791360000 }] } };
  for (const [filename, contents] of [["duplicates.jsonl", [repeated, repeated].map((profile) => JSON.stringify(profile)).join("\n")],
    ["duplicate.json", JSON.stringify(repeated, null, 2)]] as const) {
    const path = join(root, filename); await writeFile(path, contents);
    await page.click("#open-history-import"); const file = await page.$("input#history-file"); assert.ok(file); await file.uploadFile(path);
    await page.click('#history-form button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("#history-import-dialog")?.open);
  }
  for (const [tab, query] of [["profile", "Duplicate opener fixture"], ["persona", "Repeated alias"]] as const) {
    await page.click(`[data-history="${tab}"]`); await fill(page, "#history-search", query);
    assert.equal((await page.$$("#history-rows button")).length, 3, JSON.stringify(await page.evaluate(() => ({ tab: document.querySelector("[data-history][aria-current=page]")?.getAttribute("data-history"), search: document.querySelector<HTMLInputElement>("#history-search")?.value, from: document.querySelector<HTMLInputElement>("#history-from")?.value, to: document.querySelector<HTMLInputElement>("#history-to")?.value, count: document.querySelector("#history-count")?.textContent, notice: document.querySelector("#notice")?.textContent, rows: document.querySelector("#history-rows")?.textContent }))));
    const first = await page.$("#history-rows button"); assert.ok(first); await first.click();
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("#history-rows button")), true);
    await page.keyboard.press("Enter"); await fill(page, "#history-search", query);
    assert.equal(await first.evaluate((button) => button.isConnected), false);
    await page.focus(".details-window"); await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("#history-rows button")), true);
  }
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
  const firstProfile = profiles[0]; assert.ok(firstProfile);
  const oldFriendButton = await page.$("#friend-rows button"); assert.ok(oldFriendButton);
  const firstWindow = await page.$(".details-window"); assert.ok(firstWindow);
  await fill(page, "#friend-search", firstProfile);
  assert.equal(await oldFriendButton.evaluate((button) => button.isConnected), false);
  await firstWindow.focus(); await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("#friend-rows button")), true);
  await page.keyboard.press("Enter");
  await page.focus("#friend-search"); await page.keyboard.down("Control"); await page.keyboard.press("a");
  await page.keyboard.up("Control"); await page.keyboard.press("Backspace");
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
  // Canvas profiles remain available through keyboard search, with independent detail windows.
  await fill(page, "#network-search", seed);
  await page.focus(`#network-matches [data-node-id="${seed}"]`); await page.keyboard.press("Enter");
  assert.equal((await page.$$(".details-window")).length, 1);
  const firstDetails = await page.$(".details-window"); assert.ok(firstDetails);
  await page.$eval("#network-search", (input) => { if (input instanceof HTMLInputElement) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); } });
  await page.focus("#graph"); await page.keyboard.press("Enter");
  assert.equal((await page.$$(".details-window")).length, 2);
  await firstDetails.focus(); await page.keyboard.press("Escape");
  assert.equal((await page.$$(".details-window")).length, 1);
  await page.focus(".details-window"); await page.keyboard.press("Escape");
  assert.equal((await page.$$(".details-window")).length, 0);
  await fill(page, "#network-search", second);
  await page.focus(`#network-matches [data-node-id="${second}"]`); await page.keyboard.press("Enter");
  await page.focus(".details-window"); await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-node-id")), second);
  await fill(page, "#network-search", "");
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
  const browser = await puppeteer.launch({ executablePath, headless: true, downloadBehavior: { policy: "allow", downloadPath: downloadDirectory }, args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"] });
  shutdown.push(() => browser.close());
  let server = await Server.start({ root, key: "b".repeat(32), port: 0, steamBaseUrl: fixture.url, historyBaseUrl: historyProvider.url, historySession: historyProvider.session, retryBaseMs: 1 });
  shutdown.push(() => server.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on("pageerror", (error) => errors.push(String(error)));
  const runRequests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/runs/")) runRequests.push(request.url()); });
  const screenshot = async (name: string) => {
    if (!process.env.VAPORA_BROWSER_SCREENSHOTS) return;
    if (name === "exports") await page.setViewport({ width: 1078, height: 800 });
    const screenshotOptions: ScreenshotOptions = { path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, `${name}.png`) };
    if (name === "exports") screenshotOptions.clip = await page.$eval("body", (body) => ({ x: 0, y: 0, width: innerWidth, height: body.getBoundingClientRect().height }));
    await page.screenshot(screenshotOptions);
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
  const helpDescription = await page.$eval(help, (element) => element.getAttribute("aria-describedby"));
  assert.ok(helpDescription);
  assert.match(await page.$eval(help, (element) => (element.getAttribute("aria-describedby") ?? "").split(" ")
    .map((id) => document.getElementById(id)?.textContent).join(" ")), /0 removes the cap/);
  await page.keyboard.press("Escape"); await page.waitForSelector('#app-tooltip:popover-open', { hidden: true });
  assert.equal(await page.$eval(help, (element) => element.getAttribute("aria-describedby")), helpDescription);
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
  await page.waitForFunction(() => /ETA ~\d+[smh]/.test(document.querySelector("#progress-text")?.textContent ?? ""));
  await screenshot("scan-eta");
  await page.setViewport({ width: 390, height: 844 }); await screenshot("scan-eta-narrow");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewport({ width: 1078, height: 599 });
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
  await page.mouse.move(600, 300);
  await page.waitForSelector('#app-tooltip:popover-open', { hidden: true });
  assert.equal(await page.$eval("#app-tooltip", (tooltip) => tooltip.matches(":popover-open")), false);
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
  await page.click('[data-view="network"]'); await page.waitForSelector("#graph canvas");
  const graphCanvas = await page.$("#graph canvas"); assert.ok(graphCanvas);
  const originalZoom = await page.$eval("#graph", (graph) => graph.getAttribute("data-ratio"));
  await page.click("#zoom-in"); const zoomed = await page.$eval("#graph", (graph) => graph.getAttribute("data-ratio"));
  assert.notEqual(zoomed, originalZoom);
  await page.click('[data-view="friends"]'); await page.click('[data-view="network"]');
  assert.equal(await graphCanvas.evaluate((node) => node.isConnected), true);
  assert.equal(await page.$eval("#graph", (graph) => graph.getAttribute("data-ratio")), zoomed);
  await page.click("#zoom-reset");
  assert.equal(await page.$eval("#graph", (graph) => graph.getAttribute("data-ratio")), originalZoom);
  assert.equal(await graphCanvas.evaluate((node) => node.isConnected), true);
  await screenshot("network"); await checkProfileDetails(page);
  await page.click('[data-view="locations"]');
  const oldLocationButton = await page.$("#location-rows button"); assert.ok(oldLocationButton);
  await oldLocationButton.click(); const capturedLocation = await visibleText(page, ".details-record");
  await page.$eval('[data-view="ranking"]', (button) => { if (!(button instanceof HTMLButtonElement)) throw new Error("Expected ranking tab"); button.click(); });
  const requestCount = fixture.requests.length; await fill(page, "#ranking-mutual", "3");
  await page.click("#save-ranking"); await page.waitForFunction(() => document.querySelector("#notice")?.textContent?.includes("Saved ranking"));
  assert.equal(await oldLocationButton.evaluate((button) => button.isConnected), false);
  assert.equal(await visibleText(page, ".details-record"), capturedLocation);
  await page.$eval('[data-view="locations"]', (button) => { if (!(button instanceof HTMLButtonElement)) throw new Error("Expected locations tab"); button.click(); });
  await page.focus(".details-window"); await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("#location-rows button")), true);
  await page.click('[data-view="ranking"]');
  assert.equal(fixture.requests.length, requestCount); await screenshot("ranking");
  const history = join(root, "history-current.json"); const now = Math.floor(Date.now() / 1000);
  await writeFile(history, JSON.stringify({ steamID64: seed, name: "Current fixture", lastChecked: now, historic: { friends: [{ Friend: second, FriendDate: now - 1000 }] } }));
  await page.click('[data-screen="scan"]'); await page.click("#target-history"); await page.click("#open-history-import"); const upload = await page.$("input#history-file"); assert.ok(upload); await upload.uploadFile(history);
  await page.click("#attach-history"); await page.click('#history-form button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector<HTMLElement>("#history-download")?.hidden);
  await page.reload(); await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "complete");
  await page.click("#open-history"); assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 1);
  assert.equal(await page.$eval("#history-screen", (element) => element.checkVisibility()), false);
  assert.equal(await page.$eval("#results-screen", (element) => element.checkVisibility()), true);
  assert.equal(await page.$eval("#open-history", (element) => element.getAttribute("aria-current")), "page");
  assert.equal(await page.$eval("#history-view #history-content", (element) => element.checkVisibility()), true);
  const shortcut = await page.$eval("#obsidian-shortcut", (element) => element instanceof HTMLAnchorElement && element.checkVisibility() ? element.href : "");
  assert.match(shortcut, /api\/obsidian\?id=/);
  assert.equal(shortcut, await page.$eval("#obsidian-export", (element) => element instanceof HTMLAnchorElement ? element.href : ""));
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
  const browser = await puppeteer.launch({ executablePath, headless: true, downloadBehavior: { policy: "allow", downloadPath: downloadDirectory }, args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"] });
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
  const original = await readDownload(join(downloadDirectory, `history-${seed}-1.json`));
  const capture = JSON.parse(original);
  assert.equal(capture.type, "SteamHistoryCapture");
  assert.equal(capture.steamID64, seed);
  assert.equal(capture.pages.length, 7);
  assert.match(capture.profile.contents, /customField/);
  history.counts.set("comments", 8); await page.click("#history-refresh");
  await page.waitForFunction(() => document.querySelector("#target-history-status")?.textContent === "History partial");
  assert.match(await visibleText(page, "#history-warnings") ?? "", /Comments: 4 \/ 8 captured/);
  assert.doesNotMatch(await visibleText(page, "#history-warnings") ?? "", /supporter access/);
  await page.hover("#history-warnings .info"); await checkAdjacentHelp(page, "#history-warnings .info");
  assert.match(await visibleText(page, "#app-tooltip") ?? "", /supporter access/);
  assert.equal(await page.$$eval("#app-tooltip li", (items) => items.length >= 2), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval("#history-warnings", (element) => element.getBoundingClientRect().bottom <= innerHeight), true);
  assert.equal(await page.$eval("#history-fetch-status", (element) => element instanceof HTMLElement && element.hidden), true);
  await page.click('[data-history="comments"]');
  assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 4);
  // Account metadata and actions fit one toolbar at the normal desktop width.
  assert.equal(await page.$eval(".history-header", (header) => header.getBoundingClientRect().height <= 36), true);
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
  // A mounted graph must not prevent inspecting friends excluded by the admission cap.
  await page.click('[data-view="network"]'); await page.waitForSelector("#graph canvas");
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
  const cachedRequests = history.requests(); await checkSavedHistoryDiagnostics(page, root, downloadDirectory);
  assert.equal(history.requests(), cachedRequests);
  await checkDuplicateHistoryOpeners(page, root);
  assert.deepEqual(errors, []);
});

test("Steam UI keeps ranking fields aligned, errors inside dialogs and help controls reachable", { timeout: 90000 }, async (context) => {
  const executablePath = process.env.VAPORA_BROWSER; assert.ok(executablePath);
  const shutdown: (() => Promise<void>)[] = []; let root: string | undefined;
  context.after(async () => {
    const outcomes = await Promise.allSettled(shutdown.map((close) => close()));
    if (root) await rm(root, { recursive: true, force: true });
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  });
  const fixture = await steamFixture(); const history = await historyFixture();
  shutdown.push(() => fixture.close(), () => history.close());
  root = await mkdtemp(join(tmpdir(), "vapora-ui-browser-"));
  const server = await Server.start({ root, key, port: 0, steamBaseUrl: fixture.url, historyBaseUrl: history.url, historySession: history.session, retryBaseMs: 1 });
  shutdown.push(() => server.close());
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"] });
  shutdown.push(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = []; page.on("pageerror", (error) => errors.push(String(error)));
  await page.setUserAgent(userAgent); await page.setViewport({ width: 1078, height: 700 }); await page.goto(server.origin);
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#scan-button")?.disabled);
  for (const [width, height] of [[1078, 606], [1078, 900], [320, 740]] as const) {
    await page.setViewport({ width, height });
    const help = '[aria-label="About request rate"]';
    await page.mouse.move(0, 0); await page.hover(help); await checkAdjacentHelp(page, help); await page.keyboard.press("Escape");
  }
  await page.setViewport({ width: 1078, height: 700 });
  await page.click("#open-scan-ranking");
  for (const width of [1078, 320]) {
    await page.setViewport({ width, height: 740 });
    const fields = await page.$$eval("#scan-ranking-dialog .weights input, #scan-ranking-dialog .weights select", (controls) => controls.map((control) => {
      const box = control.getBoundingClientRect(); const label = control.parentElement?.getBoundingClientRect();
      if (!label) throw new Error("Expected ranking label");
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, height: box.height, inside: box.left >= label.left && box.right <= label.right };
    }));
    assert.equal(fields.length, 9);
    for (const [index, field] of fields.entries()) {
      assert.equal(field.height, 32); assert.equal(field.inside, true);
      for (const other of fields.slice(index + 1)) assert.equal(field.x < other.right && field.right > other.x && field.y < other.bottom && field.bottom > other.y, false);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  await page.focus("#mutualWeight"); await page.waitForSelector("#app-tooltip:popover-open");
  await checkAdjacentHelp(page, "#mutualWeight");
  await page.keyboard.press("Escape"); await page.waitForSelector("#app-tooltip:popover-open", { hidden: true });
  await page.setViewport({ width: 320, height: 100 });
  await page.$eval("#mutualWeight", (input) => {
    if (!(input instanceof HTMLInputElement)) throw new Error("Expected ranking input");
    input.blur(); input.scrollIntoView();
  });
  await delay(150); await page.focus("#mutualWeight");
  await page.waitForSelector("#app-tooltip:popover-open");
  assert.equal(await page.$eval("#app-tooltip", (tooltip) => {
    const box = tooltip.getBoundingClientRect();
    return tooltip.scrollHeight > tooltip.clientHeight && box.top >= 8 && box.bottom <= innerHeight - 8;
  }), true);
  await page.hover("#app-tooltip"); await page.mouse.wheel({ deltaY: 100 });
  await page.waitForFunction(() => {
    const tooltip = document.querySelector("#app-tooltip");
    return tooltip?.matches(":popover-open") && tooltip.scrollTop > 0;
  });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape"); await page.setViewport({ width: 1078, height: 700 });
  await page.click("#save-settings"); await fill(page, "#profile-name", "spaces are invalid");
  await page.click('#profile-form button[type="submit"]'); await page.waitForSelector("#save-dialog-error:not([hidden])");
  assert.match(await visibleText(page, "#save-dialog-error"), /letters, digits/);
  assert.equal(await page.$eval("#profile-name", (field) => field.getAttribute("aria-invalid")), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "save-dialog-error");
  await fill(page, "#profile-name", "ui-audit"); await page.click('#profile-form button[type="submit"]');
  await page.waitForSelector("#save-dialog[open]", { hidden: true });
  // Restored focus opens Save's help. It must leave Load's click target usable.
  await page.waitForSelector("#app-tooltip:popover-open");
  assert.equal(await page.$eval("#open-settings", (button) => {
    const box = button.getBoundingClientRect(); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest("button") === button;
  }), true);
  await page.click("#open-settings"); await page.select("#profiles", ""); await page.click("#load-profile");
  await page.waitForSelector("#load-dialog-error:not([hidden])"); assert.match(await visibleText(page, "#load-dialog-error"), /Choose a saved profile/);
  await page.select("#profiles", "ui-audit"); await page.click("#load-profile"); await page.waitForSelector("#load-dialog[open]", { hidden: true });
  await page.click("#apply-settings");
  await page.waitForFunction(() => document.querySelector("#notice")?.textContent === "Saved default settings.");
  await page.setOfflineMode(true);
  await page.waitForFunction(() => document.querySelector("#notice")?.textContent?.includes("Cannot reach Vapora"));
  await page.click("#apply-settings");
  await page.waitForFunction(() => document.querySelector("#notice")?.textContent?.includes("Settings were not saved"));
  assert.match(await visibleText(page, "#notice"), /retry/);
  await page.waitForRequest((request) => request.url().endsWith("/api/state"));
  await delay(100); assert.match(await visibleText(page, "#notice"), /Settings were not saved/);
  await page.setOfflineMode(false); await page.click("#apply-settings");
  await page.waitForFunction(() => document.querySelector("#notice")?.textContent === "Saved default settings.");
  await fill(page, "#target", seed); await fill(page, "#maxNodes", "5"); await fill(page, "#rpm", "0");
  await page.click("#lookup-target"); await page.waitForFunction(() => document.querySelector("#target-history-status")?.textContent === "History ready");
  await page.click("#scan-button"); await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "complete");
  const help = '[aria-label="About evidence / 100"]'; await page.focus(help);
  await page.waitForSelector("#app-tooltip:popover-open"); assert.match(await visibleText(page, "#app-tooltip"), /not a friendship probability/);
  assert.match(await visibleText(page, "#app-tooltip .tooltip-heading"), /evidence/);
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "friends-filter.png") });
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval("#friend-search", (input) => {
    const box = input.getBoundingClientRect(); const label = input.parentElement?.getBoundingClientRect(); const table = document.querySelector("#friends-view .table-wrap")?.getBoundingClientRect();
    return label && table && Math.abs(box.top - label.top) < 2 && table.top - box.bottom >= 0 && table.top - box.bottom <= 10;
  }), true);
  assert.equal(await page.$eval("#results", (element) => getComputedStyle(element).scrollbarColor), "auto");
  assert.equal(await page.$eval("#results", (element) => getComputedStyle(element, "::-webkit-scrollbar-thumb").borderRadius), "0px");
  await page.keyboard.press("Escape");
  assert.match(await page.$eval(help, (button) => (button.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent).join(" ")), /not a friendship probability/);
  await page.focus("#friend-rows .player-link"); await page.click("#friend-rows button");
  await page.waitForSelector(".details-window"); await page.keyboard.press("Escape");
  await page.setViewport({ width: 320, height: 740 }); await page.click('[data-view="ranking"]');
  const tops = await page.$$eval('#report .tabs button:not([hidden])', (tabs) => tabs.map((tab) => tab.getBoundingClientRect().top));
  assert.ok(tops.every((top) => Math.abs(top - (tops[0] ?? top)) < 1));
  assert.equal(await page.$eval('#report .tab-scroll:last-child', (button) => button instanceof HTMLElement && !button.hidden), true);
  assert.equal(await page.$eval('[data-view="ranking"]', (tab) => { const box = tab.getBoundingClientRect(); const strip = tab.parentElement?.getBoundingClientRect(); return strip && box.left >= strip.left - 1 && box.right <= strip.right + 1; }), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.setViewport({ width: 1078, height: 700 }); await page.click("#open-history"); await page.click('[data-history="comments"]');
  assert.equal(await page.$eval("#results-screen", (element) => element.checkVisibility()), true);
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "attached-history.png") });
  assert.match(await visibleText(page, "#history-rows"), /Bob/); await fill(page, "#history-search", "Bob");
  assert.equal(await page.$eval("#history-rows", (rows) => rows.children.length), 1); await fill(page, "#history-search", "Undated unknown author");
  assert.equal(await page.$$eval("#history-rows tr", (rows) => rows.some((row) => row.textContent?.includes("Undated unknown author") && row.cells[0]?.textContent === "Unknown author")), true);
  await fill(page, "#history-search", "");
  await page.click('[data-history="friends"]');
  const durations = await page.$$eval("#history-rows tr td:nth-child(4)", (cells) => cells.map((cell) => cell.textContent));
  assert.ok(durations.includes("1 day")); assert.equal(durations.includes("1 days"), false);
  await page.click('[data-history="profile"]'); assert.doesNotMatch(await visibleText(page, "#history-rows"), /1400000000|\btrue\b/);
  assert.match(await visibleText(page, "#history-rows"), /Yes/); assert.match(await visibleText(page, "#history-rows"), /Not supplied/);
  await page.click("#history-rows button"); assert.match(await visibleText(page, ".details-record"), /1400000000/); await page.keyboard.press("Escape");
  const invalid = join(root, "invalid.json"); await writeFile(invalid, "{invalid");
  await page.click("#open-history-import"); const file = await page.$("input#history-file"); assert.ok(file); await file.uploadFile(invalid);
  await page.click('#history-form button[type="submit"]'); await page.waitForSelector("#history-import-dialog-error:not([hidden])");
  assert.match(await visibleText(page, "#history-import-dialog-error"), /not valid JSON/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "history-import-dialog-error");
  await page.keyboard.press("Escape");
  // A failed lookup for another target must not hide or contaminate the saved attachment.
  history.setStatus(403); await page.click('[data-screen="scan"]');
  await fill(page, "#target", second); await page.click("#lookup-target");
  await page.waitForFunction(() => document.querySelector("#target-history-status")?.textContent === "History unavailable");
  await page.click('[data-screen="results"]'); await page.click("#open-history");
  assert.equal(await page.$eval("#history-result", (element) => element.checkVisibility()), true);
  assert.equal(await visibleText(page, "#history-name"), "Alice");
  assert.equal(await page.$eval("#history-fetch-status", (element) => element.hasAttribute("hidden")), true);
  assert.equal(await page.$eval("#history-retry", (element) => element.hasAttribute("hidden")), true);
  await page.click('[data-screen="scan"]'); await page.click("#target-history");
  assert.equal(await page.$eval("#history-result", (element) => element.checkVisibility()), false);
  assert.equal(await page.$eval("#history-fetch-status", (element) => element.checkVisibility()), true);
  assert.match(await visibleText(page, "#history-fetch-status"), /blocked/);
  await page.click('[data-screen="results"]'); await page.click("#open-history");
  assert.equal(await page.$eval("#history-result", (element) => element.checkVisibility()), true);
  assert.equal(await page.$eval("#history-fetch-status", (element) => element.hasAttribute("hidden")), true);
  assert.deepEqual(errors, []);
});


test("network preview expands in-app, keeps all connections and supports exploration and image export", { timeout: 120000 }, async (context) => {
  const executablePath = process.env.VAPORA_BROWSER; assert.ok(executablePath);
  const root = await mkdtemp(join(tmpdir(), "vapora-network-e2e-"));
  const fixture = await steamFixture(); const history = await historyFixture();
  const ids = Array.from({ length: 200 }, (_, index) => Schema.decodeUnknownSync(Contracts.Metric.fields.id)(String(BigInt(seed) + BigInt(index))));
  const saved = scan(ids.map((id, index) => player(id, Array.from({ length: 10 }, (_, offset) => ids[(index + offset + 1) % ids.length]).filter((id) => id !== undefined),
    { groups: index < 3 ? ["test-group"] : [], groupsStatus: "public", avatar: index === 1 ? `${fixture.url}/missing-avatar.jpg` : index === 2 ? null : `${fixture.url}/avatars/${id}.svg` })));
  const directory = join(root, "outputs", saved.id); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "scan.json"), JSON.stringify(saved));
  const downloads = join(root, "downloads"); await mkdir(downloads);
  const server = await Server.start({ root, key: "", port: 0, steamBaseUrl: fixture.url, historySession: history.session });
  const browser = await puppeteer.launch({ executablePath, headless: true, downloadBehavior: { policy: "allow", downloadPath: downloads }, args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"] });
  context.after(async () => { await browser.close(); await server.close(); await fixture.close(); await history.close(); await rm(root, { recursive: true, force: true }); });
  const page = await browser.newPage(); const errors: string[] = []; page.on("pageerror", (error) => errors.push(String(error)));
  await page.setUserAgent(userAgent); await page.setViewport({ width: 1078, height: 750 });
  await page.goto(`${server.origin}/#${saved.id}`); await page.waitForSelector("#report-status", { visible: true });
  assert.equal(await page.$eval("#graph", (element) => element.children.length), 0);
  await page.click('[data-view="network"]');
  await page.waitForFunction(() => document.querySelector("#network-layout-status")?.textContent === "Layout settled");
  assert.equal(await page.$eval("#graph", (element) => element.getAttribute("data-nodes")), "200");
  assert.equal(await page.$eval("#graph", (element) => element.getAttribute("data-edges")), "2000");
  assert.ok(await page.$("#graph canvas"));
  assert.ok(await page.$eval("#graph", (element) => element.clientHeight <= 240));
  const canvas = await page.$("#graph canvas"); assert.ok(canvas);
  await page.click("#zoom-in"); const zoom = await page.$eval("#graph", (element) => element.getAttribute("data-ratio"));
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "network-preview.png") });
  await page.click("#network-maximize");
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "network-explorer.png") });
  assert.equal(await page.$eval("#network-maximize", (element) => element.getAttribute("aria-expanded")), "true");
  assert.ok(await page.$eval("#graph", (element) => element.clientHeight > 400));
  assert.equal(await canvas.evaluate((element) => element.isConnected), true);
  assert.equal(await page.$eval("#graph", (element) => element.getAttribute("data-ratio")), zoom);
  assert.equal((await browser.pages()).length, 2, "Maximizing must not open a new tab");
  await fill(page, "#network-search", seed);
  await page.waitForFunction((id) => document.querySelectorAll("#network-profiles button").length === 1
    && document.querySelector(`#network-profiles [data-node-id="${id}"]`), {}, seed);
  await page.focus(`#network-profiles [data-node-id="${seed}"]`); await page.keyboard.press("Enter");
  await page.waitForFunction((id) => document.querySelector<HTMLElement>("#graph")?.dataset.selected === id, {}, seed);
  assert.equal(await page.$eval("#graph", (element) => element.getAttribute("data-edges")), "2000", "Selection must highlight without removing links");
  assert.ok(await page.$("#network-selection img"));
  assert.equal(await page.$eval(".toolbar", (element) => element instanceof HTMLElement && element.inert), true);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "network-selected.png") });
  const center = await page.$eval("#graph", (element) => { const box = element.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
  await checkNodePicture(page, `${fixture.url}/avatars/${seed}.svg`);
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "network-selected.png") });
  await page.mouse.move(center.x, center.y); await page.mouse.down(); await page.mouse.move(center.x + 36, center.y + 12, { steps: 5 }); await page.mouse.up();
  assert.equal(await page.$eval("#network-selection button:last-child", (element) => element.getAttribute("aria-pressed")), "true", "Dragging a node must pin it");
  await page.click("#network-selection button:last-child");
  for (const id of ids.slice(1, 3)) {
    await fill(page, "#network-search", id);
    await page.waitForFunction((id) => document.querySelectorAll("#network-profiles button").length === 1
      && document.querySelector(`#network-profiles [data-node-id="${id}"]`), {}, id);
    await page.click(`#network-profiles [data-node-id="${id}"]`);
    await checkNodePicture(page, `${server.origin}/placeholder.jpg`);
  }
  await fill(page, "#network-search", seed);
  await page.waitForFunction((id) => document.querySelectorAll("#network-profiles button").length === 1
    && document.querySelector(`#network-profiles [data-node-id="${id}"]`), {}, seed);
  await page.click(`#network-profiles [data-node-id="${seed}"]`);
  await page.click("#network-selection button"); await page.waitForSelector(".details-window");
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval("#network-maximize", (element) => element.getAttribute("aria-expanded")), "true");
  await fill(page, "#network-search", "");
  await page.select("#network-scope", "one");
  assert.equal(await page.$eval("#graph", (element) => element.getAttribute("data-nodes")), "21");
  await page.select("#network-scope", "two");
  assert.equal(await page.$eval("#graph", (element) => element.getAttribute("data-nodes")), "41");
  await fill(page, "#network-minimum", "9999");
  await page.waitForFunction(() => document.querySelector("#network-layout-status")?.textContent === "No profiles match these filters.");
  assert.equal(await visibleText(page, "#network-layout-status"), "No profiles match these filters.");
  await page.click("#network-clear");
  await page.select("#network-availability", "private");
  assert.equal(await page.$eval("#graph", (element) => element.getAttribute("data-nodes")), "0");
  await page.click("#network-clear");
  await page.select("#edge-kind", "group");
  assert.equal(await page.$eval("#graph", (element) => element.getAttribute("data-edges")), "3");
  await page.select("#edge-kind", "all");
  assert.equal(await page.$eval("#graph", (element) => element.getAttribute("data-edges")), "2003");
  await page.select("#network-community", "0");
  assert.ok(Number(await page.$eval("#graph", (element) => element.getAttribute("data-nodes"))) < 200);
  await page.click("#network-clear");
  await page.select("#edge-kind", "group");
  await fill(page, "#network-minimum", "1");
  assert.equal(await page.$eval("#graph", (element) => element.getAttribute("data-nodes")), "3");
  assert.equal(await page.$eval("#graph", (element) => element.getAttribute("data-edges")), "3");
  await fill(page, "#network-search", seed);
  await page.click(`#network-profiles [data-node-id="${seed}"]`);
  assert.match(await visibleText(page, "#network-selection") ?? "", /2 visible connections/);
  await page.select("#edge-kind", "all");
  assert.match(await visibleText(page, "#network-selection") ?? "", /22 visible connections/);
  await fill(page, "#network-minimum", "21");
  assert.equal(await page.$eval("#graph", (element) => element.getAttribute("data-nodes")), "3");
  assert.match(await visibleText(page, "#network-selection") ?? "", /4 visible connections/);
  await page.click("#network-clear");
  assert.equal((await page.$$("#network-profiles button")).length, 50);
  await page.click("#network-next"); assert.match(await visibleText(page, "#network-profile-count") ?? "", /51.*100/);
  await page.click("#network-previous");
  await page.setViewport({ width: 1078, height: 599 });
  await page.hover("#network-export"); await checkAdjacentHelp(page, "#network-export");
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "network-export-help.png") });
  const statusBeforeExport = await visibleText(page, "#network-layout-status");
  const cameraBeforeExport = await page.$eval("#graph", (element) => element.getAttribute("data-ratio"));
  await page.click("#network-export");
  const image = join(downloads, `vapora-${saved.id}-network.png`);
  await readDownload(image); const bytes = await readFile(image);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a"); assert.ok(bytes.length > 10000);
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  assert.equal(Math.max(width, height), 4096);
  assert.equal(await page.$eval("#graph", (element) => element.getAttribute("data-ratio")), cameraBeforeExport);
  assert.equal(await visibleText(page, "#network-layout-status"), statusBeforeExport);
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await copyFile(image, join(process.env.VAPORA_BROWSER_SCREENSHOTS, "network-export.png"));
  await page.setViewport({ width: 1078, height: 700 });
  assert.equal(await page.$("#network-arrange"), null);
  // A stationary pointer and small movements within a circle must not oscillate its hit target.
  await page.click(`#network-profiles [data-node-id="${seed}"]`);
  const bounds = await page.$eval("#graph", (graph) => { const box = graph.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; });
  await page.mouse.click(bounds.x + bounds.width - 3, bounds.y + bounds.height - 3);
  assert.equal(await page.$eval("#graph", (graph) => graph.getAttribute("data-selected")), "");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.waitForFunction((id) => document.querySelector<HTMLElement>("#graph")?.dataset.hovered === id, {}, seed);
  const hoverChanges = page.$eval("#graph", (graph) => new Promise<string[]>((resolve) => {
    const changes: string[] = []; const observer = new MutationObserver(() => changes.push(graph.getAttribute("data-hovered") ?? ""));
    observer.observe(graph, { attributes: true, attributeFilter: ["data-hovered"] });
    setTimeout(() => { observer.disconnect(); resolve(changes); }, 700);
  }));
  for (const offset of [1, -1, 2, -2, 0]) await page.mouse.move(bounds.x + bounds.width / 2 + offset, bounds.y + bounds.height / 2);
  assert.equal((await hoverChanges).some((id) => id !== seed), false, "Hover must stay on the circle without flickering");
  assert.equal(await page.$eval("#graph", (graph) => graph.getAttribute("data-selected")), "", "Hover must not select a profile");
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "network-hover.png") });
  // Pinning makes the current layout resumable; Pause/Resume is the only layout action.
  await page.click(`#network-profiles [data-node-id="${seed}"]`);
  await page.click("#network-selection button:last-child");
  await page.evaluate(() => { document.querySelector<HTMLButtonElement>("#network-pause")?.click(); document.querySelector<HTMLButtonElement>("#network-pause")?.click(); });
  assert.equal(await visibleText(page, "#network-layout-status"), "Layout paused");
  await page.click("#network-pause");
  await page.waitForFunction(() => document.querySelector("#network-layout-status")?.textContent === "Layout settled");
  await page.setViewport({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.waitForFunction(() => document.querySelector<HTMLElement>("#network-sidebar")?.hidden === true);
  await page.click("#network-filters"); assert.equal(await page.$eval("#network-sidebar", (element) => element instanceof HTMLElement && element.hidden), false);
  await page.click("#network-filters");
  if (process.env.VAPORA_BROWSER_SCREENSHOTS) await page.screenshot({ path: join(process.env.VAPORA_BROWSER_SCREENSHOTS, "network-explorer-narrow.png") });
  await page.keyboard.press("Escape");
  assert.equal(await page.$eval("#network-maximize", (element) => element.getAttribute("aria-expanded")), "false");
  assert.equal(await canvas.evaluate((element) => element.isConnected), true);
  assert.equal(await page.$eval(".toolbar", (element) => element instanceof HTMLElement && element.inert), false);
  // Perform the tab switch in one event turn, before the real worker can deliver its frame.
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("#network-selection button:last-child")?.click();
    document.querySelector<HTMLButtonElement>("#network-pause")?.click();
    document.querySelector<HTMLButtonElement>('[data-view="friends"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-view="network"]')?.click();
  });
  await page.waitForFunction(() => document.querySelector("#network-layout-status")?.textContent === "Layout settled");
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("#network-selection button:last-child")?.click();
    document.querySelector<HTMLButtonElement>("#network-pause")?.click();
    document.querySelector<HTMLButtonElement>("#network-pause")?.click();
    document.querySelector<HTMLButtonElement>('[data-view="friends"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-view="network"]')?.click();
  });
  assert.equal(await visibleText(page, "#network-layout-status"), "Layout paused");
  assert.equal(fixture.requests.filter((request) => request.path.startsWith("/ISteamUser/")).length, 0, "Exploration must not fetch new Steam observations");
  assert.equal(await readFile(join(directory, "scan.json"), "utf8"), JSON.stringify(saved));
  // Navigate away during real dense-run analysis, without delaying or intercepting HTTP.
  const dense = denseScan(); const denseDirectory = join(root, "outputs", dense.id);
  await mkdir(denseDirectory); await writeFile(join(denseDirectory, "scan.json"), JSON.stringify(dense));
  // A hash-only navigation does not reload the app or open a different saved run.
  await page.goto("about:blank");
  const denseUrl = `${server.origin}/api/runs/${dense.id}`;
  const started = page.waitForRequest((request) => request.url() === denseUrl);
  const cancelled = new Promise<string>((resolve) => {
    const listener = (request: HTTPRequest) => {
      if (request.url() !== denseUrl) return;
      page.off("requestfailed", listener); resolve(request.failure()?.errorText ?? "");
    };
    page.on("requestfailed", listener);
  });
  await page.goto(`${server.origin}/#${dense.id}`, { waitUntil: "domcontentloaded" }); await started;
  await page.click('[data-screen="scan"]');
  assert.match(await cancelled, /ERR_ABORTED/);
  assert.equal(await page.$eval("#scan-screen", (screen) => screen instanceof HTMLElement && screen.hidden), false);
  await page.goto("about:blank");
  await page.goto(`${server.origin}/#${saved.id}`); await page.waitForSelector("#report-status", { visible: true });
  assert.deepEqual(errors, []);
});


test("unavailable WebGL shows recovery guidance and leaves saved results usable", { timeout: 60000 }, async (context) => {
  const executablePath = process.env.VAPORA_BROWSER; assert.ok(executablePath);
  const root = await mkdtemp(join(tmpdir(), "vapora-no-webgl-")); const history = await historyFixture();
  const saved = scan([player(seed, [])]); const directory = join(root, "outputs", saved.id);
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, "scan.json"), JSON.stringify(saved));
  const server = await Server.start({ root, key: "", port: 0, historySession: history.session });
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-webgl"] });
  context.after(async () => { await browser.close(); await server.close(); await history.close(); await rm(root, { recursive: true, force: true }); });
  const page = await browser.newPage(); const errors: string[] = []; page.on("pageerror", (error) => errors.push(String(error)));
  await page.setUserAgent(userAgent); await page.goto(`${server.origin}/#${saved.id}`);
  await page.waitForSelector("#report-status", { visible: true });
  // Finish the automatic attachment before exercising recovery controls; it re-renders the report.
  await page.waitForSelector("#open-history", { visible: true }); await page.click('[data-view="network"]');
  assert.equal(await visibleText(page, "#graph-count"), "Graph unavailable");
  assert.match(await visibleText(page, "#graph") ?? "", /Enable graphics acceleration/);
  await page.click("#graph button"); assert.equal(await visibleText(page, "#graph-count"), "Graph unavailable");
  await page.click('[data-view="friends"]');
  assert.equal(await page.$eval("#friends-view", (element) => element instanceof HTMLElement && element.hidden), false);
  assert.equal(await readFile(join(directory, "scan.json"), "utf8"), JSON.stringify(saved));
  assert.deepEqual(errors, []);
});
