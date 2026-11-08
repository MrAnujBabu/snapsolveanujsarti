/**
 * Port of Crawl4AI's WebScrapingStrategy (content_scraping_strategy.py): metadata, cleaned HTML,
 * internal/external links, scored images, media and data tables from one HTML document.
 */
import {
  bodyOf, cleanText, elementsOf, findFirst, hasChildren, headOf, isTag, isText, outerHtml, parseHtml,
  removeAll, removeComments, select, type AnyNode, type Document, type Element, type ParentNode,
} from "./dom";
import { baseDomain, isSocialMediaUrl, normalizeUrl, parseHttpUrl } from "./url";
import { wordCount } from "./text";

export type PageLink = { href: string; text: string; title?: string; baseDomain: string };
export type PageImage = { src: string; alt: string; desc: string; score: number; width?: number; height?: number };
export type PageMedia = { images: PageImage[]; videos: { src: string; title?: string }[]; audios: { src: string; title?: string }[] };
export type PageTable = { caption?: string; headers: string[]; rows: string[][] };
export type PageMetadata = {
  title: string;
  description?: string;
  keywords?: string;
  author?: string;
  language?: string;
  canonical?: string;
  image?: string;
  siteName?: string;
  published?: string;
  type?: string;
};

export type ScrapeOptions = {
  /** Keep only elements matching this CSS selector (Crawl4AI css_selector). */
  cssSelector?: string;
  /** Extra tags to drop entirely (excluded_tags). */
  excludedTags?: string[];
  /** CSS selector of elements to drop (excluded_selector). */
  excludedSelector?: string;
  /** Drop nav/header/footer/aside page chrome before markdown. */
  removeChrome?: boolean;
  removeForms?: boolean;
  excludeExternalLinks?: boolean;
  excludeSocialMediaLinks?: boolean;
  excludeExternalImages?: boolean;
  /** Blocks with fewer words are removed (word_count_threshold); 1 keeps everything with text. */
  wordCountThreshold?: number;
  imageScoreThreshold?: number;
};

export type ScrapeResult = {
  metadata: PageMetadata;
  cleanedHtml: string;
  /** Cleaned body, reusable by markdown and filters without re-parsing. */
  root: ParentNode;
  links: { internal: PageLink[]; external: PageLink[] };
  media: PageMedia;
  tables: PageTable[];
  wordCount: number;
};

const ALWAYS_REMOVE = ["script", "style", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "canvas", "svg", "math-field", "link", "meta", "base", "dialog", "portal"];
const CONTROLS = ["button", "input", "select", "textarea", "option", "optgroup", "datalist", "output", "progress", "meter"];
const CHROME = ["nav", "header", "footer", "aside"];
const KEEP_ATTRS = new Set(["href", "src", "alt", "title", "colspan", "rowspan", "lang", "dir", "datetime", "cite", "start", "type", "srcset", "width", "height", "summary", "abbr", "scope", "headers"]);
const CODE_ATTRS = new Set(["class"]);
const MEDIA_TAGS = new Set(["img", "video", "audio", "picture", "source", "br", "hr", "td", "th", "tr", "table", "thead", "tbody", "tfoot", "math"]);
const BLOCK_PRUNE = new Set(["p", "div", "section", "article", "li", "span", "font", "center", "figure", "figcaption", "blockquote", "dd", "dt", "small", "label", "strong", "em", "b", "i", "a", "h1", "h2", "h3", "h4", "h5", "h6"]);
const IMAGE_FORMATS = /\.(jpe?g|png|webp|avif|gif)(\?|$)/i;

function metaContent(head: ParentNode | null, doc: Document, ...keys: string[]): string | undefined {
  const scope = head ?? doc;
  for (const key of keys) {
    const el = findFirst(scope, (e) => e.name === "meta" && ((e.attribs["name"] ?? e.attribs["property"] ?? e.attribs["itemprop"] ?? "").toLowerCase() === key));
    const v = el?.attribs["content"]?.trim();
    if (v) return v;
  }
  return undefined;
}

export function extractMetadata(doc: Document, pageUrl: string): PageMetadata {
  const head = headOf(doc);
  const titleEl = findFirst(head ?? doc, (e) => e.name === "title");
  const h1 = findFirst(doc, (e) => e.name === "h1");
  const canonicalEl = findFirst(head ?? doc, (e) => e.name === "link" && (e.attribs["rel"] ?? "").toLowerCase().split(/\s+/).includes("canonical"));
  const htmlEl = findFirst(doc, (e) => e.name === "html");
  const image = metaContent(head, doc, "og:image", "twitter:image");
  const title = (titleEl ? cleanText(titleEl) : "") || metaContent(head, doc, "og:title", "twitter:title") || (h1 ? cleanText(h1) : "");
  const meta: PageMetadata = { title: title.slice(0, 300) };
  const set = <K extends keyof PageMetadata>(k: K, v: PageMetadata[K] | undefined) => { if (v) meta[k] = v; };
  set("description", metaContent(head, doc, "description", "og:description", "twitter:description")?.slice(0, 1000));
  set("keywords", metaContent(head, doc, "keywords")?.slice(0, 500));
  set("author", metaContent(head, doc, "author", "article:author"));
  set("language", htmlEl?.attribs["lang"]);
  set("canonical", canonicalEl?.attribs["href"] ? normalizeUrl(canonicalEl.attribs["href"], pageUrl) ?? undefined : undefined);
  set("image", image ? normalizeUrl(image, pageUrl) ?? undefined : undefined);
  set("siteName", metaContent(head, doc, "og:site_name"));
  set("published", metaContent(head, doc, "article:published_time", "datepublished", "date", "dc.date"));
  set("type", metaContent(head, doc, "og:type"));
  return meta;
}

function isHidden(el: Element): boolean {
  if ("hidden" in el.attribs) return true;
  const style = (el.attribs["style"] ?? "").toLowerCase().replace(/\s+/g, "");
  if (/display:none|visibility:hidden/.test(style)) return true;
  // aria-hidden on a container usually hides decorative duplicates (icons, mobile menus).
  return el.attribs["aria-hidden"] === "true" && !findFirst(el, (e) => e.name === "img" && !!e.attribs["alt"]);
}

function dims(el: Element): { width?: number; height?: number } {
  const w = Number.parseInt(el.attribs["width"] ?? "", 10);
  const h = Number.parseInt(el.attribs["height"] ?? "", 10);
  return { ...(Number.isFinite(w) ? { width: w } : {}), ...(Number.isFinite(h) ? { height: h } : {}) };
}

function imageSource(el: Element): string | undefined {
  const lazy = el.attribs["data-src"] ?? el.attribs["data-lazy-src"] ?? el.attribs["data-original"];
  const src = el.attribs["src"];
  if (lazy && (!src || src.startsWith("data:"))) return lazy;
  if (src && !src.startsWith("data:")) return src;
  const srcset = el.attribs["srcset"] ?? el.attribs["data-srcset"];
  if (srcset) return srcset.split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).pop();
  return undefined;
}

/** Nearby text that describes an image: figcaption, then the parent's text (≤ 30 words). */
function imageDescription(el: Element): string {
  let p: AnyNode | null = el.parent;
  for (let depth = 0; p && depth < 3; depth++, p = p.parent) {
    if (isTag(p)) {
      const cap = findFirst(p, (e) => e.name === "figcaption");
      if (cap) return cleanText(cap).slice(0, 300);
      const t = cleanText(p);
      if (t) return t.split(" ").slice(0, 30).join(" ");
    }
  }
  return "";
}

function tableFrom(el: Element): PageTable | null {
  const rows = elementsOf(el, (e) => e.name === "tr").filter((tr) => {
    // Skip rows of nested tables.
    let p = tr.parent;
    while (p && p !== el) { if (isTag(p) && p.name === "table") return false; p = p.parent; }
    return true;
  });
  if (rows.length < 2) return null;
  const cells = rows.map((tr) => tr.children.filter((c): c is Element => isTag(c) && (c.name === "td" || c.name === "th")));
  const headerRow = cells[0]!.some((c) => c.name === "th") ? cells.shift()!.map((c) => cleanText(c)) : [];
  const body = cells.map((r) => r.map((c) => cleanText(c))).filter((r) => r.some(Boolean));
  const cols = Math.max(headerRow.length, ...body.map((r) => r.length));
  if (cols < 2 || !body.length) return null;
  const caption = findFirst(el, (e) => e.name === "caption");
  return { ...(caption ? { caption: cleanText(caption) } : {}), headers: headerRow, rows: body.slice(0, 200) };
}

export function scrapeHtml(html: string, pageUrl: string, opts: ScrapeOptions = {}): ScrapeResult {
  const doc = parseHtml(html);
  const metadata = extractMetadata(doc, pageUrl);
  const baseEl = findFirst(headOf(doc) ?? doc, (e) => e.name === "base" && !!e.attribs["href"]);
  const baseHref = (baseEl && parseHttpUrl(baseEl.attribs["href"]!, pageUrl)?.toString()) || pageUrl;
  const pageHost = parseHttpUrl(pageUrl)?.hostname ?? "";
  const pageBase = baseDomain(pageHost);

  let root: ParentNode = bodyOf(doc);
  removeComments(root);
  const drop = new Set([...ALWAYS_REMOVE, ...CONTROLS, ...(opts.removeChrome ? CHROME : []), ...(opts.removeForms ? ["form"] : []), ...(opts.excludedTags ?? []).map((t) => t.toLowerCase())]);
  removeAll(elementsOf(root, (e) => drop.has(e.name) || isHidden(e)));
  if (opts.excludedSelector) removeAll(select(opts.excludedSelector, root));

  if (opts.cssSelector) {
    const picked = select(opts.cssSelector, root).filter((el, _, all) => !all.some((o) => o !== el && contains(o, el)));
    const wrapper = parseHtml(`<div data-c4a-selection></div>`);
    const holder = findFirst(wrapper, (e) => e.name === "div")!;
    for (const el of picked) {
      if (el.parent && hasChildren(el.parent)) el.parent.children.splice(el.parent.children.indexOf(el), 1);
      el.parent = holder;
      el.prev = holder.children[holder.children.length - 1] ?? null;
      if (el.prev) el.prev.next = el;
      el.next = null;
      holder.children.push(el);
    }
    root = holder;
  }

  // ---- links
  const internal = new Map<string, PageLink>();
  const external = new Map<string, PageLink>();
  const doomedLinks: Element[] = [];
  for (const a of elementsOf(root, (e) => e.name === "a")) {
    const raw = (a.attribs["href"] ?? "").trim();
    if (!raw || /^(javascript|mailto|tel|sms|data):/i.test(raw) || raw.startsWith("#")) {
      if (raw.startsWith("#") || /^javascript:/i.test(raw)) delete a.attribs["href"];
      continue;
    }
    const href = normalizeUrl(raw, baseHref);
    if (!href) { delete a.attribs["href"]; continue; }
    const u = new URL(href);
    const isInt = baseDomain(u.hostname) === pageBase;
    if (!isInt && (opts.excludeExternalLinks || (opts.excludeSocialMediaLinks && isSocialMediaUrl(href)))) {
      doomedLinks.push(a);
      continue;
    }
    a.attribs["href"] = href;
    const entry: PageLink = { href, text: cleanText(a).slice(0, 200), baseDomain: baseDomain(u.hostname), ...(a.attribs["title"] ? { title: a.attribs["title"] } : {}) };
    const bucket = isInt ? internal : external;
    const prev = bucket.get(href);
    if (!prev || (!prev.text && entry.text)) bucket.set(href, entry);
  }
  removeAll(doomedLinks);

  // ---- media
  const imgs = elementsOf(root, (e) => e.name === "img");
  const images: PageImage[] = [];
  const seenImg = new Set<string>();
  const threshold = opts.imageScoreThreshold ?? 2;
  imgs.forEach((img, index) => {
    const rawSrc = imageSource(img);
    const src = rawSrc ? normalizeUrl(rawSrc, baseHref) : null;
    if (!src) { removeAll([img]); return; }
    img.attribs["src"] = src;
    delete img.attribs["srcset"];
    const d = dims(img);
    if ((d.width !== undefined && d.width <= 2) || (d.height !== undefined && d.height <= 2)) { removeAll([img]); return; }
    const isExternal = baseDomain(new URL(src).hostname) !== pageBase;
    if (isExternal && opts.excludeExternalImages) { removeAll([img]); return; }
    const alt = (img.attribs["alt"] ?? "").trim();
    let score = 0;
    if ((d.width ?? 0) > 150 || (d.height ?? 0) > 150) score++;
    if (alt) score++;
    if (IMAGE_FORMATS.test(src)) score++;
    if (index < Math.ceil(imgs.length / 2)) score++;
    if (!/logo|icon|sprite|avatar|badge|pixel|spacer|tracking/i.test(src)) score++;
    if (score < threshold || seenImg.has(src)) return;
    seenImg.add(src);
    images.push({ src, alt, desc: imageDescription(img), score, ...d });
  });
  const mediaOf = (tag: "video" | "audio") =>
    elementsOf(root, (e) => e.name === tag).flatMap((el) => {
      const srcs = [el.attribs["src"], ...elementsOf(el, (s) => s.name === "source").map((s) => s.attribs["src"])].filter(Boolean) as string[];
      return srcs.map((s) => normalizeUrl(s, baseHref)).filter((s): s is string => !!s).map((src) => ({ src, ...(el.attribs["title"] ? { title: el.attribs["title"] } : {}) }));
    });
  const media: PageMedia = { images: images.sort((a, b) => b.score - a.score).slice(0, 60), videos: mediaOf("video"), audios: mediaOf("audio") };

  // ---- tables (before pruning so data tables survive)
  const tables = elementsOf(root, (e) => e.name === "table").map(tableFrom).filter((t): t is PageTable => !!t).slice(0, 20);

  // ---- word threshold + empty element pruning
  const minWords = Math.max(1, opts.wordCountThreshold ?? 1);
  pruneSmallBlocks(root, minWords);

  // ---- attribute cleanup
  for (const el of elementsOf(root)) {
    const keepClass = el.name === "pre" || el.name === "code";
    for (const name of Object.keys(el.attribs)) {
      if (!KEEP_ATTRS.has(name) && !(keepClass && CODE_ATTRS.has(name))) delete el.attribs[name];
    }
  }

  const cleanedHtml = outerHtml(root.children);
  return { metadata, cleanedHtml, root, links: { internal: [...internal.values()], external: [...external.values()] }, media, tables, wordCount: wordCount(cleanText(root)) };
}

function contains(ancestor: AnyNode, node: AnyNode): boolean {
  for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

/** Removes empty elements and (for threshold > 1) small leaf text blocks, bottom-up. */
function pruneSmallBlocks(root: ParentNode, minWords: number) {
  const visit = (node: ParentNode) => {
    for (const child of [...node.children]) {
      if (!isTag(child)) continue;
      visit(child);
      if (MEDIA_TAGS.has(child.name)) continue;
      const hasMedia = !!findFirst(child, (e) => MEDIA_TAGS.has(e.name));
      if (hasMedia) continue;
      const t = cleanText(child);
      if (!t) { removeAll([child]); continue; }
      if (minWords > 1 && BLOCK_PRUNE.has(child.name) && wordCount(t) < minWords && !child.children.some(isTag) && !/^h[1-6]$/.test(child.name)) {
        removeAll([child]);
      }
    }
  };
  visit(root);
  // Collapse whitespace-only text nodes left at the top level.
  for (const c of [...root.children]) if (isText(c) && !c.data.trim() && root.children.length > 1) removeAll([c]);
}
