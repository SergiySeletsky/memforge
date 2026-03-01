import { NextRequest, NextResponse } from "next/server";
import { runRead, runWrite } from "@/lib/db/memgraph";
type RouteParams = { params: Promise<{ appId: string }> };
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { appId } = await params;
  const url = new URL(request.url);
  const userId = url.searchParams.get("user_id");
  if (!userId) return NextResponse.json({ detail: "user_id required" }, { status: 400 });
  const rows = await runRead<{ name: string; id: string; is_active: boolean; created_at: string; memory_count: number }>(
    `MATCH (u:User {userId: $userId})-[:HAS_APP]->(a:App)
     WHERE a.appName = $appId OR a.id = $appId
     OPTIONAL MATCH (u)-[:HAS_MEMORY]->(m:Memory)-[:CREATED_BY]->(a)
     WHERE m.state = 'active' AND m.invalidAt IS NULL
     RETURN a.appName AS name, a.id AS id, a.isActive AS is_active,
            a.createdAt AS created_at, count(m) AS memory_count`,
    { appId, userId }
  );
  if (!rows.length) return NextResponse.json({ detail: "App not found" }, { status: 404 });
  const r = rows[0];
  return NextResponse.json({
    id: r.id,
    name: r.name,
    is_active: r.is_active !== false,
    created_at: r.created_at,
    memory_count: r.memory_count ?? 0,
    total_memories_created: r.memory_count ?? 0,
    total_memories_accessed: 0,
    first_accessed: null,
    last_accessed: null,
  });
}
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { appId } = await params;
  const url = new URL(request.url);
  const userId = url.searchParams.get("user_id");
  if (!userId) return NextResponse.json({ detail: "user_id required" }, { status: 400 });
  const body = await request.json();
  if (typeof body.is_active !== "boolean")
    return NextResponse.json({ detail: "Nothing to update" }, { status: 400 });
  await runWrite(
    `MATCH (u:User {userId: $userId})-[:HAS_APP]->(a:App {appName: $appId})
     SET a.isActive = $isActive`,
    { userId, appId, isActive: body.is_active }
  );
  return NextResponse.json({ message: "App updated" });
}