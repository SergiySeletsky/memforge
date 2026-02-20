/**
 * GET /api/v1/memories/:memoryId/related — find related memories via category overlap
 *
 * Port of openmemory/api/app/routers/memories.py (GET /{memory_id}/related)
 *
 * Uses the same category-overlap algorithm as Python: finds memories that share
 * categories with the source memory, ranked by the number of shared categories.
 * Returns a paginated response with forced page size of 5.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  memories,
  apps,
  categories,
  memoryCategories,
  type MemoryState,
} from "@/lib/db/schema";
import { eq, ne, and, inArray, sql } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/db/helpers";
import { buildPageResponse } from "@/lib/validation";

type RouteParams = { params: Promise<{ memoryId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { memoryId } = await params;
  const sp = request.nextUrl.searchParams;
  const userId = sp.get("user_id");
  if (!userId) {
    return NextResponse.json({ detail: "user_id is required" }, { status: 400 });
  }

  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  // Force page size to 5 — matching Python implementation
  const size = 5;

  const db = getDb();
  const user = getOrCreateUser(userId);

  const mem = db.select().from(memories).where(eq(memories.id, memoryId)).get();
  if (!mem) {
    return NextResponse.json({ detail: "Memory not found" }, { status: 404 });
  }

  // Get category IDs for the source memory
  const sourceCats = db
    .select({ categoryId: memoryCategories.categoryId })
    .from(memoryCategories)
    .where(eq(memoryCategories.memoryId, memoryId))
    .all();
  const categoryIds = sourceCats.map((c) => c.categoryId);

  if (categoryIds.length === 0) {
    return NextResponse.json(buildPageResponse([], 0, page, size));
  }

  // Find related memories that share categories, ranked by overlap count.
  // We run a raw SQL query because Drizzle doesn't easily support
  // GROUP BY + COUNT + ORDER BY COUNT in a type-safe way.
  const relatedRows = db.all<{ memory_id: string; overlap: number }>(sql`
    SELECT mc.memory_id, COUNT(mc.category_id) AS overlap
    FROM ${memoryCategories} mc
    INNER JOIN ${memories} m ON m.id = mc.memory_id
    WHERE mc.category_id IN (${sql.join(categoryIds.map(id => sql`${id}`), sql`, `)})
      AND m.user_id = ${user.id}
      AND m.id != ${memoryId}
      AND m.state != 'deleted'
    GROUP BY mc.memory_id
    ORDER BY overlap DESC, m.created_at DESC
  `);

  const total = relatedRows.length;
  const paged = relatedRows.slice((page - 1) * size, page * size);

  const items = paged.map((row) => {
    const relMem = db.select().from(memories).where(eq(memories.id, row.memory_id)).get()!;
    const app = relMem.appId ? db.select().from(apps).where(eq(apps.id, relMem.appId)).get() : null;
    const cats = db
      .select({ name: categories.name })
      .from(memoryCategories)
      .innerJoin(categories, eq(memoryCategories.categoryId, categories.id))
      .where(eq(memoryCategories.memoryId, relMem.id))
      .all();

    return {
      id: relMem.id,
      content: relMem.content,
      created_at: relMem.createdAt ? Math.floor(new Date(relMem.createdAt).getTime() / 1000) : 0,
      state: relMem.state || "active",
      app_id: relMem.appId,
      app_name: app?.name || null,
      categories: cats.map((c) => c.name),
      metadata_: relMem.metadata as Record<string, unknown> | null,
    };
  });

  return NextResponse.json(buildPageResponse(items, total, page, size));
}
