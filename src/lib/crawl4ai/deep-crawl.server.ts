/**
 * Deep crawling (Crawl4AI deep_crawling/): BFS and Best-First strategies with a FilterChain
 * (domain, URL pattern, content type, robots.txt) and URL scorers (keyword relevance, path depth,
 * freshness). Bounded for the edge server: depth ≤ 3, pages ≤ 15, 3 pages at a time.
 */
import { crawl, type CrawlConfig, type CrawlResult } from "./crawler.server";
import { CrawlError, fetchPage } from "./fetcher.server";
import { isAllowed, robotsFor } from "./robots";
import { baseDomain, normalizeUrl, parseHttpUrl, urlContentType } from "./url";

export const DEEP_LIMITS = { maxDepth: 3, maxPages: 15, concurrency: 3 } as const;

export type DeepCrawlOptions = {
  strategy: "bfs" | "best-first";
  maxDepth: number;
  maxPages: number;
  includeExternal?: boolean;
  keywords?: string[];
  allowedDomains?: string[];
  blockedDomains?: string[];
  includePatterns?: string[];
  excludePatterns?: string[];
  contentTypes?: string[];
  scoreThreshold?: number;
  respectRobots?: boolean;
  config?: CrawlConfig;
  signal?: AbortSignal;
  onPage?: (r: CrawlResult, depth: number, score: number) => void;
  onSkip?: (url: string, reason: string) => void;
};

export type DeepCrawlStats = { crawled: number; failed: number; skippedByFilter: number; skippedByRobots: number; discovered: number; depthReached: number };

// ------------------------------------------------------------ filters
export function globToRegex(glob: string): RegExp {
  const body = glob.trim().split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(glob.includes("://") ? `^${body}$` : body, "i");
}

export function makeFilterChain(o: Pick<DeepCrawlOptions, "allowedDomains" | "blockedDomains" | "includePatterns" | "excludePatterns" | "contentTypes" | "includeExternal">, startHost: string) {
  const allowed = (o.allowedDomains ?? []).map((d) => d.toLowerCase().replace(/^www\./, ""));
  const blocked = (o.blockedDomains ?? []).map((d) => d.toLowerCase().replace(/^www\./, ""));
  const include = (o.includePatterns ?? []).filter(Boolean).map(globToRegex);
  const exclude = (o.excludePatterns ?? []).filter(Boolean).map(globToRegex);
  const types = new Set(o.contentTypes ?? ["text/html", "application/pdf", "text/plain", "unknown"]);
  const startBase = baseDomain(startHost);
  const hostMatch = (host: string, d: string) => host === d || host.endsWith(`.${d}`);
  return (url: string): string | null => {
    const u = parseHttpUrl(url);
    if (!u) return "not a web link";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (blocked.some((d) => hostMatch(host, d))) return "blocked domain";
    if (allowed.length ? !allowed.some((d) => hostMatch(host, d)) : !o.includeExternal && baseDomain(host) !== startBase) return "outside the site";
    if (!types.has(urlContentType(url))) return "file type";
    if (include.length && !include.some((r) => r.test(url))) return "does not match include pattern";
    if (exclude.some((r) => r.test(url))) return "matches exclude pattern";
    return null;
  };
}

// ------------------------------------------------------------ scorers
export function keywordRelevance(url: string, keywords: string[]): number {
  if (!keywords.length) return 0;
  const lower = decodeURIComponent(url).toLowerCase();
  const matches = keywords.filter((k) => lower.includes(k.toLowerCase())).length;
  return matches / keywords.length;
}

const DEPTH_LOOKUP = [1.0, 0.5, 0.3333333333333333, 0.25];
export function pathDepthScore(url: string, optimal = 3): number {
  const u = parseHttpUrl(url);
  const depth = u ? u.pathname.split("/").filter(Boolean).length : 0;
  const d = Math.abs(depth - optimal);
  return d < 4 ? DEPTH_LOOKUP[d]! : 1 / (1 + d);
}

export function freshnessScore(url: string, currentYear = new Date().getUTCFullYear()): number {
  const years = [...url.matchAll(/(?:^|[^\d])(19\d{2}|20\d{2})(?=[^\d]|$)/g)].map((m) => Number(m[1])).filter((y) => y <= currentYear);
  if (!years.length) return 0.5;
  const diff = currentYear - Math.max(...years);
  return diff === 0 ? 1 : diff === 1 ? 0.9 : diff === 2 ? 0.8 : diff <= 5 ? 0.6 : 0.3;
}

/** CompositeScorer: keyword relevance dominates, depth and freshness break ties. */
export function scoreUrl(url: string, keywords: string[], anchorText = ""): number {
  const kw = keywords.length ? Math.max(keywordRelevance(url, keywords), keywordRelevance(` ${anchorText} `, keywords)) : 0;
  return kw * 1.0 + pathDepthScore(url) * 0.3 + freshnessScore(url) * 0.15;
}

// ------------------------------------------------------------ traversal
async function robotsLoader(robotsUrl: string): Promise<string | null> {
  try {
    const page = await fetchPage(robotsUrl, { timeoutMs: 5000, maxHtmlBytes: 500_000, accept: "text/plain,*/*;q=0.5" });
    return page.status < 400 ? page.text ?? null : null;
  } catch {
    return null;
  }
}

export async function deepCrawl(startUrl: string, opts: DeepCrawlOptions): Promise<{ results: CrawlResult[]; stats: DeepCrawlStats }> {
  const start = normalizeUrl(startUrl);
  if (!start) throw new CrawlError("blocked", "Enter a full web link starting with http:// or https://.");
  const maxDepth = Math.max(0, Math.min(DEEP_LIMITS.maxDepth, Math.floor(opts.maxDepth)));
  const maxPages = Math.max(1, Math.min(DEEP_LIMITS.maxPages, Math.floor(opts.maxPages)));
  const keywords = (opts.keywords ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 12);
  const filter = makeFilterChain(opts, new URL(start).hostname);
  const stats: DeepCrawlStats = { crawled: 0, failed: 0, skippedByFilter: 0, skippedByRobots: 0, discovered: 1, depthReached: 0 };
  const visited = new Set<string>([start]);
  const results: CrawlResult[] = [];
  type Item = { url: string; depth: number; score: number };
  let frontier: Item[] = [{ url: start, depth: 0, score: Infinity }];
  const threshold = opts.scoreThreshold ?? -Infinity;

  const allowedByRobots = async (url: string) => {
    if (opts.respectRobots === false) return true;
    const rules = await robotsFor(url, robotsLoader);
    const u = new URL(url);
    return isAllowed(rules, u.pathname + u.search);
  };

  const discover = (r: CrawlResult, depth: number) => {
    if (depth >= maxDepth) return;
    const links = [...r.links.internal, ...(opts.includeExternal || opts.allowedDomains?.length ? r.links.external : [])];
    for (const l of links) {
      const url = normalizeUrl(l.href);
      if (!url || visited.has(url)) continue;
      visited.add(url);
      const why = filter(url);
      if (why) { stats.skippedByFilter++; opts.onSkip?.(url, why); continue; }
      const score = scoreUrl(url, keywords, l.text);
      if (score < threshold) { stats.skippedByFilter++; opts.onSkip?.(url, "low score"); continue; }
      stats.discovered++;
      frontier.push({ url, depth: depth + 1, score });
    }
  };

  while (frontier.length && results.length < maxPages) {
    if (opts.signal?.aborted) throw new CrawlError("cancelled", "Stopped.");
    let batch: Item[];
    if (opts.strategy === "best-first") {
      frontier.sort((a, b) => b.score - a.score || a.depth - b.depth);
      batch = frontier.splice(0, Math.min(DEEP_LIMITS.concurrency, maxPages - results.length));
    } else {
      const depth = Math.min(...frontier.map((f) => f.depth));
      const level = frontier.filter((f) => f.depth === depth);
      batch = level.slice(0, Math.min(DEEP_LIMITS.concurrency, maxPages - results.length));
      frontier = frontier.filter((f) => !batch.includes(f));
    }
    const done = await Promise.all(
      batch.map(async (item) => {
        if (item.depth > 0 && !(await allowedByRobots(item.url))) {
          stats.skippedByRobots++;
          opts.onSkip?.(item.url, "robots.txt");
          return null;
        }
        const r = await crawl(item.url, { ...opts.config, fetch: { timeoutMs: 15000, ...opts.config?.fetch, ...(opts.signal ? { signal: opts.signal } : {}) } });
        return { r, item };
      }),
    );
    for (const entry of done) {
      if (!entry) continue;
      const { r, item } = entry;
      results.push(r);
      if (r.success) stats.crawled++;
      else stats.failed++;
      stats.depthReached = Math.max(stats.depthReached, item.depth);
      opts.onPage?.(r, item.depth, Number.isFinite(item.score) ? item.score : 1);
      if (r.success) discover(r, item.depth);
    }
  }
  return { results, stats };
}
