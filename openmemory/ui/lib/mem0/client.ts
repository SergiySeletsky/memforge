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
} catch (e: any) {
  // Will be set lazily on first use
  console.error("Initial mem0ai/oss load failed:", e?.message, e?.stack?.split("\n").slice(0, 3).join(" | "));
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
/**
 * Translate a Python-style snake_case LLM config (from DB or old format) into
 * the camelCase format expected by the TypeScript mem0ai/oss SDK.
 */
function translateLlmConfig(provider: string, snakeCfg: Record<string, any>): Record<string, any> {
  if (provider === "groq") {
    return {
      model: snakeCfg.model || "llama-3.1-8b-instant",
      apiKey: snakeCfg.api_key || snakeCfg.apiKey || "env:GROQ_API_KEY",
    };
  }
  if (provider === "azure_openai") {
    const az = snakeCfg.azure_kwargs || {};
    return {
      model: snakeCfg.model,
      apiKey: az.api_key || snakeCfg.api_key,
      modelProperties: {
        endpoint: az.azure_endpoint || snakeCfg.azure_endpoint,
        deployment: az.azure_deployment || snakeCfg.azure_deployment || snakeCfg.model,
        apiVersion: az.api_version || snakeCfg.api_version,
      },
    };
  }
  if (provider === "ollama") {
    return {
      model: snakeCfg.model,
      baseURL: snakeCfg.ollama_base_url || snakeCfg.baseURL || "http://localhost:11434/v1",
      apiKey: "ollama",
    };
  }
  if (provider === "lmstudio") {
    return {
      model: snakeCfg.model,
      apiKey: snakeCfg.api_key || snakeCfg.apiKey || "lm-studio",
      baseURL: snakeCfg.lmstudio_base_url || snakeCfg.baseURL || "http://localhost:1234/v1",
    };
  }
  // openai / default
  return {
    model: snakeCfg.model,
    apiKey: snakeCfg.api_key || snakeCfg.apiKey || "env:OPENAI_API_KEY",
    ...(snakeCfg.openai_base_url || snakeCfg.baseURL
      ? { baseURL: snakeCfg.openai_base_url || snakeCfg.baseURL }
      : {}),
  };
}

/**
 * Translate a Python-style snake_case embedder config into camelCase SDK format.
 */
function translateEmbedderConfig(provider: string, snakeCfg: Record<string, any>): Record<string, any> {
  const dims = snakeCfg.embedding_dims || snakeCfg.embeddingDims || 1536;
  if (provider === "azure_openai") {
    const az = snakeCfg.azure_kwargs || {};
    return {
      model: snakeCfg.model,
      apiKey: az.api_key || snakeCfg.api_key || snakeCfg.apiKey,
      embeddingDims: dims,
      modelProperties: {
        endpoint: az.azure_endpoint || snakeCfg.azure_endpoint,
        deployment: az.azure_deployment || snakeCfg.azure_deployment || snakeCfg.model,
        apiVersion: az.api_version || snakeCfg.api_version,
      },
    };
  }
  if (provider === "ollama") {
    return {
      model: snakeCfg.model,
      url: snakeCfg.ollama_base_url || snakeCfg.url || "http://localhost:11434/v1",
      embeddingDims: dims,
    };
  }
  if (provider === "lmstudio") {
    return {
      model: snakeCfg.model,
      apiKey: snakeCfg.api_key || snakeCfg.apiKey || "lm-studio",
      url: snakeCfg.lmstudio_base_url || snakeCfg.url || "http://localhost:1234/v1",
      embeddingDims: dims,
    };
  }
  // openai / default
  return {
    model: snakeCfg.model,
    apiKey: snakeCfg.api_key || snakeCfg.apiKey || "env:OPENAI_API_KEY",
    ...(snakeCfg.embedding_dims || snakeCfg.embeddingDims ? { embeddingDims: dims } : {}),
  };
}

/**
 * Translate a Python-style snake_case vector_store config into camelCase SDK format.
 */
function translateVectorStoreConfig(snakeCfg: Record<string, any>): Record<string, any> {
  const dims = snakeCfg.embedding_model_dims || snakeCfg.embeddingModelDims || 1536;
  return {
    collectionName: snakeCfg.collection_name || snakeCfg.collectionName || "openmemory",
    host: snakeCfg.host,
    port: snakeCfg.port,
    url: snakeCfg.url,
    apiKey: snakeCfg.apiKey || snakeCfg.api_key,
    embeddingModelDims: dims,
    ...(snakeCfg.path ? { path: snakeCfg.path } : {}),
  };
}

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

  // Detect vector store — camelCase keys required by TypeScript SDK
  let vectorStoreProvider = "qdrant";
  let vectorStoreConfig: Record<string, any>;

  if (process.env.CHROMA_HOST && process.env.CHROMA_PORT) {
    vectorStoreProvider = "chroma";
    vectorStoreConfig = {
      collectionName: "openmemory",
      host: process.env.CHROMA_HOST,
      port: parseInt(process.env.CHROMA_PORT, 10),
    };
  } else if (process.env.REDIS_URL) {
    vectorStoreProvider = "redis";
    vectorStoreConfig = {
      collectionName: "openmemory",
      redisUrl: process.env.REDIS_URL,
    };
  } else if (process.env.QDRANT_HOST && process.env.QDRANT_PORT) {
    vectorStoreProvider = "qdrant";
    vectorStoreConfig = {
      collectionName: "openmemory",
      host: process.env.QDRANT_HOST,
      port: parseInt(process.env.QDRANT_PORT, 10),
      embeddingModelDims: embeddingModelDims,
    };
  } else {
    // Default: Qdrant on mem0_store (Docker compose) or localhost
    vectorStoreProvider = "qdrant";
    vectorStoreConfig = {
      collectionName: "openmemory",
      host: "mem0_store",
      port: 6333,
      embeddingModelDims: embeddingModelDims,
    };
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

  // Build LLM config — camelCase keys required by TypeScript SDK
  let llmConfig: Record<string, any>;
  if (llmProvider === "azure_openai") {
    const azureLlmModel = process.env.LLM_AZURE_DEPLOYMENT || llmModel;
    llmConfig = {
      model: azureLlmModel,
      apiKey: "env:LLM_AZURE_OPENAI_API_KEY",
      timeout: 30_000,   // 30 s per Azure API call — spread into AzureOpenAI constructor
      maxRetries: 1,
      modelProperties: {
        endpoint: "env:LLM_AZURE_ENDPOINT",
        deployment: "env:LLM_AZURE_DEPLOYMENT",
        apiVersion: "env:LLM_AZURE_API_VERSION",
      },
    };
  } else if (llmProvider === "lmstudio") {
    llmConfig = {
      model: llmModel,
      apiKey: process.env.OPENAI_API_KEY || "lm-studio",
      baseURL: openaiBaseUrl || "http://localhost:1234/v1",
    };
  } else {
    llmConfig = {
      model: llmModel,
      apiKey: "env:OPENAI_API_KEY",
    };
    if (openaiBaseUrl) llmConfig.baseURL = openaiBaseUrl;
  }

  // Build embedder config — camelCase keys required by TypeScript SDK
  let embedderConfig: Record<string, any>;
  if (embedderProvider === "azure_openai") {
    const azureEmbedModel = process.env.EMBEDDING_AZURE_DEPLOYMENT || embedModel;
    embedderConfig = {
      model: azureEmbedModel,
      apiKey: "env:EMBEDDING_AZURE_OPENAI_API_KEY",
      embeddingDims: embeddingModelDims,
      modelProperties: {
        endpoint: "env:EMBEDDING_AZURE_ENDPOINT",
        deployment: "env:EMBEDDING_AZURE_DEPLOYMENT",
        apiVersion: "env:EMBEDDING_AZURE_API_VERSION",
      },
    };
  } else if (embedderProvider === "lmstudio") {
    embedderConfig = {
      model: embedModel,
      apiKey: process.env.OPENAI_API_KEY || "lm-studio",
      url: openaiBaseUrl || "http://localhost:1234/v1",
      embeddingDims: embeddingModelDims,
    };
  } else {
    embedderConfig = {
      model: embedModel,
      apiKey: "env:OPENAI_API_KEY",
    };
    if (openaiBaseUrl) embedderConfig.url = openaiBaseUrl;
  }

  const config: Record<string, any> = {
    vectorStore: { provider: vectorStoreProvider, config: vectorStoreConfig },
    llm: { provider: llmProvider, config: llmConfig },
    embedder: { provider: embedderProvider, config: embedderConfig },
    version: "v1.1",
  };

  // Graph store detection — TypeScript SDK uses camelCase `graphStore`
  // Memgraph speaks the Bolt protocol so it uses the "neo4j" provider (neo4j-driver internally)
  //
  // Graph LLM override: entity/relation extraction uses 3 sequential LLM tool-calls.
  // With Azure gpt-4.1-mini each call takes ~3 s → ~10 s total for add, ~3 s for search.
  // If GROQ_API_KEY is set we route those calls to Groq llama-3.1-8b-instant (~100-200 ms each)
  // → ~600 ms for add background, ~200 ms for search entity extraction.
  // Override via GRAPH_LLM_PROVIDER / GRAPH_LLM_MODEL / GRAPH_LLM_API_KEY for other providers.
  const graphLlmProvider = process.env.GRAPH_LLM_PROVIDER ||
    (process.env.GROQ_API_KEY ? "groq" : null);
  const graphLlmCfg: Record<string, any> | null = graphLlmProvider ? {
    model: process.env.GRAPH_LLM_MODEL ||
      (graphLlmProvider === "groq" ? "llama-3.1-8b-instant" : llmConfig.model),
    apiKey: process.env.GRAPH_LLM_API_KEY ||
      (graphLlmProvider === "groq" ? "env:GROQ_API_KEY" : llmConfig.apiKey),
    ...(process.env.GRAPH_LLM_BASE_URL ? { baseURL: process.env.GRAPH_LLM_BASE_URL } : {}),
  } : null;
  const graphLlm = graphLlmCfg
    ? { provider: graphLlmProvider as string, config: graphLlmCfg }
    : { provider: llmProvider, config: llmConfig };
  if (graphLlmCfg) {
    console.log(`Graph LLM override: provider=${graphLlmProvider} model=${graphLlmCfg.model}`);
  }

  if (process.env.MEMGRAPH_URL) {
    config.graphStore = {
      provider: "neo4j",
      config: {
        url: process.env.MEMGRAPH_URL,
        username: process.env.MEMGRAPH_USERNAME || "",
        password: process.env.MEMGRAPH_PASSWORD || "",
      },
      // Must explicitly pass the same LLM so the default "openai" from SDK defaults
      // doesn't get spread in by ConfigManager and override the main LLM provider.
      llm: graphLlm,
    };
    config.enableGraph = true;
    console.log("Graph store: Memgraph (Bolt) at", process.env.MEMGRAPH_URL);
  } else if (process.env.NEO4J_URL) {
    config.graphStore = {
      provider: "neo4j",
      config: {
        url: process.env.NEO4J_URL,
        username: process.env.NEO4J_USERNAME || "neo4j",
        password: process.env.NEO4J_PASSWORD || "",
        database: process.env.NEO4J_DATABASE,
      },
      llm: graphLlm,
    };
    config.enableGraph = true;
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
      } catch (e: any) {
        console.error("Failed to load mem0ai/oss:", e?.message, e?.stack?.split("\n").slice(0, 3).join(" | "));
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

          // Translate snake_case DB config to camelCase TypeScript SDK format
          if (mem0Config.llm) {
            const provider = mem0Config.llm.provider || "openai";
            const rawCfg = mem0Config.llm.config || {};
            const translated = translateLlmConfig(provider, rawCfg);
            if (provider === "ollama") {
              const fixed = fixOllamaUrls({ provider, config: { ollama_base_url: translated.baseURL } });
              translated.baseURL = fixed.config?.ollama_base_url || translated.baseURL;
            }
            config.llm = { provider, config: translated };
          }

          if (mem0Config.embedder) {
            const provider = mem0Config.embedder.provider || "openai";
            const rawCfg = mem0Config.embedder.config || {};
            const translated = translateEmbedderConfig(provider, rawCfg);
            config.embedder = { provider, config: translated };
          }

          // Support both old `vector_store` and new `vectorStore` keys
          const vsRaw = mem0Config.vectorStore || mem0Config.vector_store;
          if (vsRaw) {
            const vsProvider = vsRaw.provider || "qdrant";
            const vsCfg = vsRaw.config || {};
            // Translate if it still uses snake_case keys
            const vsTranslated = vsCfg.collectionName
              ? vsCfg
              : translateVectorStoreConfig(vsCfg);
            config.vectorStore = { provider: vsProvider, config: vsTranslated };
          }
        }
      } else {
        console.log("No configuration found in database, using defaults");
      }
    } catch (e) {
      console.warn("Warning: Error loading configuration from database:", e);
    }

    // Apply custom instructions — TypeScript SDK uses `customPrompt`
    const instructions = customInstructions || dbCustomInstructions;
    if (instructions) {
      config.customPrompt = instructions;
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
        console.error("ERROR: Failed to initialize memory client:", JSON.stringify(initError, null, 2));
        console.error("ERROR initError message:", (initError as any)?.message);
        console.error("ERROR config used:", JSON.stringify(config, null, 2));
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
