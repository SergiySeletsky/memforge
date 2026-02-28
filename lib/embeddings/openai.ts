/**
 * lib/embeddings/openai.ts â€” Embedding provider router (Spec 00 / Spec 10)
 *
 * Selects the active embedding backend based on EMBEDDING_PROVIDER env var:
 *
 *   EMBEDDING_PROVIDER=intelli  (default) â†’ serhiiseletskyi/intelli-embed-v3
 *     Requires: nothing (model auto-downloaded on first call, ~542 MB INT8 ONNX)
 *     Dims:     1024 (CLS pooling, L2-normalized)
 *     Benchmark: Sep=0.505, beats azure-large on 5/6 MemForge metrics
 *
 *   EMBEDDING_PROVIDER=azure  â†’ Azure AI Foundry text-embedding-3-small
 *     Requires: EMBEDDING_AZURE_OPENAI_API_KEY + EMBEDDING_AZURE_ENDPOINT
 *     Dims:     1536 (or EMBEDDING_DIMS override)
 *
 *   EMBEDDING_PROVIDER=nomic  â†’ nomic-ai/nomic-embed-text-v1.5 (local CPU, offline)
 *     Requires: nothing (model auto-downloaded on first call, ~120 MB)
 *     Dims:     768 (or EMBEDDING_DIMS override for Matryoshka sub-dims)
 *
 * âš ï¸  IMPORTANT: Changing EMBEDDING_PROVIDER changes the vector dimension.
 *     This requires dropping and recreating Memgraph vector indexes AND
 *     re-embedding all stored memories.  See AGENTS.md for migration steps.
 *
 * All other modules must import from THIS file (not from azure/nomic directly)
 * so mock setup in tests (`jest.mock("@/lib/embeddings/openai")`) works correctly.
 */

const _providerName = (process.env.EMBEDDING_PROVIDER ?? "intelli").toLowerCase();

// --- Lazy provider resolution (avoids loading both at module init) ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _impl: any | null = null;

async function getImpl() {
  if (!_impl) {
    if (_providerName === "nomic") {
      _impl = await import("./nomic");
    } else if (_providerName === "azure") {
      _impl = await import("./azure");
    } else {
      // Default: intelli-embed-v3 (local ONNX via transformers.js)
      _impl = await import("./intelli");
    }
  }
  return _impl;
}

// --- Synchronous constants (evaluated at module load time) ------------------

export const EMBED_MODEL: string =
  _providerName === "nomic"
    ? "nomic-ai/nomic-embed-text-v1.5"
    : _providerName === "azure"
      ? (process.env.EMBEDDING_AZURE_DEPLOYMENT ?? "text-embedding-3-small")
      : "serhiiseletskyi/intelli-embed-v3";

export const EMBED_DIM: number =
  _providerName === "nomic"
    ? parseInt(process.env.EMBEDDING_DIMS ?? "768", 10)
    : _providerName === "azure"
      ? parseInt(process.env.EMBEDDING_DIMS ?? "1536", 10)
      : parseInt(process.env.EMBEDDING_DIMS ?? "1024", 10);

// --- Async embedding functions ----------------------------------------------

/**
 * Generate an embedding vector for a single text string.
 * Returns a number[] of length EMBED_DIM.
 */
export async function embed(text: string): Promise<number[]> {
  const impl = await getImpl();
  return impl.embed(text);
}

/**
 * Generate embeddings for multiple texts (batched where the provider supports it).
 * Returns arrays in the same order as the input.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const impl = await getImpl();
  return impl.embedBatch(texts);
}

/**
 * Validate the active embedding provider is reachable.
 * Returns provider name, dimension, and health status.
 */
export async function checkEmbeddingHealth(): Promise<{
  provider: string;
  model: string;
  dim: number;
  ok: boolean;
  latencyMs: number;
  error?: string;
}> {
  const impl = await getImpl();
  const result = await impl.healthCheck();
  return { provider: _providerName, model: EMBED_MODEL, dim: EMBED_DIM, ...result };
}
