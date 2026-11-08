/**
 * Small DOM toolkit over htmlparser2/domhandler (pure JS, runs in the edge server and tests).
 * Crawl4AI uses BeautifulSoup/lxml; these helpers give the ported strategies the same primitives.
 */
import { parseDocument } from "htmlparser2";
import { cloneNode, hasChildren, isComment, isTag, isText, type AnyNode, type ChildNode, type Document, type Element, type ParentNode } from "domhandler";
import render from "dom-serializer";
import { removeElement, textContent } from "domutils";
import { selectAll, selectOne } from "css-select";

export type { AnyNode, ChildNode, Document, Element, ParentNode };
export { cloneNode, hasChildren, isComment, isTag, isText, removeElement };

export function parseHtml(html: string): Document {
  return parseDocument(html, { lowerCaseTags: true, lowerCaseAttributeNames: true, decodeEntities: true });
}

/** The <body> element, or the document itself for fragments. */
export function bodyOf(doc: Document): ParentNode {
  return findFirst(doc, (el) => el.name === "body") ?? doc;
}

export function headOf(doc: Document): ParentNode | null {
  return findFirst(doc, (el) => el.name === "head");
}

export function findFirst(root: AnyNode, test: (el: Element) => boolean): Element | null {
  const stack: AnyNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (isTag(node) && node !== root && test(node)) return node;
    if (hasChildren(node)) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return null;
}

/** Every element under root (document order), excluding root itself. */
export function elementsOf(root: AnyNode, test?: (el: Element) => boolean): Element[] {
  const out: Element[] = [];
  const stack: AnyNode[] = hasChildren(root) ? [...root.children].reverse() : [];
  while (stack.length) {
    const node = stack.pop()!;
    if (isTag(node)) {
      if (!test || test(node)) out.push(node);
    }
    if (hasChildren(node)) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return out;
}

export function text(node: AnyNode | AnyNode[]): string {
  return textContent(node);
}

/** Text with runs of whitespace collapsed, like BeautifulSoup get_text(strip=True) joined by spaces. */
export function cleanText(node: AnyNode | AnyNode[]): string {
  return textContent(node).replace(/\s+/g, " ").trim();
}

export function attr(el: Element, name: string): string | undefined {
  const v = el.attribs[name];
  return v === undefined ? undefined : v;
}

export function classIdString(el: Element): string {
  return [el.attribs["class"] ?? "", el.attribs["id"] ?? ""].filter(Boolean).join(" ");
}

export function outerHtml(node: AnyNode | AnyNode[]): string {
  return render(node as AnyNode, { encodeEntities: "utf8", decodeEntities: true });
}

export function innerHtml(node: ParentNode): string {
  return render(node.children, { encodeEntities: "utf8", decodeEntities: true });
}

export function select(selector: string, root: AnyNode | AnyNode[]): Element[] {
  try {
    return selectAll(selector, root as AnyNode) as Element[];
  } catch {
    return [];
  }
}

export function selectFirst(selector: string, root: AnyNode | AnyNode[]): Element | null {
  try {
    return selectOne(selector, root as AnyNode) as Element | null;
  } catch {
    return null;
  }
}

/** Validates a CSS selector without throwing (used for user-supplied selectors). */
export function isValidSelector(selector: string): boolean {
  try {
    selectAll(selector, parseHtml("<div></div>"));
    return true;
  } catch {
    return false;
  }
}

export function removeAll(nodes: AnyNode[]) {
  for (const n of nodes) if (n.parent) removeElement(n as ChildNode);
}

/** Removes comments anywhere under root. */
export function removeComments(root: AnyNode) {
  const doomed: ChildNode[] = [];
  const stack: AnyNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (isComment(node)) doomed.push(node);
    else if (hasChildren(node)) for (const c of node.children) stack.push(c);
  }
  removeAll(doomed);
}
