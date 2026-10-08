import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';
import type { ReactNode } from 'react';
export default function Layout({ children }: { children: ReactNode }) {
  return <DocsLayout tree={source.pageTree} nav={{ title: <span className="wordmark"><img src="/vapora.svg" width="28" height="28" alt="" />vapora<span className="nav-tag">docs / 2.2</span></span>, url: '/' }}
    themeSwitch={{ enabled: false }} links={[{ text: 'Downloads', url: 'https://github.com/Microck/vapora/releases/latest', external: true }, { text: 'GitHub', url: 'https://github.com/Microck/vapora', external: true }]}>{children}</DocsLayout>;
}
