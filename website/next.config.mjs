import { fileURLToPath } from 'node:url';
import { createMDX } from 'fumadocs-mdx/next';
const withMDX = createMDX();
export default withMDX({ output: 'export', turbopack: { root: fileURLToPath(new URL('.', import.meta.url)) }, trailingSlash: true, images: { unoptimized: true }, reactStrictMode: true });
