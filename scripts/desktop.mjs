import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { Config, Effect, Redacted, Schema } from "effect";
import { RunId } from "../dist/src/model.js";
import { start } from "../dist/src/server.js";

if (existsSync(".env")) loadEnvFile(".env");
app.setName("Vapora");
// The portable launcher extracts binaries into TEMP; data belongs beside the original EXE.
const desktopRoot = resolve(process.env.VAPORA_ROOT ?? (process.env.PORTABLE_EXECUTABLE_DIR
  ? join(process.env.PORTABLE_EXECUTABLE_DIR, "Vapora-data")
  : join(app.getPath("appData"), "Vapora")));
await mkdir(desktopRoot, { recursive: true, mode: 0o700 });
app.setPath("userData", desktopRoot);
app.setPath("sessionData", desktopRoot);
async function launch() {
  const root = desktopRoot;
  const storedKeyPath = join(root, "steam-key.enc");
  // Linux basic_text encryption uses a known password, so it cannot protect a remembered key.
  const available = safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend()));
  const remembered = existsSync(storedKeyPath);
  let key = Redacted.value(await Effect.runPromise(Config.Redacted("STEAM_API_KEY").pipe(Config.withDefault(Redacted.make("")))));
  if (!key && remembered && available) {
    try {
      key = Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{32}$/)))(safeStorage.decryptString(await readFile(storedKeyPath)));
    } catch {
      throw new Error(`Cannot read the saved Steam key. Remove ${storedKeyPath}, then reopen Vapora and enter your key again.`);
    }
  }
  const saveKey = async (candidate) => {
    if (candidate === null) { await rm(storedKeyPath, { force: true }); return; }
    if (!available) throw new Error("Secure key storage is unavailable. Use the key for this session.");
    const temporary = `${storedKeyPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, safeStorage.encryptString(candidate), { mode: 0o600 });
      await rename(temporary, storedKeyPath);
    } catch {
      throw new Error("Could not save the encrypted key. Check data-folder permissions and disk space, then retry or use a session key.");
    } finally { await rm(temporary, { force: true }); }
  };
  const options = { root, key, port: 0, keyStorage: { available, remembered, save: saveKey } };
  // Development fixtures stay opt-in and loopback-only, sharing the browser server's test transport.
  if (process.env.VAPORA_STEAM_FIXTURE) {
    const fixture = new URL(process.env.VAPORA_STEAM_FIXTURE);
    if (fixture.hostname !== "127.0.0.1") throw new Error("The desktop Steam fixture must use loopback.");
    options.steamBaseUrl = fixture.origin;
  }
  const server = await start(options);
  const window = new BrowserWindow({
    width: 1078, height: 599, minWidth: 720, minHeight: 520, frame: false, show: false,
    backgroundColor: "#4c5844", title: "Vapora",
    icon: fileURLToPath(new URL("../assets/vapora.ico", import.meta.url)),
    webPreferences: {
      preload: fileURLToPath(new URL("./desktop-preload.cjs", import.meta.url)),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.once("ready-to-show", () => window.show());

  // Only this local main frame can invoke the fixed window/folder operations.
  function authorized(event) {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== server.origin) throw new Error("This desktop action is unavailable.");
  }
  ipcMain.handle("vapora:minimize", (event) => { authorized(event); window.minimize(); });
  ipcMain.handle("vapora:maximize", (event) => { authorized(event); if (window.isMaximized()) window.unmaximize(); else window.maximize(); });
  ipcMain.handle("vapora:maximized", (event) => { authorized(event); return window.isMaximized(); });
  window.on("maximize", () => window.webContents.send("vapora:maximized-changed", true));
  window.on("unmaximize", () => window.webContents.send("vapora:maximized-changed", false));
  ipcMain.handle("vapora:close", (event) => { authorized(event); window.close(); });
  ipcMain.handle("vapora:outputs", async (event, id) => {
    authorized(event);
    const output = id === null ? join(root, "outputs") : join(root, "outputs", Schema.decodeUnknownSync(RunId)(id));
    await mkdir(output, { recursive: true, mode: 0o700 });
    const error = await shell.openPath(output);
    if (error) throw new Error(error);
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== server.origin) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const link = new URL(url);
    if (link.protocol === "https:" && link.hostname === "steamcommunity.com") void shell.openExternal(link.href);
    return { action: "deny" };
  });
  let closing = false;
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault(); closing = true;
    void server.close().finally(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());
  await window.loadURL(`${server.origin}/`);
}
// Electron waits for the ESM entry to settle before emitting ready; do not await ready at module scope.
void app.whenReady().then(launch).catch((error) => { dialog.showErrorBox("Vapora could not start", error.message); app.quit(); });
