/**
 * GET /api/v1/apps/:appId/accessed — list memories accessed by this app
 *
 * Port of openmemory/api/app/routers/apps.py (GET /{app_id}/accessed)
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apps, memories, memoryAccessLogs, categories, memoryCategories } from "@/lib/db/schema";
import { eq, desc, count, sql } from "drizzle-orm";

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

  // Get memory IDs with access counts for this app
  const accessedRows = db
    .select({
      memoryId: memoryAccessLogs.memoryId,
      accessCount: count(memoryAccessLogs.id),
    })
    .from(memoryAccessLogs)
    .where(eq(memoryAccessLogs.appId, appId))
    .groupBy(memoryAccessLogs.memoryId)
    .orderBy(desc(count(memoryAccessLogs.id)))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  // Get total distinct memories accessed
  const totalResult = db
    .select({ count: sql<number>`count(distinct ${memoryAccessLogs.memoryId})` })
    .from(memoryAccessLogs)
    .where(eq(memoryAccessLogs.appId, appId))
    .get();

  const items = accessedRows.map((row) => {
    const mem = db.select().from(memories).where(eq(memories.id, row.memoryId)).get();
    if (!mem) return null;

    const memApp = db.select().from(apps).where(eq(apps.id, mem.appId)).get();
    const cats = db
      .select({ name: categories.name })
      .from(memoryCategories)
      .innerJoin(categories, eq(memoryCategories.categoryId, categories.id))
      .where(eq(memoryCategories.memoryId, mem.id))
      .all();

    return {
      memory: {
        id: mem.id,
        content: mem.content,
        created_at: mem.createdAt,
        state: mem.state || "active",
        app_id: mem.appId,
        app_name: memApp?.name || null,
        categories: cats.map((c) => c.name),
        metadata_: mem.metadata,
      },
      access_count: row.accessCount,
    };
  }).filter(Boolean);

  return NextResponse.json({
    total: totalResult?.count || 0,
    page,
    page_size: pageSize,
    memories: items,
  });
}
