/**
 * Vector search wrapper -- Spec 02
 *
 * Wraps the Memgraph vector_search.search() procedure, using the
 * `memory_vectors` index (1536-dim cosine, created in Spec 00 initSchema).
 *
 * Returns results in cosine similarity order with 1-based rank.
 * Bi-temporal filter: only returns memories where invalidAt IS NULL.
 */

import { runRead } from "@/lib/db/memgraph";
import { ensureVectorIndexes } from "@/lib/db/memgraph";
import { embed } from "@/lib/embeddings/openai";

export interface VectorResult {
  id: string;
  /** 1-based position in vector_search result set */
  rank: number;
  /** Raw cosine similarity (0–1) */
  score: number;
}

/**
 * Semantic search over a user's memories using the Memgraph vector index.
 *
 * @param query   Natural-language query string (will be embedded)
 * @param userId  Scope results to this user
 * @param limit   Maximum number of results to return (default 20)
 */
export async function vectorSearch(
  query: string,
  userId: string,
  limit = 20
): Promise<VectorResult[]> {
  try {
    // Ensure vector index exists (no-op after first successful check)
    await ensureVectorIndexes();

    const embedding = await embed(query);
    const records = await runRead(
      `CALL vector_search.search("memory_vectors", toInteger($fetchLimit), $embedding)
       YIELD node, similarity
       MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(node)
       WHERE node.invalidAt IS NULL AND node.state <> 'deleted'
       RETURN node.id AS id, similarity
       ORDER BY similarity DESC
       LIMIT $limit`,
      { userId, fetchLimit: limit * 2, limit, embedding }
    );
    return records.map((r, i) => ({
      id: r.id as string,
      rank: i + 1,
      score: (r.similarity as number) ?? 0,
    }));
  } catch (e) {
    console.error("[vectorSearch] error:", e);
    return [];
  }
}
