import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';
import type { ReactNode } from 'react';
export default function Layout({ children }: { children: ReactNode }) {
  return <DocsLayout tree={source.pageTree} sidebar={{ defaultOpenLevel: 1 }} nav={{ title: <span className="wordmark"><img src="/vapora.svg" width="20" height="20" alt="" />vapora</span>, url: '/docs/' }}
    themeSwitch={{ enabled: false }} links={[{ text: 'Downloads', url: 'https://github.com/Microck/vapora/releases/latest', external: true }, { text: 'GitHub', url: 'https://github.com/Microck/vapora', external: true }]}>{children}</DocsLayout>;
}
