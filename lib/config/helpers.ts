/**
 * Shared config helpers â€” reads/writes config from Memgraph Config nodes.
 *
 * Config nodes: (c:Config {key, value}) where value is a JSON string.
 * Top-level keys: "memforge" and "memforge_ext".
 */
import { runRead, runWrite } from "@/lib/db/memgraph";
// ---------------------------------------------------------------------------
// TTL cache for config reads — avoids Memgraph round-trip on every addMemory
// ---------------------------------------------------------------------------

const CONFIG_TTL_MS = 30_000; // 30 seconds

let _configCache: { config: AppConfig; expiresAt: number } | null = null;

/** Invalidate the config cache (call after writes). */
export function invalidateConfigCache(): void {
  _configCache = null;
}
export function getDefaultConfiguration() {
  return {
    memforge: {} as {
      dedup?: { enabled?: boolean; threshold?: number; azureThreshold?: number; intelliThreshold?: number };
      context_window?: { enabled?: boolean; size?: number };
      [key: string]: unknown;
    },

    memforge_ext: {
      vector_store: null as Record<string, unknown> | null,
    },
  };
}

export type AppConfig = ReturnType<typeof getDefaultConfiguration>;

/** Read full config from Memgraph, merging with defaults. TTL-cached for 30s. */
export async function getConfigFromDb(): Promise<AppConfig> {
  // CONFIG-NO-TTL-CACHE fix: return cached value when fresh
  if (_configCache && Date.now() < _configCache.expiresAt) {
    return _configCache.config;
  }
  try {
    const rows = await runRead<{ key: string; value: string }>(
      `MATCH (c:Config) RETURN c.key AS key, c.value AS value`,
      {}
    );
    const result: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        result[r.key] = JSON.parse(r.value);
      } catch {
        result[r.key] = r.value;
      }
    }
    const defaults = getDefaultConfiguration();
    const config = {
      memforge: (result.memforge as AppConfig["memforge"]) ?? defaults.memforge,
      memforge_ext: (result.memforge_ext as AppConfig["memforge_ext"]) ?? defaults.memforge_ext,
    };
    _configCache = { config, expiresAt: Date.now() + CONFIG_TTL_MS };
    return config;
  } catch {
    return getDefaultConfiguration();
  }
}

/** Persist config to Memgraph, one Config node per top-level key. */
export async function saveConfigToDb(config: AppConfig): Promise<AppConfig> {
  for (const [key, value] of Object.entries(config)) {
    await runWrite(
      `MERGE (c:Config {key: $key}) SET c.value = $value`,
      { key, value: JSON.stringify(value) }
    );
  }
  // Invalidate TTL cache after write so next read picks up fresh data
  invalidateConfigCache();
  return config;
}

export function deepUpdate(source: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(overrides)) {
    if (
      typeof overrides[key] === "object" &&
      overrides[key] !== null &&
      !Array.isArray(overrides[key]) &&
      typeof source[key] === "object" &&
      source[key] !== null
    ) {
      source[key] = deepUpdate(source[key] as Record<string, unknown>, overrides[key] as Record<string, unknown>);
    } else {
      source[key] = overrides[key];
    }
  }
  return source;
}

// ---------------------------------------------------------------------------
// Dedup config â€” Spec 03
// ---------------------------------------------------------------------------

export interface DedupConfig {
  enabled: boolean;
  threshold: number;        // cosine similarity threshold 0â€“1 (default provider)
  azureThreshold: number;   // Azure-specific threshold (lower: supSim=0.613 on text-embedding-3-small)
  intelliThreshold: number; // intelli-embed-v3-specific threshold (supSim=0.580)
}

/**
 * Read dedup configuration from Memgraph config or return safe defaults.
 * Keyed under memforge.dedup in the config JSON.
 *
 * Default threshold lowered from 0.85 to 0.75 (Eval v4 Finding 4) to catch
 * paraphrased/semantically-equivalent content. LLM verification in Stage 2
 * prevents false-positive dedup at this lower threshold.
 */
export async function getDedupConfig(): Promise<DedupConfig> {
  try {
    const raw = await getConfigFromDb();
    const dedupCfg = raw?.memforge?.dedup ?? {};
    return {
      enabled: dedupCfg.enabled ?? true,
      threshold: dedupCfg.threshold ?? 0.75,
      azureThreshold: dedupCfg.azureThreshold ?? 0.55,
      intelliThreshold: dedupCfg.intelliThreshold ?? 0.55,
    };
  } catch {
    return { enabled: true, threshold: 0.75, azureThreshold: 0.55, intelliThreshold: 0.55 };
  }
}

// ---------------------------------------------------------------------------
// Context window config â€” Spec 05
// ---------------------------------------------------------------------------

export interface ContextWindowConfig {
  enabled: boolean;
  size: number; // max memories to include as context (0 = disabled)
}

/**
 * Read context window configuration from Memgraph config or return safe defaults.
 * Keyed under memforge.context_window in the config JSON.
 */
export async function getContextWindowConfig(): Promise<ContextWindowConfig> {
  try {
    const raw = await getConfigFromDb();
    const ctx = raw?.memforge?.context_window ?? {};
    return {
      enabled: ctx.enabled ?? true,
      size: Math.min(50, Math.max(0, ctx.size ?? 10)),
    };
  } catch {
    return { enabled: true, size: 10 };
  }
}
