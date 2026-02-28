/**
 * lib/entities/tools.ts â€” LLM tool-calling definitions for entity & relation extraction
 *
 * Migrated from memforge-ts/oss graphs/tools.ts â€” adapted for MemForge architecture.
 *
 * Tool-calling is more reliable than JSON mode for structured extraction.
 * These tool definitions are passed to the LLM via function-calling API.
 *
 * Tools:
 *   EXTRACT_ENTITIES_TOOL  â€” Extract entities with types from text
 *   RELATIONS_TOOL         â€” Extract relationships between entities
 *   DELETE_MEMORY_TOOL_GRAPH â€” Identify relationships to delete
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// TypeScript interfaces
// ---------------------------------------------------------------------------

export interface GraphToolParameters {
  source: string;
  destination: string;
  relationship: string;
  source_type?: string;
  destination_type?: string;
}

export interface GraphEntitiesParameters {
  entities: Array<{
    entity: string;
    entity_type: string;
  }>;
}

export interface GraphRelationsParameters {
  entities: Array<{
    source: string;
    relationship: string;
    destination: string;
  }>;
}

// ---------------------------------------------------------------------------
// Zod schemas for argument validation
// ---------------------------------------------------------------------------

export const GraphSimpleRelationshipArgsSchema = z.object({
  source: z.string().describe("The identifier of the source node in the relationship."),
  relationship: z.string().describe("The relationship between the source and destination nodes."),
  destination: z.string().describe("The identifier of the destination node in the relationship."),
});

export const GraphAddRelationshipArgsSchema = GraphSimpleRelationshipArgsSchema.extend({
  source_type: z.string().describe("The type or category of the source node."),
  destination_type: z.string().describe("The type or category of the destination node."),
});

export const GraphExtractEntitiesArgsSchema = z.object({
  entities: z
    .array(
      z.object({
        entity: z.string().describe("The name or identifier of the entity."),
        entity_type: z.string().describe("The type or category of the entity."),
      }),
    )
    .describe("An array of entities with their types."),
});

export const GraphRelationsArgsSchema = z.object({
  entities: z
    .array(GraphSimpleRelationshipArgsSchema)
    .describe("An array of relationships (source, relationship, destination)."),
});

// ---------------------------------------------------------------------------
// OpenAI function-calling tool definitions
// ---------------------------------------------------------------------------

export const EXTRACT_ENTITIES_TOOL = {
  type: "function" as const,
  function: {
    name: "extract_entities",
    description: "Extract entities and their types from the text.",
    parameters: {
      type: "object",
      properties: {
        entities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              entity: {
                type: "string",
                description: "The name or identifier of the entity.",
              },
              entity_type: {
                type: "string",
                description: "The type or category of the entity.",
              },
            },
            required: ["entity", "entity_type"],
            additionalProperties: false,
          },
          description: "An array of entities with their types.",
        },
      },
      required: ["entities"],
      additionalProperties: false,
    },
  },
};

export const RELATIONS_TOOL = {
  type: "function" as const,
  function: {
    name: "establish_relationships",
    description: "Establish relationships among the entities based on the provided text.",
    parameters: {
      type: "object",
      properties: {
        entities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source: {
                type: "string",
                description: "The source entity of the relationship.",
              },
              relationship: {
                type: "string",
                description: "The relationship between the source and destination entities.",
              },
              destination: {
                type: "string",
                description: "The destination entity of the relationship.",
              },
            },
            required: ["source", "relationship", "destination"],
            additionalProperties: false,
          },
        },
      },
      required: ["entities"],
      additionalProperties: false,
    },
  },
};

export const DELETE_MEMORY_TOOL_GRAPH = {
  type: "function" as const,
  function: {
    name: "delete_graph_memory",
    description: "Delete the relationship between two nodes.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "The identifier of the source node in the relationship.",
        },
        relationship: {
          type: "string",
          description:
            "The existing relationship between the source and destination nodes that needs to be deleted.",
        },
        destination: {
          type: "string",
          description: "The identifier of the destination node in the relationship.",
        },
      },
      required: ["source", "relationship", "destination"],
      additionalProperties: false,
    },
  },
};

export const NOOP_TOOL = {
  type: "function" as const,
  function: {
    name: "noop",
    description: "No operation should be performed to the graph entities.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
};
