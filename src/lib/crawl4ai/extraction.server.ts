/**
 * AI strategies from Crawl4AI, running on Lovable AI credits:
 *  - LLMContentFilter: AI-cleaned, instruction-focused markdown.
 *  - LLMExtractionStrategy: "blocks" (semantic blocks with tags) or "fields" (your field list →
 *    strict JSON schema), chunked by tokens with overlap, 3 chunks at a time, merged in order.
 *  - generate_schema: AI writes a reusable CSS schema once; JsonCssExtraction then runs for free.
 */
import { chunkMarkdown } from "./chunking";
import { cssExtract, structuralSample, validateCssSchema, type CssSchema } from "./css-extract";
import { CrawlAiError, mapLimit, runJson, runResponse, type UsageMeter } from "./llm.server";

type Common = { signal?: AbortSignal; meter?: UsageMeter; url?: string; onProgress?: (done: number, total: number) => void };

const FILTER_INSTRUCTIONS = `Your task is to filter and convert web page content into clean, focused markdown that is optimised for study and information retrieval.
1. Content selection — keep essential information, main content and key details; keep code blocks, tables and key lists. Remove navigation menus, ads, footers, cookie notices, social widgets, sidebars and related-content lists.
2. Transformation — proper markdown (#, ##, **, \`), markdown tables, fenced code with language; keep link text but drop tracking parameters; no HTML tags, classes or ids.
3. Organisation — logical flow, related content under the right headers, consistent header levels, no duplication.
If the user gives an instruction, it overrides these general guidelines.
Return only the markdown, nothing else. Copy facts exactly; never add information that is not in the content.`;

export async function llmContentFilter(markdown: string, instruction: string, opts: Common & { chunkTokens?: number; maxChunks?: number } = {}): Promise<string> {
  const chunks = chunkMarkdown(markdown, opts.chunkTokens ?? 3000).slice(0, opts.maxChunks ?? 8);
  if (!chunks.length) return "";
  let done = 0;
  const parts = await mapLimit(chunks, 3, async (chunk) => {
    const r = await runResponse({
      instructions: FILTER_INSTRUCTIONS,
      input: `${opts.url ? `Page: ${opts.url}\n\n` : ""}<content>\n${chunk}\n</content>\n\n<instruction>\n${instruction.trim() || "Convert this into clean, relevant markdown, removing noise."}\n</instruction>`,
      effort: "low",
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.meter ? { meter: opts.meter } : {}),
    });
    opts.onProgress?.(++done, chunks.length);
    return r.text.replace(/^<content>\s*|\s*<\/content>$/g, "").trim();
  });
  return parts.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------- blocks
export type Block = { index: number; tags: string[]; content: string[] };

const BLOCKS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["blocks"],
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["index", "tags", "content"],
        properties: { index: { type: "integer" }, tags: { type: "array", items: { type: "string" } }, content: { type: "array", items: { type: "string" } } },
      },
    },
  },
} as const;

const BLOCKS_INSTRUCTIONS = `Break the page content into semantically relevant blocks that follow the user's request. For each block give its index (order on the page), one or two short semantic tags, and its text content as a list of strings copied EXACTLY from the content (clean whitespace only, never rewrite). Keep the page order. Skip navigation and boilerplate. If nothing matches the request, return an empty list.`;

// ---------------------------------------------------------------- fields
export type FieldSpec = { name: string; description?: string; type: "string" | "number" | "boolean" | "list" };

export function fieldKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "field";
}

export function fieldsSchema(fields: FieldSpec[]) {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    const desc = f.description?.slice(0, 200);
    const base = f.type === "list" ? { type: ["array", "null"], items: { type: "string" } } : { type: [f.type === "number" ? "number" : f.type === "boolean" ? "boolean" : "string", "null"] };
    properties[fieldKey(f.name)] = desc ? { ...base, description: desc } : base;
  }
  return {
    type: "object", additionalProperties: false, required: ["items"],
    properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: Object.keys(properties), properties } } },
  };
}

const FIELDS_INSTRUCTIONS = `Extract the requested information from the page content into the JSON schema. Return one item per distinct record (for a list of products, questions, dates, colleges, etc.) in page order, or a single item for single-topic pages. Copy values exactly as written; use null when a value is not present. Never guess or invent values.`;

export type ExtractResult =
  | { mode: "blocks"; blocks: Block[]; chunks: number }
  | { mode: "fields"; items: Record<string, unknown>[]; chunks: number; keys: string[] };

export async function llmExtract(
  markdown: string,
  spec: { mode: "blocks"; instruction: string } | { mode: "fields"; instruction: string; fields: FieldSpec[] },
  opts: Common & { chunkTokens?: number; maxChunks?: number } = {},
): Promise<ExtractResult> {
  const chunks = chunkMarkdown(markdown, opts.chunkTokens ?? 4000).slice(0, opts.maxChunks ?? 8);
  if (!chunks.length) return spec.mode === "blocks" ? { mode: "blocks", blocks: [], chunks: 0 } : { mode: "fields", items: [], chunks: 0, keys: [] };
  let done = 0;
  const input = (chunk: string) => `${opts.url ? `<url>${opts.url}</url>\n` : ""}<content>\n${chunk}\n</content>\n\n<request>\n${spec.instruction.trim() || "Extract the main information."}\n</request>`;
  const common = { effort: "low" as const, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.meter ? { meter: opts.meter } : {}) };
  if (spec.mode === "blocks") {
    const parts = await mapLimit(chunks, 3, async (chunk) => {
      const { value } = await runJson<{ blocks: Block[] }>({ ...common, instructions: BLOCKS_INSTRUCTIONS, input: input(chunk), schema: { name: "content_blocks", schema: BLOCKS_SCHEMA } });
      opts.onProgress?.(++done, chunks.length);
      return Array.isArray(value.blocks) ? value.blocks : [];
    });
    const seen = new Set<string>();
    const blocks: Block[] = [];
    for (const b of parts.flat()) {
      const content = (b.content ?? []).filter((c) => typeof c === "string" && c.trim());
      const key = content.join("\n");
      if (!content.length || seen.has(key)) continue;
      seen.add(key);
      blocks.push({ index: blocks.length, tags: (b.tags ?? []).slice(0, 4), content });
    }
    return { mode: "blocks", blocks, chunks: chunks.length };
  }
  if (!spec.fields.length) throw new CrawlAiError("invalid", "Add at least one field to extract.", 400);
  const schema = fieldsSchema(spec.fields);
  const fieldList = spec.fields.map((f) => `- ${fieldKey(f.name)} (${f.type})${f.description ? `: ${f.description}` : ""}`).join("\n");
  const parts = await mapLimit(chunks, 3, async (chunk) => {
    const { value } = await runJson<{ items: Record<string, unknown>[] }>({
      ...common, instructions: `${FIELDS_INSTRUCTIONS}\nFields:\n${fieldList}`, input: input(chunk), schema: { name: "extracted_items", schema },
    });
    opts.onProgress?.(++done, chunks.length);
    return Array.isArray(value.items) ? value.items : [];
  });
  const seen = new Set<string>();
  const items: Record<string, unknown>[] = [];
  for (const row of parts.flat()) {
    if (!row || typeof row !== "object" || Object.values(row).every((v) => v === null || (Array.isArray(v) && !v.length) || v === "")) continue;
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(row);
  }
  return { mode: "fields", items, chunks: chunks.length, keys: Object.keys(schema.properties.items.items.properties) };
}

// ---------------------------------------------------------------- CSS schema generation
const SCHEMA_GEN = {
  type: "object", additionalProperties: false, required: ["name", "baseSelector", "fields"],
  properties: {
    name: { type: "string" },
    baseSelector: { type: "string" },
    fields: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["name", "selector", "type", "attribute", "pattern"],
        properties: {
          name: { type: "string" },
          selector: { type: ["string", "null"] },
          type: { type: "string", enum: ["text", "attribute", "html", "regex", "list"] },
          attribute: { type: ["string", "null"] },
          pattern: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

const SCHEMA_INSTRUCTIONS = `You design CSS extraction schemas for a scraper (Crawl4AI JsonCssExtractionStrategy).
Given an HTML sample, return a schema with:
- baseSelector: CSS selector matching EACH repeating item (one card/row/question per match), or the main container for a single item.
- fields: for each requested value, a selector RELATIVE to the base element (null = the base element itself) and a type: "text" (visible text), "attribute" (set attribute, e.g. href or src), "html", "regex" (set pattern with one capture group, applied to the text) or "list" (all matching elements' text).
Rules: use only classes, ids, tags and attributes that really exist in the sample; prefer stable semantic classes over generated ones (no hashes like css-1x2y3); avoid :nth-child unless necessary; selectors must be valid CSS3. Name fields in snake_case.`;

export type GeneratedSchema = { schema: CssSchema; items: Record<string, unknown>[]; matched: number };

export async function generateCssSchema(html: string, instruction: string, opts: Common = {}): Promise<GeneratedSchema> {
  const sample = structuralSample(html);
  const { value } = await runJson<{ name: string; baseSelector: string; fields: Array<{ name: string; selector: string | null; type: string; attribute: string | null; pattern: string | null }> }>({
    instructions: SCHEMA_INSTRUCTIONS,
    input: `<request>\n${instruction.trim() || "Extract the main repeating items with their key details."}\n</request>\n\n<html_sample>\n${sample}\n</html_sample>`,
    effort: "medium",
    schema: { name: "css_schema", schema: SCHEMA_GEN },
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.meter ? { meter: opts.meter } : {}),
  });
  const schema: CssSchema = {
    name: value.name || "items",
    baseSelector: value.baseSelector,
    fields: (value.fields ?? []).map((f) => ({
      name: f.name,
      ...(f.selector ? { selector: f.selector } : {}),
      type: (["text", "attribute", "html", "regex", "list"].includes(f.type) ? f.type : "text") as CssSchema["fields"][number]["type"],
      ...(f.attribute ? { attribute: f.attribute } : {}),
      ...(f.pattern ? { pattern: f.pattern } : {}),
    })),
  };
  const problem = validateCssSchema(schema);
  if (problem) throw new CrawlAiError("failed", `The AI schema was not usable: ${problem}`, 502);
  const items = cssExtract(html, schema, opts.url);
  return { schema, items, matched: items.length };
}
