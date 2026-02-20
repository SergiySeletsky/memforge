/**
 * POST /api/v1/memories/filter — advanced filtered + paginated memory listing
 *
 * Port of openmemory/api/app/routers/memories.py (POST /filter)
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { memories, apps, categories, memoryCategories, type MemoryState } from "@/lib/db/schema";
import { eq, and, ne, like, inArray, gte, lte, desc, asc, count } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/db/helpers";
import { FilterMemoriesRequestSchema, buildPageResponse, type MemoryResponse } from "@/lib/validation";

export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = FilterMemoriesRequestSchema.parse(await request.json());
  } catch (e: any) {
    return NextResponse.json({ detail: e.errors || e.message }, { status: 400 });
  }

  const db = getDb();
  const user = getOrCreateUser(body.user_id);

  // Build conditions
  const conditions: any[] = [
    eq(memories.userId, user.id),
    ne(memories.state, "deleted" as MemoryState),
  ];

  if (!body.show_archived) {
    conditions.push(ne(memories.state, "archived" as MemoryState));
  }

  if (body.search_query) {
    conditions.push(like(memories.content, `%${body.search_query}%`));
  }

  if (body.app_ids && body.app_ids.length > 0) {
    conditions.push(inArray(memories.appId, body.app_ids));
  }

  if (body.from_date) {
    conditions.push(gte(memories.createdAt, new Date(body.from_date * 1000).toISOString()));
  }

  if (body.to_date) {
    conditions.push(lte(memories.createdAt, new Date(body.to_date * 1000).toISOString()));
  }

  // If category filtering, get ids first
  let categoryMemoryIds: string[] | null = null;
  if (body.category_ids && body.category_ids.length > 0) {
    const mc = db
      .select({ memoryId: memoryCategories.memoryId })
      .from(memoryCategories)
      .where(inArray(memoryCategories.categoryId, body.category_ids))
      .all();
    categoryMemoryIds = mc.map((r) => r.memoryId);
    if (categoryMemoryIds.length === 0) {
      return NextResponse.json(buildPageResponse([], 0, body.page, body.size));
    }
    conditions.push(inArray(memories.id, categoryMemoryIds));
  }

  // Count total
  const totalResult = db
    .select({ count: count() })
    .from(memories)
    .where(and(...conditions))
    .get();
  const total = totalResult?.count || 0;

  // Sorting
  const validSortCols: Record<string, any> = {
    memory: memories.content,
    created_at: memories.createdAt,
  };
  let orderBy = desc(memories.createdAt);
  if (body.sort_column && body.sort_direction) {
    const dir = body.sort_direction.toLowerCase();
    if (dir !== "asc" && dir !== "desc") {
      return NextResponse.json({ detail: "Invalid sort direction" }, { status: 400 });
    }
    if (!validSortCols[body.sort_column] && body.sort_column !== "app_name") {
      return NextResponse.json({ detail: "Invalid sort column" }, { status: 400 });
    }
    const field = validSortCols[body.sort_column] || memories.createdAt;
    orderBy = dir === "asc" ? asc(field) : desc(field);
  }

  const page = Math.max(1, body.page);
  const size = Math.min(100, Math.max(1, body.size));

  const rows = db
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(orderBy)
    .limit(size)
    .offset((page - 1) * size)
    .all();

  // Build response items
  const items: MemoryResponse[] = rows.map((mem) => {
    const app = db.select().from(apps).where(eq(apps.id, mem.appId)).get();
    const cats = db
      .select({ name: categories.name })
      .from(memoryCategories)
      .innerJoin(categories, eq(memoryCategories.categoryId, categories.id))
      .where(eq(memoryCategories.memoryId, mem.id))
      .all();

    return {
      id: mem.id,
      content: mem.content,
      created_at: mem.createdAt ? Math.floor(new Date(mem.createdAt).getTime() / 1000) : 0,
      state: mem.state || "active",
      app_id: mem.appId,
      app_name: app?.name || null,
      categories: cats.map((c) => c.name),
      metadata_: mem.metadata as Record<string, unknown> | null,
    };
  });

  // Sort by app_name in JS if needed (since it's a join field)
  if (body.sort_column === "app_name") {
    items.sort((a, b) => {
      const an = a.app_name || "";
      const bn = b.app_name || "";
      return body.sort_direction === "asc" ? an.localeCompare(bn) : bn.localeCompare(an);
    });
  }

  return NextResponse.json(buildPageResponse(items, total, page, size));
}
