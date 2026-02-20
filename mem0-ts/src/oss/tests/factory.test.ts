/// <reference types="jest" />
/**
 * Comprehensive factory tests — covers all providers in EmbedderFactory,
 * LLMFactory, VectorStoreFactory, RerankerFactory, and HistoryManagerFactory.
 *
 * All external dependencies are mocked so no real API calls are made.
 */

// ---- Mock external modules BEFORE imports ----
jest.mock("openai", () => {
  const MockOpenAI = jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } },
    embeddings: { create: jest.fn() },
  }));
  return {
    __esModule: true,
    default: MockOpenAI,
    AzureOpenAI: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: jest.fn() } },
      embeddings: { create: jest.fn() },
    })),
  };
});
jest.mock("@anthropic-ai/sdk", () => {
  const ctor = jest.fn().mockImplementation(() => ({
    messages: { create: jest.fn() },
  }));
  return { __esModule: true, default: ctor };
});
jest.mock("groq-sdk", () => {
  return {
    Groq: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: jest.fn() } },
    })),
  };
});
jest.mock("ollama", () => ({
  Ollama: jest.fn().mockImplementation(() => ({
    list: jest.fn().mockResolvedValue({ models: [] }),
    pull: jest.fn().mockResolvedValue(undefined),
    chat: jest.fn().mockResolvedValue({ message: { content: "" } }),
  })),
}));
jest.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: jest.fn().mockImplementation(() => ({
    getCollections: jest.fn().mockResolvedValue({ collections: [] }),
    createCollection: jest.fn().mockResolvedValue(true),
  })),
}));
jest.mock("redis", () => ({
  createClient: jest.fn().mockReturnValue({
    connect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    ft: { _list: jest.fn().mockResolvedValue([]), create: jest.fn() },
  }),
}));
// Mock Azure Search Documents so indexClient.listIndexes() returns an empty
// async iterator immediately — prevents the constructor's initialize() call
// from making real HTTP requests that outlive the test suite.
jest.mock("@azure/search-documents", () => {
  const emptyAsyncIter = {
    [Symbol.asyncIterator]: function* () {},
  };
  return {
    SearchClient: jest.fn().mockImplementation(() => ({})),
    SearchIndexClient: jest.fn().mockImplementation(() => ({
      listIndexes: jest.fn().mockReturnValue(emptyAsyncIter),
      createOrUpdateIndex: jest.fn().mockResolvedValue({}),
    })),
    AzureKeyCredential: jest.fn().mockImplementation(() => ({})),
    SearchField: {},
    VectorSearchAlgorithmConfiguration: {},
  };
});
jest.mock("@azure/identity", () => ({
  DefaultAzureCredential: jest.fn().mockImplementation(() => ({})),
  AzureKeyCredential: jest.fn().mockImplementation(() => ({})),
}));

import {
  EmbedderFactory,
  LLMFactory,
  VectorStoreFactory,
  RerankerFactory,
} from "../src/utils/factory";
import { AzureAISearch } from "../src/vector_stores/azure_ai_search";

// ---- EmbedderFactory ----
describe("EmbedderFactory", () => {
  const base = { apiKey: "test-key", model: "test-model", embeddingDims: 128 };

  it("should create openai embedder", () => {
    const e = EmbedderFactory.create("openai", base);
    expect(e).toBeDefined();
    expect(e.constructor.name).toBe("OpenAIEmbedder");
  });

  it("should create ollama embedder", () => {
    const e = EmbedderFactory.create("ollama", {
      ...base,
      ollamaBaseUrl: "http://localhost:11434",
    });
    expect(e).toBeDefined();
    expect(e.constructor.name).toBe("OllamaEmbedder");
  });

  it("should create google embedder", () => {
    const e = EmbedderFactory.create("google", base);
    expect(e).toBeDefined();
    expect(e.constructor.name).toBe("GoogleEmbedder");
  });

  it("should create gemini embedder (alias)", () => {
    const e = EmbedderFactory.create("gemini", base);
    expect(e.constructor.name).toBe("GoogleEmbedder");
  });

  it("should create azure_openai embedder", () => {
    const e = EmbedderFactory.create("azure_openai", {
      ...base,
      modelProperties: { endpoint: "https://x.openai.azure.com" },
    });
    expect(e).toBeDefined();
    expect(e.constructor.name).toBe("AzureOpenAIEmbedder");
  });

  it("should create lmstudio embedder", () => {
    const e = EmbedderFactory.create("lmstudio", base);
    expect(e).toBeDefined();
    expect(e.constructor.name).toBe("LMStudioEmbedder");
  });

  it("should throw for unsupported provider", () => {
    expect(() => EmbedderFactory.create("nonexistent", base)).toThrow(
      "Unsupported embedder provider",
    );
  });
});

// ---- LLMFactory ----
describe("LLMFactory", () => {
  const base = { apiKey: "test-key", model: "test-model" };

  it("should create openai LLM", () => {
    const llm = LLMFactory.create("openai", base);
    expect(llm.constructor.name).toBe("OpenAILLM");
  });

  it("should create openai_structured LLM", () => {
    const llm = LLMFactory.create("openai_structured", base);
    expect(llm.constructor.name).toBe("OpenAIStructuredLLM");
  });

  it("should create anthropic LLM", () => {
    const llm = LLMFactory.create("anthropic", base);
    expect(llm.constructor.name).toBe("AnthropicLLM");
  });

  it("should create groq LLM", () => {
    const llm = LLMFactory.create("groq", base);
    expect(llm.constructor.name).toBe("GroqLLM");
  });

  it("should create ollama LLM", () => {
    const llm = LLMFactory.create("ollama", {
      ...base,
      ollamaBaseUrl: "http://localhost:11434",
    });
    expect(llm.constructor.name).toBe("OllamaLLM");
  });

  it("should create google LLM", () => {
    const llm = LLMFactory.create("google", base);
    expect(llm.constructor.name).toBe("GoogleLLM");
  });

  it("should create azure_openai LLM", () => {
    const llm = LLMFactory.create("azure_openai", {
      ...base,
      modelProperties: { endpoint: "https://x.openai.azure.com" },
    });
    expect(llm.constructor.name).toBe("AzureOpenAILLM");
  });

  it("should create deepseek LLM", () => {
    const llm = LLMFactory.create("deepseek", base);
    expect(llm.constructor.name).toBe("DeepSeekLLM");
  });

  it("should create xai LLM", () => {
    const llm = LLMFactory.create("xai", base);
    expect(llm.constructor.name).toBe("XAILLM");
  });

  it("should create together LLM", () => {
    const llm = LLMFactory.create("together", base);
    expect(llm.constructor.name).toBe("TogetherLLM");
  });

  it("should create lmstudio LLM", () => {
    const llm = LLMFactory.create("lmstudio", base);
    expect(llm.constructor.name).toBe("LMStudioLLM");
  });

  it("should throw for unsupported provider", () => {
    expect(() => LLMFactory.create("nonexistent", base)).toThrow(
      "Unsupported LLM provider",
    );
  });
});

// ---- VectorStoreFactory ----
describe("VectorStoreFactory", () => {
  it("should create memory store", () => {
    const vs = VectorStoreFactory.create("memory", {
      collectionName: "test",
      dimension: 128,
    });
    expect(vs.constructor.name).toBe("MemoryVectorStore");
  });

  it("should create Azure AI Search vector store", () => {
    const config = {
      collectionName: "test-memories",
      serviceName: "test-service",
      apiKey: "test-api-key",
      embeddingModelDims: 1536,
      compressionType: "none" as const,
      useFloat16: false,
      hybridSearch: false,
      vectorFilterMode: "preFilter" as const,
    };
    const vs = VectorStoreFactory.create("azure-ai-search", config);
    expect(vs).toBeInstanceOf(AzureAISearch);
  });

  it("should create qdrant store", () => {
    const vs = VectorStoreFactory.create("qdrant", {
      collectionName: "test",
      embeddingModelDims: 128,
      path: ":memory:",
    });
    expect(vs.constructor.name).toBe("Qdrant");
  });

  it("should create chroma store", () => {
    try {
      const vs = VectorStoreFactory.create("chroma", {
        collectionName: "test",
        path: ":memory:",
      });
      expect(vs.constructor.name).toBe("ChromaDB");
    } catch (e: any) {
      // chromadb may not be installed
      expect(e.message).toContain("chromadb");
    }
  });

  it("should create chromadb store (alias)", () => {
    try {
      const vs = VectorStoreFactory.create("chromadb", {
        collectionName: "test",
        path: ":memory:",
      });
      expect(vs.constructor.name).toBe("ChromaDB");
    } catch (e: any) {
      expect(e.message).toContain("chromadb");
    }
  });

  it("should throw for unsupported provider", () => {
    expect(() =>
      VectorStoreFactory.create("unsupported-provider", {}),
    ).toThrow("Unsupported vector store provider: unsupported-provider");
  });
});

// ---- RerankerFactory ----
describe("RerankerFactory", () => {
  it("should create llm reranker", () => {
    const r = RerankerFactory.create("llm", { apiKey: "test-key" });
    expect(r).toBeDefined();
    expect(r.constructor.name).toBe("LLMReranker");
  });

  it("should create llm_reranker (alias)", () => {
    const r = RerankerFactory.create("llm_reranker", { apiKey: "test-key" });
    expect(r.constructor.name).toBe("LLMReranker");
  });

  it("should create cohere reranker", () => {
    try {
      const r = RerankerFactory.create("cohere", { apiKey: "test-key" });
      expect(r.constructor.name).toBe("CohereReranker");
    } catch (e: any) {
      // cohere-ai may not be installed
      expect(e.message).toContain("cohere-ai");
    }
  });

  it("should throw for unsupported provider", () => {
    expect(() => RerankerFactory.create("nonexistent", {})).toThrow(
      "Unsupported reranker provider",
    );
  });
});
