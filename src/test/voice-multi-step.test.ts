import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

const seen: ModelMessage[][] = [];
vi.mock("@/lib/ai/pause.server", () => ({ getAiPause: async () => null, setAiPause: async () => {}, noteAiSuccess: async () => {} }));
vi.mock("@/lib/agent/tools.server", () => ({ createAgentTools: () => ({}) }));
vi.mock("ai", async (importOriginal) => {
  const real = await importOriginal<typeof import("ai")>();
  return {
    ...real,
    // Plays the SDK's real callback order for search → open page → answer: each step reports only its own messages.
    streamText: (opts: { prepareStep: (a: unknown) => { messages: ModelMessage[] }; onStepFinish: (s: unknown) => void }) => {
      const step = (n: number, tool: string) => ({
        toolCalls: [{ toolName: tool }],
        response: { messages: [
          { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${n}`, toolName: tool, input: {} }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: `c${n}`, toolName: tool, output: { type: "json", value: n } }] },
        ] },
      });
      seen.push(opts.prepareStep({}).messages);
      opts.onStepFinish(step(1, "web_search"));
      seen.push(opts.prepareStep({}).messages);
      opts.onStepFinish(step(2, "open_web_page"));
      seen.push(opts.prepareStep({}).messages);
      opts.onStepFinish({ toolCalls: [], response: { messages: [{ role: "assistant", content: "Jawab" }] } });
      async function* fullStream() {
        yield { type: "start-step" };
        yield { type: "finish-step", rawFinishReason: "end_turn" };
        yield { type: "finish", finishReason: "stop" };
      }
      return { fullStream: fullStream(), text: Promise.resolve("Jawab") };
    },
  };
});

describe("voice web teacher", () => {
  it("after searching and opening a page, the next step sees both results instead of searching again", async () => {
    const { answerQuestion, parseCallPrefs } = await import("@/lib/live-relay.server");
    const messages: ModelMessage[] = [{ role: "user", content: "NEET 2026 kab hua?" }];
    let searches = 0;
    const answer = await answerQuestion(
      messages,
      { baseURL: "https://ai.gateway.lovable.dev/v1", key: "test", liveModel: "m", backendModel: "anthropic/claude-fable-5-1" },
      { runID: "r", sessionID: undefined, delegationID: "d" },
      new AbortController().signal,
      () => {},
      () => {},
      parseCallPrefs({ search: true }),
      () => { searches++; },
    );
    expect(answer).toBe("Jawab");
    expect(searches).toBe(2);
    expect(seen[1]!.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(seen[2]!.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
  });
});
