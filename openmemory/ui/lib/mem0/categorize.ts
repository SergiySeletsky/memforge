/**
 * Memory categorization: apply categories to a memory in the DB.
 * Port of the SQLAlchemy after_insert/after_update event handler.
 */
import { getDb } from "@/lib/db";
import { categories, memoryCategories } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getCategoriesForMemory } from "./categorization";

/**
 * Categorize a memory and store category associations in the DB.
 * Best-effort — errors are swallowed.
 */
export async function categorizeMemory(memoryId: string, content: string): Promise<void> {
  try {
    const categoryNames = await getCategoriesForMemory(content);
    if (categoryNames.length === 0) return;

    const db = getDb();

    for (const name of categoryNames) {
      // Get or create category
      let category = db.select().from(categories).where(eq(categories.name, name)).get();
      if (!category) {
        category = db
          .insert(categories)
          .values({ name, description: `Automatically created category for ${name}` })
          .returning()
          .get();
      }

      // Check if association already exists
      const existing = db
        .select()
        .from(memoryCategories)
        .where(
          and(
            eq(memoryCategories.memoryId, memoryId),
            eq(memoryCategories.categoryId, category.id)
          )
        )
        .get();

      if (!existing) {
        db.insert(memoryCategories)
          .values({ memoryId, categoryId: category.id })
          .run();
      }
    }
  } catch (e) {
    console.error("Error categorizing memory:", e);
  }
}
