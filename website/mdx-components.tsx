import defaultComponents from 'fumadocs-ui/mdx';
import { Callout } from 'fumadocs-ui/components/callout';
import { Cards, Card } from 'fumadocs-ui/components/card';
import type { MDXComponents } from 'mdx/types';
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return { ...defaultComponents, Callout, Cards, Card, ...components };
}
