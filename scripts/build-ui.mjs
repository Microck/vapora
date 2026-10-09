import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist/ui", { recursive: true });
await build({ entryPoints: ["ui/app.ts"], bundle: true, format: "esm", platform: "browser", target: "es2023", minify: true, outfile: "dist/ui/app.js" });
await build({ entryPoints: ["ui/network-layout.ts"], bundle: true, format: "esm", platform: "browser", target: "es2023", minify: true, outfile: "dist/ui/network-layout.js" });
await copyFile("ui/index.html", "dist/ui/index.html");
await copyFile("ui/style.css", "dist/ui/style.css");
for (const asset of ["vapora.svg", "vapora.ico", "placeholder.jpg", "key.png", "save.svg", "presets.png", "checkbox-off.png", "checkbox-on.png"]) await copyFile(`assets/${asset}`, `dist/ui/${asset}`);
await mkdir("dist/ui/fonts", { recursive: true });
for (const weight of ["regular", "medium", "bold"]) await copyFile(`assets/fonts/motiva-sans-${weight}.ttf`, `dist/ui/fonts/motiva-sans-${weight}.ttf`);
