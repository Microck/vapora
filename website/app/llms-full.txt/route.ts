import { source } from '@/lib/source';
import { llms } from 'fumadocs-core/source';

export const dynamic = 'force-static';

export async function GET(): Promise<Response> {
  const documents = llms(source, {
    renderPage: async (page) => `# ${page.data.title} (${page.url})\n\n${await page.data.getText('processed')}`,
  });
  return new Response(await documents.full(), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
