import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Platform } from "electron-builder";
import { getMakeNsisPath } from "app-builder-lib/out/toolsets/windows.js";
import { nsisEscapeString } from "app-builder-lib/out/targets/nsis/nsisScriptGenerator.js";

async function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
  }
  return bytes;
}

// The stock portable target silently stages two copies in system TEMP. Build one
// launcher with NSIS's native extraction and an explicit, drive-local lifecycle.
export default async function buildPortable(build) {
  if (!build.platformToTargets.has(Platform.WINDOWS)) return [];
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const appDirectory = join(build.outDir, "win-unpacked");
  const output = join(build.outDir, `vapora-${version}-win-x64-portable.exe`);
  const requiredBytes = await directoryBytes(appDirectory) + 32 * 1024 * 1024;
  const compiler = await getMakeNsisPath(build.configuration.toolsets?.nsis);
  const definitions = { APP_DIRECTORY: appDirectory, OUTPUT: output, VERSION: version,
    ICON: join(root, "assets/vapora.ico"), REQUIRED_BYTES: requiredBytes,
    REQUIRED_MB: Math.ceil(requiredBytes / (1024 * 1024)) };
  const args = ["-WX", "-INPUTCHARSET", "UTF8",
    ...Object.entries(definitions).map(([name, value]) => `-D${name}=${nsisEscapeString(String(value))}`),
    join(root, "scripts/portable.nsi")];
  await new Promise((resolve, reject) => {
    const child = spawn(compiler.path, args, { stdio: "inherit", env: { ...process.env, ...compiler.env } });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Portable NSIS build exited ${code}`)));
  });
  return [output];
}
