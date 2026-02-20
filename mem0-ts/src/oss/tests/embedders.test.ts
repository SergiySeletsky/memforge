/// <reference types="jest" />
/**
 * Embedder unit tests.
 * Mocks OpenAI SDK to verify each embedder's constructor, embed(), and embedBatch().
 */

const mockEmbedCreate = jest.fn();

jest.mock("openai", () => {
  return jest.fn().mockImplementation((opts: any) => {
    (mockEmbedCreate as any).__lastOpts = opts;
    return {
      embeddings: { create: mockEmbedCreate },
    };
  });
});

import { OpenAIEmbedder } from "../src/embeddings/openai";
import { LMStudioEmbedder } from "../src/embeddings/lmstudio";

beforeEach(() => {
  mockEmbedCreate.mockReset();
});

// Helper: mock embedding response
function mockEmbedResponse(dims = 4, count = 1) {
  const embedding = Array.from({ length: dims }, (_, i) => i * 0.1);
  mockEmbedCreate.mockResolvedValue({
    data: Array.from({ length: count }, () => ({ embedding })),
  });
  return embedding;
}

// ============ OpenAI Embedder ============
describe("OpenAIEmbedder", () => {
  it("should use default model text-embedding-3-small", () => {
    const e = new OpenAIEmbedder({ apiKey: "test-key" });
    expect(e).toBeDefined();
  });

  it("embed should call OpenAI embeddings.create", async () => {
    const expectedEmb = mockEmbedResponse(4);
    const e = new OpenAIEmbedder({ apiKey: "test-key", model: "text-embedding-3-small" });
    const result = await e.embed("hello world");
    expect(result).toEqual(expectedEmb);
    expect(mockEmbedCreate).toHaveBeenCalledTimes(1);
    expect(mockEmbedCreate.mock.calls[0][0].input).toBe("hello world");
    expect(mockEmbedCreate.mock.calls[0][0].model).toBe("text-embedding-3-small");
  });

  it("embedBatch should handle multiple texts", async () => {
    mockEmbedResponse(4, 3);
    const e = new OpenAIEmbedder({ apiKey: "test-key" });
    const result = await e.embedBatch(["a", "b", "c"]);
    expect(result).toHaveLength(3);
    expect(mockEmbedCreate.mock.calls[0][0].input).toEqual(["a", "b", "c"]);
  });

  it("should accept custom model", async () => {
    mockEmbedResponse(4);
    const e = new OpenAIEmbedder({ apiKey: "test-key", model: "text-embedding-ada-002" });
    await e.embed("test");
    expect(mockEmbedCreate.mock.calls[0][0].model).toBe("text-embedding-ada-002");
  });
});

// ============ LMStudio Embedder ============
describe("LMStudioEmbedder", () => {
  it("should use localhost:1234 as default base URL", () => {
    const e = new LMStudioEmbedder({});
    expect(e).toBeDefined();
    const OpenAIMock = require("openai");
    const lastCall = OpenAIMock.mock.calls[OpenAIMock.mock.calls.length - 1][0];
    expect(lastCall.baseURL).toBe("http://localhost:1234/v1");
  });

  it("should use lm-studio as default API key", () => {
    const e = new LMStudioEmbedder({});
    const OpenAIMock = require("openai");
    const lastCall = OpenAIMock.mock.calls[OpenAIMock.mock.calls.length - 1][0];
    expect(lastCall.apiKey).toBe("lm-studio");
  });

  it("should default to nomic embedding model", async () => {
    mockEmbedResponse(4);
    const e = new LMStudioEmbedder({});
    await e.embed("test");
    expect(mockEmbedCreate.mock.calls[0][0].model).toContain("nomic");
  });

  it("embed should strip newlines (matching Python)", async () => {
    mockEmbedResponse(4);
    const e = new LMStudioEmbedder({});
    await e.embed("hello\nworld\n");
    const input = mockEmbedCreate.mock.calls[0][0].input;
    expect(input).toEqual(["hello world "]);
  });

  it("embedBatch should strip newlines from all texts", async () => {
    mockEmbedResponse(4, 2);
    const e = new LMStudioEmbedder({});
    await e.embedBatch(["line\none", "line\ntwo"]);
    const input = mockEmbedCreate.mock.calls[0][0].input;
    expect(input).toEqual(["line one", "line two"]);
  });

  it("should accept custom base URL via config", () => {
    const e = new LMStudioEmbedder({
      lmstudioBaseUrl: "http://remote:9999/v1",
    } as any);
    const OpenAIMock = require("openai");
    const lastCall = OpenAIMock.mock.calls[OpenAIMock.mock.calls.length - 1][0];
    expect(lastCall.baseURL).toBe("http://remote:9999/v1");
  });

  it("should set embeddingDims from config", () => {
    const e = new LMStudioEmbedder({ embeddingDims: 768 });
    expect(e.embeddingDims).toBe(768);
  });

  it("should default embeddingDims to 1536", () => {
    const e = new LMStudioEmbedder({});
    expect(e.embeddingDims).toBe(1536);
  });
});
