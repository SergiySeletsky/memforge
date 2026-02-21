/**
 * GET /api/v1/apps/:appId/memories
 * Spec 00: Memgraph port
 */
import { NextRequest, NextResponse } from "next/server";
import { runRead } from "@/lib/db/memgraph";

type RouteParams = { params: Promise<{ appId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
  const { appId } = await params;
  const url = new URL(request.url);
  const userId = url.searchParams.get("user_id");
  const page = parseInt(url.searchParams.get("page") || "1", 10);
  const pageSize = parseInt(url.searchParams.get("page_size") || "20", 10);
  const skip = (page - 1) * pageSize;

  const userClause = userId ? `AND u.userId = $userId` : "";
  const rows = await runRead(
    `MATCH (u:User)-[:HAS_MEMORY]->(m:Memory)-[:CREATED_BY]->(a:App)
     WHERE (a.appName = $appId OR a.id = $appId)
     AND m.state = 'active' ${userClause}
     WITH m, a
     OPTIONAL MATCH (m)-[:HAS_CATEGORY]->(c:Category)
     WITH m, a, collect(c.name) AS categories
     RETURN m.id AS id, m.content AS content, m.state AS state,
            m.createdAt AS createdAt, m.metadata AS metadata,
            a.appName AS app_name, categories
     ORDER BY createdAt DESC SKIP $skip LIMIT $limit`,
    { appId, userId: userId || "", skip, limit: pageSize }
  );
  const countRows = await runRead(
    `MATCH (:User)-[:HAS_MEMORY]->(m:Memory)-[:CREATED_BY]->(a:App)
     WHERE (a.appName = $appId OR a.id = $appId)
     AND m.state = 'active' RETURN count(m) AS total`,
    { appId }
  );
  const total = (countRows[0] as any)?.total ?? 0;
  return NextResponse.json({
    total, page, page_size: pageSize,
    memories: rows.map((r: any) => ({
      id: r.id, content: r.content,
      created_at: r.createdAt || null,
      state: r.state || "active", app_id: null, app_name: r.app_name ?? appId,
      categories: r.categories || [],
      metadata_: r.metadata ? (typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata) : null,
    })),
  });
  } catch (e: any) {
    console.error("[apps/memories]", e);
    return NextResponse.json({ detail: e.message }, { status: 500 });
  }
}
