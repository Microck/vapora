import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist/ui", { recursive: true });
await build({ entryPoints: ["ui/app.ts"], bundle: true, format: "esm", platform: "browser", target: "es2023", minify: true, outfile: "dist/ui/app.js" });
await copyFile("ui/index.html", "dist/ui/index.html");
await copyFile("ui/style.css", "dist/ui/style.css");
for (const asset of ["vapora.png", "vapora.ico", "placeholder.jpg"]) await copyFile(`assets/${asset}`, `dist/ui/${asset}`);
