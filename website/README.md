# vapora docs

Fumadocs + Next.js documentation site for Vapora 2.2.0.

```sh
npm ci
npm run dev
npm run verify
```

Run commands in this directory with Node.js 24+. `npm run build` creates `out/`; deploy that directory at a static host's domain root. Search uses the exported `/api/search` index, with queries executed locally in the browser. No Steam key or app runtime is needed.

Content lives in `content/docs/`; ordering lives in `meta.json`. The predev/prebuild script copies the existing repository screenshots and icon into ignored public paths. See [maintenance and deployment](content/docs/project/documentation.mdx).
