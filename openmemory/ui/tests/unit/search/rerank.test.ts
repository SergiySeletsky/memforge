export {};

/**
 * Unit tests for lib/search/rerank.ts — Spec 08
 *
 * RER_01 — 5 candidates, clear winner by LLM score → ranked first
 * RER_02 — All candidates score 0 → returns array without crashing
 * RER_03 — LLM error for one candidate → defaults to score 0, others unaffected
 * RER_04 — topN < candidates.length → returns exactly topN results
 */

const mockCreate = jest.fn();

// Mock the LLM client factory so we never check Azure credentials
jest.mock("@/lib/ai/client", () => ({
  getLLMClient: () => ({
    chat: { completions: { create: mockCreate } },
  }),
  resetLLMClient: jest.fn(),
}));

import { crossEncoderRerank } from "@/lib/search/rerank";

const makeCandidates = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `mem-${i}`,
    content: `Memory content ${i}`,
  }));

beforeEach(() => {
  jest.clearAllMocks();
});

describe("crossEncoderRerank", () => {
  test("RER_01: clear LLM winner → ranked first in results", async () => {
    // mem-2 gets score 9, others get 3
    mockCreate.mockImplementation(async ({ messages }: { messages: { content: string }[] }) => {
      const userMsg = messages[1]?.content ?? "";
      const score = userMsg.includes("Memory content 2") ? "9" : "3";
      return { choices: [{ message: { content: score } }] };
    });

    const candidates = makeCandidates(5);
    const results = await crossEncoderRerank("test query", candidates, 5);

    expect(results[0].id).toBe("mem-2");
    expect(results[0].rerankScore).toBe(9);
  });

  test("RER_02: all candidates score 0 → returns array without crashing", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "0" } }],
    });

    const candidates = makeCandidates(3);
    const results = await crossEncoderRerank("test query", candidates, 3);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.rerankScore === 0)).toBe(true);
  });

  test("RER_03: LLM errors for middle candidate → gets score 0, others have positive scores", async () => {
    mockCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: "7" } }] })
      .mockRejectedValueOnce(new Error("rate limit"))
      .mockResolvedValueOnce({ choices: [{ message: { content: "5" } }] });

    const candidates = makeCandidates(3);
    const results = await crossEncoderRerank("test query", candidates, 3);

    expect(results).toHaveLength(3);
    // The one that failed gets score 0
    const failedResult = results.find((r) => r.rerankScore === 0);
    expect(failedResult).toBeDefined();
    // Others should have non-zero scores
    const nonZero = results.filter((r) => r.rerankScore > 0);
    expect(nonZero).toHaveLength(2);
  });

  test("RER_04: topN=2 with 5 candidates → returns exactly 2 results", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "5" } }],
    });

    const candidates = makeCandidates(5);
    const results = await crossEncoderRerank("test query", candidates, 2);

    expect(results).toHaveLength(2);
  });
});
