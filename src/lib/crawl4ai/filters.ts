/**
 * Ports of Crawl4AI's content filters (content_filter_strategy.py):
 *  - PruningContentFilter: query-free boilerplate pruning by text density, link density, tag weight,
 *    class/id hints and text length, with fixed or dynamic thresholds.
 *  - BM25ContentFilter: query-focused chunk selection (BM25Okapi over stemmed, stop-word-free tokens,
 *    weighted by tag priority), returned in document order.
 * Two deliberate fixes over upstream: class/id hints really lower the score (upstream clamps the
 * penalty to zero) and link density counts nested links, so menus of links are pruned.
 */
import {
  bodyOf, cleanText, cloneNode, elementsOf, findFirst, hasChildren, isTag, isText, outerHtml, parseHtml, removeAll, removeComments,
  type AnyNode, type Element, type ParentNode,
} from "./dom";
import { bm25Scores, scoringTokens, wordCount } from "./text";

const EXCLUDED_TAGS = new Set(["nav", "footer", "header", "aside", "script", "style", "form", "iframe", "noscript"]);
const NEGATIVE = /(^|[\s_-])(nav|navbar|navigation|footer|header|sidebar|ads?|advert\w*|sponsor\w*|comments?|promo\w*|social|share\w*|cookie\w*|banner|popup|modal|newsletter|related|breadcrumbs?|menu|widget)([\s_-]|$)/i;
const HEADER_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "header"]);
const INLINE_TAGS = new Set([
  "a", "abbr", "acronym", "b", "bdo", "big", "br", "button", "cite", "code", "dfn", "em", "i", "img", "input", "kbd", "label", "map",
  "object", "q", "samp", "script", "select", "small", "span", "strong", "sub", "sup", "textarea", "time", "tt", "var",
]);
const BLOCKISH = new Set(["p", "div", "section", "article", "main", "ul", "ol", "li", "table", "tr", "td", "th", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dd", "dt", "figure", "header", "footer", "aside", "nav", "form"]);

function toRoot(input: string | ParentNode): ParentNode {
  if (typeof input === "string") return bodyOf(parseHtml(input.includes("<body") ? input : `<body>${input}</body>`));
  return cloneNode(input as unknown as Element, true) as unknown as ParentNode;
}

/** BeautifulSoup get_text(strip=True) length: stripped strings concatenated. */
function strippedTextLength(node: AnyNode): number {
  let n = 0;
  const stack: AnyNode[] = [node];
  while (stack.length) {
    const cur = stack.pop()!;
    if (isText(cur)) n += cur.data.trim().length;
    else if (hasChildren(cur)) for (const c of cur.children) stack.push(c);
  }
  return n;
}

// ------------------------------------------------------------------ Pruning
export type PruningOptions = {
  threshold?: number;
  thresholdType?: "fixed" | "dynamic";
  minWordThreshold?: number;
  preserveTags?: string[];
  preserveClasses?: string[];
};

const TAG_IMPORTANCE: Record<string, number> = { article: 1.5, main: 1.4, section: 1.3, p: 1.2, h1: 1.4, h2: 1.3, h3: 1.2, div: 0.7, span: 0.6 };
const TAG_WEIGHTS: Record<string, number> = {
  div: 0.5, p: 1.0, article: 1.5, section: 1.0, span: 0.3, li: 0.5, ul: 0.5, ol: 0.5, h1: 1.2, h2: 1.1, h3: 1.0, h4: 0.9, h5: 0.8, h6: 0.7,
  table: 1.0, pre: 1.0, blockquote: 1.0, main: 1.4, figure: 0.9,
};
const METRIC_WEIGHTS = { textDensity: 0.4, linkDensity: 0.2, tagWeight: 0.2, classIdWeight: 0.1, textLength: 0.1 };

export function classIdWeight(el: Element): number {
  let score = 0;
  if (el.attribs["class"] && NEGATIVE.test(el.attribs["class"])) score -= 0.5;
  if (el.attribs["id"] && NEGATIVE.test(el.attribs["id"])) score -= 0.5;
  if (/(^|[\s_-])(content|article|post|entry|main|body|story|chapter|text)([\s_-]|$)/i.test(`${el.attribs["class"] ?? ""} ${el.attribs["id"] ?? ""}`)) score += 0.5;
  return score;
}

export function pruningScore(el: Element, minWordThreshold?: number): number {
  const textLen = strippedTextLength(el);
  if (minWordThreshold) {
    const words = cleanText(el).split(" ").filter(Boolean).length;
    if (words < minWordThreshold) return -1;
  }
  const tagLen = outerHtml(el.children).length;
  let linkTextLen = 0;
  for (const a of elementsOf(el, (e) => e.name === "a")) linkTextLen += strippedTextLength(a);
  const density = tagLen > 0 ? textLen / tagLen : 0;
  const linkDensity = 1 - (textLen > 0 ? Math.min(1, linkTextLen / textLen) : 0);
  const tagScore = TAG_WEIGHTS[el.name] ?? 0.5;
  const total = METRIC_WEIGHTS.textDensity + METRIC_WEIGHTS.linkDensity + METRIC_WEIGHTS.tagWeight + METRIC_WEIGHTS.classIdWeight + METRIC_WEIGHTS.textLength;
  const score =
    METRIC_WEIGHTS.textDensity * density +
    METRIC_WEIGHTS.linkDensity * linkDensity +
    METRIC_WEIGHTS.tagWeight * tagScore +
    METRIC_WEIGHTS.classIdWeight * classIdWeight(el) +
    METRIC_WEIGHTS.textLength * Math.log(textLen + 1);
  return score / total;
}

export function pruningFilter(input: string | ParentNode, opts: PruningOptions = {}): string[] {
  const root = toRoot(input);
  removeComments(root);
  removeAll(elementsOf(root, (e) => EXCLUDED_TAGS.has(e.name)));
  const threshold = opts.threshold ?? 0.48;
  const preserveTags = new Set(opts.preserveTags ?? []);
  const preserveClasses = new Set(opts.preserveClasses ?? []);
  const preserved = (el: Element) =>
    preserveTags.has(el.name) || (!!el.attribs["class"] && el.attribs["class"].split(/\s+/).some((c) => preserveClasses.has(c)));

  const prune = (el: Element) => {
    if (preserved(el)) return;
    const score = pruningScore(el, opts.minWordThreshold);
    let limit = threshold;
    if (opts.thresholdType === "dynamic") {
      const textLen = strippedTextLength(el);
      const tagLen = outerHtml(el.children).length;
      const linkLen = elementsOf(el, (e) => e.name === "a").reduce((s, a) => s + strippedTextLength(a), 0);
      if ((TAG_IMPORTANCE[el.name] ?? 0.7) > 1) limit *= 0.8;
      if (tagLen > 0 && textLen / tagLen > 0.4) limit *= 0.9;
      if ((textLen > 0 ? linkLen / textLen : 1) > 0.6) limit *= 1.2;
    }
    if (score < limit) {
      removeAll([el]);
      return;
    }
    for (const c of [...el.children]) if (isTag(c)) prune(c);
  };
  for (const c of [...root.children]) if (isTag(c)) prune(c);
  return root.children.filter(isTag).filter((c) => strippedTextLength(c) > 0).map((c) => outerHtml(c));
}

// ------------------------------------------------------------------ BM25
export type TextChunk = { index: number; text: string; type: "header" | "content"; element: Element | null; tag: string };

/** extract_text_chunks: text accumulated until a block boundary, in document order. */
export function extractTextChunks(root: ParentNode, minWordThreshold?: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  let current: string[] = [];
  let index = 0;
  const stack: Array<{ node: AnyNode; visited: boolean }> = [{ node: root, visited: false }];
  const shouldBreak = (el: Element) => !INLINE_TAGS.has(el.name) && !(el.name === "p" && current.length === 0);
  while (stack.length) {
    const { node, visited } = stack.pop()!;
    if (visited) {
      const el = isTag(node) ? node : null;
      if (current.length && (!el || shouldBreak(el))) {
        const text = current.join(" ").replace(/\s+/g, " ").trim();
        if (text) chunks.push({ index: index++, text, type: el && HEADER_TAGS.has(el.name) ? "header" : "content", element: el, tag: el?.name ?? "body" });
        current = [];
      }
      continue;
    }
    if (isText(node)) {
      const t = node.data.trim();
      if (t) current.push(t);
      continue;
    }
    if (!hasChildren(node) || !node.children.length) continue;
    if (isTag(node) && (node.name === "script" || node.name === "style")) continue;
    stack.push({ node, visited: true });
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i]!, visited: false });
  }
  if (current.length) {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    if (text) chunks.push({ index: index++, text, type: "content", element: null, tag: "body" });
  }
  return minWordThreshold ? chunks.filter((c) => wordCount(c.text) >= minWordThreshold) : chunks;
}

/** extract_page_query: title + h1 + meta keywords/description, else the first long paragraph. */
export function pageQuery(input: string | ParentNode): string {
  const doc = typeof input === "string" ? parseHtml(input) : input;
  const parts: string[] = [];
  const title = findFirst(doc, (e) => e.name === "title");
  if (title) parts.push(cleanText(title));
  const h1 = findFirst(doc, (e) => e.name === "h1");
  if (h1) parts.push(cleanText(h1));
  let meta = "";
  for (const name of ["keywords", "description"]) {
    const m = findFirst(doc, (e) => e.name === "meta" && e.attribs["name"] === name);
    if (m?.attribs["content"]) { parts.push(m.attribs["content"]); meta += m.attribs["content"]; }
  }
  if (!meta) {
    const p = elementsOf(doc, (e) => e.name === "p").find((e) => cleanText(e).length > 150);
    if (p) parts.push(cleanText(p).slice(0, 150));
  }
  return parts.filter(Boolean).join(" ");
}

const PRIORITY_TAGS: Record<string, number> = { h1: 5, h2: 4, h3: 3, title: 4, strong: 2, b: 1.5, em: 1.5, blockquote: 2, code: 2, pre: 1.5, th: 1.5 };

export type BM25Options = { threshold?: number; useStemming?: boolean; minWordThreshold?: number };
export type ScoredChunk = TextChunk & { score: number };

export function bm25ScoredChunks(input: string | ParentNode, query?: string, opts: BM25Options = {}): ScoredChunk[] {
  const root = typeof input === "string" ? toRoot(input) : input;
  const q = (query?.trim() || pageQuery(root)).slice(0, 1000);
  if (!q) return [];
  const chunks = extractTextChunks(root, opts.minWordThreshold);
  if (!chunks.length) return [];
  const useStemming = opts.useStemming !== false;
  const scores = bm25Scores(chunks.map((c) => scoringTokens(c.text, useStemming)), scoringTokens(q, useStemming));
  return chunks.map((c, i) => ({ ...c, score: scores[i]! * (PRIORITY_TAGS[c.tag] ?? 1) }));
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Chunk HTML for fit markdown: the element itself when it is a leaf block, otherwise only its own text. */
function chunkHtml(c: TextChunk): string {
  if (c.element && !findFirst(c.element, (e) => BLOCKISH.has(e.name))) return outerHtml(c.element);
  const tag = /^h[1-6]$/.test(c.tag) ? c.tag : "p";
  return `<${tag}>${escapeHtml(c.text)}</${tag}>`;
}

export function bm25Filter(input: string | ParentNode, query?: string, opts: BM25Options = {}): string[] {
  const threshold = opts.threshold ?? 1.0;
  const selected = bm25ScoredChunks(input, query, opts).filter((c) => c.score >= threshold).sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of selected) {
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    out.push(chunkHtml(c));
  }
  return out;
}

/** BM25 over plain-text passages (PDF pages, search snippets): best first, with scores. */
export function rankPassages(passages: string[], query: string, useStemming = true): Array<{ index: number; text: string; score: number }> {
  if (!passages.length || !query.trim()) return passages.map((text, index) => ({ index, text, score: 0 }));
  const scores = bm25Scores(passages.map((p) => scoringTokens(p, useStemming)), scoringTokens(query, useStemming));
  return passages.map((text, index) => ({ index, text, score: scores[index]! })).sort((a, b) => b.score - a.score || a.index - b.index);
}
