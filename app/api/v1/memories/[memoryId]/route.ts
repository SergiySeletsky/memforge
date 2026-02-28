/**
 * GET /api/v1/memories/:memoryId — get single memory
 * PUT /api/v1/memories/:memoryId — update memory text
 * Spec 00: Memgraph port
 * Spec 09: Namespace isolation — all queries anchored to User node
 */
import { NextRequest, NextResponse } from "next/server";
import { runRead } from "@/lib/db/memgraph";
import { supersedeMemory } from "@/lib/memory/write";

type RouteParams = { params: Promise<{ memoryId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { memoryId } = await params;
  // Spec 09: require user_id for ownership verification
  const userId =
    request.nextUrl.searchParams.get("user_id") ??
    request.headers.get("x-user-id") ??
    null;
  if (!userId || userId.trim() === "") {
    return NextResponse.json({ detail: "user_id is required" }, { status: 400 });
  }
  // Spec 09: anchored traversal — Memory unreachable from wrong User returns [] → 404
  const rows = await runRead<{ id: string; content: string; state: string; createdAt: string; metadata: string | null; validAt: string | null; invalidAt: string | null; appName: string | null; categories: string[]; supersededBy: string | null }>(
    `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $memoryId})
     OPTIONAL MATCH (m)-[:CREATED_BY]->(a:App)
     OPTIONAL MATCH (m)-[:HAS_CATEGORY]->(c:Category)
     OPTIONAL MATCH (newer:Memory)-[:SUPERSEDES]->(m)
     RETURN m.id AS id, m.content AS content, m.state AS state,
            m.createdAt AS createdAt, m.metadata AS metadata,
            m.validAt AS validAt, m.invalidAt AS invalidAt,
            a.appName AS appName, collect(c.name) AS categories,
            newer.id AS supersededBy`,
    { userId: userId.trim(), memoryId }
  );
  if (!rows.length) {
    return NextResponse.json({ detail: "Memory not found" }, { status: 404 });
  }
  const r = rows[0];
  return NextResponse.json({
    id: r.id,
    text: r.content,
    created_at: r.createdAt ? Math.floor(new Date(r.createdAt).getTime() / 1000) : 0,
    state: r.state || "active",
    app_id: null,
    app_name: r.appName || null,
    categories: r.categories || [],
    metadata_: r.metadata ? JSON.parse(r.metadata) : null,
    valid_at: r.validAt || null,
    invalid_at: r.invalidAt || null,
    is_current: r.invalidAt == null,
    superseded_by: r.supersededBy || null,
  });
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { memoryId } = await params;
  const body = await request.json();
  const text = body.memory_content || body.text;
  const user_id = body.user_id;
  const app_name = body.app_name || body.app || "memforge";
  if (!text || !user_id) {
    return NextResponse.json({ detail: "text and user_id are required" }, { status: 400 });
  }
  // Spec 09: verify ownership — memory must belong to this user
  const ownerCheck = await runRead(
    `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $memoryId}) RETURN m.id AS id`,
    { userId: user_id, memoryId }
  );
  if (!ownerCheck.length) {
    return NextResponse.json({ detail: "Memory not found" }, { status: 404 });
  }
  // Spec 01: use temporal supersession instead of in-place update
  const newId = await supersedeMemory(memoryId, text, user_id, app_name);
  // Spec 09: anchored lookup of the just-created node
  const rows = await runRead<{ id: string; content: string; state: string; createdAt: string; validAt: string | null; metadata: string | null; appName: string | null; categories: string[] }>(
    `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $id})
     OPTIONAL MATCH (m)-[:CREATED_BY]->(a:App)
     OPTIONAL MATCH (m)-[:HAS_CATEGORY]->(c:Category)
     RETURN m.id AS id, m.content AS content, m.state AS state,
            m.createdAt AS createdAt, m.validAt AS validAt,
            m.metadata AS metadata,
            a.appName AS appName, collect(c.name) AS categories`,
    { userId: user_id, id: newId }
  );
  const r = rows[0] ?? { id: newId, content: text, state: "active", createdAt: "", validAt: null, metadata: null, appName: null, categories: [] as string[] };
  return NextResponse.json({
    id: r.id ?? newId,
    content: r.content ?? text,
    created_at: r.createdAt ? Math.floor(new Date(r.createdAt).getTime() / 1000) : 0,
    state: r.state || "active",
    app_id: null,
    app_name: r.appName || null,
    categories: r.categories || [],
    metadata_: r.metadata ? JSON.parse(r.metadata) : null,
    valid_at: r.validAt || null,
    invalid_at: null,
    is_current: true,
  });
}
