/**
 * Zod schemas for API request/response validation.
 * Port of MemForge/api/app/schemas.py + router request models.
 */
import { z } from "zod";

// --- Memory ---

export const MemoryResponseSchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  created_at: z.number().int(),
  state: z.string(),
  app_id: z.string().uuid().nullable(),
  app_name: z.string().nullable(),
  categories: z.array(z.string()),
  metadata_: z.record(z.string(), z.unknown()).nullable().optional(),
  // Bi-temporal fields (Spec 01) -- optional for backward compat
  valid_at: z.string().nullable().optional(),
  invalid_at: z.string().nullable().optional(),
  is_current: z.boolean().optional(),
  superseded_by: z.string().nullable().optional(),
});
export type MemoryResponse = z.infer<typeof MemoryResponseSchema>;

export const CreateMemoryRequestSchema = z.object({
  user_id: z.string(),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  infer: z.boolean().optional().default(true),
  app: z.string().optional().default("memforge"),
});

export const DeleteMemoriesRequestSchema = z.object({
  memory_ids: z.array(z.string().uuid()),
  user_id: z.string(),
});

export const UpdateMemoryRequestSchema = z.object({
  memory_content: z.string(),
  user_id: z.string(),
});

export const FilterMemoriesRequestSchema = z.object({
  user_id: z.string(),
  page: z.number().int().min(1).optional().default(1),
  size: z.number().int().min(1).max(100).optional().default(10),
  search_query: z.string().nullable().optional(),
  app_ids: z.array(z.string().uuid()).nullable().optional(),
  category_ids: z.array(z.string().uuid()).nullable().optional(),
  sort_column: z.string().nullable().optional(),
  sort_direction: z.string().nullable().optional(),
  from_date: z.number().int().nullable().optional(),
  to_date: z.number().int().nullable().optional(),
  show_archived: z.boolean().optional().default(false),
});

export const PauseMemoriesRequestSchema = z.object({
  memory_ids: z.array(z.string().uuid()).nullable().optional(),
  category_ids: z.array(z.string().uuid()).nullable().optional(),
  app_id: z.string().uuid().nullable().optional(),
  all_for_app: z.boolean().optional().default(false),
  global_pause: z.boolean().optional().default(false),
  state: z.enum(["active", "paused", "archived", "deleted"]).nullable().optional(),
  user_id: z.string(),
});

// --- Config ---

export const AzureKwargsSchema = z.object({
  api_key: z.string().nullable().optional(),
  azure_endpoint: z.string().nullable().optional(),
  azure_deployment: z.string().nullable().optional(),
  api_version: z.string().nullable().optional(),
});

export const LLMConfigSchema = z.object({
  model: z.string(),
  temperature: z.number(),
  max_tokens: z.number().int(),
  api_key: z.string().nullable().optional(),
  ollama_base_url: z.string().nullable().optional(),
  azure_kwargs: AzureKwargsSchema.nullable().optional(),
});

export const LLMProviderSchema = z.object({
  provider: z.string(),
  config: LLMConfigSchema,
});

export const EmbedderConfigSchema = z.object({
  model: z.string(),
  api_key: z.string().nullable().optional(),
  ollama_base_url: z.string().nullable().optional(),
  azure_kwargs: AzureKwargsSchema.nullable().optional(),
  embedding_dims: z.number().int().nullable().optional(),
});

export const EmbedderProviderSchema = z.object({
  provider: z.string(),
  config: EmbedderConfigSchema,
});

export const VectorStoreProviderSchema = z.object({
  provider: z.string(),
  config: z.record(z.string(), z.unknown()),
});

export const MemForgeConfigSchema = z.object({});

export const MemforgeExtConfigSchema = z.object({
  llm: LLMProviderSchema.nullable().optional(),
  embedder: EmbedderProviderSchema.nullable().optional(),
  vector_store: VectorStoreProviderSchema.nullable().optional(),
});

export const ConfigSchemaZ = z.object({
  memforge: MemForgeConfigSchema.nullable().optional(),
  memforge_ext: MemforgeExtConfigSchema.nullable().optional(),
});

// --- Backup ---

export const ExportRequestSchema = z.object({
  user_id: z.string(),
  app_id: z.string().uuid().nullable().optional(),
  from_date: z.number().int().nullable().optional(),
  to_date: z.number().int().nullable().optional(),
  include_vectors: z.boolean().optional().default(false),
});

// --- Paginated response ---

export const PaginatedResponseSchema = z.object({
  items: z.array(z.unknown()),
  total: z.number().int(),
  page: z.number().int(),
  size: z.number().int(),
  pages: z.number().int(),
});

/** Helper: build a Page response matching fastapi-pagination format */
export function buildPageResponse<T>(
  items: T[],
  total: number,
  page: number,
  size: number
) {
  return {
    items,
    total,
    page,
    size,
    pages: Math.ceil(total / size),
  };
}
