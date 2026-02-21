/**
 * POST /api/v1/memories/search -- Hybrid search endpoint
 *
 * Spec 02: Combined full-text + vector search with RRF merging.
 * Returns ranked results with rrfScore, textRank, vectorRank per result.
 */
import { NextRequest, NextResponse } from "next/server";
import { hybridSearch } from "@/lib/search/hybrid";
import { runWrite } from "@/lib/db/memgraph";
import { z } from "zod";

const SearchRequestSchema = z.object({
  query: z.string().min(1),
  user_id: z.string(),
  app_name: z.string().optional().default("openmemory"),
  top_k: z.number().int().min(1).max(50).optional().default(10),
  mode: z.enum(["hybrid", "text", "vector"]).optional().default("hybrid"),
});

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = SearchRequestSchema.parse(await req.json());
  } catch (e: any) {
    return NextResponse.json({ detail: e.errors ?? e.message }, { status: 400 });
  }

  try {
    const results = await hybridSearch(body.query, {
      userId: body.user_id,
      topK: body.top_k,
      mode: body.mode,
    });

    // Log ACCESSED relationships for each result — batch write to avoid concurrent MERGE races
    if (results.length > 0) {
      const now = new Date().toISOString();
      const appName = body.app_name;
      const memoryIds = results.map(r => r.id);
      runWrite(
        `MERGE (a:App {appName: $appName})
         WITH a
         MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory)
         WHERE m.id IN $ids
         CREATE (a)-[:ACCESSED {accessedAt: $accessedAt, queryUsed: $query}]->(m)`,
        { appName, userId: body.user_id, ids: memoryIds, accessedAt: now, query: body.query }
      ).catch(() => {/* non-critical */});
    }

    return NextResponse.json({
      query: body.query,
      results,
      total: results.length,
    });
  } catch (e: any) {
    console.error("POST /memories/search error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
