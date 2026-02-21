/**
 * GET /api/v1/memories/:memoryId/related
 * Returns memories sharing at least one category with the given memory.
 * Spec 00: Memgraph port
 * Spec 09: Namespace isolation — all queries anchored to User node
 */
import { NextRequest, NextResponse } from "next/server";
import { runRead } from "@/lib/db/memgraph";

type RouteParams = { params: Promise<{ memoryId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { memoryId } = await params;
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get("limit") || "5", 10);

  // Spec 09: require user_id for ownership verification
  const userId =
    url.searchParams.get("user_id") ??
    request.headers.get("x-user-id") ??
    null;
  if (!userId || userId.trim() === "") {
    return NextResponse.json({ detail: "user_id is required" }, { status: 400 });
  }

  // Spec 09: First confirm ownership — the anchored path returns nothing for wrong user
  const ownerCheck = await runRead(
    `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $memoryId})
     RETURN m.id AS id`,
    { userId: userId.trim(), memoryId }
  );
  if (!ownerCheck.length) {
    // Memory doesn't belong to this user (or doesn't exist) — return 404, not 403
    return NextResponse.json({ detail: "Memory not found" }, { status: 404 });
  }

  // Safe to query related memories; also scope to same user
  const rows = await runRead(
    `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $memoryId})
     MATCH (u)-[:HAS_MEMORY]->(other:Memory)-[:HAS_CATEGORY]->(c:Category)<-[:HAS_CATEGORY]-(m)
     WHERE other.id <> $memoryId AND other.state = 'active'
     WITH other, count(c) AS shared ORDER BY shared DESC LIMIT $limit
     OPTIONAL MATCH (other)-[:CREATED_BY]->(a:App)
     OPTIONAL MATCH (other)-[:HAS_CATEGORY]->(cat:Category)
     RETURN other.id AS id, other.content AS content, other.state AS state,
            other.createdAt AS createdAt, a.appName AS appName,
            collect(cat.name) AS categories, shared`,
    { userId: userId.trim(), memoryId, limit }
  );
  return NextResponse.json({
    items: rows.map((r: any) => ({
      id: r.id,
      content: r.content,
      created_at: r.createdAt ? Math.floor(new Date(r.createdAt).getTime() / 1000) : 0,
      state: r.state || "active",
      app_id: null,
      app_name: r.appName || null,
      categories: r.categories || [],
      metadata_: null,
    })),
    total: rows.length,
    page: 1,
    size: rows.length,
    pages: 1,
  });
}
