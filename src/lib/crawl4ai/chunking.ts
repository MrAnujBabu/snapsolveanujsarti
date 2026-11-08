/**
 * Chunking strategies ported from Crawl4AI: merge_chunks (token-budgeted word chunks with overlap,
 * used by LLMExtractionStrategy / LLMContentFilter), RegexChunking and a section-aware markdown
 * splitter that keeps headings with their text so AI chunks stay readable.
 */
import { CHUNK_TOKEN_THRESHOLD, OVERLAP_RATE, WORD_TOKEN_RATE } from "./text";

/** Port of utils.merge_chunks: distributes words into ~target-token chunks with overlapping tail words. */
export function mergeChunks(docs: string[], targetSize: number, overlap = 0, wordTokenRatio = 1): string[] {
  const allTokens: string[] = [];
  let totalTokens = 0;
  for (const doc of docs) {
    const tokens = doc.split(/\s+/).filter(Boolean);
    const count = Math.floor(tokens.length * wordTokenRatio);
    if (count) {
      allTokens.push(...tokens);
      totalTokens += count;
    }
  }
  if (!totalTokens) return [];
  const numChunks = Math.max(1, Math.ceil(totalTokens / targetSize));
  const chunks: string[][] = Array.from({ length: numChunks }, () => []);
  let current = 0;
  let size = 0;
  for (const token of allTokens) {
    if (size >= targetSize && current < numChunks - 1) {
      if (overlap > 0) {
        const tail = chunks[current]!.slice(-overlap);
        current += 1;
        chunks[current]!.push(...tail);
        size = tail.length;
      } else {
        current += 1;
        size = 0;
      }
    }
    chunks[current]!.push(token);
    size += 1;
  }
  return chunks.filter((c) => c.length).map((c) => c.join(" "));
}

/** RegexChunking: split on blank lines (paragraphs) by default. */
export function regexChunks(text: string, patterns: RegExp[] = [/\n\n+/]): string[] {
  let parts = [text];
  for (const p of patterns) parts = parts.flatMap((t) => t.split(p));
  return parts.map((t) => t.trim()).filter(Boolean);
}

/**
 * Markdown-aware chunking for LLM steps: keeps lines intact, prefers to break before headings,
 * and carries an overlap of trailing lines (≈ OVERLAP_RATE) into the next chunk.
 */
export function chunkMarkdown(markdown: string, tokenThreshold = CHUNK_TOKEN_THRESHOLD, overlapRate = OVERLAP_RATE): string[] {
  const lines = markdown.split("\n");
  const wordsPerChunk = Math.max(50, Math.floor(tokenThreshold / WORD_TOKEN_RATE));
  const overlapWords = Math.floor(wordsPerChunk * overlapRate);
  const chunks: string[] = [];
  let current: string[] = [];
  let words = 0;
  const flush = () => {
    const body = current.join("\n").trim();
    if (body) chunks.push(body);
    const tail: string[] = [];
    let tailWords = 0;
    for (let i = current.length - 1; i >= 0 && tailWords < overlapWords; i--) {
      tail.unshift(current[i]!);
      tailWords += current[i]!.split(/\s+/).filter(Boolean).length;
    }
    current = overlapWords ? tail : [];
    words = overlapWords ? tailWords : 0;
  };
  for (const line of lines) {
    const n = line.split(/\s+/).filter(Boolean).length;
    const heading = /^#{1,6}\s/.test(line);
    if (words > 0 && (words + n > wordsPerChunk || (heading && words > wordsPerChunk * 0.6))) flush();
    if (n > wordsPerChunk) {
      // A single giant line (minified text): fall back to word chunks.
      for (const piece of mergeChunks([line], tokenThreshold, Math.floor(tokenThreshold * overlapRate), WORD_TOKEN_RATE)) {
        current.push(piece);
        words += piece.split(/\s+/).length;
        flush();
      }
      continue;
    }
    current.push(line);
    words += n;
  }
  if (current.join("").trim() && (chunks.length === 0 || words > overlapWords)) {
    const body = current.join("\n").trim();
    if (body) chunks.push(body);
  }
  return chunks;
}
