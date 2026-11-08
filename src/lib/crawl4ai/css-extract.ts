/**
 * JsonCssExtractionStrategy port: structured extraction with a CSS schema and no AI at all.
 * Supports field types text / attribute / html / regex (or a pipeline of them), nested, list and
 * nested_list, baseFields, defaults and simple transforms. `computed` fields are intentionally not
 * supported (upstream evaluates code strings).
 */
import { cleanText, outerHtml, parseHtml, select, selectFirst, type AnyNode, type Element } from "./dom";
import { normalizeUrl } from "./url";

export type CssFieldType = "text" | "attribute" | "html" | "regex" | "nested" | "list" | "nested_list";

export type CssField = {
  name: string;
  selector?: string;
  type: CssFieldType | Array<"text" | "attribute" | "html" | "regex">;
  attribute?: string;
  pattern?: string;
  group?: number;
  default?: unknown;
  transform?: "lowercase" | "uppercase" | "strip" | "number";
  fields?: CssField[];
};

export type CssSchema = { name?: string; baseSelector: string; baseFields?: CssField[]; fields: CssField[] };

const URL_ATTRS = new Set(["href", "src", "data-src", "poster", "action"]);

function transform(value: unknown, t: CssField["transform"]): unknown {
  if (typeof value !== "string" || !t) return value;
  if (t === "lowercase") return value.toLowerCase();
  if (t === "uppercase") return value.toUpperCase();
  if (t === "strip") return value.trim();
  if (t === "number") {
    const n = Number(value.replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return value;
}

function single(el: Element, field: CssField, baseUrl?: string): unknown {
  let target: Element | null = el;
  if (field.selector) target = selectFirst(field.selector, el);
  if (!target) return field.default ?? null;
  const pipeline = Array.isArray(field.type) ? field.type : [field.type];
  let value: unknown = target;
  for (const step of pipeline) {
    if (step === "text") value = typeof value === "string" ? value : cleanText(value as AnyNode);
    else if (step === "attribute") {
      const raw = (value as Element).attribs?.[field.attribute ?? ""];
      value = raw === undefined ? null : URL_ATTRS.has(field.attribute ?? "") && baseUrl ? normalizeUrl(raw, baseUrl) ?? raw : raw;
    } else if (step === "html") value = outerHtml(value as AnyNode);
    else if (step === "regex") {
      const str = typeof value === "string" ? value : cleanText(value as AnyNode);
      let m: RegExpMatchArray | null = null;
      try { m = field.pattern ? str.match(new RegExp(field.pattern)) : null; } catch { m = null; }
      value = m ? m[field.group ?? 1] ?? m[0] : null;
    }
    if (value === null || value === undefined) break;
  }
  value = transform(value, field.transform);
  return value === null || value === undefined || value === "" ? field.default ?? null : value;
}

function item(el: Element, fields: CssField[], baseUrl?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = fieldValue(el, f, baseUrl);
    if (v !== null && v !== undefined) out[f.name] = v;
  }
  return out;
}

function fieldValue(el: Element, f: CssField, baseUrl?: string): unknown {
  try {
    if (f.type === "nested") {
      const n = f.selector ? selectFirst(f.selector, el) : el;
      return n ? item(n, f.fields ?? [], baseUrl) : f.default ?? null;
    }
    if (f.type === "list") {
      const els = f.selector ? select(f.selector, el) : [el];
      if (f.fields?.length) return els.map((e) => item(e, f.fields!, baseUrl));
      return els.map((e) => cleanText(e)).filter(Boolean);
    }
    if (f.type === "nested_list") return (f.selector ? select(f.selector, el) : []).map((e) => item(e, f.fields ?? [], baseUrl));
    return single(el, f, baseUrl);
  } catch {
    return f.default ?? null;
  }
}

export function cssExtract(html: string, schema: CssSchema, baseUrl?: string, limit = 500): Record<string, unknown>[] {
  const doc = parseHtml(html);
  const bases = select(schema.baseSelector, doc).slice(0, limit);
  const out: Record<string, unknown>[] = [];
  for (const base of bases) {
    const row = { ...item(base, schema.baseFields ?? [], baseUrl), ...item(base, schema.fields, baseUrl) };
    if (Object.keys(row).length) out.push(row);
  }
  return out;
}

/** Validates an untrusted schema object (from the user or the AI). Returns an error message or null. */
export function validateCssSchema(raw: unknown, depth = 0): string | null {
  if (!raw || typeof raw !== "object") return "The schema must be a JSON object.";
  const s = raw as Partial<CssSchema>;
  if (depth === 0 && (typeof s.baseSelector !== "string" || !s.baseSelector.trim())) return "The schema needs a baseSelector.";
  if (!Array.isArray(s.fields) || !s.fields.length) return "The schema needs at least one field.";
  if (s.fields.length > 40) return "Use at most 40 fields.";
  const types = new Set(["text", "attribute", "html", "regex", "nested", "list", "nested_list"]);
  for (const f of [...(s.fields ?? []), ...(s.baseFields ?? [])]) {
    if (!f || typeof f !== "object" || typeof f.name !== "string" || !f.name) return "Every field needs a name.";
    const steps = Array.isArray(f.type) ? f.type : [f.type];
    if (!steps.every((t) => types.has(String(t)))) return `Field "${f.name}" has an unknown type.`;
    if (steps.includes("attribute") && !f.attribute) return `Field "${f.name}" needs an attribute name.`;
    if (f.pattern) { try { new RegExp(f.pattern); } catch { return `Field "${f.name}" has an invalid pattern.`; } }
    if (f.fields && depth < 3) {
      const nested = validateCssSchema({ baseSelector: "x", fields: f.fields }, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** Structure-only HTML sample for schema generation: no scripts, short text, class/id kept. */
export function structuralSample(html: string, maxChars = 40000): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/\s(on\w+|style|data-(?!src)[\w-]+|aria-[\w-]+|role|tabindex|srcset|sizes|loading|decoding|integrity|crossorigin)=("[^"]*"|'[^']*'|\S+)/gi, "")
    .replace(/>([^<]{80})[^<]+</g, ">$1…<")
    .replace(/\s{2,}/g, " ")
    .slice(0, maxChars);
}
