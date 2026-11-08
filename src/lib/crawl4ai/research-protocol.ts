/**
 * Browser-safe contract between the Web Research page and /api/crawl (NDJSON events).
 */
import { z } from "zod";

export const RESEARCH_LIMITS = { searchPages: 6, deepDepth: 3, deepPages: 15, fields: 20, pageMarkdownChars: 60000 } as const;

const url = z.string().trim().min(4).max(2000).refine((v) => /^https?:\/\//i.test(v), "Enter a full link starting with http:// or https://");

export const fieldSpecSchema = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).optional(),
  type: z.enum(["string", "number", "boolean", "list"]),
});

export const researchRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("search"),
    query: z.string().trim().min(2).max(500),
    site: z.string().trim().max(100).regex(/^$|^[a-z0-9.-]+\.[a-z]{2,}$/i, "Enter a site like ncert.nic.in").optional(),
    pages: z.number().int().min(1).max(RESEARCH_LIMITS.searchPages).default(4),
    answer: z.boolean().default(true),
  }),
  z.object({
    mode: z.literal("read"),
    url,
    focus: z.string().trim().max(300).optional(),
    filter: z.enum(["auto", "pruning", "bm25", "none"]).default("auto"),
    aiClean: z.boolean().default(false),
    question: z.string().trim().max(500).optional(),
  }),
  z.object({
    mode: z.literal("deep"),
    url,
    strategy: z.enum(["bfs", "best-first"]).default("best-first"),
    maxDepth: z.number().int().min(1).max(RESEARCH_LIMITS.deepDepth).default(2),
    maxPages: z.number().int().min(1).max(RESEARCH_LIMITS.deepPages).default(8),
    keywords: z.string().trim().max(200).optional(),
    include: z.string().trim().max(300).optional(),
    exclude: z.string().trim().max(300).optional(),
    includeExternal: z.boolean().default(false),
    summarize: z.boolean().default(false),
  }),
  z.object({
    mode: z.literal("extract"),
    url,
    method: z.enum(["ai-fields", "ai-blocks", "css-auto", "css-schema", "tables"]),
    instruction: z.string().trim().max(600).optional(),
    fields: z.array(fieldSpecSchema).max(RESEARCH_LIMITS.fields).optional(),
    schema: z.string().max(20000).optional(),
  }),
]);

export type ResearchRequest = z.infer<typeof researchRequestSchema>;
export type ResearchMode = ResearchRequest["mode"];
export type FieldSpecInput = z.infer<typeof fieldSpecSchema>;

/** Which requests spend Lovable AI credits (search always; others only for AI options). */
export function usesAi(req: ResearchRequest): boolean {
  switch (req.mode) {
    case "search":
      return true;
    case "read":
      return req.aiClean || !!req.question?.trim();
    case "deep":
      return req.summarize;
    case "extract":
      return req.method === "ai-fields" || req.method === "ai-blocks" || req.method === "css-auto";
  }
}

export type PageView = {
  url: string;
  finalUrl: string;
  title: string;
  success: boolean;
  error?: string;
  kind: "html" | "pdf" | "text";
  status: number;
  wordCount: number;
  fitWordCount: number;
  depth?: number;
  score?: number;
  needsBrowser: boolean;
  cached: boolean;
  truncated: boolean;
  rawMarkdown: string;
  citedMarkdown: string;
  fitMarkdown: string;
  aiMarkdown?: string;
  description?: string;
  links: { internal: number; external: number; sample: { href: string; text: string }[] };
  images: { src: string; alt: string }[];
  tables: number;
};

export type SourceRef = { n: number; url: string; title: string };

export type UsageView = { calls: number; inputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number; webSearches: number };

export type ResearchEvent =
  | { type: "status"; message: string }
  | { type: "search"; summary: string; queries: string[]; hits: { url: string; title?: string; snippet: string; cited: boolean }[] }
  | { type: "page"; page: PageView }
  | { type: "skip"; url: string; reason: string }
  | { type: "answer-delta"; delta: string }
  | { type: "answer"; text: string; sources: SourceRef[] }
  | { type: "extracted"; method: string; data: unknown; schema?: unknown; count: number; note?: string }
  | { type: "stats"; stats: { crawled: number; failed: number; skippedByFilter: number; skippedByRobots: number; discovered: number; depthReached: number } }
  | { type: "usage"; usage: UsageView }
  | { type: "error"; message: string; kind?: string; status?: number }
  | { type: "done"; elapsedMs: number };

/** Parses newline-delimited JSON chunks, keeping partial lines for the next chunk. */
export function createNdjsonParser(onEvent: (e: ResearchEvent) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as ResearchEvent);
        } catch {
          /* ignore a malformed line */
        }
      }
    },
    flush() {
      const line = buffer.trim();
      buffer = "";
      if (line) {
        try { onEvent(JSON.parse(line) as ResearchEvent); } catch { /* ignore */ }
      }
    },
  };
}
