/**
 * Hybrid search orchestrator -- Spec 02
 *
 * Combines full-text search (Memgraph text_search) and vector similarity
 * (Memgraph vector_search) using Reciprocal Rank Fusion.
 *
 * Modes:
 *   "hybrid"  -- both arms, merged via RRF (default)
 *   "text"    -- text_search only
 *   "vector"  -- vector_search only
 *
 * All results are hydrated with content, categories, and appName via a
 * single Cypher round-trip after ranking.
 */

import { textSearch } from "./text";
import { vectorSearch } from "./vector";
import { reciprocalRankFusion, type RRFResult } from "./rrf";
import { runRead } from "@/lib/db/memgraph";
// SEARCH-01 fix: pre-import rerank/mmr at module level to avoid first-call dynamic import latency
import { crossEncoderRerank } from "./rerank";
import { mmrRerank } from "./mmr";

export type SearchMode = "hybrid" | "text" | "vector";

export interface HybridSearchOptions {
  userId: string;
  topK?: number;
  mode?: SearchMode;
  candidateSize?: number;
  /** Post-retrieval reranking strategy. Default: "none" */
  rerank?: "none" | "cross_encoder" | "mmr";
  /** How many final results to return after reranking. Defaults to topK. */
  rerankTopN?: number;
}

export interface HybridSearchResult extends RRFResult {
  content: string;
  categories: string[];
  tags: string[];
  createdAt: string;
  appName: string | null;
}

/**
 * Run a hybrid search over a user's memories and return ranked,
 * hydrated results.
 */
export async function hybridSearch(
  query: string,
  opts: HybridSearchOptions
): Promise<HybridSearchResult[]> {
  const { userId, topK = 10, mode = "hybrid", candidateSize = 20 } = opts;

  // Run search arms in parallel where both are needed
  const [textResults, vectorResults] = await Promise.all([
    mode !== "vector"
      ? textSearch(query, userId, candidateSize).catch((err) => {
          // Memgraph text search requires --experimental-enabled='text-search'.
          // Fall back to empty results so vector arm still works.
          console.warn("[hybrid] text search unavailable, falling back to vector-only:", err?.message ?? err);
          return [] as { id: string; rank: number }[];
        })
      : Promise.resolve([]),
    mode !== "text"
      ? vectorSearch(query, userId, candidateSize)
      : Promise.resolve([]),
  ]);

  // Merge rankings
  let merged: RRFResult[];
  if (mode === "text") {
    merged = textResults
      .slice(0, topK)
      .map((r) => ({ id: r.id, rrfScore: 0, textRank: r.rank, vectorRank: null }));
  } else if (mode === "vector") {
    merged = vectorResults
      .slice(0, topK)
      .map((r) => ({ id: r.id, rrfScore: 0, textRank: null, vectorRank: r.rank }));
  } else {
    merged = reciprocalRankFusion(textResults, vectorResults, topK);
  }

  const ids = merged.map((r) => r.id);
  if (ids.length === 0) return [];

  // Hydrate all result nodes in one Cypher round-trip
  // SEARCH-HYDRATE-NO-BITEMPORAL fix: guard with invalidAt IS NULL
  const rows = await runRead(
    `UNWIND $ids AS memId
     MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: memId})
     WHERE m.invalidAt IS NULL
     OPTIONAL MATCH (m)-[:CREATED_BY]->(a:App)
     OPTIONAL MATCH (m)-[:HAS_CATEGORY]->(c:Category)
     RETURN m.id AS id, m.content AS content, m.createdAt AS createdAt,
            a.appName AS appName, collect(c.name) AS categories,
            coalesce(m.tags, []) AS tags`,
    { ids, userId }
  );

  const rowMap = new Map(rows.map((r) => [r.id as string, r]));

  const hydrated = merged
    .map((r) => {
      const row = rowMap.get(r.id);
      if (!row) return null;
      return {
        ...r,
        content: row.content as string,
        categories: (row.categories as string[]) ?? [],
        tags: (row.tags as string[]) ?? [],
        createdAt: (row.createdAt as string) ?? "",
        appName: (row.appName as string | null) ?? null,
      } as HybridSearchResult;
    })
    .filter((r): r is HybridSearchResult => r !== null);

  const rerankTopN = opts.rerankTopN ?? topK;

  if (opts.rerank === "cross_encoder") {
    const reranked = await crossEncoderRerank(
      query,
      hydrated as unknown as Parameters<typeof crossEncoderRerank>[1],
      rerankTopN
    );
    return reranked as unknown as HybridSearchResult[];
  }

  if (opts.rerank === "mmr") {
    return mmrRerank(
      hydrated as unknown as Parameters<typeof mmrRerank>[0],
      rerankTopN
    ) as unknown as HybridSearchResult[];
  }

  return hydrated;
}
