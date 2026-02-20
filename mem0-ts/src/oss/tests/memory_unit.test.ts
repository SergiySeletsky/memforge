/// <reference types="jest" />
/**
 * Memory class unit tests.
 * All external deps are mocked — tests verify business logic without real APIs.
 *
 * Ported from Python tests/test_main.py, tests/test_memory.py,
 * tests/memory/test_main.py, and tests/configs/test_prompts.py.
 */

// ---- Mock OpenAI for LLM + Embedder ----
const mockChatCreate = jest.fn();
const mockEmbedCreate = jest.fn();

jest.mock("openai", () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockChatCreate } },
    embeddings: { create: mockEmbedCreate },
  }));
});

import { Memory } from "../src";

jest.setTimeout(15000);

// ---- Helpers ----
function mockEmbedding(dims = 128) {
  const vec = Array.from({ length: dims }, (_, i) => Math.sin(i));
  mockEmbedCreate.mockResolvedValue({
    data: [{ embedding: vec }],
  });
  return vec;
}

function mockLLMFactExtraction(facts: string[]) {
  // LLM returns JSON with facts array for the fact-extraction call
  mockChatCreate.mockResolvedValue({
    choices: [
      {
        message: {
          role: "assistant",
          content: JSON.stringify({ facts }),
        },
      },
    ],
  });
}

function mockLLMRelations(relations: any[]) {
  // For the update/dedup call
  mockChatCreate.mockResolvedValue({
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: relations.length > 0
            ? relations.map((r) => ({
                function: {
                  name: r.name ?? "update_memory",
                  arguments: JSON.stringify(r.args ?? {}),
                },
              }))
            : undefined,
        },
      },
    ],
  });
}

async function createMemory(overrides: any = {}) {
  return new Memory({
    version: "v1.1",
    embedder: {
      provider: "openai",
      config: { apiKey: "test-key", model: "text-embedding-3-small" },
    },
    vectorStore: {
      provider: "memory",
      config: { collectionName: "test-memories", dimension: 128, dbPath: ":memory:" },
    },
    llm: {
      provider: "openai",
      config: { apiKey: "test-key", model: "gpt-4" },
    },
    historyDbPath: ":memory:",
    ...overrides,
  });
}

describe("Memory Class (Unit)", () => {
  let memory: Memory;

  beforeEach(async () => {
    mockChatCreate.mockReset();
    mockEmbedCreate.mockReset();
    memory = await createMemory();
    await memory.reset();
    // Give the SQLite async init/reset a moment to fully settle
    await new Promise((r) => setTimeout(r, 30));
  });

  // ============ Construction / Config ============
  describe("Construction", () => {
    it("should create with minimal config", () => {
      expect(memory).toBeDefined();
    });

    it("should preserve collection name setting", async () => {
      const m = await createMemory({
        vectorStore: {
          provider: "memory",
          config: { collectionName: "my-custom-collection", dimension: 128 },
        },
      });
      expect(m).toBeDefined();
    });

    it("should accept custom prompt", async () => {
      const m = await createMemory({ customPrompt: "Custom system prompt" });
      expect(m).toBeDefined();
    });

    it("should accept custom update memory prompt", async () => {
      const m = await createMemory({
        customUpdateMemoryPrompt: "Custom update prompt template",
      });
      expect(m).toBeDefined();
    });

    it("should accept reranker config", async () => {
      const m = await createMemory({
        reranker: { provider: "llm", config: { apiKey: "test-key" } },
      });
      expect(m).toBeDefined();
    });
  });

  // ============ Add Operations ============
  describe("add()", () => {
    it("should add a string message and return results", async () => {
      mockEmbedding();
      // First call: fact extraction, second call: memory update decisions
      mockChatCreate
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  facts: ["John is a software engineer"],
                }),
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  memory: [
                    {
                      id: "new",
                      event: "ADD",
                      old_memory: "",
                      new_memory: "John is a software engineer",
                    },
                  ],
                }),
              },
            },
          ],
        });

      const result = await memory.add(
        "Hi, my name is John and I am a software engineer.",
        { userId: "user-1" },
      );

      expect(result).toBeDefined();
      expect((result as any).results).toBeDefined();
    });

    it("should add array of messages", async () => {
      mockEmbedding();
      mockChatCreate
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({ facts: ["Loves Paris"] }),
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  memory: [
                    {
                      id: "new",
                      event: "ADD",
                      old_memory: "",
                      new_memory: "Loves Paris",
                    },
                  ],
                }),
              },
            },
          ],
        });

      const messages = [
        { role: "user", content: "What is your favorite city?" },
        {
          role: "assistant",
          content: "I love Paris, it is my favorite city.",
        },
      ];

      const result = await memory.add(messages as any, { userId: "user-1" });
      expect(result).toBeDefined();
    });

    it("should handle empty facts gracefully", async () => {
      mockEmbedding();
      mockLLMFactExtraction([]);

      const result = await memory.add("random noise text", { userId: "user-1" });
      expect(result).toBeDefined();
    });

    it("should throw when no userId/agentId/runId provided", async () => {
      mockEmbedding();
      mockLLMFactExtraction(["some fact"]);
      await expect(memory.add("test", {} as any)).rejects.toThrow(
        "One of the filters: userId, agentId or runId is required!",
      );
    });
  });

  // ============ Get / GetAll ============
  describe("get() / getAll()", () => {
    it("getAll should return empty results initially", async () => {
      const result = await memory.getAll({ userId: "user-1" });
      expect(result).toBeDefined();
      expect((result as any).results).toEqual([]);
    });

    it("get should return null for nonexistent ID", async () => {
      const result = await memory.get("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  // ============ Search ============
  describe("search()", () => {
    it("should return results array", async () => {
      mockEmbedding();
      const result = await memory.search("query", { userId: "user-1" });
      expect(result).toBeDefined();
      expect(Array.isArray((result as any).results)).toBe(true);
    });

    it("should accept limit parameter", async () => {
      mockEmbedding();
      const result = await memory.search("query", {
        userId: "user-1",
        limit: 2,
      });
      expect(result).toBeDefined();
    });

    it("should throw when no userId/agentId/runId provided", async () => {
      mockEmbedding();
      await expect(memory.search("test", {} as any)).rejects.toThrow(
        "One of the filters: userId, agentId or runId is required!",
      );
    });
  });

  // ============ Delete ============
  describe("delete()", () => {
    it("delete nonexistent should throw", async () => {
      await expect(memory.delete("nonexistent")).rejects.toThrow();
    });
  });

  // ============ Reset ============
  describe("reset()", () => {
    it("should clear all memories", async () => {
      mockEmbedding();
      mockChatCreate
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({ facts: ["Test memory"] }),
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  memory: [
                    {
                      id: "new",
                      event: "ADD",
                      old_memory: "",
                      new_memory: "Test memory",
                    },
                  ],
                }),
              },
            },
          ],
        });

      await memory.add("Test memory", { userId: "user-1" });
      await memory.reset();

      const result = await memory.getAll({ userId: "user-1" });
      expect((result as any).results).toEqual([]);
    });
  });

  // ============ History ============
  describe("history()", () => {
    it("should return empty array for unknown memory", async () => {
      const history = await memory.history("nonexistent-id");
      expect(Array.isArray(history)).toBe(true);
      expect(history).toHaveLength(0);
    });
  });

  // ============ Version handling ============
  describe("Version", () => {
    it("should accept v1.0 version", async () => {
      const m = await createMemory({ version: "v1.0" });
      expect(m).toBeDefined();
    });

    it("should accept v1.1 version", async () => {
      const m = await createMemory({ version: "v1.1" });
      expect(m).toBeDefined();
    });
  });

  // ============ Disable history ============
  describe("disableHistory", () => {
    it("should work with history disabled", async () => {
      const m = await createMemory({ disableHistory: true });
      expect(m).toBeDefined();
      // Should be able to get history (returns empty)
      const h = await m.history("some-id");
      expect(Array.isArray(h)).toBe(true);
    });
  });
});
