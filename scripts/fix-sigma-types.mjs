import { readFile, writeFile } from "node:fs/promises";

// Sigma 4.0.0 extracts style values from optional properties without removing undefined.
// With strictNullChecks that yields never for every property. Patch declarations only;
// remove this script and postinstall when a Sigma release fixes ExtractBaseType upstream.
const path = new URL("../node_modules/sigma/dist/declarations/src/types/styles.d.ts", import.meta.url);
const original = "type ExtractBaseType<GV> = [GV] extends";
const corrected = "type ExtractBaseType<GV> = [NonNullable<GV>] extends";
const source = await readFile(path, "utf8");
if (!source.includes(original) && !source.includes(corrected)) throw new Error("Sigma style declarations changed. Review the type fix before installing.");
if (source.includes(original)) await writeFile(path, source.replace(original, corrected));
