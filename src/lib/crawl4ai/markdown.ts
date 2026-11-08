/**
 * Port of Crawl4AI's DefaultMarkdownGenerator: HTML → Markdown (html2text options body_width=0,
 * single_line_break, mark_code), links → numbered citations ⟨n⟩ with a "## References" block,
 * and "fit markdown" from a content filter's selected blocks.
 */
import { hasChildren, isTag, isText, parseHtml, bodyOf, text as nodeText, type AnyNode, type Element, type ParentNode } from "./dom";
import { normalizeUrl } from "./url";

export type MarkdownOptions = {
  baseUrl?: string;
  ignoreLinks?: boolean;
  ignoreImages?: boolean;
};

export type MarkdownResult = {
  rawMarkdown: string;
  markdownWithCitations: string;
  referencesMarkdown: string;
  fitMarkdown: string;
  fitHtml: string;
};

const BLOCK = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "figure", "figcaption", "address", "center", "form",
  "fieldset", "legend", "details", "summary", "body", "html", "hgroup", "search", "caption",
]);
const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

type Ctx = { opts: MarkdownOptions; code: string[]; inPre: boolean; inTable: boolean; listDepth: number };

const codeToken = (i: number) => `\u0000C${i}\u0000`;

function joinChunks(chunks: string[]): string {
  let out = "";
  for (let chunk of chunks) {
    if (!chunk) continue;
    if (!out || out.endsWith("\n")) chunk = chunk.replace(/^[ \t]+/, "");
    if (out.endsWith(" ") && chunk.startsWith(" ")) chunk = chunk.slice(1);
    out += chunk;
  }
  return out;
}

function block(content: string): string {
  const t = content.trim();
  return t ? `\n\n${t}\n\n` : "";
}

function wrapInline(inner: string, mark: string): string {
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner;
}

function children(node: ParentNode, ctx: Ctx): string {
  return joinChunks(node.children.map((c) => renderNode(c, ctx)));
}

function resolve(href: string | undefined, ctx: Ctx): string | null {
  if (!href) return null;
  if (/^(mailto|tel):/i.test(href)) return href;
  return ctx.opts.baseUrl ? normalizeUrl(href, ctx.opts.baseUrl) : /^https?:/i.test(href) ? href : null;
}

function codeLanguage(el: Element): string {
  const classes = `${el.attribs["class"] ?? ""} ${el.children.filter(isTag).map((c) => c.attribs["class"] ?? "").join(" ")}`;
  return classes.match(/(?:language|lang)-([\w+#-]+)/)?.[1] ?? "";
}

function renderTable(table: Element, ctx: Ctx): string {
  const rows: string[][] = [];
  let headerRows = 0;
  const walkRows = (node: ParentNode, inHead: boolean) => {
    for (const c of node.children) {
      if (!isTag(c)) continue;
      if (c.name === "table") continue; // nested tables are flattened as text by their cell
      if (c.name === "thead") walkRows(c, true);
      else if (c.name === "tbody" || c.name === "tfoot") walkRows(c, false);
      else if (c.name === "tr") {
        const cells: string[] = [];
        let allTh = true;
        for (const cell of c.children) {
          if (!isTag(cell) || (cell.name !== "td" && cell.name !== "th")) continue;
          if (cell.name !== "th") allTh = false;
          const content = renderInlineCell(cell, ctx);
          cells.push(content);
          const span = Math.min(10, Number.parseInt(cell.attribs["colspan"] ?? "1", 10) || 1);
          for (let i = 1; i < span; i++) cells.push("");
        }
        if (!cells.length) continue;
        if ((inHead || (allTh && rows.length === headerRows)) && rows.length === headerRows) headerRows++;
        rows.push(cells);
      }
    }
  };
  walkRows(table, false);
  if (!rows.length) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols === 1 && rows.length <= 2) return block(rows.map((r) => r[0]).join("\n\n"));
  const pad = (r: string[]) => [...r, ...new Array(cols - r.length).fill("")];
  const header = headerRows > 0 ? pad(rows[0]!) : new Array(cols).fill("");
  const body = (headerRows > 0 ? rows.slice(1) : rows).map(pad);
  const line = (r: string[]) => `| ${r.join(" | ")} |`;
  const captionEl = table.children.find((c): c is Element => isTag(c) && c.name === "caption");
  const caption = captionEl ? `**${renderInlineCell(captionEl, ctx)}**\n\n` : "";
  return block(caption + [line(header), line(new Array(cols).fill("---")), ...body.map(line)].join("\n"));
}

function renderInlineCell(cell: Element, ctx: Ctx): string {
  const inner = children(cell, { ...ctx, inTable: true });
  return inner.replace(/\u0000C(\d+)\u0000/g, (_, i) => `\`${(ctx.code[Number(i)] ?? "").replace(/\n/g, " ")}\``)
    .replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|").trim();
}

function renderList(list: Element, ctx: Ctx): string {
  const ordered = list.name === "ol";
  let n = Number.parseInt(list.attribs["start"] ?? "1", 10);
  if (!Number.isFinite(n)) n = 1;
  const items: string[] = [];
  for (const c of list.children) {
    if (!isTag(c)) {
      if (isText(c) && c.data.trim()) items.push(`- ${c.data.trim()}`);
      continue;
    }
    if (c.name === "ul" || c.name === "ol") { items.push(renderList(c, { ...ctx, listDepth: ctx.listDepth + 1 }).trim()); continue; }
    const marker = ordered ? `${n++}. ` : "- ";
    const body = children(c, { ...ctx, listDepth: ctx.listDepth + 1 }).replace(/\n{3,}/g, "\n\n").trim();
    if (!body) continue;
    const indent = " ".repeat(marker.length);
    items.push(marker + body.split("\n").map((l, i) => (i === 0 || !l ? l : indent + l)).join("\n"));
  }
  if (!items.length) return "";
  const joined = items.join("\n");
  return ctx.listDepth > 0 ? `\n${joined}\n` : block(joined);
}

function renderNode(node: AnyNode, ctx: Ctx): string {
  if (isText(node)) {
    if (ctx.inPre) return node.data;
    return node.data.replace(/\s+/g, " ");
  }
  if (!isTag(node)) return "";
  const el = node;
  const tag = el.name;
  const level = HEADINGS[tag];
  if (level) {
    const inner = children(el, ctx).replace(/\s+/g, " ").trim();
    return ctx.inTable ? inner : inner ? `\n\n${"#".repeat(level)} ${inner}\n\n` : "";
  }
  switch (tag) {
    case "br":
      return ctx.inTable ? " " : "\n";
    case "hr":
      return "\n\n---\n\n";
    case "strong":
    case "b":
      return wrapInline(children(el, ctx), "**");
    case "em":
    case "i":
    case "cite":
    case "dfn":
      return wrapInline(children(el, ctx), "*");
    case "del":
    case "s":
    case "strike":
      return wrapInline(children(el, ctx), "~~");
    case "sup": {
      const inner = children(el, ctx).trim();
      return inner ? `^${inner.length > 1 && !/^[\w+\-−]+$/.test(inner) ? `(${inner})` : inner}` : "";
    }
    case "sub":
      return children(el, ctx);
    case "q":
      return `“${children(el, ctx).trim()}”`;
    case "code":
    case "kbd":
    case "samp":
    case "tt": {
      if (ctx.inPre) return nodeText(el);
      const raw = nodeText(el).replace(/\s+/g, " ");
      if (!raw.trim()) return "";
      const fence = raw.includes("`") ? "``" : "`";
      return `${fence}${raw}${fence}`;
    }
    case "pre": {
      const raw = nodeText(el).replace(/^\n+|\s+$/g, "");
      if (!raw.trim()) return "";
      const lang = codeLanguage(el);
      const fence = raw.includes("```") ? "````" : "```";
      ctx.code.push(raw);
      return `\n\n${fence}${lang}\n${codeToken(ctx.code.length - 1)}\n${fence}\n\n`;
    }
    case "blockquote": {
      const inner = children(el, ctx).replace(/\n{3,}/g, "\n\n").trim();
      return inner ? block(inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")) : "";
    }
    case "ul":
    case "ol":
    case "menu":
      return renderList(el, ctx);
    case "li":
      return block(`- ${children(el, ctx).trim()}`);
    case "dl": {
      const parts: string[] = [];
      for (const c of el.children) {
        if (!isTag(c)) continue;
        const inner = children(c, ctx).trim();
        if (!inner) continue;
        parts.push(c.name === "dt" ? `**${inner.replace(/\s+/g, " ")}**` : `: ${inner}`);
      }
      return block(parts.join("\n"));
    }
    case "table":
      return ctx.inTable ? children(el, ctx) : renderTable(el, ctx);
    case "a": {
      const inner = children(el, ctx);
      const href = ctx.opts.ignoreLinks ? null : resolve(el.attribs["href"], ctx);
      const label = inner.replace(/\s+/g, " ").trim();
      if (!href || !label) return inner;
      if (/^!\[/.test(label)) return `[${label}](${href})`;
      const title = el.attribs["title"]?.replace(/"/g, "'").trim();
      return `${inner.match(/^\s*/)![0]}[${label.replace(/[[\]]/g, "\\$&")}](${href}${title && title !== label ? ` "${title}"` : ""})${inner.match(/\s*$/)![0]}`;
    }
    case "img": {
      if (ctx.opts.ignoreImages) return "";
      const src = resolve(el.attribs["src"], ctx);
      if (!src) return "";
      const alt = (el.attribs["alt"] ?? "").replace(/[[\]\n]/g, " ").trim();
      return `![${alt}](${src})`;
    }
    case "summary":
      return block(`**${children(el, ctx).trim()}**`);
    case "picture":
    case "span":
    case "label":
    case "small":
    case "mark":
    case "abbr":
    case "time":
    case "u":
    case "ins":
    case "font":
    case "big":
    case "bdi":
    case "bdo":
    case "data":
    case "var":
    case "wbr":
    case "nobr":
      return children(el, ctx);
    default:
      if (BLOCK.has(tag) || tag === "td" || tag === "th" || tag === "tr" || tag === "tbody" || tag === "thead") return block(children(el, ctx));
      return hasChildren(el) ? children(el, ctx) : "";
  }
}

function finalize(md: string, code: string[]): string {
  return md
    .split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000C(\d+)\u0000/g, (_, i) => code[Number(i)] ?? "")
    .trim();
}

/** HTML string or DOM nodes → Markdown. */
export function htmlToMarkdown(input: string | ParentNode | AnyNode[], opts: MarkdownOptions = {}): string {
  const ctx: Ctx = { opts, code: [], inPre: false, inTable: false, listDepth: 0 };
  let out: string;
  if (typeof input === "string") out = children(bodyOf(parseHtml(input)), ctx);
  else if (Array.isArray(input)) out = joinChunks(input.map((n) => renderNode(n, ctx)));
  else out = children(input, ctx);
  return finalize(out, ctx.code);
}

// Pattern from markdown_generation_strategy.LINK_PATTERN (nested brackets, optional "title").
const LINK_PATTERN = /!?\[((?:[^[\]]|\[(?:[^[\]]|\[[^\]]*\])*\])*)\]\(((?:[^()\s]|\([^()]*\))*)(?:\s+"([^"]*)")?\)/g;

/** convert_links_to_citations: `[text](url)` → `text⟨n⟩`, references listed once per URL in first-seen order. */
export function convertLinksToCitations(markdown: string, baseUrl = ""): { markdown: string; references: string } {
  const linkMap = new Map<string, { num: number; desc: string }>();
  let counter = 1;
  const converted = markdown.replace(LINK_PATTERN, (match, text: string, rawUrl: string, title: string | undefined) => {
    let url = rawUrl;
    if (baseUrl && !/^(https?:|mailto:)/i.test(url)) url = normalizeUrl(url, baseUrl) ?? url;
    if (!linkMap.has(url)) {
      const desc = [title, text && text !== title ? text : undefined].filter(Boolean).join(" - ");
      linkMap.set(url, { num: counter++, desc: desc ? `: ${desc}` : "" });
    }
    const num = linkMap.get(url)!.num;
    return match.startsWith("!") ? `![${text}⟨${num}⟩]` : `${text}⟨${num}⟩`;
  });
  if (!linkMap.size) return { markdown: converted, references: "" };
  const refs = [...linkMap.entries()].sort((a, b) => a[1].num - b[1].num).map(([url, { num, desc }]) => `⟨${num}⟩ ${url}${desc}`);
  return { markdown: converted, references: `\n\n## References\n\n${refs.join("\n")}\n` };
}

export function generateMarkdown(
  input: string | ParentNode,
  opts: MarkdownOptions & { citations?: boolean; filtered?: string[] | null } = {},
): MarkdownResult {
  const rawMarkdown = htmlToMarkdown(input, opts);
  let markdownWithCitations = rawMarkdown;
  let referencesMarkdown = "";
  if (opts.citations !== false) {
    const c = convertLinksToCitations(rawMarkdown, opts.baseUrl);
    markdownWithCitations = c.markdown;
    referencesMarkdown = c.references;
  }
  let fitHtml = "";
  let fitMarkdown = "";
  if (opts.filtered && opts.filtered.length) {
    fitHtml = opts.filtered.map((s) => `<div>${s}</div>`).join("\n");
    fitMarkdown = htmlToMarkdown(fitHtml, opts);
  }
  return { rawMarkdown, markdownWithCitations, referencesMarkdown, fitMarkdown, fitHtml };
}
