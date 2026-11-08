/**
 * Crawl4AI's LLMConfig / perform_completion_with_backoff, routed through the Lovable AI Gateway SDK
 * so every AI step is billed to the workspace's Lovable AI credits. All calls stream (final text is
 * consumed server-side), never auto-replay billed work, honour Stop, track TokenUsage, and feed the
 * app's shared credits/denial pause so a 402 pauses every AI feature consistently.
 */
import {
  AuthenticationError, CancelledError, ConfigurationError, GatewayError, PaymentRequiredError, PermissionDeniedError, RateLimitError,
  RequestRejectedError, streamResponse,
} from "@lovable.dev/ai-gateway";
import { classifyAiFailure } from "@/lib/ai/errors";
import { getAiPause, noteAiSuccess, setAiPause } from "@/lib/ai/pause.server";

export const CRAWL_MODEL = "openai/gpt-6-astra" as const;

export type AiErrorKind = "credits" | "denied" | "configuration" | "rate_limited" | "cancelled" | "refused" | "invalid" | "failed";

export class CrawlAiError extends Error {
  constructor(public kind: AiErrorKind, message: string, public status: number, public retryAfter?: number) {
    super(message);
    this.name = "CrawlAiError";
  }
}

export type TokenUsage = { calls: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number; webSearches: number };

export class UsageMeter {
  usage: TokenUsage = { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, webSearches: 0 };
  add(raw: unknown, webSearches = 0) {
    const u = (raw ?? {}) as { input_tokens?: number; output_tokens?: number; total_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } };
    this.usage.calls += 1;
    this.usage.inputTokens += u.input_tokens ?? 0;
    this.usage.cachedInputTokens += u.input_tokens_details?.cached_tokens ?? 0;
    this.usage.outputTokens += u.output_tokens ?? 0;
    this.usage.reasoningTokens += u.output_tokens_details?.reasoning_tokens ?? 0;
    this.usage.totalTokens += u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    this.usage.webSearches += webSearches;
  }
  snapshot(): TokenUsage {
    return { ...this.usage };
  }
}

/** Throws when the shared AI pause (credits or a provider denial) is active. */
export async function assertAiAvailable(): Promise<void> {
  const [workspace, model] = await Promise.all([getAiPause(), getAiPause(CRAWL_MODEL)]);
  const paused = workspace ?? model;
  if (paused) throw new CrawlAiError(paused.kind === "credits" ? "credits" : "denied", paused.message, paused.kind === "credits" ? 402 : 403);
}

/** Maps SDK errors to app errors and records credits/denial pauses (never key-setup problems). */
export async function toCrawlAiError(error: unknown, signal?: AbortSignal): Promise<CrawlAiError> {
  if (error instanceof CrawlAiError) return error;
  if (error instanceof CancelledError || signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return new CrawlAiError("cancelled", "Stopped.", 499);
  }
  if (error instanceof ConfigurationError || error instanceof AuthenticationError) {
    return new CrawlAiError("configuration", "Lovable AI is not connected for this app. Reconnect Lovable AI in the workspace.", 503);
  }
  if (error instanceof PaymentRequiredError) {
    const failure = classifyAiFailure(402, { error: { message: error.recovery?.message ?? error.message, type: error.remote?.type } });
    await setAiPause(failure);
    return new CrawlAiError("credits", failure.message || "Lovable AI credits are used up. Add credits to keep using AI search.", 402);
  }
  if (error instanceof PermissionDeniedError) {
    const type = error.remote?.type ?? "";
    const failure = classifyAiFailure(403, { error: { message: error.recovery?.message ?? error.message, type } });
    if (failure.kind === "credits") {
      await setAiPause(failure);
      return new CrawlAiError("credits", failure.message, 402);
    }
    if (failure.kind === "configuration") return new CrawlAiError("configuration", failure.message, 503);
    if (!/provider_not_available_in_region|model_requires_retention_consent|model_vendor_not_enabled/.test(type)) await setAiPause(failure, CRAWL_MODEL);
    return new CrawlAiError("denied", failure.message, 403);
  }
  if (error instanceof RateLimitError) {
    return new CrawlAiError("rate_limited", "Lovable AI is busy right now. Wait a minute and try again.", 429, error.retryAfter);
  }
  if (error instanceof RequestRejectedError) {
    console.error("[crawl4ai] AI request rejected", error.message);
    return new CrawlAiError("invalid", "The AI step could not run with this input. Try a shorter page or fewer fields.", 400);
  }
  if (error instanceof GatewayError) {
    console.error("[crawl4ai] AI call failed", error.code, error.message, error.ids);
    return new CrawlAiError("failed", "The AI step did not finish. Your crawl results are still shown.", error.httpStatus && error.httpStatus >= 400 ? error.httpStatus : 503);
  }
  console.error("[crawl4ai] AI step error", error instanceof Error ? error.message : error);
  return new CrawlAiError("failed", "The AI step did not finish. Your crawl results are still shown.", 503);
}

export type WebSearchTool = { allowedDomains?: string[]; contextSize?: "low" | "medium" | "high" };

export type RunOptions = {
  instructions: string;
  input: string;
  effort?: "low" | "medium" | "high";
  /** Strict JSON schema (object root, every property required, additionalProperties:false). */
  schema?: { name: string; schema: Record<string, unknown> };
  webSearch?: WebSearchTool;
  signal?: AbortSignal;
  meter?: UsageMeter;
  onDelta?: (delta: string) => void;
  maxOutputTokens?: number;
};

export type UrlCitation = { url: string; title?: string; start: number; end: number };

export type RunResult = {
  text: string;
  citations: UrlCitation[];
  /** URLs the web_search tool consulted (action.sources and opened pages). */
  sources: string[];
  queries: string[];
  runId?: string;
};

type OutputItem = {
  type?: string;
  action?: { type?: string; query?: string; queries?: string[]; url?: string; sources?: { url?: string }[] };
  content?: Array<{ type?: string; text?: string; refusal?: string; annotations?: Array<{ type?: string; url?: string; title?: string; start_index?: number; end_index?: number }> }>;
};

type FinalResponse = { output?: OutputItem[]; usage?: unknown; status?: string; incomplete_details?: { reason?: string } };

/** One streamed Responses call on Lovable AI. */
export async function runResponse(opts: RunOptions): Promise<RunResult> {
  if (opts.signal?.aborted) throw new CrawlAiError("cancelled", "Stopped.", 499);
  let text = "";
  let final: FinalResponse | null = null;
  let runId: string | undefined;
  try {
    const stream = await streamResponse(
      {
        model: CRAWL_MODEL,
        reasoning: { effort: opts.effort ?? "low" },
        instructions: opts.instructions,
        input: [{ role: "user", content: opts.input }],
        ...(opts.maxOutputTokens ? { max_output_tokens: opts.maxOutputTokens } : {}),
        ...(opts.schema ? { text: { format: { type: "json_schema", name: opts.schema.name, strict: true, schema: opts.schema.schema } } } : {}),
        ...(opts.webSearch
          ? {
              tools: [{ type: "web_search", search_context_size: opts.webSearch.contextSize ?? "low", ...(opts.webSearch.allowedDomains?.length ? { filters: { allowed_domains: opts.webSearch.allowedDomains } } : {}) }],
              include: ["web_search_call.action.sources"],
            }
          : {}),
      },
      // Billed generation is never replayed automatically (a retry could bill twice).
      { maxRetries: 0, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    runId = stream.runId;
    for await (const ev of stream as AsyncIterable<{ type?: string; delta?: string; response?: FinalResponse }>) {
      if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
        text += ev.delta;
        opts.onDelta?.(ev.delta);
      } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
        final = ev.response ?? null;
      }
    }
  } catch (error) {
    throw await toCrawlAiError(error, opts.signal);
  }
  const output = final?.output ?? [];
  const sources: string[] = [];
  const queries: string[] = [];
  const citations: UrlCitation[] = [];
  let searches = 0;
  let refusal = "";
  for (const item of output) {
    if (item.type === "web_search_call") {
      searches += 1;
      const a = item.action ?? {};
      if (a.query) queries.push(a.query);
      for (const q of a.queries ?? []) if (!queries.includes(q)) queries.push(q);
      if (a.url) sources.push(a.url);
      for (const s of a.sources ?? []) if (s.url) sources.push(s.url);
    }
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "refusal" && part.refusal) refusal = part.refusal;
        for (const ann of part.annotations ?? []) {
          if (ann.type === "url_citation" && ann.url) citations.push({ url: ann.url, ...(ann.title ? { title: ann.title } : {}), start: ann.start_index ?? 0, end: ann.end_index ?? 0 });
        }
      }
    }
  }
  opts.meter?.add(final?.usage, searches);
  if (refusal && !text.trim()) throw new CrawlAiError("refused", "The AI declined this request. It has stopped.", 403);
  if (!text.trim() && final?.status === "incomplete") throw new CrawlAiError("failed", "The AI ran out of room before answering. Try a narrower request.", 503);
  void noteAiSuccess();
  return { text, citations, sources, queries, ...(runId ? { runId } : {}) };
}

/** Strict-schema JSON call. Throws CrawlAiError("failed") when the output cannot be parsed. */
export async function runJson<T>(opts: RunOptions & { schema: NonNullable<RunOptions["schema"]> }): Promise<{ value: T; result: RunResult }> {
  const result = await runResponse(opts);
  try {
    return { value: JSON.parse(result.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as T, result };
  } catch {
    throw new CrawlAiError("failed", "The AI returned data that could not be read. Try again with a smaller page.", 502);
  }
}

/** Bounded parallel map for chunked AI steps (Crawl4AI uses a 4-worker pool). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
