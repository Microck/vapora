import defaultComponents from 'fumadocs-ui/mdx';
import { Callout } from 'fumadocs-ui/components/callout';
import { Cards, Card } from 'fumadocs-ui/components/card';
import { Tabs, Tab } from 'fumadocs-ui/components/tabs';
import { ImageZoom } from 'fumadocs-ui/components/image-zoom';
import type { MDXComponents } from 'mdx/types';
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultComponents, Callout, Cards, Card, Tabs, Tab,
    img: ({ src, ...props }) => {
      // Markdown screenshots use file paths; Next's Image does not accept React's Blob source.
      if (src instanceof Blob) throw new Error('Documentation images require a file path.');
      return <ImageZoom src={src} {...props} />;
    },
    ...components,
  };
}
