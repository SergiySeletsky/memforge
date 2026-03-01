---
applyTo: '**'
---

# MemForge MCP -- Long-Term Memory for AI Agents

Two tools give you persistent memory across conversations: **`add_memories`** (remember) and **`search_memory`** (recall).

---

## add_memories -- Remember

Store any facts, decisions, preferences, patterns, or insights worth keeping across conversations.

The system understands natural language intent:
- Statements, facts, decisions --> **remembered** (duplicates auto-detected and merged)
- "Forget X" / "Remove memories about Y" --> matching memories **removed**
- "Stop tracking entity Z" --> entity and its connections **cleaned up**
- "Still relevant: X" / "Confirm X still applies" --> timestamp refreshed (**TOUCH**)
- "Resolved: X" / "X has been fixed" --> memory archived as resolved (**RESOLVE**)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | `string \| string[]` | Yes | What to remember. Single string or array for batch writes. |
| `categories` | `string[]` | | Semantic labels for organization (e.g. `["Architecture", "Security"]`). Auto-assigned when omitted. When provided, `suppress_auto_categories` auto-defaults to `true`. |
| `tags` | `string[]` | | Exact identifiers you control for precise filtering (e.g. `["project-x", "session-5"]`). Never auto-assigned. |
| `suppress_auto_categories` | `boolean` | | Skip automatic category suggestions. Auto-defaults to `true` when `categories` is provided. Set explicitly to `false` to keep LLM enrichment alongside your categories. |

**Response (minimal -- no input echo):**
```jsonc
// All stored:            {"stored": 4, "ids": ["a","b","c","d"]}
// Mixed outcomes:        {"stored": 2, "ids": ["a","c"], "skipped": 1, "superseded": 1}
// With errors:           {"stored": 2, "ids": ["a","c"], "errors": [{"index": 1, "message": "..."}]}
// Invalidate command:    {"invalidated": 2}
// Delete entity command: {"deleted": "Alice"}
// Touch command:         {"touched": 1}
// Resolve command:       {"resolved": 1}
// Empty input:           {}
```
Only non-zero counts appear. `ids` covers stored + superseded items. Errors carry the input index for correlation.

---

## search_memory -- Recall

Find what's already known. **Use BEFORE making decisions, writing code, or answering questions.**

Two modes:
- **With query:** finds the most relevant memories and surfaces related entities with their connections. Use natural language -- be specific.
- **Without query:** lists all memories newest-first (use on first interaction, or to see what's stored).

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | `string` | | What to recall. Natural language -- be specific. Omit for browse mode. |
| `category` | `string` | | Return only memories in this category. |
| `tag` | `string` | | Return only memories with this exact tag (case-insensitive). |
| `limit` | `number` | | Max results (default: 10 search / 50 browse; max: 200). |
| `offset` | `number` | | Skip N memories for pagination (browse mode). Default: 0. |
| `include_entities` | `boolean` | | Include related entity profiles and connections (default: true). Set false for speed. |
| `created_after` | `string` | | Only memories after this date (ISO, e.g. `"2026-02-01"`). |

**Search response:**
```jsonc
{
  "total_matching": 25,       // total matches before limit cap
  "confident": true,          // whether results are likely relevant
  "message": "Found relevant results.",
  "results": [{
    "id": "...", "memory": "...",
    "relevance_score": 0.95,  // 0-1 normalized
    "created_at": "...", "updated_at": "...",
    "categories": ["Architecture"], "tags": ["project-x"]
  }],
  "entities": [{              // only when include_entities=true
    "name": "AuthService", "type": "COMPONENT",
    "description": "...", "relationships": [...]
  }]
}
```

**Browse response:**
```jsonc
{
  "total": 142, "offset": 0, "limit": 50,
  "results": [{
    "id": "...", "memory": "...",
    "created_at": "...", "updated_at": "...",
    "categories": ["Security"], "tags": ["session-5"]
  }]
}
```

---

## When to Use Each Tool

| Situation | Tool | Example |
|-----------|------|---------|
| Starting a new task | `search_memory` | Check for existing patterns, prior decisions |
| Making a design decision | `search_memory` then `add_memories` | Search first, then store the decision |
| Finished implementing something | `add_memories` | Store the approach, patterns, gotchas |
| Hit a bug or edge case | `search_memory` then `add_memories` | Check for known issues, then store the solution |
| Want to see everything stored | `search_memory` (no query) | Browse mode -- full inventory |
| Need project-specific context | `search_memory(tag: "repo-name")` | Filter to one project |
| Confirming a prior finding still applies | `add_memories` | `"Still relevant: auth uses JWT"` -- refreshes timestamp |
| Marking a tracked issue as fixed | `add_memories` | `"Resolved: CORS bug in /api/health"` -- archives the memory |

**Key principle:** Search 2-3 times with different phrasings before acting. Memory recall improves with varied queries.

---

## Query Guidance

- **Be specific:** "What authentication pattern does this project use?" not "auth"
- **Add context:** "How are entities deduplicated during extraction?" not "entity dedup"
- **Vary phrasings:** search from different angles to maximize recall
- **Browse first:** on cold-start, browse (no query) to see what's available

---

## What to Store

**Store:** Architecture decisions, problem-solving strategies, component relationships, implementation patterns, debug solutions, non-obvious behaviors, multi-file workflows.
**Skip:** Trivial one-line fixes, information already in code comments.

---

## Tags vs Categories

| | Tags | Categories |
|---|------|------------|
| **Control** | You set them, never auto-assigned | Auto-assigned by system (you can also set explicitly) |
| **Purpose** | Precise filtering and scoping | Semantic organization |
| **Examples** | `"project-x"`, `"session-5"`, `"prod-incident"` | `"Architecture"`, `"Security"`, `"Frontend"` |
| **Retrieval** | `search_memory(tag: "project-x")` | `search_memory(category: "Security")` |

---

## Project / Repo Scoping

Use **tags** for project-level isolation -- tag with the repo slug.

```jsonc
// Store a project-scoped memory:
add_memories(content: "Auth uses JWT with 15min expiry", tags: ["mem0ai/mem0"])

// Recall only this project's memories:
search_memory(query: "auth architecture", tag: "mem0ai/mem0")

// Browse all for this project:
search_memory(tag: "mem0ai/mem0")

// Stack multiple tags:
add_memories(content: "...", tags: ["mem0ai/mem0", "session-8", "security"])
```

`search_memory(tag: ...)` filters on one tag at a time -- use the most specific one.

---

## Security

**NEVER store:** API keys, tokens, passwords, private keys, credentials, connection strings.
**Instead store:** Redacted patterns (`"uses bearer token auth"`), setup instructions (`"Set API_KEY env var"`).
**Deletion:** `add_memories(content: "Forget X")` -- the system handles it automatically.
