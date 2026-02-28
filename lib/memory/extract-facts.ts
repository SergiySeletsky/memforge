/**
 * lib/memory/extract-facts.ts â€” Conversation fact extraction (migrated from memforge-ts/oss)
 *
 * Extracts discrete facts from multi-turn conversations using LLM.
 * Two modes:
 *   - User-focused: extracts facts from user messages only (default)
 *   - Agent-focused: extracts facts from assistant messages only
 *
 * This enables MCP add_memories to accept raw conversation transcripts
 * and auto-extract individual facts, rather than requiring pre-extracted statements.
 *
 * Uses getLLMClient() from lib/ai/client.ts for LLM access.
 */
import { z } from "zod";
import { getLLMClient } from "@/lib/ai/client";

// ---------------------------------------------------------------------------
// Zod schemas for structured LLM output
// ---------------------------------------------------------------------------

export const FactRetrievalSchema = z.object({
  facts: z.array(z.string()).describe(
    "An array of distinct facts extracted from the conversation."
  ),
});

export type FactRetrievalResult = z.infer<typeof FactRetrievalSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip fenced code block markers that the LLM sometimes wraps around JSON output.
 * Extracts the content inside the fences (if any), leaving it intact.
 */
export function removeCodeBlocks(text: string): string {
  // Match ```lang?\n...content...\n``` and replace with just the content
  return text.replace(/```(?:\w*)\n?([\s\S]*?)```/g, "$1").trim();
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build system + user prompt pair for fact extraction.
 * @param parsedMessages Stringified conversation (role: content lines)
 * @param isAgentMemory  When true, extracts facts about the assistant instead of the user
 */
export function getFactRetrievalMessages(
  parsedMessages: string,
  isAgentMemory: boolean = false,
): [system: string, user: string] {
  return isAgentMemory
    ? getAgentFactRetrievalMessages(parsedMessages)
    : getUserFactRetrievalMessages(parsedMessages);
}

function getUserFactRetrievalMessages(
  parsedMessages: string,
): [string, string] {
  const systemPrompt = `You are a Personal Information Organizer, specialized in accurately storing facts, user memories, and preferences. Your primary role is to extract relevant pieces of information from conversations and organize them into distinct, manageable facts. This allows for easy retrieval and personalization in future interactions. Below are the types of information you need to focus on and the detailed instructions on how to handle the input data.

# [IMPORTANT]: GENERATE FACTS SOLELY BASED ON THE USER'S MESSAGES. DO NOT INCLUDE INFORMATION FROM ASSISTANT OR SYSTEM MESSAGES.
# [IMPORTANT]: YOU WILL BE PENALIZED IF YOU INCLUDE INFORMATION FROM ASSISTANT OR SYSTEM MESSAGES.

Types of Information to Remember:

1. Store Personal Preferences: Keep track of likes, dislikes, and specific preferences in various categories such as food, products, activities, and entertainment.
2. Maintain Important Personal Details: Remember significant personal information like names, relationships, and important dates.
3. Track Plans and Intentions: Note upcoming events, trips, goals, and any plans the user has shared.
4. Remember Activity and Service Preferences: Recall preferences for dining, travel, hobbies, and other services.
5. Monitor Health and Wellness Preferences: Keep a record of dietary restrictions, fitness routines, and other wellness-related information.
6. Store Professional Details: Remember job titles, work habits, career goals, and other professional information.
7. Miscellaneous Information Management: Keep track of favorite books, movies, brands, and other miscellaneous details that the user shares.
8. Basic Facts and Statements: Store clear, factual statements that might be relevant for future context or reference.

Here are some few shot examples:

User: Hi.
Assistant: Hello! I enjoy assisting you. How can I help today?
Output: {"facts" : []}

User: There are branches in trees.
Assistant: That's an interesting observation. I love discussing nature.
Output: {"facts" : []}

User: Hi, I am looking for a restaurant in San Francisco.
Assistant: Sure, I can help with that. Any particular cuisine you're interested in?
Output: {"facts" : ["Looking for a restaurant in San Francisco"]}

User: Yesterday, I had a meeting with John at 3pm. We discussed the new project.
Assistant: Sounds like a productive meeting. I'm always eager to hear about new projects.
Output: {"facts" : ["Had a meeting with John at 3pm and discussed the new project"]}

User: Hi, my name is John. I am a software engineer.
Assistant: Nice to meet you, John! My name is Alex and I admire software engineering. How can I help?
Output: {"facts" : ["Name is John", "Is a Software engineer"]}

User: Me favourite movies are Inception and Interstellar. What are yours?
Assistant: Great choices! Both are fantastic movies. I enjoy them too. Mine are The Dark Knight and The Shawshank Redemption.
Output: {"facts" : ["Favourite movies are Inception and Interstellar"]}

Return the facts and preferences in a JSON format as shown above. You MUST return a valid JSON object with a 'facts' key containing an array of strings.

Remember the following:
# [IMPORTANT]: GENERATE FACTS SOLELY BASED ON THE USER'S MESSAGES. DO NOT INCLUDE INFORMATION FROM ASSISTANT OR SYSTEM MESSAGES.
# [IMPORTANT]: YOU WILL BE PENALIZED IF YOU INCLUDE INFORMATION FROM ASSISTANT OR SYSTEM MESSAGES.
- Today's date is ${new Date().toISOString().split("T")[0]}.
- Do not return anything from the custom few shot example prompts provided above.
- If you do not find anything relevant in the below conversation, you can return an empty list corresponding to the "facts" key.
- Create the facts based on the user messages only. Do not pick anything from the assistant or system messages.
- Make sure to return the response in the JSON format mentioned in the examples. The response should be in JSON with a key as "facts" and corresponding value will be a list of strings.
- DO NOT RETURN ANYTHING ELSE OTHER THAN THE JSON FORMAT.
- DO NOT ADD ANY ADDITIONAL TEXT OR CODEBLOCK IN THE JSON FIELDS WHICH MAKE IT INVALID SUCH AS "\`\`\`json" OR "\`\`\`".
- You should detect the language of the user input and record the facts in the same language.
- For basic factual statements, break them down into individual facts if they contain multiple pieces of information.

Following is a conversation between the user and the assistant. You have to extract the relevant facts and preferences about the user, if any, from the conversation and return them in the JSON format as shown above.
You should detect the language of the user input and record the facts in the same language.
`;

  const userPrompt = `Following is a conversation between the user and the assistant. You have to extract the relevant facts and preferences about the user, if any, from the conversation and return them in the JSON format as shown above.\n\nInput:\n${parsedMessages}`;

  return [systemPrompt, userPrompt];
}

function getAgentFactRetrievalMessages(
  parsedMessages: string,
): [string, string] {
  const systemPrompt = `You are an Assistant Information Organizer, specialized in accurately storing facts, preferences, and characteristics about the AI assistant from conversations.
Your primary role is to extract relevant pieces of information about the assistant from conversations and organize them into distinct, manageable facts.
This allows for easy retrieval and characterization of the assistant in future interactions. Below are the types of information you need to focus on and the detailed instructions on how to handle the input data.

# [IMPORTANT]: GENERATE FACTS SOLELY BASED ON THE ASSISTANT'S MESSAGES. DO NOT INCLUDE INFORMATION FROM USER OR SYSTEM MESSAGES.
# [IMPORTANT]: YOU WILL BE PENALIZED IF YOU INCLUDE INFORMATION FROM USER OR SYSTEM MESSAGES.

Types of Information to Remember:

1. Assistant's Preferences: Keep track of likes, dislikes, and specific preferences the assistant mentions in various categories such as activities, topics of interest, and hypothetical scenarios.
2. Assistant's Capabilities: Note any specific skills, knowledge areas, or tasks the assistant mentions being able to perform.
3. Assistant's Hypothetical Plans or Activities: Record any hypothetical activities or plans the assistant describes engaging in.
4. Assistant's Personality Traits: Identify any personality traits or characteristics the assistant displays or mentions.
5. Assistant's Approach to Tasks: Remember how the assistant approaches different types of tasks or questions.
6. Assistant's Knowledge Areas: Keep track of subjects or fields the assistant demonstrates knowledge in.
7. Miscellaneous Information: Record any other interesting or unique details the assistant shares about itself.

Here are some few shot examples:

User: Hi, I am looking for a restaurant in San Francisco.
Assistant: Sure, I can help with that. Any particular cuisine you're interested in?
Output: {"facts" : []}

User: Yesterday, I had a meeting with John at 3pm. We discussed the new project.
Assistant: Sounds like a productive meeting.
Output: {"facts" : []}

User: Hi, my name is John. I am a software engineer.
Assistant: Nice to meet you, John! My name is Alex and I admire software engineering. How can I help?
Output: {"facts" : ["Admires software engineering", "Name is Alex"]}

User: Me favourite movies are Inception and Interstellar. What are yours?
Assistant: Great choices! Both are fantastic movies. Mine are The Dark Knight and The Shawshank Redemption.
Output: {"facts" : ["Favourite movies are Dark Knight and Shawshank Redemption"]}

Return the facts and preferences in a JSON format as shown above. You MUST return a valid JSON object with a 'facts' key containing an array of strings.

Remember the following:
# [IMPORTANT]: GENERATE FACTS SOLELY BASED ON THE ASSISTANT'S MESSAGES. DO NOT INCLUDE INFORMATION FROM USER OR SYSTEM MESSAGES.
# [IMPORTANT]: YOU WILL BE PENALIZED IF YOU INCLUDE INFORMATION FROM USER OR SYSTEM MESSAGES.
- Today's date is ${new Date().toISOString().split("T")[0]}.
- Do not return anything from the custom few shot example prompts provided above.
- If you do not find anything relevant in the below conversation, you can return an empty list corresponding to the "facts" key.
- Create the facts based on the assistant messages only. Do not pick anything from the user or system messages.
- Make sure to return the response in the format mentioned in the examples. The response should be in json with a key as "facts" and corresponding value will be a list of strings.
- DO NOT RETURN ANYTHING ELSE OTHER THAN THE JSON FORMAT.
- DO NOT ADD ANY ADDITIONAL TEXT OR CODEBLOCK IN THE JSON FIELDS WHICH MAKE IT INVALID SUCH AS "\`\`\`json" OR "\`\`\`".
- You should detect the language of the assistant input and record the facts in the same language.

Following is a conversation between the user and the assistant. You have to extract the relevant facts and preferences about the assistant, if any, from the conversation and return them in the json format as shown above.
`;

  const userPrompt = `Following is a conversation between the user and the assistant. You have to extract the relevant facts and preferences about the assistant, if any, from the conversation and return them in the JSON format as shown above.\n\nInput:\n${parsedMessages}`;

  return [systemPrompt, userPrompt];
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * Format conversation messages into the string format expected by the prompts.
 */
export function formatConversation(messages: ConversationMessage[]): string {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
}

/**
 * Extract discrete facts from a conversation using LLM.
 *
 * @param messages    Array of conversation messages (user + assistant)
 * @param isAgentMemory  When true, extracts facts about the assistant
 * @returns Array of fact strings, empty on error (fail-open)
 */
export async function extractFactsFromConversation(
  messages: ConversationMessage[],
  isAgentMemory: boolean = false,
): Promise<string[]> {
  const model =
    process.env.LLM_AZURE_DEPLOYMENT ??
    process.env.MEMFORGE_CATEGORIZATION_MODEL ??
    "gpt-4o-mini";

  try {
    const formatted = formatConversation(messages);
    const [systemPrompt, userPrompt] = getFactRetrievalMessages(formatted, isAgentMemory);

    const client = getLLMClient();
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 1000,
    });

    const raw = (response.choices[0]?.message?.content ?? "{}").trim();
    const cleaned = removeCodeBlocks(raw);
    const parsed = FactRetrievalSchema.safeParse(JSON.parse(cleaned));

    if (!parsed.success) {
      console.warn("[extract-facts] Zod validation failed:", parsed.error.message);
      return [];
    }

    return parsed.data.facts.filter((f) => f.trim().length > 0);
  } catch (e) {
    console.warn("[extract-facts] failed:", e);
    return [];
  }
}
