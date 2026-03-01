/**
 * lib/entities/prompts.ts — Entity & relationship extraction prompts (Spec 04)
 *
 * Open ontology: LLM assigns domain-specific types in UPPER_SNAKE_CASE rather
 * than a closed list. Well-known base types (PERSON, ORGANIZATION, LOCATION,
 * PRODUCT) should still be used for conventional entity classes; domain-specific
 * types (SERVICE, DATABASE, LIBRARY, FRAMEWORK, TEAM, INCIDENT, API, etc.) are
 * encouraged when more precise.
 *
 * Combined extraction (GraphRAG-inspired): entities AND relationships are
 * extracted in a single LLM call to reduce latency and improve coherence.
 */
export const ENTITY_EXTRACTION_PROMPT = `You are an entity and relationship extraction assistant.
Extract named entities AND relationships between them from the given memory statement.

For each entity, provide:
- name: The canonical name of the entity (use the most complete, official form)
- type: A short entity type in UPPER_SNAKE_CASE. Use domain-specific types when precise
  (e.g. SERVICE, DATABASE, LIBRARY, FRAMEWORK, PATTERN, TEAM, INCIDENT, METRIC, API,
  INFRASTRUCTURE, SECURITY_POLICY, CONFIGURATION, COMPLIANCE_RULE).
  Fall back to well-known base types for conventional entity classes:
  PERSON, ORGANIZATION, LOCATION, PRODUCT.
  Use CONCEPT only for abstract ideas without a more specific type.
  Use OTHER only when nothing else fits.
- description: A brief description based on context (1 sentence max)
- metadata: (optional) A flat JSON object with domain-specific structured attributes that are
  explicitly stated in the text. Only include concrete, factual values — not inferences.
  Examples: {"dosage": "50mg", "frequency": "daily"}, {"ticker": "AAPL", "sector": "Technology"},
  {"language": "TypeScript", "version": "5.0"}, {"population": 8336817, "country": "USA"}.
  Omit metadata entirely if no structured attributes are stated.

For each relationship between entities, provide:
- source: Name of the source entity (must match an entity name above)
- target: Name of the target entity (must match an entity name above)
- type: Relationship type in UPPER_SNAKE_CASE (e.g. WORKS_AT, USES, DEPENDS_ON, LOCATED_IN, CREATED_BY, MANAGES, PART_OF)
- description: A brief description of the relationship (1 sentence max)
- metadata: (optional) A flat JSON object with domain-specific structured attributes on the relationship.
  Examples: {"since": "2024-01", "role": "Senior Engineer"}, {"dosage": "500mg", "frequency": "twice daily"}.
  Omit metadata entirely if no structured attributes are stated.

Return ONLY valid JSON:
{"entities": [{"name": "...", "type": "...", "description": "...", "metadata": {...}}], "relationships": [{"source": "...", "target": "...", "type": "...", "description": "...", "metadata": {...}}]}
If no entities found, return {"entities": [], "relationships": []}`;

// ---------------------------------------------------------------------------
// Gleaning prompt — used for multi-pass extraction
// ---------------------------------------------------------------------------

export const GLEANING_PROMPT = `Many entities and relationships were missed in the previous extraction.
Using the same output format, extract any ADDITIONAL entities and relationships that were not captured before.

Previously extracted entities: {previousEntities}

Return ONLY newly found items — do NOT repeat entities or relationships already listed above.
Return valid JSON: {"entities": [...], "relationships": [...]}
If nothing additional found, return {"entities": [], "relationships": []}`;

// ---------------------------------------------------------------------------
// Entity description summarization prompt (GraphRAG-inspired)
// ---------------------------------------------------------------------------

export const ENTITY_DESCRIPTION_SUMMARIZE_PROMPT = `You are an entity knowledge consolidation assistant.
Given two descriptions of the same entity from different contexts, produce a single consolidated description that:
1. Preserves ALL distinct facts from both descriptions
2. Resolves any contradictions by preferring the more specific/recent information
3. Is written in third person
4. Stays concise (1-2 sentences max)

Entity name: {entityName}

Description A: {descriptionA}
Description B: {descriptionB}

Return ONLY the consolidated description text, no JSON wrapping.`;

// ---------------------------------------------------------------------------
// Edge contradiction detection prompt (Graphiti-inspired temporal edges)
// ---------------------------------------------------------------------------

export const EDGE_CONTRADICTION_PROMPT = `You are a fact comparison assistant.
Given two statements about the same relationship between two entities, classify whether the new statement:
- SAME: Says effectively the same thing as the old statement (paraphrase/rewording)
- UPDATE: Adds new information or refines the old statement without contradicting it
- CONTRADICTION: Directly contradicts the old statement (e.g., changed employer, reversed relationship, negated fact)

Old statement: {oldDescription}
New statement: {newDescription}
Relationship type: {relType} (between {sourceName} and {targetName})

Return ONLY valid JSON: {"verdict": "SAME"} or {"verdict": "UPDATE"} or {"verdict": "CONTRADICTION"}`;

// ---------------------------------------------------------------------------
// Entity profile summary prompt (Graphiti-inspired)
// ---------------------------------------------------------------------------

export const ENTITY_SUMMARY_PROMPT = `You are an entity knowledge summarization assistant.
Given an entity and all known context about it (memories that mention it, its relationships), produce a comprehensive profile summary.

Entity: {entityName}
Type: {entityType}
Current description: {entityDescription}

Memories mentioning this entity:
{memories}

Known relationships:
{relationships}

Write a concise but comprehensive summary (2-4 sentences) that captures:
1. Who/what this entity is
2. Key facts and attributes
3. Important relationships and roles
4. Any notable changes or temporal information

Return ONLY the summary text, no JSON wrapping.`;

export interface MergeCandidate {
  name: string;
  type: string;
  description: string;
}

/**
 * Build a prompt asking the LLM whether two entities refer to the same real-world thing.
 * Used during semantic dedup to confirm or reject near-duplicate entities before merging.
 */
export function buildEntityMergePrompt(
  incoming: MergeCandidate,
  existing: MergeCandidate
): string {
  return `You are an entity deduplication assistant. Determine whether two entity records
refer to the SAME real-world person, organization, system, concept, or thing.

Entity A (incoming):
  Name: ${incoming.name}
  Type: ${incoming.type}
  Description: ${incoming.description || "(none)"}

Entity B (existing):
  Name: ${existing.name}
  Type: ${existing.type}
  Description: ${existing.description || "(none)"}

Answer with a single JSON object: {"same": true} if they are the same entity,
or {"same": false} if they are distinct. No explanation.`;
}
