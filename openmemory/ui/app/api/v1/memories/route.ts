/**
 * GET /api/v1/memories — list memories (paginated, filtered)
 * POST /api/v1/memories — create a new memory
 * DELETE /api/v1/memories — bulk delete memories
 *
 * Port of openmemory/api/app/routers/memories.py (GET /, POST /, DELETE /)
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  memories,
  apps,
  categories,
  memoryCategories,
  memoryStatusHistory,
  type MemoryState,
} from "@/lib/db/schema";
import { eq, and, ne, like, inArray, gte, lte, desc, asc, sql, count } from "drizzle-orm";
import { getOrCreateUser, getOrCreateApp } from "@/lib/db/helpers";
import { getMemoryClient } from "@/lib/mem0/client";
import { categorizeMemory } from "@/lib/mem0/categorize";
import { checkMemoryAccessPermissions } from "@/lib/permissions";
import {
  CreateMemoryRequestSchema,
  DeleteMemoriesRequestSchema,
  buildPageResponse,
  type MemoryResponse,
} from "@/lib/validation";
import { updateMemoryState } from "@/lib/api/helpers";

// ---------- GET /api/v1/memories ----------
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const userId = sp.get("user_id");
  if (!userId) {
    return NextResponse.json({ detail: "user_id is required" }, { status: 400 });
  }

  const db = getDb();
  const user = getOrCreateUser(userId);

  const appIdFilter = sp.get("app_id");
  const fromDate = sp.get("from_date") ? Number(sp.get("from_date")) : null;
  const toDate = sp.get("to_date") ? Number(sp.get("to_date")) : null;
  const categoriesParam = sp.get("categories");
  const searchQuery = sp.get("search_query");
  const sortColumn = sp.get("sort_column");
  const sortDirection = sp.get("sort_direction");
  const page = Math.max(1, Number(sp.get("page") || "1"));
  const size = Math.min(100, Math.max(1, Number(sp.get("size") || "10")));

  // Build conditions
  const conditions: any[] = [
    eq(memories.userId, user.id),
    ne(memories.state, "deleted" as MemoryState),
    ne(memories.state, "archived" as MemoryState),
  ];

  if (searchQuery) {
    conditions.push(like(memories.content, `%${searchQuery}%`));
  }
  if (appIdFilter) {
    conditions.push(eq(memories.appId, appIdFilter));
  }
  if (fromDate) {
    conditions.push(gte(memories.createdAt, new Date(fromDate * 1000).toISOString()));
  }
  if (toDate) {
    conditions.push(lte(memories.createdAt, new Date(toDate * 1000).toISOString()));
  }

  // Count total
  const totalResult = db
    .select({ count: count() })
    .from(memories)
    .where(and(...conditions))
    .get();
  const total = totalResult?.count || 0;

  // Query with joins
  let orderBy = desc(memories.createdAt);
  if (sortColumn === "created_at") {
    orderBy = sortDirection === "asc" ? asc(memories.createdAt) : desc(memories.createdAt);
  } else if (sortColumn === "memory") {
    orderBy = sortDirection === "asc" ? asc(memories.content) : desc(memories.content);
  }

  const rows = db
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(orderBy)
    .limit(size)
    .offset((page - 1) * size)
    .all();

  // Build response items with categories and app name
  const items: MemoryResponse[] = [];
  for (const mem of rows) {
    // Get app name
    const app = db.select().from(apps).where(eq(apps.id, mem.appId)).get();

    // Get categories
    const cats = db
      .select({ name: categories.name })
      .from(memoryCategories)
      .innerJoin(categories, eq(memoryCategories.categoryId, categories.id))
      .where(eq(memoryCategories.memoryId, mem.id))
      .all();

    // Filter by category if requested
    if (categoriesParam) {
      const catList = categoriesParam.split(",").map((c) => c.trim());
      const memCatNames = cats.map((c) => c.name);
      if (!catList.some((c) => memCatNames.includes(c))) continue;
    }

    // Check permissions
    if (!checkMemoryAccessPermissions(mem.state as MemoryState, mem.id, appIdFilter)) {
      continue;
    }

    items.push({
      id: mem.id,
      content: mem.content,
      created_at: mem.createdAt ? Math.floor(new Date(mem.createdAt).getTime() / 1000) : 0,
      state: mem.state || "active",
      app_id: mem.appId,
      app_name: app?.name || null,
      categories: cats.map((c) => c.name),
      metadata_: mem.metadata as Record<string, unknown> | null,
    });
  }

  return NextResponse.json(buildPageResponse(items, total, page, size));
}

// ---------- POST /api/v1/memories ----------
export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = CreateMemoryRequestSchema.parse(await request.json());
  } catch (e: any) {
    return NextResponse.json({ detail: e.errors || e.message }, { status: 400 });
  }

  const db = getDb();
  const user = getOrCreateUser(body.user_id);

  // Get or create app
  let appObj = db
    .select()
    .from(apps)
    .where(and(eq(apps.name, body.app), eq(apps.ownerId, user.id)))
    .get();
  if (!appObj) {
    appObj = db.insert(apps).values({ ownerId: user.id, name: body.app }).returning().get();
  }

  if (!appObj.isActive) {
    return NextResponse.json(
      { detail: `App ${body.app} is currently paused on OpenMemory. Cannot create new memories.` },
      { status: 403 }
    );
  }

  // Get memory client
  let memoryClient: any;
  try {
    memoryClient = getMemoryClient();
    if (!memoryClient) throw new Error("Memory client is not available");
  } catch (clientError: any) {
    return NextResponse.json({ error: clientError.message || String(clientError) });
  }

  // Save to vector store
  try {
    const qdrantResponse = await memoryClient.add(body.text, {
      userId: body.user_id,
      metadata: { source_app: "openmemory", mcp_client: body.app },
      infer: body.infer,
    });

    if (qdrantResponse && typeof qdrantResponse === "object" && "results" in qdrantResponse) {
      const createdMemories: any[] = [];

      for (const result of qdrantResponse.results) {
        // TypeScript SDK puts event in metadata.event; Python SDK puts it top-level
        const event: string = result.event ?? result.metadata?.event ?? "";
        const memoryId = result.id as string;

        if (event === "ADD") {
          const existing = db.select().from(memories).where(eq(memories.id, memoryId)).get();

          if (existing) {
            db.update(memories)
              .set({ state: "active" as MemoryState, content: result.memory, updatedAt: new Date().toISOString() })
              .where(eq(memories.id, memoryId))
              .run();
          } else {
            db.insert(memories)
              .values({
                id: memoryId,
                userId: user.id,
                appId: appObj.id,
                content: result.memory,
                metadata: body.metadata || {},
                state: "active" as MemoryState,
              })
              .run();
          }

          // History entry
          db.insert(memoryStatusHistory)
            .values({
              memoryId,
              changedBy: user.id,
              oldState: "deleted" as MemoryState,
              newState: "active" as MemoryState,
            })
            .run();

          createdMemories.push(memoryId);

          // Async categorization (fire-and-forget)
          categorizeMemory(memoryId, result.memory).catch(() => {});
        } else if (event === "UPDATE") {
          const existing = db.select().from(memories).where(eq(memories.id, memoryId)).get();
          if (existing) {
            db.update(memories)
              .set({ content: result.memory, updatedAt: new Date().toISOString() })
              .where(eq(memories.id, memoryId))
              .run();
            db.insert(memoryStatusHistory)
              .values({
                memoryId,
                changedBy: user.id,
                oldState: existing.state as MemoryState,
                newState: existing.state as MemoryState,
              })
              .run();
          }
          createdMemories.push(memoryId);
        } else if (event === "DELETE") {
          await updateMemoryState(memoryId, "deleted" as MemoryState, user.id);
        }
        // NONE: no change needed
      }

      if (createdMemories.length > 0) {
        const first = db.select().from(memories).where(eq(memories.id, createdMemories[0])).get();
        return NextResponse.json(first);
      }
    }

    return NextResponse.json(qdrantResponse);
  } catch (qdrantError: any) {
    return NextResponse.json({ error: qdrantError.message || String(qdrantError) });
  }
}

// ---------- DELETE /api/v1/memories ----------
export async function DELETE(request: NextRequest) {
  let body: any;
  try {
    body = DeleteMemoriesRequestSchema.parse(await request.json());
  } catch (e: any) {
    return NextResponse.json({ detail: e.errors || e.message }, { status: 400 });
  }

  const user = getOrCreateUser(body.user_id);

  let memoryClient: any;
  try {
    memoryClient = getMemoryClient();
    if (!memoryClient) throw new Error("Memory client is not available");
  } catch (clientError: any) {
    return NextResponse.json(
      { detail: `Memory service unavailable: ${clientError.message}` },
      { status: 503 }
    );
  }

  for (const memoryId of body.memory_ids) {
    try {
      await memoryClient.delete(memoryId);
    } catch (e: any) {
      console.warn(`Failed to delete memory ${memoryId} from vector store:`, e);
    }
    updateMemoryState(memoryId, "deleted", user.id);
  }

  return NextResponse.json({ message: `Successfully deleted ${body.memory_ids.length} memories` });
}
