import { source } from '@/lib/source';
import { DocsBody, DocsPage, DocsTitle } from 'fumadocs-ui/page';
import { getMDXComponents } from '@/mdx-components';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const MDX = page.data.body;
  return <DocsPage toc={page.data.toc} full={page.data.full}>
    <DocsTitle>{page.data.title}</DocsTitle>
    <DocsBody><MDX components={getMDXComponents()} /></DocsBody>
    <a className="edit-link" href={`https://github.com/Microck/vapora/blob/main/website/content/docs/${page.path}`}>Edit this page on GitHub ↗</a>
  </DocsPage>;
}
export function generateStaticParams() { return source.generateParams(); }
export async function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }): Promise<Metadata> {
  const page = source.getPage((await params).slug);
  return { title: page?.data.title, description: page?.data.description };
}
