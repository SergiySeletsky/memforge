import { OpenAIEmbedder } from "../embeddings/openai";
import { OllamaEmbedder } from "../embeddings/ollama";
import { OpenAILLM } from "../llms/openai";
import { OpenAIStructuredLLM } from "../llms/openai_structured";
import { AnthropicLLM } from "../llms/anthropic";
import { GroqLLM } from "../llms/groq";
import { MistralLLM } from "../llms/mistral";
import { MemoryVectorStore } from "../vector_stores/memory";
import { MemgraphVectorStore } from "../vector_stores/memgraph";
import { KuzuVectorStore } from "../vector_stores/kuzu";
import {
  EmbeddingConfig,
  HistoryStoreConfig,
  LLMConfig,
  VectorStoreConfig,
} from "../types";
import { Embedder } from "../embeddings/base";
import { LLM } from "../llms/base";
import { VectorStore } from "../vector_stores/base";
import { OllamaLLM } from "../llms/ollama";
import { MemgraphHistoryManager } from "../storage/MemgraphHistoryManager";
import { KuzuHistoryManager } from "../storage/KuzuHistoryManager";
import { MemoryHistoryManager } from "../storage/MemoryHistoryManager";
import { HistoryManager } from "../storage/base";
import { GoogleEmbedder } from "../embeddings/google";
import { GoogleLLM } from "../llms/google";
import { AzureOpenAILLM } from "../llms/azure";
import { AzureOpenAIEmbedder } from "../embeddings/azure";
import { LangchainLLM } from "../llms/langchain";
import { DeepSeekLLM } from "../llms/deepseek";
import { XAILLM } from "../llms/xai";
import { TogetherLLM } from "../llms/together";
import { LMStudioLLM } from "../llms/lmstudio";
import { LangchainEmbedder } from "../embeddings/langchain";
import { LMStudioEmbedder } from "../embeddings/lmstudio";
import { Reranker } from "../reranker/base";
import { LLMReranker } from "../reranker/llm";
import { CohereReranker } from "../reranker/cohere";

export class EmbedderFactory {
  static create(provider: string, config: EmbeddingConfig): Embedder {
    switch (provider.toLowerCase()) {
      case "openai":
        return new OpenAIEmbedder(config);
      case "ollama":
        return new OllamaEmbedder(config);
      case "google":
      case "gemini":
        return new GoogleEmbedder(config);
      case "azure_openai":
        return new AzureOpenAIEmbedder(config);
      case "langchain":
        return new LangchainEmbedder(config);
      case "lmstudio":
        return new LMStudioEmbedder(config);
      default:
        throw new Error(`Unsupported embedder provider: ${provider}`);
    }
  }
}

export class LLMFactory {
  static create(provider: string, config: LLMConfig): LLM {
    switch (provider.toLowerCase()) {
      case "openai":
        return new OpenAILLM(config);
      case "openai_structured":
        return new OpenAIStructuredLLM(config);
      case "anthropic":
        return new AnthropicLLM(config);
      case "groq":
        return new GroqLLM(config);
      case "ollama":
        return new OllamaLLM(config);
      case "google":
      case "gemini":
        return new GoogleLLM(config);
      case "azure_openai":
        return new AzureOpenAILLM(config);
      case "mistral":
        return new MistralLLM(config);
      case "langchain":
        return new LangchainLLM(config);
      case "deepseek":
        return new DeepSeekLLM(config);
      case "xai":
        return new XAILLM(config);
      case "together":
        return new TogetherLLM(config);
      case "lmstudio":
        return new LMStudioLLM(config);
      default:
        throw new Error(`Unsupported LLM provider: ${provider}`);
    }
  }
}

export class RerankerFactory {
  static create(provider: string, config: Record<string, any> = {}): Reranker {
    switch (provider.toLowerCase()) {
      case "llm_reranker":
      case "llm":
        return new LLMReranker(config);
      case "cohere":
        return new CohereReranker(config);
      default:
        throw new Error(`Unsupported reranker provider: ${provider}`);
    }
  }
}

export class VectorStoreFactory {
  static create(provider: string, config: VectorStoreConfig): VectorStore {
    switch (provider.toLowerCase()) {
      case "memory":
        return new MemoryVectorStore(config);
      case "memgraph":
        return new MemgraphVectorStore(config as any);
      case "kuzu":
        return new KuzuVectorStore(config as any);
      default:
        throw new Error(`Unsupported vector store provider: ${provider}`);
    }
  }
}

export class HistoryManagerFactory {
  static create(provider: string, config: HistoryStoreConfig): HistoryManager {
    switch (provider.toLowerCase()) {
      case "memgraph":
        return new MemgraphHistoryManager(config.config);
      case "kuzu":
        return new KuzuHistoryManager({ dbPath: config.config.dbPath });
      case "memory":
        return new MemoryHistoryManager();
      default:
        throw new Error(`Unsupported history store provider: ${provider}`);
    }
  }
}
