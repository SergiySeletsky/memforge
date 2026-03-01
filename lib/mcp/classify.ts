/**
 * lib/mcp/classify.ts â€” Intent classifier for 2-tool MCP architecture
 *
 * Classifies incoming add_memories text into one of:
 *   STORE           â€” a fact to remember (default, enters dedup pipeline)
 *   INVALIDATE      â€” a request to forget/remove memories
 *   DELETE_ENTITY   â€” a request to stop tracking a specific entity
 *
 * Uses a fast regex pre-filter to skip LLM for obvious STORE items.
 * Falls back to LLM classification only when the text contains command-like patterns.
 * Fails open: any error defaults to STORE so memory writes are never blocked.
 */
import { getLLMClient } from "@/lib/ai/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryIntent =
  | { type: "STORE" }
  | { type: "INVALIDATE"; target: string }
  | { type: "DELETE_ENTITY"; entityName: string }
  | { type: "TOUCH"; target: string }
  | { type: "RESOLVE"; target: string };

// ---------------------------------------------------------------------------
// Fast-path regex pre-filter
// ---------------------------------------------------------------------------
// Skip LLM call for text that is clearly a factual statement (no command verbs).
// Only activate LLM when text contains potential command-like patterns.

const COMMAND_PATTERNS = [
  /\b(forget|remove|delete|erase|drop|purge|clear)\b.*\b(memor|about|that|everything|all)\b/i,
  /\b(stop\s+tracking|stop\s+remembering|don'?t\s+remember)\b/i,
  /\b(no\s+longer\s+relevant|mark\s+as\s+irrelevant|mark\s+as\s+outdated)\b/i,
  /\b(invalidate|mark\s+as\s+(deleted|removed))\b/i,
  /\b(untrack|remove\s+entity|delete\s+entity|stop\s+tracking\s+(person|entity|concept))\b/i,
  // TOUCH: confirm existing memory is still valid (update timestamp only)
  /\b(still\s+(relevant|unfixed|open|valid|pending|applies|true)|confirm(ed)?|reconfirm|touch\s+memor|refresh\s+memor)\b/i,
  // RESOLVE: mark existing memory as resolved/fixed/addressed
  /\b(resolved|mark\s+as\s+(resolved|fixed|done|complete|closed)|has\s+been\s+(fixed|resolved|addressed|completed))\b/i,
];

/** Returns true when text might be a command (needs LLM classification). */
export function mightBeCommand(text: string): boolean {
  return COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// LLM classification prompt
// ---------------------------------------------------------------------------

const CLASSIFY_PROMPT = `You are an intent classifier for a memory system. Given user input, determine the intent:

- STORE: A fact, preference, decision, observation, or piece of information to remember. This is the overwhelmingly common case.
- INVALIDATE: A request to forget, remove, or mark as irrelevant one or more existing memories. The user is telling the system to stop remembering something specific.
- DELETE_ENTITY: A request to stop tracking a specific person, concept, organization, or entity entirely. Not just updating a fact â€” removing the entity itself.
- TOUCH: A confirmation that an existing memory/finding is still relevant or valid. The user is NOT adding new information — just refreshing the timestamp. Examples: "still unfixed", "confirm X is still open", "this still applies".
- RESOLVE: Marking an existing memory/finding as resolved, fixed, addressed, or completed. The memory should be archived (not deleted). Examples: "X has been fixed", "resolved: Y", "mark Z as done".

Respond with EXACTLY one JSON object (no markdown, no fences):
  {"intent":"STORE"}
  {"intent":"INVALIDATE","target":"description of what to forget"}
  {"intent":"DELETE_ENTITY","entityName":"name of entity to remove"}
  {"intent":"TOUCH","target":"description of the memory to refresh"}
  {"intent":"RESOLVE","target":"description of the memory that was resolved"}`;

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify the intent of an add_memories input text.
 *
 * Fast-path: returns STORE immediately for obvious factual statements.
 * Slow-path: uses LLM when text contains potential command patterns.
 * Fail-open: any error in LLM call defaults to STORE.
 */
export async function classifyIntent(text: string): Promise<MemoryIntent> {
  // Fast path: obvious factual statement â€” no command verbs detected
  if (!mightBeCommand(text)) {
    return { type: "STORE" };
  }

  // Slow path: LLM classification for ambiguous text
  try {
    const client = getLLMClient();
    const model =
      process.env.LLM_AZURE_DEPLOYMENT ??
      process.env.MEMFORGE_CATEGORIZATION_MODEL ??
      "gpt-4o-mini";

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: CLASSIFY_PROMPT },
        { role: "user", content: text },
      ],
      temperature: 0,
      max_tokens: 100,
    });

    const raw = (response.choices[0]?.message?.content ?? "").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (parsed.intent === "INVALIDATE" && typeof parsed.target === "string") {
      return { type: "INVALIDATE", target: parsed.target };
    }
    if (parsed.intent === "DELETE_ENTITY" && typeof parsed.entityName === "string") {
      return { type: "DELETE_ENTITY", entityName: parsed.entityName };
    }
    if (parsed.intent === "TOUCH" && typeof parsed.target === "string") {
      return { type: "TOUCH", target: parsed.target };
    }
    if (parsed.intent === "RESOLVE" && typeof parsed.target === "string") {
      return { type: "RESOLVE", target: parsed.target };
    }

    return { type: "STORE" };
  } catch (e) {
    // Fail open: treat as STORE if classification fails
    console.warn("[classify] intent classification failed, defaulting to STORE:", e);
    return { type: "STORE" };
  }
}
