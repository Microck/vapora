import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { State } from "../src/contracts.js";
import { listPackage } from "@electron/asar";
import puppeteer from "puppeteer-core";
import { key, seed, steamFixture, userAgent } from "./fixtures.js";

// Portable NSIS launchers do not relay Electron stderr. Chromium writes this endpoint
// into the real session directory, so every distribution uses the same startup check.
async function launchDesktop(shutdown: (() => Promise<void>)[], executable: string, dataRoot: string, fixtureUrl: string, portable: boolean) {
  await rm(join(dataRoot, "DevToolsActivePort"), { force: true });
  const env: NodeJS.ProcessEnv = { ...process.env, STEAM_API_KEY: key, VAPORA_STEAM_FIXTURE: fixtureUrl };
  delete env.PORTABLE_EXECUTABLE_DIR;
  if (portable) delete env.VAPORA_ROOT; else env.VAPORA_ROOT = dataRoot;
  const args = ["--remote-debugging-port=0"];
  // Sandbox restrictions on CI hosts must not change the distributed app's defaults.
  if (process.platform === "linux") args.push("--no-sandbox", "--disable-dev-shm-usage");
  const child = spawn(executable, args, { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  shutdown.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const activePort = await readFile(join(dataRoot, "DevToolsActivePort"), "utf8").catch((error: Error) => {
      if (!("code" in error) || error.code !== "ENOENT") throw error;
      return "";
    });
    const endpoint = /^(\d+)\r?\n(\/devtools\/browser\/[^\s]+)/.exec(activePort);
    if (endpoint) {
      const browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${endpoint[1]}${endpoint[2]}`, defaultViewport: null });
      shutdown.push(async () => { if (browser.connected) await browser.close(); });
      return { browser, exited };
    }
    await delay(100);
  }
  throw new Error(`Packaged app did not start: ${output}`);
}

// Run the actual packaged executable from a fresh directory, without a Node launcher.
// CI supplies an installed NSIS app, portable launcher, extracted AppImage or mounted DMG.
test("packaged desktop includes its assets and completes a scan with real fixture HTTP", { timeout: 120000 }, async (context) => {
  const executable = process.env.VAPORA_DESKTOP;
  const archive = process.env.VAPORA_DESKTOP_ASAR;
  assert.ok(executable && archive, "Set VAPORA_DESKTOP and VAPORA_DESKTOP_ASAR to the packaged application.");
  const packagedFiles = listPackage(resolve(archive), { isPack: false }).map((name) => name.replaceAll("\\", "/"));
  for (const required of ["/scripts/desktop.mjs", "/scripts/desktop-preload.cjs", "/dist/src/server.js", "/dist/ui/index.html", "/dist/ui/vapora.svg", "/dist/ui/placeholder.jpg", "/dist/ui/fonts/motiva-sans-regular.ttf", "/node_modules/effect/package.json"]) {
    assert.ok(packagedFiles.includes(required), `Missing packaged file: ${required}`);
  }
  assert.ok(!packagedFiles.some((name) => /\/(?:\.env|test|outputs|profiles)(?:\/|$)/.test(name)));
  assert.ok(!packagedFiles.includes("/node_modules/puppeteer-core/package.json"));
  const portable = process.env.VAPORA_TEST_PORTABLE === "1";
  const root = await mkdtemp(join(tmpdir(), "vapora packaged e2e-"));
  const fixture = await steamFixture();
  const dataRoot = portable ? join(root, "Vapora-data") : root;
  const launchPath = portable ? join(root, "Vapora portable.exe") : resolve(executable);
  if (portable) await copyFile(resolve(executable), launchPath);
  const shutdown: (() => Promise<void>)[] = [
    () => rm(root, { recursive: true, force: true }), () => fixture.close(),
  ];
  context.after(async () => {
    // Stop native processes before removing their session files, including on failed assertions.
    for (const close of shutdown.reverse()) await close();
  });
  const { browser, exited } = await launchDesktop(shutdown, launchPath, dataRoot, fixture.url, portable);
  const target = await browser.waitForTarget((candidate) => candidate.type() === "page" && candidate.url().startsWith("http://127.0.0.1:"));
  const page = await target.page(); assert.ok(page);
  await page.setUserAgent(userAgent);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // The preload bridge appears before renderer handlers and the first state response.
  // Wait for the app's desktop mode and ready connection before sending input.
  await page.waitForFunction(() => document.visibilityState === "visible" && document.body.classList.contains("desktop") &&
    document.querySelector<HTMLElement>("#key-indicator")?.dataset.key === "ready" &&
    !document.querySelector<HTMLButtonElement>("#lookup-target")?.disabled);
  await page.bringToFront();
  // Font loading can move the native window's controls before its first painted frame.
  await page.evaluate(async () => { await document.fonts.ready; });
  assert.equal(await page.evaluate(() => "require" in window || "process" in window), false);
  const origin = new URL(page.url()).origin;
  for (const asset of ["/app.js", "/style.css", "/vapora.svg", "/placeholder.jpg", "/fonts/motiva-sans-regular.ttf"]) {
    const response = await fetch(origin + asset, { headers: { "user-agent": userAgent } });
    assert.equal(response.status, 200, asset); assert.ok((await response.arrayBuffer()).byteLength);
  }
  await page.type("#target", seed);
  assert.equal(await page.$eval("#target", (input) => {
    if (!(input instanceof HTMLInputElement)) throw new Error("Expected target field");
    return input.value;
  }), seed, "Keyboard entry did not reach the target field");
  await page.click("#lookup-target");
  await page.waitForFunction(() => document.querySelector("#target-name")?.textContent === "Player 29").catch(async (error: Error) => {
    const renderer = await page.evaluate(() => ({
      name: document.querySelector("#target-name")?.textContent,
      notice: document.querySelector("#notice")?.textContent,
      active: document.activeElement?.id,
    }));
    throw new Error(`Target lookup failed: ${JSON.stringify({ renderer, requests: fixture.requests, errors })}`, { cause: error });
  });
  await page.$eval("#maxNodes", (input) => {
    if (!(input instanceof HTMLInputElement)) throw new Error("Expected node cap field");
    input.value = "5"; input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("#scan-button");
  await page.waitForFunction(() => document.querySelector("#report-status")?.textContent === "complete", { timeout: 60000 });
  const downloadLinks = await page.$$eval("#downloads a", (links) => links.map((link) => {
    if (!(link instanceof HTMLAnchorElement)) throw new Error("Expected an export link");
    return link.href;
  }));
  assert.equal(downloadLinks.length, 6);
  for (const url of downloadLinks) {
    const response = await fetch(url, { headers: { "user-agent": userAgent } });
    assert.equal(response.status, 200); assert.ok((await response.arrayBuffer()).byteLength);
  }
  const state = await (await fetch(origin + "/api/state", { headers: { "user-agent": userAgent } })).text();
  const saved = Schema.decodeUnknownSync(Schema.fromJsonString(State))(state);
  const run = saved.runs[0]; assert.ok(run);
  assert.equal(run.status, "complete");
  const checkpoint = await readFile(join(dataRoot, "outputs", run.id, "scan.json"));
  assert.ok(!checkpoint.includes(Buffer.from(key)));
  assert.ok(!state.includes(key)); assert.ok(fixture.requests.length > 0);
  if (process.env.VAPORA_DESKTOP_SCREENSHOT) await page.screenshot({ path: process.env.VAPORA_DESKTOP_SCREENSHOT });
  await page.evaluate(async () => {
    if (!window.vaporaDesktop) throw new Error("Desktop bridge missing");
    await window.vaporaDesktop.maximize(); await window.vaporaDesktop.maximize();
  });
  assert.deepEqual(errors, []);
  // Closing the native window must stop its local server and exit normally.
  await page.evaluate(() => { void window.vaporaDesktop?.close(); }).catch((error: Error) => {
    if (!error.message.includes("Target closed")) throw error;
  });
  const [exitCode] = await exited; assert.equal(exitCode, 0);
  await assert.rejects(fetch(origin + "/api/state", { headers: { "user-agent": userAgent } }));
  assert.ok(!(await readFile(resolve(archive))).includes(Buffer.from(key)));
  if (portable) {
    // The launcher cleans up its extracted binaries. Persistent data must survive a move.
    const moved = join(root, "moved portable folder"); await mkdir(moved);
    const movedExecutable = join(moved, "Vapora portable.exe");
    await rename(launchPath, movedExecutable);
    await rename(dataRoot, join(moved, "Vapora-data"));
    const requestsBeforeReopen = fixture.requests.length;
    const reopened = await launchDesktop(shutdown, movedExecutable, join(moved, "Vapora-data"), fixture.url, true);
    const reopenedTarget = await reopened.browser.waitForTarget((candidate) => candidate.type() === "page" && candidate.url().startsWith("http://127.0.0.1:"));
    const reopenedPage = await reopenedTarget.page(); assert.ok(reopenedPage);
    await reopenedPage.waitForFunction(() => document.body.classList.contains("desktop"));
    const movedOrigin = new URL(reopenedPage.url()).origin;
    const movedState = Schema.decodeUnknownSync(State)(await (await fetch(movedOrigin + "/api/state", { headers: { "user-agent": userAgent } })).json());
    assert.equal(movedState.runs[0]?.id, run.id);
    assert.equal(movedState.runs[0]?.status, "complete");
    for (const link of downloadLinks) {
      const response = await fetch(movedOrigin + new URL(link).pathname, { headers: { "user-agent": userAgent } });
      assert.equal(response.status, 200); assert.ok((await response.arrayBuffer()).byteLength);
    }
    assert.equal(fixture.requests.length, requestsBeforeReopen, "Reopening saved portable data must not repeat Steam collection");
    await reopened.browser.close();
    const [movedExitCode] = await reopened.exited; assert.equal(movedExitCode, 0);
  }
});
