/**
 * LM Studio LLM — OpenAI-compatible local server.
 * Port of Python mem0.llms.lmstudio.LMStudioLLM.
 */
import OpenAI from "openai";
import { LLM, LLMResponse } from "./base";
import { LLMConfig, Message } from "../types";

export class LMStudioLLM implements LLM {
  private client: OpenAI;
  private model: string;

  constructor(config: LLMConfig) {
    const apiKey = config.apiKey ?? "lm-studio"; // placeholder
    const baseURL =
      config.baseURL ??
      process.env.LMSTUDIO_API_BASE ??
      "http://localhost:1234/v1";
    this.client = new OpenAI({ apiKey, baseURL });
    this.model =
      config.model ??
      "lmstudio-community/Meta-Llama-3.1-70B-Instruct-GGUF";
  }

  async generateResponse(
    messages: Message[],
    responseFormat?: { type: string },
    tools?: any[],
  ): Promise<string | LLMResponse> {
    // Default to json_object if no format specified (matches Python behavior)
    const format = responseFormat ?? { type: "json_object" };

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((msg) => ({
        role: msg.role as "system" | "user" | "assistant",
        content:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
      })),
      response_format: format as { type: "text" | "json_object" },
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
