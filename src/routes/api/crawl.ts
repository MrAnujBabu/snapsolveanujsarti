import { createFileRoute } from "@tanstack/react-router";
import { researchRequestSchema, usesAi, type ResearchEvent } from "@/lib/crawl4ai/research-protocol";

// Per-instance guard so one visitor cannot hammer the crawler (and the workspace's AI credits).
const WINDOW_MS = 60_000;
const LIMIT = 10;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): number {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) {
    hits.set(ip, recent);
    return Math.ceil((WINDOW_MS - (now - recent[0]!)) / 1000);
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return 0;
}

export const Route = createFileRoute("/api/crawl")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (request.signal.aborted) return new Response(null, { status: 499 });
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          if (request.signal.aborted) return new Response(null, { status: 499 });
          return Response.json({ error: "Invalid request." }, { status: 400 });
        }
        const parsed = researchRequestSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
        }
        const req = parsed.data;
        const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
        const wait = rateLimited(ip);
        if (wait) return Response.json({ error: `Too many research requests. Try again in ${wait} seconds.` }, { status: 429, headers: { "Retry-After": String(wait) } });

        if (usesAi(req)) {
          const { assertAiAvailable, CrawlAiError } = await import("@/lib/crawl4ai/llm.server");
          try {
            await assertAiAvailable();
          } catch (error) {
            if (error instanceof CrawlAiError) return Response.json({ error: error.message, kind: error.kind }, { status: error.status });
            throw error;
          }
        }

        const { runResearch } = await import("@/lib/crawl4ai/research.server");
        const work = new AbortController();
        const onAbort = () => work.abort(request.signal.reason);
        request.signal.addEventListener("abort", onAbort, { once: true });
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let open = true;
            const emit = (e: ResearchEvent) => {
              if (!open) return;
              try {
                controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
              } catch {
                open = false;
              }
            };
            void runResearch(req, emit, work.signal).finally(() => {
              request.signal.removeEventListener("abort", onAbort);
              if (open) {
                open = false;
                try { controller.close(); } catch { /* already closed */ }
              }
            });
          },
          cancel() {
            work.abort(new DOMException("Client closed the research stream.", "AbortError"));
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Content-Type-Options": "nosniff" },
        });
      },
    },
  },
});
