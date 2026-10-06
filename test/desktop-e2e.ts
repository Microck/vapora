import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { listPackage } from "@electron/asar";
import puppeteer from "puppeteer-core";
import type { Browser } from "puppeteer-core";
import { key, seed, steamFixture, userAgent } from "./fixtures.js";

// Run the actual packaged executable from a fresh directory, without a Node launcher.
// CI supplies an installed NSIS app, extracted AppImage or mounted DMG executable.
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
  const root = await mkdtemp(join(tmpdir(), "vapora-packaged-e2e-"));
  const fixture = await steamFixture();
  const args = ["--remote-debugging-port=0"];
  // Sandbox restrictions on CI hosts must not change the distributed app's defaults.
  if (process.platform === "linux") args.push("--no-sandbox", "--disable-dev-shm-usage");
  const child = spawn(resolve(executable), args, {
    cwd: root, env: { ...process.env, STEAM_API_KEY: key, VAPORA_ROOT: root, VAPORA_STEAM_FIXTURE: fixture.url },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let browser: Browser | undefined;
  context.after(async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    } finally {
      browser?.disconnect();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  let output = "";
  const endpoint = await new Promise<string>((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Packaged app did not start: ${output}`)), 30000);
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
      if (match?.[1]) { clearTimeout(timeout); accept(match[1]); }
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Packaged app exited ${code}: ${output}`)); });
  });
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
  const target = await browser.waitForTarget((candidate) => candidate.type() === "page" && candidate.url().startsWith("http://127.0.0.1:"));
  const page = await target.page(); assert.ok(page);
  await page.setUserAgent(userAgent);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // The preload bridge appears before renderer handlers and the first state response.
  // Wait for the app's desktop mode and ready connection before sending input.
  await page.waitForFunction(() => document.body.classList.contains("desktop") &&
    document.querySelector<HTMLElement>("#key-indicator")?.dataset.key === "ready" &&
    !document.querySelector<HTMLButtonElement>("#lookup-target")?.disabled);
  assert.equal(await page.evaluate(() => "require" in window || "process" in window), false);
  const origin = new URL(page.url()).origin;
  for (const asset of ["/app.js", "/style.css", "/vapora.svg", "/placeholder.jpg", "/fonts/motiva-sans-regular.ttf"]) {
    const response = await fetch(origin + asset, { headers: { "user-agent": userAgent } });
    assert.equal(response.status, 200, asset); assert.ok((await response.arrayBuffer()).byteLength);
  }
  await page.type("#target", seed);
  await page.click("#lookup-target");
  await page.waitForFunction(() => document.querySelector("#target-name")?.textContent === "Player 29");
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
  const [exitCode] = await exited; assert.equal(exitCode, 0, output);
  await assert.rejects(fetch(origin + "/api/state", { headers: { "user-agent": userAgent } }));
  assert.ok(!(await readFile(resolve(archive))).includes(Buffer.from(key)));
});
