import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import extract from "@electron-internal/extract-zip";

const root = fileURLToPath(new URL("../.history-runtime/", import.meta.url));
const version = "153.0.8001.0";
const targets = { linux: { arm64: "linux-arm64", x64: "linux64" }, win32: { x64: "win64" }, darwin: { arm64: "mac-arm64", x64: "mac-x64" } };
const target = targets[process.platform]?.[process.arch];
if (!target) throw new Error("The history browser supports Linux x64/arm64, Windows x64 and macOS x64/arm64.");
const browser = process.platform === "darwin" ? `browser/chrome-${target}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  : `browser/chrome-${target}/${process.platform === "win32" ? "chrome.exe" : "chrome"}`;
const helper = `helper/steam-history${process.platform === "win32" ? ".exe" : ""}`;
const inputs = await readFile(fileURLToPath(new URL("./history-worker.py", import.meta.url)), "utf8");
const requirements = await readFile(fileURLToPath(new URL("./history-requirements.txt", import.meta.url)), "utf8");
const signature = JSON.stringify({ version, target, inputs, requirements });
await mkdir(root, { recursive: true });
const previous = await readFile(join(root, "build-signature.json"), "utf8").catch(() => "");
if (previous === signature) {
  await Promise.all([access(join(root, browser)), access(join(root, helper)), access(join(root, "runtime.json"))]);
  console.info("History runtime is built.");
  process.exit(0);
}
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit" });
  child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
const manifestPath = join(root, "runtime.json");
const previousRuntime = JSON.parse(await readFile(manifestPath, "utf8").catch(() => "null"));
const browserReady = previousRuntime?.version === version && previousRuntime?.browser === browser
  && await access(join(root, browser)).then(() => true, () => false);
// A failed build must never advertise a partially replaced runtime as ready.
await rm(manifestPath, { force: true });
const build = join(root, "build"); await mkdir(build, { recursive: true });
const venv = join(build, "python");
await run(process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3"), ["-m", "venv", venv]);
const python = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", "-r", fileURLToPath(new URL("./history-requirements.txt", import.meta.url))]);
await run(python, ["-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--name", "steam-history",
  "--distpath", join(root, "helper"), "--workpath", join(build, "pyinstaller"), "--specpath", build,
  fileURLToPath(new URL("./history-worker.py", import.meta.url))]);
if (!browserReady) {
  const archive = join(build, "chrome.zip");
  const response = await fetch(`https://storage.googleapis.com/chrome-for-testing-public/${version}/${target}/chrome-${target}.zip`,
    { headers: { "user-agent": "OpenAI File Downloader, XaiImageApiFetch/1.0" }, signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error(`Could not download the history browser: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  const stagedBrowser = resolve(build, "browser");
  await extract(archive, { dir: stagedBrowser });
  await rm(join(root, "browser"), { recursive: true, force: true });
  await rename(stagedBrowser, join(root, "browser"));
}
await Promise.all([access(join(root, browser)), access(join(root, helper))]);
await writeFile(join(root, "runtime.json"), JSON.stringify({ browser, helper, platform: process.platform, arch: process.arch, version, pydoll: "3.0.0" }));
await writeFile(join(root, "build-signature.json"), signature);
await rm(build, { recursive: true, force: true });
console.info("Built the self-contained History browser runtime.");
