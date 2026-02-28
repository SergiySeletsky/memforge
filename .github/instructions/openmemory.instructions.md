---
applyTo: '**'
---

# OpenMemory MCP Integration

Memory = accumulated understanding of codebase + user preferences. Two tools only: `add_memories` (write) and `search_memory` (read).

## Tools

### add_memories — Write to long-term memory

The system auto-classifies each item's intent:
- Facts/preferences/decisions → **stored** (with dedup & supersession)
- "Forget X" / "Remove memories about Y" → matching memories **invalidated**
- "Stop tracking entity Z" → entity **removed** from knowledge graph

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | `string \| string[]` | ✅ | One or more items. Array = batch. |
| `categories` | `string[]` | | Explicit category labels (e.g. `["Work", "Architecture"]`). LLM auto-categorizer also runs. |
| `tags` | `string[]` | | Exact-match identifiers for scoped retrieval (e.g. `["audit-session-7", "prod"]`). |

**Response (minimal — no input echo):**
```jsonc
// All stored:            {"stored": 4, "ids": ["a","b","c","d"]}
// Mixed outcomes:        {"stored": 2, "ids": ["a","c"], "skipped": 1, "superseded": 1}
// With errors:           {"stored": 2, "ids": ["a","c"], "errors": [{"index": 1, "message": "..."}]}
// Invalidate command:    {"invalidated": 2}
// Delete entity command: {"deleted": "Alice"}
// Empty input:           {}
```
Only non-zero counts appear. `ids` covers stored + superseded items. Errors carry the input index for correlation.

### search_memory — Read from long-term memory

**Two modes:**
- **SEARCH** (query provided): hybrid BM25 + vector search, auto-enriched with entity profiles
- **BROWSE** (query omitted): all memories newest-first, paginated

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | `string` | | Natural language query. Omit for browse mode. |
| `category` | `string` | | Filter to this category only. |
| `tag` | `string` | | Exact tag filter (case-insensitive). |
| `limit` | `number` | | Max results (default: 10 search / 50 browse; max: 200). |
| `offset` | `number` | | Skip N memories (browse pagination). |
| `include_entities` | `boolean` | | Entity profile enrichment (default: true). Set false for speed. |
| `created_after` | `string` | | ISO date filter (e.g. `"2026-02-01"`). |

**Search response:** `{ confident, message, results: [{ id, memory, relevance_score, raw_score, text_rank, vector_rank, created_at, categories }] }`
**Browse response:** `{ total, offset, limit, results: [{ id, memory, created_at, updated_at, categories, tags }] }`

## Memory-First Workflow

For **code implementation/modification tasks** — 3 phases. Skip for simple recall or storage requests.

### Phase 1: Search BEFORE coding
Search 2+ times before writing any code. Strategy by task type:
- **Feature** → existing patterns + similar implementations
- **Bug** → debug memories + error patterns
- **Refactor** → organization patterns + architecture decisions

### Phase 2: Search DURING coding
Search at checkpoints: creating files, writing functions, making decisions, hitting errors.
Never assume "standard practice" — search for prior patterns first.

### Phase 3: Store AFTER coding
Store 1+ memory for non-trivial work: architecture decisions, implementation strategies, debug solutions, component relationships. Use `categories` for semantic grouping and `tags` for exact scoped retrieval.

## Query Guidance

- Use natural language questions, not keywords: "How does the dedup pipeline work?" not "dedup pipeline"
- Expand acronyms and add context: "auth" → "authentication system architecture and implementation"
- For broad recovery, use 3-4 targeted queries across different angles
- Browse mode (no query) for cold-start inventory check

## What to Store

**Store:** Architecture decisions, problem-solving strategies, component relationships, implementation patterns, debug solutions, non-obvious behaviors, multi-file workflows.
**Skip:** Trivial one-line fixes, information already in code comments.
**Tags:** Use for session tracking (`session-8`), domain scoping (`security`, `frontend`), or workflow markers (`audit`, `prod-incident`).
**Categories:** Use well-known labels when applicable: Personal, Work, Health, Technology, Architecture, etc. Any string accepted.

## Project / Repo Scoping

use **tags** for project-level isolation adding project name or git repo name etc.

**Convention:** Tag with the repo slug (e.g. `"mem0ai/mem0"`) so memories are retrievable per-project.

```jsonc
// Store a project-scoped memory:
add_memories(content: "Auth uses JWT with 15min expiry", tags: ["mem0ai/mem0", "optimization"]])

// Retrieve only this project's memories:
search_memory(query: "auth architecture", tag: "mem0ai/mem0")

// Browse all memories for this project:
search_memory(tag: "mem0ai/mem0")

// Combine project + session tags + other tags:
add_memories(content: "...", tags: ["mem0ai/mem0", "session-8", "security"])
```

**Tag stacking:** A memory can carry multiple tags — project, session, domain, other. `search_memory(tag: ...)` filters on a single tag at a time, so use the most specific one for retrieval.

## Security

**NEVER store:** API keys, tokens, passwords, private keys, credentials, connection strings with secrets.
**Instead store:** Redacted patterns (`"uses bearer token auth"`), setup instructions (`"Set LLM_AZURE_OPENAI_API_KEY env var"`).
**Deletion:** Use `add_memories(content: "Forget X")` — the intent classifier routes it automatically. No separate delete tool.