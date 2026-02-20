/**
 * GET /api/v1/apps/:appId/memories — list memories created by this app
 *
 * Port of openmemory/api/app/routers/apps.py (GET /{app_id}/memories)
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apps, memories, categories, memoryCategories, type MemoryState } from "@/lib/db/schema";
import { eq, and, inArray, desc, count } from "drizzle-orm";

type RouteParams = { params: Promise<{ appId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { appId } = await params;
  const sp = request.nextUrl.searchParams;
  const page = Math.max(1, Number(sp.get("page") || "1"));
  const pageSize = Math.min(100, Math.max(1, Number(sp.get("page_size") || "10")));

  const db = getDb();

  const app = db.select().from(apps).where(eq(apps.id, appId)).get();
  if (!app) {
    return NextResponse.json({ detail: "App not found" }, { status: 404 });
  }

  const activeStates: MemoryState[] = ["active", "paused", "archived"];
  const totalResult = db
    .select({ count: count() })
    .from(memories)
    .where(and(eq(memories.appId, appId), inArray(memories.state, activeStates)))
    .get();

  const rows = db
    .select()
    .from(memories)
    .where(and(eq(memories.appId, appId), inArray(memories.state, activeStates)))
    .orderBy(desc(memories.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  const items = rows.map((mem) => {
    const cats = db
      .select({ name: categories.name })
      .from(memoryCategories)
      .innerJoin(categories, eq(memoryCategories.categoryId, categories.id))
      .where(eq(memoryCategories.memoryId, mem.id))
      .all();

    return {
      id: mem.id,
      content: mem.content,
      created_at: mem.createdAt,
      state: mem.state || "active",
      app_id: mem.appId,
      categories: cats.map((c) => c.name),
      metadata_: mem.metadata,
    };
  });

  return NextResponse.json({
    total: totalResult?.count || 0,
    page,
    page_size: pageSize,
    memories: items,
  });
}
