/**
 * GET /api/v1/memories â€” list memories (paginated, filtered)
 * POST /api/v1/memories â€” create a new memory
 * DELETE /api/v1/memories â€” bulk delete memories
 *
 * Spec 00: Memgraph port â€” replaces SQLite/Drizzle + mem0ai SDK
 * Spec 01: Bi-temporal query params (include_superseded, as_of)
 * Spec 02: search_query uses hybridSearch() instead of LIKE
 * Spec 03: POST pre-write deduplication hook
 * Spec 04: POST async entity extraction (fire-and-forget)
 */
import { NextRequest, NextResponse } from "next/server";
import { runRead, runWrite } from "@/lib/db/memgraph";
import { addMemory, supersedeMemory } from "@/lib/memory/write";
import { listMemories } from "@/lib/memory/search";
import { hybridSearch } from "@/lib/search/hybrid";
import { checkDeduplication } from "@/lib/dedup";
import { processEntityExtraction } from "@/lib/entities/worker";
import {
  CreateMemoryRequestSchema,
  DeleteMemoriesRequestSchema,
  buildPageResponse,
  type MemoryResponse,
} from "@/lib/validation";

// ---------- GET /api/v1/memories ----------
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const userId = sp.get("user_id");
  if (!userId) {
    return NextResponse.json({ detail: "user_id is required" }, { status: 400 });
  }

  const appId = sp.get("app_id") ?? undefined;
  const categoriesParam = sp.get("categories");
  const searchQuery = sp.get("search_query") ?? undefined;
  const page = Math.max(1, Number(sp.get("page") || "1"));
  const size = Math.min(100, Math.max(1, Number(sp.get("size") || "10")));
  // Spec 01: bi-temporal query params
  const includeSuperseeded = sp.get("include_superseded") === "true";
  const asOf = sp.get("as_of") ?? undefined;

  try {
    // Spec 02: hybrid search when search_query is provided
    if (searchQuery) {
      const searchResults = await hybridSearch(searchQuery, {
        userId,
        topK: size * page, // fetch enough to cover requested page
        mode: "hybrid",
      });
      if (searchResults.length === 0) {
        return NextResponse.json(buildPageResponse([], 0, page, size));
      }
      const allIds = searchResults.map((r) => r.id);
      const pageIds = allIds.slice((page - 1) * size, page * size);

      // Batch-fetch categories for all page results in one round-trip (API-01)
      const allCatRowsSearch = await runRead<{ id: string; name: string }>(
        `UNWIND $ids AS memId
         MATCH (m:Memory {id: memId})-[:HAS_CATEGORY]->(c:Category)
         RETURN memId AS id, c.name AS name`,
        { ids: pageIds }
      ).catch(() => []);
      const catsByMemorySearch = new Map<string, string[]>();
      for (const row of allCatRowsSearch) {
        const list = catsByMemorySearch.get(row.id) ?? [];
        list.push(row.name);
        catsByMemorySearch.set(row.id, list);
      }

      const items: MemoryResponse[] = [];
      for (const result of searchResults.filter((r) => pageIds.includes(r.id))) {
        const catNames = catsByMemorySearch.get(result.id) ?? [];

        if (categoriesParam) {
          const catList = categoriesParam.split(",").map((c) => c.trim());
          if (!catList.some((c) => catNames.includes(c))) continue;
        }

        items.push({
          id: result.id,
          content: result.content,
          created_at: result.createdAt
            ? Math.floor(new Date(result.createdAt).getTime() / 1000)
            : 0,
          state: "active",
          app_id: null,
          app_name: result.appName || null,
          categories: catNames,
          metadata_: null,
        });
      }
      return NextResponse.json(buildPageResponse(items, allIds.length, page, size));
    }
    const { memories, total } = await listMemories({
      userId,
      appName: appId,
      page,
      pageSize: size,
      includeSuperseeded,
      asOf,
    });

    // Batch-fetch categories for all memories in one round-trip (API-01)
    const memIds = memories.map((m) => m.id);
    const allCatRowsList = memIds.length > 0
      ? await runRead<{ id: string; name: string }>(
          `UNWIND $ids AS memId
           MATCH (m:Memory {id: memId})-[:HAS_CATEGORY]->(c:Category)
           RETURN memId AS id, c.name AS name`,
          { ids: memIds }
        ).catch(() => [])
      : [];
    const catsByMemoryList = new Map<string, string[]>();
    for (const row of allCatRowsList) {
      const list = catsByMemoryList.get(row.id) ?? [];
      list.push(row.name);
      catsByMemoryList.set(row.id, list);
    }

    const items: MemoryResponse[] = [];
    for (const mem of memories) {
      const catNames = catsByMemoryList.get(mem.id) ?? [];

      if (categoriesParam) {
        const catList = categoriesParam.split(",").map((c) => c.trim());
        if (!catList.some((c) => catNames.includes(c))) continue;
      }

      const createdAtTs = mem.createdAt
        ? Math.floor(new Date(mem.createdAt as string).getTime() / 1000)
        : 0;

      items.push({
        id: mem.id,
        content: mem.content,
        created_at: createdAtTs,
        state: mem.state || "active",
        app_id: null,
        app_name: mem.appName || null,
        categories: catNames,
        metadata_: mem.metadata ? JSON.parse(mem.metadata as string) : null,
        valid_at: mem.validAt || null,
        invalid_at: mem.invalidAt || null,
        is_current: mem.invalidAt == null,
      });
    }

    return NextResponse.json(buildPageResponse(items, total, page, size));
  } catch (e: unknown) {
    console.error("GET /memories error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// ---------- POST /api/v1/memories ----------
export async function POST(request: NextRequest) {
  let body: { user_id: string; text: string; metadata?: Record<string, unknown>; infer?: boolean; app?: string };
  try {
    body = CreateMemoryRequestSchema.parse(await request.json());
  } catch (e: unknown) {
    const detail = e instanceof Error && 'errors' in e ? (e as { errors: unknown }).errors : e instanceof Error ? e.message : String(e);
    return NextResponse.json({ detail }, { status: 400 });
  }

  try {
    if (body.app) {
      const appRows = await runRead<{ isActive: boolean }>(
        `MATCH (u:User {userId: $userId})-[:HAS_APP]->(a:App {appName: $appName})
         RETURN a.isActive AS isActive`,
        { userId: body.user_id, appName: body.app }
      );
      if (appRows.length > 0 && appRows[0].isActive === false) {
        return NextResponse.json(
          { detail: `App ${body.app} is currently paused on MemForge. Cannot create new memories.` },
          { status: 403 }
        );
      }
    }

    // Spec 03: Deduplication pre-write hook
    const dedup = await checkDeduplication(body.text, body.user_id);

    if (dedup.action === "skip") {
      // Return the existing memory without writing a duplicate
      // Spec 09: anchor to User â€” prevents cross-user memory ID probing
      const existing = await runRead(
        `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $id})
         RETURN m.id AS id, m.content AS content, m.state AS state, m.createdAt AS createdAt`,
        { userId: body.user_id, id: dedup.existingId }
      );
      return NextResponse.json({ ...(existing[0] ?? { id: dedup.existingId }), event: "SKIP_DUPLICATE" });
    }

    let id: string;
    if (dedup.action === "supersede") {
      id = await supersedeMemory(dedup.existingId, body.text, body.user_id, body.app);
    } else {
      id = await addMemory(body.text, {
        userId: body.user_id,
        appName: body.app,
        metadata: body.metadata,
      });
    }

    const rows = await runRead(
      `MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: $id})
       OPTIONAL MATCH (m)-[:CREATED_BY]->(a:App)
       RETURN m.id AS id, m.content AS content, m.state AS state,
              m.createdAt AS createdAt, m.metadata AS metadata,
              a.appName AS appName`,
      { userId: body.user_id, id }
    );

    // Spec 04: Async entity extraction â€” fire-and-forget, never blocks API response
    processEntityExtraction(id).catch((e) => console.warn("[entity worker]", e));

    return NextResponse.json(rows[0] ?? { id });
  } catch (e: unknown) {
    console.error("POST /memories error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// ---------- DELETE /api/v1/memories ----------
export async function DELETE(request: NextRequest) {
  let body: { memory_ids: string[]; user_id: string };
  try {
    body = DeleteMemoriesRequestSchema.parse(await request.json());
  } catch (e: unknown) {
    const detail = e instanceof Error && 'errors' in e ? (e as { errors: unknown }).errors : e instanceof Error ? e.message : String(e);
    return NextResponse.json({ detail }, { status: 400 });
  }

  try {
    // API-DELETE-01 fix: batch delete in a single round-trip using UNWIND
    const now = new Date().toISOString();
    const result = await runWrite(
      `UNWIND $ids AS memId
       MATCH (u:User {userId: $userId})-[:HAS_MEMORY]->(m:Memory {id: memId})
       WHERE m.state <> 'deleted'
       SET m.state = 'deleted', m.invalidAt = $now, m.deletedAt = $now
       RETURN m.id AS id`,
      { userId: body.user_id, ids: body.memory_ids, now }
    );
    const deletedCount = result.length;
    return NextResponse.json({ message: `Successfully deleted ${deletedCount} memories` });
  } catch (e: unknown) {
    console.error("DELETE /memories error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
