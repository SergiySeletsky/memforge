/// <reference types="jest" />
/**
 * Reranker unit tests.
 * Tests LLMReranker (with mocked LLM) and base helpers.
 */

const mockLLMCreate = jest.fn();

jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockLLMCreate } },
  }));
});

import { extractDocText } from "../src/reranker/base";
import { LLMReranker } from "../src/reranker/llm";

beforeEach(() => {
  mockLLMCreate.mockReset();
});

// ============ extractDocText helper ============
describe("extractDocText", () => {
  it("should prefer memory field", () => {
    expect(extractDocText({ memory: "mem text", text: "txt", content: "cnt" })).toBe("mem text");
  });

  it("should fall back to text field", () => {
    expect(extractDocText({ text: "txt", content: "cnt" })).toBe("txt");
  });

  it("should fall back to content field", () => {
    expect(extractDocText({ content: "cnt" })).toBe("cnt");
  });

  it("should JSON.stringify when no known fields", () => {
    const doc = { foo: "bar" };
    expect(extractDocText(doc)).toBe(JSON.stringify(doc));
  });
});

// ============ LLMReranker ============
describe("LLMReranker", () => {
  const docs = [
    { memory: "TypeScript is great", id: "1" },
    { memory: "Python is versatile", id: "2" },
    { memory: "Rust is fast", id: "3" },
  ];

  function mockScoreResponse(score: string) {
    mockLLMCreate.mockResolvedValue({
      choices: [{ message: { role: "assistant", content: score } }],
    });
  }

  it("should create with default config", () => {
    const r = new LLMReranker({ apiKey: "test-key" });
    expect(r).toBeDefined();
  });

  it("should score and sort documents", async () => {
    // Mock sequential responses with different scores
    mockLLMCreate
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "0.3" } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "0.9" } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "0.6" } }],
      });

    const r = new LLMReranker({ apiKey: "test-key" });
    const results = await r.rerank("best programming language", docs);

    expect(results).toHaveLength(3);
    // Should be sorted by score descending
    expect(results[0].rerank_score).toBe(0.9);
    expect(results[0].id).toBe("2"); // Python scored highest
    expect(results[1].rerank_score).toBe(0.6);
    expect(results[2].rerank_score).toBe(0.3);
  });

  it("should respect topK parameter", async () => {
    mockLLMCreate
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "0.3" } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "0.9" } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "0.6" } }],
      });

    const r = new LLMReranker({ apiKey: "test-key" });
    const results = await r.rerank("query", docs, 2);
    expect(results).toHaveLength(2);
  });

  it("should respect topK from config", async () => {
    mockLLMCreate
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "0.5" } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "0.8" } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "0.2" } }],
      });

    const r = new LLMReranker({ apiKey: "test-key", topK: 1 });
    const results = await r.rerank("query", docs);
    expect(results).toHaveLength(1);
    expect(results[0].rerank_score).toBe(0.8);
  });

  it("should fallback to 0.5 when LLM fails", async () => {
    mockLLMCreate.mockRejectedValue(new Error("API error"));

    const r = new LLMReranker({ apiKey: "test-key" });
    const results = await r.rerank("query", [docs[0]]);
    expect(results[0].rerank_score).toBe(0.5);
  });

  it("should clamp scores to [0, 1]", async () => {
    mockLLMCreate
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "1.5" } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "-0.3" } }],
      });

    const r = new LLMReranker({ apiKey: "test-key" });
    const results = await r.rerank("query", docs.slice(0, 2));
    expect(results[0].rerank_score).toBeLessThanOrEqual(1);
    expect(results[1].rerank_score).toBeGreaterThanOrEqual(0);
  });

  it("should handle non-numeric LLM output gracefully", async () => {
    mockLLMCreate.mockResolvedValue({
      choices: [
        {
          message: {
            role: "assistant",
            content: "This document is very relevant",
          },
        },
      ],
    });

    const r = new LLMReranker({ apiKey: "test-key" });
    const results = await r.rerank("query", [docs[0]]);
    // Should fallback to 0.5 when no number found
    expect(results[0].rerank_score).toBe(0.5);
  });

  it("should preserve original document fields", async () => {
    mockScoreResponse("0.7");
    const r = new LLMReranker({ apiKey: "test-key" });
    const results = await r.rerank("query", [{ memory: "test", extra: "data", id: "x" }]);
    expect(results[0].extra).toBe("data");
    expect(results[0].id).toBe("x");
    expect(results[0].memory).toBe("test");
    expect(results[0].rerank_score).toBe(0.7);
  });

  it("should use custom scoring prompt", async () => {
    mockScoreResponse("0.8");
    const customPrompt = "Rate relevance: {query} vs {document}. Score:";
    const r = new LLMReranker({ apiKey: "test-key", scoringPrompt: customPrompt });
    await r.rerank("my query", [{ memory: "my doc" }]);

    // Verify the prompt was sent to the LLM
    const sentMessages = mockLLMCreate.mock.calls[0][0].messages;
    expect(sentMessages[0].content).toContain("my query");
    expect(sentMessages[0].content).toContain("my doc");
  });
});
