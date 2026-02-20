/**
 * Memory client utilities for OpenMemory (TypeScript port).
 *
 * Singleton wrapper around the mem0ai OSS Memory class.
 * Reads configuration from DB, resolves `env:VAR` references,
 * handles Docker Ollama URL fixup, and caches by config hash.
 */
import { getDb } from "@/lib/db";
import { configs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

// mem0ai/oss is the open-source Memory class from the TypeScript SDK
// This import will be resolved at runtime when mem0ai is installed
let Memory: any;
try {
  // Dynamic import so the server doesn't crash if mem0ai isn't available yet
  Memory = require("mem0ai/oss").Memory;
} catch {
  // Will be set lazily on first use
  Memory = null;
}

let _memoryClient: any = null;
let _configHash: string | null = null;

function getConfigHash(config: Record<string, unknown>): string {
  const str = JSON.stringify(config, Object.keys(config).sort());
  return crypto.createHash("md5").update(str).digest("hex");
}

/**
 * Parse `env:VAR_NAME` references in config values to actual env var values.
 */
function parseEnvironmentVariables(config: unknown): unknown {
  if (typeof config === "string" && config.startsWith("env:")) {
    const envVar = config.split(":")[1];
    const envValue = process.env[envVar];
    if (envValue) {
      console.log(`Loaded ${envVar} from environment`);
      return envValue;
    }
    console.warn(`Warning: Environment variable ${envVar} not found, keeping original value`);
    return config;
  }
  if (Array.isArray(config)) {
    return config.map(parseEnvironmentVariables);
  }
  if (config && typeof config === "object") {
    const parsed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      parsed[key] = parseEnvironmentVariables(value);
    }
    return parsed;
  }
  return config;
}

/**
 * Fix Ollama URLs for Docker environment.
 * Replaces localhost URLs with host.docker.internal.
 */
function fixOllamaUrls(section: Record<string, any>): Record<string, any> {
  if (!section || !section.config) return section;
  const cfg = section.config;

  if (!cfg.ollama_base_url) {
    cfg.ollama_base_url = "http://host.docker.internal:11434";
  } else {
    const url: string = cfg.ollama_base_url;
    if (url.includes("localhost") || url.includes("127.0.0.1")) {
      const dockerHost = process.env.OLLAMA_HOST || "host.docker.internal";
      cfg.ollama_base_url = url
        .replace("localhost", dockerHost)
        .replace("127.0.0.1", dockerHost);
      console.log(`Adjusted Ollama URL to ${cfg.ollama_base_url}`);
    }
  }
  return section;
}

/**
 * Build default memory configuration from environment variables.
 */
export function getDefaultMemoryConfig(): Record<string, any> {
  const embeddingDimsStr = process.env.EMBEDDING_DIMS;
  let embeddingModelDims = 1536;
  if (embeddingDimsStr) {
    const parsed = parseInt(embeddingDimsStr, 10);
    if (!isNaN(parsed)) embeddingModelDims = parsed;
  }

  const llmModel = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
  const embedModel = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

  // Parse QDRANT_URL into host/port if not already set
  const qdrantUrl = process.env.QDRANT_URL;
  if (qdrantUrl && !(process.env.QDRANT_HOST && process.env.QDRANT_PORT)) {
    try {
      const parsed = new URL(qdrantUrl);
      if (parsed.hostname && parsed.port) {
        process.env.QDRANT_HOST ??= parsed.hostname;
        process.env.QDRANT_PORT ??= parsed.port;
      }
    } catch { /* ignore */ }
  }

  // Detect vector store from environment
  let vectorStoreProvider = "qdrant";
  let vectorStoreConfig: Record<string, any> = {
    collection_name: "openmemory",
    host: "mem0_store",
  };

  if (process.env.CHROMA_HOST && process.env.CHROMA_PORT) {
    vectorStoreProvider = "chroma";
    vectorStoreConfig = {
      collection_name: "openmemory",
      host: process.env.CHROMA_HOST,
      port: parseInt(process.env.CHROMA_PORT, 10),
    };
  } else if (process.env.QDRANT_HOST && process.env.QDRANT_PORT) {
    vectorStoreProvider = "qdrant";
    vectorStoreConfig = {
      collection_name: "openmemory",
      host: process.env.QDRANT_HOST,
      port: parseInt(process.env.QDRANT_PORT, 10),
      embedding_model_dims: embeddingModelDims,
    };
  } else if (process.env.REDIS_URL) {
    vectorStoreProvider = "redis";
    vectorStoreConfig = {
      collection_name: "openmemory",
      redis_url: process.env.REDIS_URL,
    };
  } else if (process.env.PG_HOST && process.env.PG_PORT) {
    vectorStoreProvider = "pgvector";
    vectorStoreConfig = {
      collection_name: "openmemory",
      host: process.env.PG_HOST,
      port: parseInt(process.env.PG_PORT, 10),
      dbname: process.env.PG_DB || "mem0",
      user: process.env.PG_USER || "mem0",
      password: process.env.PG_PASSWORD || "mem0",
    };
  } else if (
    process.env.WEAVIATE_CLUSTER_URL ||
    (process.env.WEAVIATE_HOST && process.env.WEAVIATE_PORT)
  ) {
    vectorStoreProvider = "weaviate";
    let clusterUrl = process.env.WEAVIATE_CLUSTER_URL;
    if (!clusterUrl) {
      const wHost = process.env.WEAVIATE_HOST!;
      const wPort = parseInt(process.env.WEAVIATE_PORT!, 10);
      clusterUrl = `http://${wHost}:${wPort}`;
    }
    vectorStoreConfig = {
      collection_name: "openmemory",
      cluster_url: clusterUrl,
    };
  } else if (process.env.MILVUS_HOST && process.env.MILVUS_PORT) {
    vectorStoreProvider = "milvus";
    const mHost = process.env.MILVUS_HOST;
    const mPort = parseInt(process.env.MILVUS_PORT, 10);
    vectorStoreConfig = {
      collection_name: "openmemory",
      url: `http://${mHost}:${mPort}`,
      token: process.env.MILVUS_TOKEN || "",
      db_name: process.env.MILVUS_DB_NAME || "",
      embedding_model_dims: embeddingModelDims,
      metric_type: "COSINE",
    };
  } else if (process.env.ELASTICSEARCH_HOST && process.env.ELASTICSEARCH_PORT) {
    vectorStoreProvider = "elasticsearch";
    vectorStoreConfig = {
      collection_name: "openmemory",
      host: `http://${process.env.ELASTICSEARCH_HOST}`,
      port: parseInt(process.env.ELASTICSEARCH_PORT, 10),
      user: process.env.ELASTICSEARCH_USER || "elastic",
      password: process.env.ELASTICSEARCH_PASSWORD || "changeme",
      verify_certs: false,
      use_ssl: false,
      embedding_model_dims: embeddingModelDims,
    };
  } else if (process.env.OPENSEARCH_HOST && process.env.OPENSEARCH_PORT) {
    vectorStoreProvider = "opensearch";
    vectorStoreConfig = {
      collection_name: "openmemory",
      host: process.env.OPENSEARCH_HOST,
      port: parseInt(process.env.OPENSEARCH_PORT, 10),
    };
  } else if (process.env.FAISS_PATH) {
    vectorStoreProvider = "faiss";
    vectorStoreConfig = {
      collection_name: "openmemory",
      path: process.env.FAISS_PATH,
      embedding_model_dims: embeddingModelDims,
      distance_strategy: "cosine",
    };
  } else {
    // Default: Qdrant
    vectorStoreConfig.port = 6333;
    vectorStoreConfig.embedding_model_dims = embeddingModelDims;
  }

  console.log(`Auto-detected vector store: ${vectorStoreProvider}`);

  // Detect LLM/embedder provider
  const openaiBaseUrl = process.env.OPENAI_BASE_URL || "";
  const isLMStudio =
    !!openaiBaseUrl &&
    (openaiBaseUrl.includes("localhost:1234") ||
      openaiBaseUrl.includes("host.docker.internal:1234") ||
      openaiBaseUrl.toLowerCase().includes("lmstudio"));

  const isAzureOpenAI =
    !!process.env.LLM_AZURE_OPENAI_API_KEY || !!process.env.LLM_AZURE_ENDPOINT;

  let llmProvider: string;
  let embedderProvider: string;

  if (isAzureOpenAI) {
    llmProvider = "azure_openai";
    embedderProvider = "azure_openai";
  } else if (isLMStudio) {
    llmProvider = "lmstudio";
    embedderProvider = "lmstudio";
  } else {
    llmProvider = "openai";
    embedderProvider = "openai";
  }

  // Build LLM config
  let llmConfig: Record<string, any>;
  if (llmProvider === "azure_openai") {
    llmConfig = {
      model: llmModel,
      temperature: 0.1,
      max_tokens: 2000,
      azure_kwargs: {
        api_key: "env:LLM_AZURE_OPENAI_API_KEY",
        azure_endpoint: "env:LLM_AZURE_ENDPOINT",
        azure_deployment: "env:LLM_AZURE_DEPLOYMENT",
        api_version: "env:LLM_AZURE_API_VERSION",
      },
    };
  } else if (llmProvider === "lmstudio") {
    llmConfig = {
      model: llmModel,
      temperature: 0.1,
      max_tokens: 2000,
      api_key: "env:OPENAI_API_KEY",
      lmstudio_base_url: openaiBaseUrl,
      lmstudio_response_format: { type: "text" },
    };
  } else {
    llmConfig = {
      model: llmModel,
      temperature: 0.1,
      max_tokens: 2000,
      api_key: "env:OPENAI_API_KEY",
    };
    if (openaiBaseUrl) llmConfig.openai_base_url = openaiBaseUrl;
  }

  // Build embedder config
  let embedderConfig: Record<string, any>;
  if (embedderProvider === "azure_openai") {
    embedderConfig = {
      model: embedModel,
      embedding_dims: embeddingModelDims,
      azure_kwargs: {
        api_key: "env:EMBEDDING_AZURE_OPENAI_API_KEY",
        azure_endpoint: "env:EMBEDDING_AZURE_ENDPOINT",
        azure_deployment: "env:EMBEDDING_AZURE_DEPLOYMENT",
        api_version: "env:EMBEDDING_AZURE_API_VERSION",
      },
    };
  } else if (embedderProvider === "lmstudio") {
    embedderConfig = {
      model: embedModel,
      api_key: "env:OPENAI_API_KEY",
      lmstudio_base_url: openaiBaseUrl,
      embedding_dims: embeddingModelDims,
    };
  } else {
    embedderConfig = {
      model: embedModel,
      api_key: "env:OPENAI_API_KEY",
    };
    if (openaiBaseUrl) embedderConfig.openai_base_url = openaiBaseUrl;
  }

  const config: Record<string, any> = {
    vector_store: { provider: vectorStoreProvider, config: vectorStoreConfig },
    llm: { provider: llmProvider, config: llmConfig },
    embedder: { provider: embedderProvider, config: embedderConfig },
    version: "v1.1",
  };

  // Graph store detection
  if (process.env.MEMGRAPH_URL) {
    config.graph_store = {
      provider: "memgraph",
      config: {
        url: process.env.MEMGRAPH_URL,
        username: process.env.MEMGRAPH_USERNAME || "",
        password: process.env.MEMGRAPH_PASSWORD || "",
      },
    };
  } else if (process.env.NEO4J_URL) {
    config.graph_store = {
      provider: "neo4j",
      config: {
        url: process.env.NEO4J_URL,
        username: process.env.NEO4J_USERNAME || "neo4j",
        password: process.env.NEO4J_PASSWORD || "",
        database: process.env.NEO4J_DATABASE,
      },
    };
  }

  return config;
}

/**
 * Reset the global memory client (force re-init on next call).
 */
export function resetMemoryClient(): void {
  _memoryClient = null;
  _configHash = null;
}

/**
 * Get or initialize the mem0 Memory client (singleton, cached by config hash).
 */
export function getMemoryClient(customInstructions?: string): any | null {
  try {
    // Lazy-load Memory if needed
    if (!Memory) {
      try {
        Memory = require("mem0ai/oss").Memory;
      } catch (e) {
        console.error("Failed to load mem0ai/oss:", e);
        return null;
      }
    }

    let config = getDefaultMemoryConfig();
    let dbCustomInstructions: string | null = null;

    // Load config from database
    try {
      const db = getDb();
      const dbConfig = db.select().from(configs).where(eq(configs.key, "main")).get();

      if (dbConfig) {
        const jsonConfig = dbConfig.value as Record<string, any>;

        if (jsonConfig.openmemory?.custom_instructions) {
          dbCustomInstructions = jsonConfig.openmemory.custom_instructions;
        }

        if (jsonConfig.mem0) {
          const mem0Config = jsonConfig.mem0;

          if (mem0Config.llm) {
            config.llm = mem0Config.llm;
            if (config.llm?.provider === "ollama") {
              config.llm = fixOllamaUrls(config.llm);
            }
          }

          if (mem0Config.embedder) {
            config.embedder = mem0Config.embedder;
            if (config.embedder?.provider === "ollama") {
              config.embedder = fixOllamaUrls(config.embedder);
            }
          }

          if (mem0Config.vector_store) {
            config.vector_store = mem0Config.vector_store;
          }
        }
      } else {
        console.log("No configuration found in database, using defaults");
      }
    } catch (e) {
      console.warn("Warning: Error loading configuration from database:", e);
    }

    // Apply custom instructions
    const instructions = customInstructions || dbCustomInstructions;
    if (instructions) {
      config.custom_fact_extraction_prompt = instructions;
    }

    // Parse env: references
    console.log("Parsing environment variables in final config...");
    config = parseEnvironmentVariables(config) as Record<string, any>;

    // Only re-init if config changed or client doesn't exist
    const currentHash = getConfigHash(config);
    if (!_memoryClient || _configHash !== currentHash) {
      console.log(`Initializing memory client with config hash: ${currentHash}`);
      try {
        _memoryClient = new Memory(config);
        _configHash = currentHash;
        console.log("Memory client initialized successfully");
      } catch (initError) {
        console.warn("Warning: Failed to initialize memory client:", initError);
        _memoryClient = null;
        _configHash = null;
        return null;
      }
    }

    return _memoryClient;
  } catch (e) {
    console.warn("Warning: Exception occurred while initializing memory client:", e);
    return null;
  }
}

/**
 * Get memory client with error handling. Returns null if unavailable.
 */
export function getMemoryClientSafe(): any | null {
  try {
    return getMemoryClient();
  } catch (e) {
    console.warn("Failed to get memory client:", e);
    return null;
  }
}
