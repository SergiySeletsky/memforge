/**
 * Shared config helpers — get/save config from DB, default config
 *
 * Port of openmemory/api/app/routers/config.py (helper functions)
 */
import { getDb } from "@/lib/db";
import { configs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export function getDefaultConfiguration() {
  return {
    openmemory: {
      custom_instructions: null as string | null,
    },
    mem0: {
      llm: {
        provider: "azure_openai",
        config: {
          model: "gpt-4.1-mini",
          temperature: 0.1,
          max_tokens: 2000,
          azure_kwargs: {
            api_key: "env:LLM_AZURE_OPENAI_API_KEY",
            azure_endpoint: "env:LLM_AZURE_ENDPOINT",
            azure_deployment: "env:LLM_AZURE_DEPLOYMENT",
            api_version: "env:LLM_AZURE_API_VERSION",
          },
        },
      },
      embedder: {
        provider: "azure_openai",
        config: {
          model: "text-embedding-3-small",
          embedding_dims: 1536,
          azure_kwargs: {
            api_key: "env:EMBEDDING_AZURE_OPENAI_API_KEY",
            azure_endpoint: "env:EMBEDDING_AZURE_ENDPOINT",
            azure_deployment: "env:EMBEDDING_AZURE_DEPLOYMENT",
            api_version: "env:EMBEDDING_AZURE_API_VERSION",
          },
        },
      },
      vector_store: null as Record<string, unknown> | null,
    },
  };
}

export type AppConfig = ReturnType<typeof getDefaultConfiguration>;

export function getConfigFromDb(key = "main"): AppConfig {
  const db = getDb();
  const row = db.select().from(configs).where(eq(configs.key, key)).get();

  if (!row) {
    const defaultConfig = getDefaultConfiguration();
    db.insert(configs).values({ key, value: defaultConfig }).run();
    return defaultConfig;
  }

  const configValue = row.value as any;
  const defaultConfig = getDefaultConfiguration();

  // Merge with defaults
  if (!configValue.openmemory) configValue.openmemory = defaultConfig.openmemory;
  if (!configValue.mem0) {
    configValue.mem0 = defaultConfig.mem0;
  } else {
    if (!configValue.mem0.llm) configValue.mem0.llm = defaultConfig.mem0.llm;
    if (!configValue.mem0.embedder) configValue.mem0.embedder = defaultConfig.mem0.embedder;
    if (!("vector_store" in configValue.mem0))
      configValue.mem0.vector_store = defaultConfig.mem0.vector_store;
  }

  return configValue;
}

export function saveConfigToDb(config: AppConfig, key = "main"): AppConfig {
  const db = getDb();
  const existing = db.select().from(configs).where(eq(configs.key, key)).get();

  if (existing) {
    db.update(configs)
      .set({ value: config, updatedAt: new Date().toISOString() })
      .where(eq(configs.key, key))
      .run();
  } else {
    db.insert(configs).values({ key, value: config }).run();
  }

  return config;
}

export function deepUpdate(source: any, overrides: any): any {
  for (const key of Object.keys(overrides)) {
    if (
      typeof overrides[key] === "object" &&
      overrides[key] !== null &&
      !Array.isArray(overrides[key]) &&
      typeof source[key] === "object" &&
      source[key] !== null
    ) {
      source[key] = deepUpdate(source[key], overrides[key]);
    } else {
      source[key] = overrides[key];
    }
  }
  return source;
}
