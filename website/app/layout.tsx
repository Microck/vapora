import './global.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';
export const metadata: Metadata = {
  title: { default: 'Vapora documentation', template: '%s | Vapora' },
  description: 'Desktop, browser and CLI documentation for exploring public Steam friend networks, dated history and reproducible exports.',
  icons: { icon: '/vapora.svg' },
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" className="dark" suppressHydrationWarning><body>
    <RootProvider theme={{ forcedTheme: 'dark' }} search={{ options: { type: 'static' } }}>{children}</RootProvider>
  </body></html>;
}
