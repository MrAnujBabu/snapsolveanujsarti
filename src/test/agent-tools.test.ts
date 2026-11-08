// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const aiSearch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/crawl4ai/agent-bridge.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/crawl4ai/agent-bridge.server')>()),
  aiSearchForTool: aiSearch,
}));

import { clearCrawlCache } from '@/lib/crawl4ai/crawler.server';
import { createAgentTools } from '@/lib/agent/tools.server';

const opts = { toolCallId: 'test', messages: [], context: {} };
const isConnector = (input: unknown) => String(input).startsWith('https://connector-gateway.lovable.dev');
/** Direct page reads fail like NCERT's broken certificate chain; connector calls get `connector`. */
function routeFetch(connector: (url: string) => Response | Promise<Response>, direct?: () => Response) {
  return vi.fn(async (input: unknown) => {
    if (isConnector(input)) return connector(String(input));
    if (direct) return direct();
    throw new TypeError('fetch failed: unable to verify the first certificate');
  });
}

beforeEach(() => {
  vi.stubEnv('LOVABLE_API_KEY', 'test'); vi.stubEnv('PARALLEL_API_KEY', 'test'); vi.stubEnv('FIRECRAWL_API_KEY', 'test'); vi.stubEnv('PERPLEXITY_API_KEY', 'test');
  aiSearch.mockReset();
  clearCrawlCache();
});

describe('student document links', () => {
  it('reads a page directly with the Crawl4AI engine, without paid readers', async () => {
    const fetch = routeFetch(() => Response.json({}), () => new Response('<html><head><title>Notes</title></head><body><article><h1>Inertia</h1><p>Inertia is the tendency of a body to resist any change in its state of rest or uniform motion along a straight line.</p></article></body></html>', { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetch);
    const result = await createAgentTools().read_link.execute?.({ url: 'https://example.org/notes' }, opts);
    expect(result).toMatchObject({ title: 'Notes', text: expect.stringContaining('Inertia is the tendency') });
    expect(fetch.mock.calls.some(([u]) => isConnector(u))).toBe(false);
  });
  it('falls back to Parallel when the page cannot be read directly, without scraping twice', async () => {
    const fetch = routeFetch(() => Response.json({ results: [{ title: 'NCERT', full_content: 'Question: What is inertia?' }] }));
    vi.stubGlobal('fetch', fetch);
    const result = await createAgentTools().read_link.execute?.({ url: 'https://ncert.nic.in/textbook/pdf/leph101.pdf' }, opts);
    expect(result).toMatchObject({ text: 'Question: What is inertia?', title: 'NCERT' });
    expect(fetch.mock.calls.filter(([u]) => isConnector(u))).toHaveLength(1);
  });
  it('falls back to Firecrawl when Parallel cannot extract text', async () => {
    const fetch = routeFetch((url) => url.includes('/parallel/') ? Response.json({ results: [] }) : Response.json({ data: { markdown: 'PDF chapter text' } }));
    vi.stubGlobal('fetch', fetch);
    const result = await createAgentTools().read_link.execute?.({ url: 'https://example.org/notes.pdf' }, opts);
    expect(result).toMatchObject({ text: 'PDF chapter text' });
    expect(fetch.mock.calls.filter(([u]) => isConnector(u))).toHaveLength(2);
  });
  it('reports empty extraction instead of claiming the document was read', async () => {
    vi.stubGlobal('fetch', routeFetch(() => Response.json({ results: [], data: { markdown: '' } })));
    const result = await createAgentTools().read_link.execute?.({ url: 'https://example.org/empty.pdf' }, opts);
    expect(result).toMatchObject({ error: expect.stringContaining('no readable text') });
  });
  it('does not expose live search or page opening when the toggle is off', () => {
    expect(createAgentTools()).not.toHaveProperty('web_search');
    expect(createAgentTools()).not.toHaveProperty('open_web_page');
    expect(createAgentTools({ webSearch: true })).toHaveProperty('web_search');
    expect(createAgentTools({ webSearch: true })).toHaveProperty('open_web_page');
  });
  it('web teacher opens a search result and returns the passage about the focus', async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `<p>General notice ${i} about counselling, fees, hostel rules and the registration portal for candidates.</p>`).join('');
    const html = `<html><head><title>NEET notice</title></head><body><main>${filler}<p>The NEET (UG) 2027 examination will be held on Sunday, 2 May 2027 in pen and paper mode.</p>${filler}</main></body></html>`;
    const fetch = routeFetch(() => Response.json({}), () => new Response(html, { headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetch);
    const result = await createAgentTools({ webSearch: true }).open_web_page!.execute?.({ url: 'https://nta.example.in/notice', focus: 'NEET 2027 examination date' }, opts) as { text: string };
    expect(result.text).toContain('Sunday, 2 May 2027');
    expect(result.text.length).toBeLessThanOrEqual(5100);
    expect(fetch.mock.calls.some(([u]) => isConnector(u))).toBe(false);
  });
});

describe('live web search', () => {
  it('uses Lovable AI search first and skips the connector searches', async () => {
    aiSearch.mockResolvedValue({ summary: 'NEET is held in May.', results: [{ title: 'NTA', url: 'https://nta.ac.in/neet', snippet: 'NEET (UG) 2027 will be held…', read: true }] });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await createAgentTools({ webSearch: true }).web_search!.execute?.({ query: 'NEET 2027 date' }, opts);
    expect(result).toMatchObject({ summary: 'NEET is held in May.', results: [{ url: 'https://nta.ac.in/neet' }] });
    expect(aiSearch).toHaveBeenCalledWith('NEET 2027 date', expect.objectContaining({ crawlPages: 3 }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it('falls back to Perplexity and Parallel when Lovable AI search is unavailable', async () => {
    aiSearch.mockResolvedValue({ results: [], error: 'Lovable AI search is paused.' });
    const fetch = vi.fn(async (input: unknown) => String(input).includes('/perplexity/')
      ? Response.json({ results: [{ title: 'P', url: 'https://a.org/p', snippet: 'from perplexity' }] })
      : Response.json({ results: [{ title: 'Q', url: 'https://a.org/q', excerpts: ['from parallel'] }] }));
    vi.stubGlobal('fetch', fetch);
    const result = await createAgentTools({ webSearch: true }).web_search!.execute?.({ query: 'NEET 2027 date' }, opts) as { results: { url: string }[] };
    expect(result.results.map((r) => r.url)).toEqual(['https://a.org/p', 'https://a.org/q']);
  });
  it('voice calls search without reading pages so answers stay quick', async () => {
    aiSearch.mockResolvedValue({ results: [{ url: 'https://a.org', snippet: 'x' }] });
    await createAgentTools({ webSearch: true, fastSearch: true }).web_search!.execute?.({ query: 'q' }, opts);
    expect(aiSearch).toHaveBeenCalledWith('q', expect.objectContaining({ crawlPages: 0 }));
  });
});

describe('NCERT search', () => {
  it('searches ncert.nic.in with Lovable AI when Parallel finds nothing', async () => {
    aiSearch.mockResolvedValue({ summary: 's', results: [{ title: 'Ch 5', url: 'https://ncert.nic.in/textbook/pdf/keph105.pdf', snippet: 'Newton’s second law' }] });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ results: [] })));
    const result = await createAgentTools().ncert_search.execute?.({ query: 'second law', classNum: 11, subject: 'physics' }, opts);
    expect(aiSearch).toHaveBeenCalledWith(expect.stringContaining('second law'), expect.objectContaining({ allowedDomains: ['ncert.nic.in'] }));
    expect(result).toMatchObject({ results: [{ url: 'https://ncert.nic.in/textbook/pdf/keph105.pdf' }] });
  });
});
