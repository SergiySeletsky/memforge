/**
 * Together AI LLM — OpenAI-compatible via base_url.
 * Port of Python mem0.llms.together.TogetherLLM.
 */
import OpenAI from "openai";
import { LLM, LLMResponse } from "./base";
import { LLMConfig, Message } from "../types";

export class TogetherLLM implements LLM {
  private client: OpenAI;
  private model: string;

  constructor(config: LLMConfig) {
    const apiKey = config.apiKey ?? process.env.TOGETHER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Together API key is required. Set TOGETHER_API_KEY env or pass apiKey in config.",
      );
    }
    const baseURL =
      config.baseURL ?? "https://api.together.xyz/v1";
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = config.model ?? "mistralai/Mixtral-8x7B-Instruct-v0.1";
  }

  async generateResponse(
    messages: Message[],
    responseFormat?: { type: string },
    tools?: any[],
  ): Promise<string | LLMResponse> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((msg) => ({
        role: msg.role as "system" | "user" | "assistant",
        content:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
      })),
      ...(responseFormat && {
        response_format: responseFormat as { type: "text" | "json_object" },
      }),
      ...(tools && { tools, tool_choice: "auto" as const }),
    });

    const response = completion.choices[0].message;
    if (response.tool_calls?.length) {
      return {
        content: response.content ?? "",
        role: response.role,
        toolCalls: response.tool_calls.map((tc) => ({
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
      };
    }
    return response.content ?? "";
  }

  async generateChat(messages: Message[]): Promise<LLMResponse> {
    const response = await this.generateResponse(messages);
    return typeof response === "string"
      ? { content: response, role: "assistant" }
      : response;
  }
}
