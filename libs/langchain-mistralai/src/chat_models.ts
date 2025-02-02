import { v4 as uuidv4 } from "uuid";
import { Mistral as MistralClient } from "@mistralai/mistralai";
import {
  ChatCompletionRequest as MistralAIChatCompletionRequest,
  ChatCompletionRequestToolChoice as MistralAIToolChoice,
  Messages as MistralAIMessage,
} from "@mistralai/mistralai/models/components/chatcompletionrequest.js";
import { ContentChunk } from "@mistralai/mistralai/models/components/contentchunk.js";
import { Tool as MistralAITool } from "@mistralai/mistralai/models/components/tool.js";
import { ToolCall as MistralAIToolCall } from "@mistralai/mistralai/models/components/toolcall.js";
import { ChatCompletionStreamRequest as MistralChatCompletionStreamRequest } from "@mistralai/mistralai/models/components/chatcompletionstreamrequest.js";
import { UsageInfo as MistralAITokenUsage } from "@mistralai/mistralai/models/components/usageinfo.js";
import { CompletionEvent as MistralAIChatCompletionEvent } from "@mistralai/mistralai/models/components/completionevent.js";
import { ChatCompletionResponse as MistralChatCompletionResponse } from "@mistralai/mistralai/models/components/chatcompletionresponse.js";
import {
  MessageType,
  type BaseMessage,
  MessageContent,
  AIMessage,
  HumanMessage,
  HumanMessageChunk,
  AIMessageChunk,
  ToolMessageChunk,
  ChatMessageChunk,
  FunctionMessageChunk,
  OpenAIToolCall,
  isAIMessage,
} from "@langchain/core/messages";
import type {
  BaseLanguageModelInput,
  BaseLanguageModelCallOptions,
  StructuredOutputMethodParams,
  StructuredOutputMethodOptions,
  FunctionDefinition,
} from "@langchain/core/language_models/base";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  type BaseChatModelParams,
  BaseChatModel,
  BindToolsInput,
  LangSmithParams,
} from "@langchain/core/language_models/chat_models";

import {
  ChatGeneration,
  ChatGenerationChunk,
  ChatResult,
} from "@langchain/core/outputs";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { NewTokenIndices } from "@langchain/core/callbacks/base";
import { z } from "zod";
import {
  type BaseLLMOutputParser,
  JsonOutputParser,
  StructuredOutputParser,
} from "@langchain/core/output_parsers";
import {
  JsonOutputKeyToolsParser,
  convertLangChainToolCallToOpenAI,
  makeInvalidToolCall,
  parseToolCall,
} from "@langchain/core/output_parsers/openai_tools";
import {
  Runnable,
  RunnablePassthrough,
  RunnableSequence,
} from "@langchain/core/runnables";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ToolCallChunk } from "@langchain/core/messages/tool";
import { _convertToolCallIdToMistralCompatible } from "./utils.js";

interface TokenUsage {
  completionTokens?: number;
  promptTokens?: number;
  totalTokens?: number;
}

type ChatMistralAIToolType = MistralAIToolCall | MistralAITool | BindToolsInput;

export interface ChatMistralAICallOptions
  extends Omit<BaseLanguageModelCallOptions, "stop"> {
  response_format?: {
    type: "text" | "json_object";
  };
  tools?: ChatMistralAIToolType[];
  tool_choice?: MistralAIToolChoice;
  /**
   * Whether or not to include token usage in the stream.
   * @default {true}
   */
  streamUsage?: boolean;
}

/**
 * Input to chat model class.
 */
export interface ChatMistralAIInput
  extends BaseChatModelParams,
    Pick<ChatMistralAICallOptions, "streamUsage"> {
  /**
   * The API key to use.
   * @default {process.env.MISTRAL_API_KEY}
   */
  apiKey?: string;
  /**
   * The name of the model to use.
   * Alias for `model`
   * @default {"mistral-small-latest"}
   */
  modelName?: string;
  /**
   * The name of the model to use.
   * @default {"mistral-small-latest"}
   */
  model?: string;
  /**
   * Override the default server URL used by the Mistral SDK.
   */
  serverURL?: string;
  /**
   * What sampling temperature to use, between 0.0 and 2.0.
   * Higher values like 0.8 will make the output more random, while lower values like 0.2 will make it more focused and deterministic.
   * @default {0.7}
   */
  temperature?: number;
  /**
   * Nucleus sampling, where the model considers the results of the tokens with `top_p` probability mass.
   * So 0.1 means only the tokens comprising the top 10% probability mass are considered.
   * Should be between 0 and 1.
   * @default {1}
   */
  topP?: number;
  /**
   * The maximum number of tokens to generate in the completion.
   * The token count of your prompt plus max_tokens cannot exceed the model's context length.
   */
  maxTokens?: number;
  /**
   * Whether or not to stream the response.
   * @default {false}
   */
  streaming?: boolean;
  /**
   * Whether to inject a safety prompt before all conversations.
   * @default {false}
   * @deprecated use safePrompt instead
   */
  safeMode?: boolean;
  /**
   * Whether to inject a safety prompt before all conversations.
   * @default {false}
   */
  safePrompt?: boolean;
  /**
   * The seed to use for random sampling. If set, different calls will generate deterministic results.
   * Alias for `seed`
   */
  randomSeed?: number;
  /**
   * The seed to use for random sampling. If set, different calls will generate deterministic results.
   */
  seed?: number;
}

function convertMessagesToMistralMessages(
  messages: Array<BaseMessage>
): Array<MistralAIMessage> {
  const getRole = (role: MessageType) => {
    switch (role) {
      case "human":
        return "user";
      case "ai":
        return "assistant";
      case "system":
        return "system";
      case "tool":
        return "tool";
      case "function":
        return "assistant";
      default:
        throw new Error(`Unknown message type: ${role}`);
    }
  };

  const getContent = (content: MessageContent, role: MessageType): string | ContentChunk[] => {
    const mistralRole = getRole(role)

    if (typeof content === "string") {
      return content;
    }
    else if (Array.isArray(content)) {
      if (mistralRole === "user") {
        return content.map((messageContentComplex) => {
          if (messageContentComplex?.type === "image_url") {
            return {
              type: messageContentComplex.type,
              imageUrl: messageContentComplex?.image_url
            } as ContentChunk;
          }
          else if (messageContentComplex?.type === "text"){
            return {
              type: messageContentComplex.type,
              text: messageContentComplex?.text
            } as ContentChunk;
          }
          throw new Error(
            `ChatMistralAI only supports messages of type MessageContentText
              and MessageContentImageUrl for role "human". Received: ${JSON.stringify(
              content,
              null,
              2
            )}`
          );
        });
      }
      else if (mistralRole === "system") {
        return content.map((messageContentComplex) => {
          if (messageContentComplex?.type === "text"){
            return {
              type: messageContentComplex.type,
              text: messageContentComplex?.text
            } as ContentChunk;
          }
          throw new Error(
            `ChatMistralAI only supports messages of type MessageContentText
              for role "system". Received: ${JSON.stringify(
              content,
              null,
              2
            )}`
          );
        });
      }
    }
    throw new Error(
      `ChatMistralAI does not support non text message content for role "ai", "tool", 
        or "function". Received: ${JSON.stringify(
        content,
        null,
        2
      )}`
    );
  };

  const getTools = (message: BaseMessage): MistralAIToolCall[] | undefined => {
    if (isAIMessage(message) && !!message.tool_calls?.length) {
      return message.tool_calls
        .map((toolCall) => ({
          ...toolCall,
          id: _convertToolCallIdToMistralCompatible(toolCall.id ?? ""),
        }))
        .map(convertLangChainToolCallToOpenAI) as MistralAIToolCall[];
    }
    if (!message.additional_kwargs.tool_calls?.length) {
      return undefined;
    }
    const toolCalls: Omit<OpenAIToolCall, "index">[] =
      message.additional_kwargs.tool_calls;
    return toolCalls?.map((toolCall) => ({
      id: _convertToolCallIdToMistralCompatible(toolCall.id),
      type: "function",
      function: toolCall.function,
    }));
  };

  return messages.map((message) => {
    const toolCalls = getTools(message);
    const content = getContent(message.content, message._getType());
    if ("tool_call_id" in message && typeof message.tool_call_id === "string") {
      return {
        role: getRole(message._getType()),
        content,
        name: message.name,
        toolCallId: _convertToolCallIdToMistralCompatible(
          message.tool_call_id
        ),
      };
    }
    else if (isAIMessage(message)) {
      return {
        role: getRole(message._getType()),
        content,
        toolCalls: toolCalls,
      };
    }

    return {
      role: getRole(message._getType()),
      content,
    };
  }) as MistralAIMessage[];
}

function mistralAIResponseToChatMessage(
  choice: NonNullable<MistralChatCompletionResponse["choices"]>[0],
  usage?: MistralAITokenUsage
): BaseMessage {
  const { message } = choice;
  if (message === undefined) {
    throw new Error("No message found in response");
  }
  // MistralAI SDK does not include tool_calls in the non
  // streaming return type, so we need to extract it like this
  // to satisfy typescript.
  let rawToolCalls: MistralAIToolCall[] = [];
  if ("tool_calls" in message && Array.isArray(message.tool_calls)) {
    rawToolCalls = message.tool_calls as MistralAIToolCall[];
  }
  switch (message.role) {
    case "assistant": {
      const toolCalls = [];
      const invalidToolCalls = [];
      for (const rawToolCall of rawToolCalls) {
        try {
          const parsed = parseToolCall(rawToolCall, { returnId: true });
          toolCalls.push({
            ...parsed,
            id: parsed.id ?? uuidv4().replace(/-/g, ""),
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          invalidToolCalls.push(makeInvalidToolCall(rawToolCall, e.message));
        }
      }
      return new AIMessage({
        content: message.content ?? "",
        tool_calls: toolCalls,
        invalid_tool_calls: invalidToolCalls,
        additional_kwargs: {},
        usage_metadata: usage
          ? {
              input_tokens: usage.promptTokens,
              output_tokens: usage.completionTokens,
              total_tokens: usage.totalTokens,
            }
          : undefined,
      });
    }
    default:
      return new HumanMessage(message.content ?? "");
  }
}

function _convertDeltaToMessageChunk(
  delta: {
    role?: string | undefined;
    content?: string | null | undefined;
    tool_calls?: MistralAIToolCall[] | null | undefined;
  },
  usage?: MistralAITokenUsage | null
) {
  if (!delta.content && !delta.tool_calls) {
    if (usage) {
      return new AIMessageChunk({
        content: "",
        usage_metadata: usage
          ? {
              input_tokens: usage.promptTokens,
              output_tokens: usage.completionTokens,
              total_tokens: usage.totalTokens,
            }
          : undefined,
      });
    }
    return null;
  }
  // Our merge additional kwargs util function will throw unless there
  // is an index key in each tool object (as seen in OpenAI's) so we
  // need to insert it here.
  const rawToolCallChunksWithIndex = delta.tool_calls?.length
    ? delta.tool_calls?.map(
        (toolCall, index): MistralAIToolCall & { index: number } => ({
          ...toolCall,
          index,
          id: toolCall.id ?? uuidv4().replace(/-/g, ""),
          type: "function",
        })
      )
    : undefined;

  let role = "assistant";
  if (delta.role) {
    role = delta.role;
  }
  const content = delta.content ?? "";
  let additional_kwargs;
  const toolCallChunks: ToolCallChunk[] = [];
  if (rawToolCallChunksWithIndex !== undefined) {
    for (const rawToolCallChunk of rawToolCallChunksWithIndex) {
      const rawArgs = rawToolCallChunk.function?.arguments;
      const args =
        rawArgs === undefined || typeof rawArgs === "string"
          ? rawArgs
          : JSON.stringify(rawArgs);
      toolCallChunks.push({
        name: rawToolCallChunk.function?.name,
        args,
        id: rawToolCallChunk.id,
        index: rawToolCallChunk.index,
        type: "tool_call_chunk",
      });
    }
  } else {
    additional_kwargs = {};
  }

  if (role === "user") {
    return new HumanMessageChunk({ content });
  } else if (role === "assistant") {
    return new AIMessageChunk({
      content,
      tool_call_chunks: toolCallChunks,
      additional_kwargs,
      usage_metadata: usage
        ? {
            input_tokens: usage.promptTokens,
            output_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
          }
        : undefined,
    });
  } else if (role === "tool") {
    return new ToolMessageChunk({
      content,
      additional_kwargs,
      tool_call_id: rawToolCallChunksWithIndex?.[0].id ?? "",
    });
  } else if (role === "function") {
    return new FunctionMessageChunk({
      content,
      additional_kwargs,
    });
  } else {
    return new ChatMessageChunk({ content, role });
  }
}

function _convertToolToMistralTool(
  tools: ChatMistralAIToolType[]
): MistralAITool[] {
  return tools.map((tool) => {
    if ("function" in tool) {
      return tool as MistralAITool;
    }

    const description = tool.description ?? `Tool: ${tool.name}`;
    return {
      type: "function",
      function: {
        name: tool.name,
        description,
        parameters: zodToJsonSchema(tool.schema),
      },
    };
  });
}

/**
 * Mistral AI chat model integration.
 *
 * Setup:
 * Install `@langchain/mistralai` and set an environment variable named `MISTRAL_API_KEY`.
 *
 * ```bash
 * npm install @langchain/mistralai
 * export MISTRAL_API_KEY="your-api-key"
 * ```
 *
 * ## [Constructor args](https://api.js.langchain.com/classes/_langchain_mistralai.ChatMistralAI.html#constructor)
 *
 * ## [Runtime args](https://api.js.langchain.com/interfaces/_langchain_mistralai.ChatMistralAICallOptions.html)
 *
 * Runtime args can be passed as the second argument to any of the base runnable methods `.invoke`. `.stream`, `.batch`, etc.
 * They can also be passed via `.bind`, or the second arg in `.bindTools`, like shown in the examples below:
 *
 * ```typescript
 * // When calling `.bind`, call options should be passed via the first argument
 * const llmWithArgsBound = llm.bind({
 *   stop: ["\n"],
 *   tools: [...],
 * });
 *
 * // When calling `.bindTools`, call options should be passed via the second argument
 * const llmWithTools = llm.bindTools(
 *   [...],
 *   {
 *     tool_choice: "auto",
 *   }
 * );
 * ```
 *
 * ## Examples
 *
 * <details open>
 * <summary><strong>Instantiate</strong></summary>
 *
 * ```typescript
 * import { ChatMistralAI } from '@langchain/mistralai';
 *
 * const llm = new ChatMistralAI({
 *   model: "mistral-large-2402",
 *   temperature: 0,
 *   // other params...
 * });
 * ```
 * </details>
 *
 * <br />
 *
 * <details>
 * <summary><strong>Invoking</strong></summary>
 *
 * ```typescript
 * const input = `Translate "I love programming" into French.`;
 *
 * // Models also accept a list of chat messages or a formatted prompt
 * const result = await llm.invoke(input);
 * console.log(result);
 * ```
 *
 * ```txt
 * AIMessage {
 *   "content": "The translation of \"I love programming\" into French is \"J'aime la programmation\". Here's the breakdown:\n\n- \"I\" translates to \"Je\"\n- \"love\" translates to \"aime\"\n- \"programming\" translates to \"la programmation\"\n\nSo, \"J'aime la programmation\" means \"I love programming\" in French.",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "tokenUsage": {
 *       "completionTokens": 89,
 *       "promptTokens": 13,
 *       "totalTokens": 102
 *     },
 *     "finish_reason": "stop"
 *   },
 *   "tool_calls": [],
 *   "invalid_tool_calls": [],
 *   "usage_metadata": {
 *     "input_tokens": 13,
 *     "output_tokens": 89,
 *     "total_tokens": 102
 *   }
 * }
 * ```
 * </details>
 *
 * <br />
 *
 * <details>
 * <summary><strong>Streaming Chunks</strong></summary>
 *
 * ```typescript
 * for await (const chunk of await llm.stream(input)) {
 *   console.log(chunk);
 * }
 * ```
 *
 * ```txt
 * AIMessageChunk {
 *   "content": "The",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "prompt": 0,
 *     "completion": 0
 *   },
 *   "tool_calls": [],
 *   "tool_call_chunks": [],
 *   "invalid_tool_calls": []
 * }
 * AIMessageChunk {
 *   "content": " translation",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "prompt": 0,
 *     "completion": 0
 *   },
 *   "tool_calls": [],
 *   "tool_call_chunks": [],
 *   "invalid_tool_calls": []
 * }
 * AIMessageChunk {
 *   "content": " of",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "prompt": 0,
 *     "completion": 0
 *   },
 *   "tool_calls": [],
 *   "tool_call_chunks": [],
 *   "invalid_tool_calls": []
 * }
 * AIMessageChunk {
 *   "content": " \"",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "prompt": 0,
 *     "completion": 0
 *   },
 *   "tool_calls": [],
 *   "tool_call_chunks": [],
 *   "invalid_tool_calls": []
 * }
 * AIMessageChunk {
 *   "content": "I",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "prompt": 0,
 *     "completion": 0
 *   },
 *   "tool_calls": [],
 *   "tool_call_chunks": [],
 *   "invalid_tool_calls": []
 * }
 * AIMessageChunk {
 *  "content": ".",
 *  "additional_kwargs": {},
 *  "response_metadata": {
 *    "prompt": 0,
 *    "completion": 0
 *  },
 *  "tool_calls": [],
 *  "tool_call_chunks": [],
 *  "invalid_tool_calls": []
 *}
 *AIMessageChunk {
 *  "content": "",
 *  "additional_kwargs": {},
 *  "response_metadata": {
 *    "prompt": 0,
 *    "completion": 0
 *  },
 *  "tool_calls": [],
 *  "tool_call_chunks": [],
 *  "invalid_tool_calls": [],
 *  "usage_metadata": {
 *    "input_tokens": 13,
 *    "output_tokens": 89,
 *    "total_tokens": 102
 *  }
 *}
 * ```
 * </details>
 *
 * <br />
 *
 * <details>
 * <summary><strong>Aggregate Streamed Chunks</strong></summary>
 *
 * ```typescript
 * import { AIMessageChunk } from '@langchain/core/messages';
 * import { concat } from '@langchain/core/utils/stream';
 *
 * const stream = await llm.stream(input);
 * let full: AIMessageChunk | undefined;
 * for await (const chunk of stream) {
 *   full = !full ? chunk : concat(full, chunk);
 * }
 * console.log(full);
 * ```
 *
 * ```txt
 * AIMessageChunk {
 *   "content": "The translation of \"I love programming\" into French is \"J'aime la programmation\". Here's the breakdown:\n\n- \"I\" translates to \"Je\"\n- \"love\" translates to \"aime\"\n- \"programming\" translates to \"la programmation\"\n\nSo, \"J'aime la programmation\" means \"I love programming\" in French.",
 *   "additional_kwargs": {},
 *   "response_metadata": {
 *     "prompt": 0,
 *     "completion": 0
 *   },
 *   "tool_calls": [],
 *   "tool_call_chunks": [],
 *   "invalid_tool_calls": [],
 *   "usage_metadata": {
 *     "input_tokens": 13,
 *     "output_tokens": 89,
 *     "total_tokens": 102
 *   }
 * }
 * ```
 * </details>
 *
 * <br />
 *
 * <details>
 * <summary><strong>Bind tools</strong></summary>
 *
 * ```typescript
 * import { z } from 'zod';
 *
 * const GetWeather = {
 *   name: "GetWeather",
 *   description: "Get the current weather in a given location",
 *   schema: z.object({
 *     location: z.string().describe("The city and state, e.g. San Francisco, CA")
 *   }),
 * }
 *
 * const GetPopulation = {
 *   name: "GetPopulation",
 *   description: "Get the current population in a given location",
 *   schema: z.object({
 *     location: z.string().describe("The city and state, e.g. San Francisco, CA")
 *   }),
 * }
 *
 * const llmWithTools = llm.bindTools([GetWeather, GetPopulation]);
 * const aiMsg = await llmWithTools.invoke(
 *   "Which city is hotter today and which is bigger: LA or NY?"
 * );
 * console.log(aiMsg.tool_calls);
 * ```
 *
 * ```txt
 * [
 *   {
 *     name: 'GetWeather',
 *     args: { location: 'Los Angeles, CA' },
 *     type: 'tool_call',
 *     id: '47i216yko'
 *   },
 *   {
 *     name: 'GetWeather',
 *     args: { location: 'New York, NY' },
 *     type: 'tool_call',
 *     id: 'nb3v8Fpcn'
 *   },
 *   {
 *     name: 'GetPopulation',
 *     args: { location: 'Los Angeles, CA' },
 *     type: 'tool_call',
 *     id: 'EedWzByIB'
 *   },
 *   {
 *     name: 'GetPopulation',
 *     args: { location: 'New York, NY' },
 *     type: 'tool_call',
 *     id: 'jLdLia7zC'
 *   }
 * ]
 * ```
 * </details>
 *
 * <br />
 *
 * <details>
 * <summary><strong>Structured Output</strong></summary>
 *
 * ```typescript
 * import { z } from 'zod';
 *
 * const Joke = z.object({
 *   setup: z.string().describe("The setup of the joke"),
 *   punchline: z.string().describe("The punchline to the joke"),
 *   rating: z.number().optional().describe("How funny the joke is, from 1 to 10")
 * }).describe('Joke to tell user.');
 *
 * const structuredLlm = llm.withStructuredOutput(Joke, { name: "Joke" });
 * const jokeResult = await structuredLlm.invoke("Tell me a joke about cats");
 * console.log(jokeResult);
 * ```
 *
 * ```txt
 * {
 *   setup: "Why don't cats play poker in the jungle?",
 *   punchline: 'Too many cheetahs!',
 *   rating: 7
 * }
 * ```
 * </details>
 *
 * <br />
 *
 * <details>
 * <summary><strong>Usage Metadata</strong></summary>
 *
 * ```typescript
 * const aiMsgForMetadata = await llm.invoke(input);
 * console.log(aiMsgForMetadata.usage_metadata);
 * ```
 *
 * ```txt
 * { input_tokens: 13, output_tokens: 89, total_tokens: 102 }
 * ```
 * </details>
 *
 * <br />
 */
export class ChatMistralAI<
    CallOptions extends ChatMistralAICallOptions = ChatMistralAICallOptions
  >
  extends BaseChatModel<CallOptions, AIMessageChunk>
  implements ChatMistralAIInput
{
  // Used for tracing, replace with the same name as your class
  static lc_name() {
    return "ChatMistralAI";
  }

  lc_namespace = ["langchain", "chat_models", "mistralai"];

  modelName = "mistral-small-latest";

  model = "mistral-small-latest";

  apiKey: string;

  serverURL?: string;

  temperature = 0.7;

  streaming = false;

  topP = 1;

  maxTokens: number;

  /**
   * @deprecated use safePrompt instead
   */
  safeMode = false;

  safePrompt = false;

  randomSeed?: number;

  seed?: number;

  lc_serializable = true;

  streamUsage = true;

  constructor(fields?: ChatMistralAIInput) {
    super(fields ?? {});
    const apiKey = fields?.apiKey ?? getEnvironmentVariable("MISTRAL_API_KEY");
    if (!apiKey) {
      throw new Error(
        "API key MISTRAL_API_KEY is missing for MistralAI, but it is required."
      );
    }
    this.apiKey = apiKey;
    this.streaming = fields?.streaming ?? this.streaming;
    this.serverURL = fields?.serverURL;
    this.temperature = fields?.temperature ?? this.temperature;
    this.topP = fields?.topP ?? this.topP;
    this.maxTokens = fields?.maxTokens ?? this.maxTokens;
    this.safePrompt = fields?.safePrompt ?? this.safePrompt;
    this.randomSeed = fields?.seed ?? fields?.randomSeed ?? this.seed;
    this.seed = this.randomSeed;
    this.modelName = fields?.model ?? fields?.modelName ?? this.model;
    this.model = this.modelName;
    this.streamUsage = fields?.streamUsage ?? this.streamUsage;
  }

  get lc_secrets(): { [key: string]: string } | undefined {
    return {
      apiKey: "MISTRAL_API_KEY",
    };
  }

  get lc_aliases(): { [key: string]: string } | undefined {
    return {
      apiKey: "mistral_api_key",
    };
  }

  getLsParams(options: this["ParsedCallOptions"]): LangSmithParams {
    const params = this.invocationParams(options);
    return {
      ls_provider: "mistral",
      ls_model_name: this.model,
      ls_model_type: "chat",
      ls_temperature: params.temperature ?? undefined,
      ls_max_tokens: params.maxTokens ?? undefined,
    };
  }

  _llmType() {
    return "mistral_ai";
  }

  /**
   * Get the parameters used to invoke the model
   */
  invocationParams(
    options?: this["ParsedCallOptions"]
  ): Omit<MistralAIChatCompletionRequest, "messages"> {
    const { response_format, tools, tool_choice } = options ?? {};
    const mistralAITools: Array<MistralAITool> | undefined = tools?.length
      ? _convertToolToMistralTool(tools)
      : undefined;
    const params: Omit<MistralAIChatCompletionRequest, "messages"> = {
      model: this.model,
      tools: mistralAITools,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      topP: this.topP,
      randomSeed: this.seed,
      safePrompt: this.safePrompt,
      toolChoice: tool_choice,
      responseFormat: response_format,
    };
    return params;
  }

  override bindTools(
    tools: ChatMistralAIToolType[],
    kwargs?: Partial<CallOptions>
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, CallOptions> {
    return this.bind({
      tools: _convertToolToMistralTool(tools),
      ...kwargs,
    } as CallOptions);
  }

  /**
   * Calls the MistralAI API with retry logic in case of failures.
   * @param {ChatRequest} input The input to send to the MistralAI API.
   * @returns {Promise<MistralAIChatCompletionResult | AsyncGenerator<MistralAIChatCompletionResult>>} The response from the MistralAI API.
   */
  async completionWithRetry(
    input: MistralChatCompletionStreamRequest,
    streaming: true
  ): Promise<AsyncIterable<MistralAIChatCompletionEvent>>;

  async completionWithRetry(
    input: MistralAIChatCompletionRequest,
    streaming: false
  ): Promise<MistralChatCompletionResponse>;

  async completionWithRetry(
    input: MistralAIChatCompletionRequest | MistralChatCompletionStreamRequest,
    streaming: boolean
  ): Promise<
    MistralChatCompletionResponse | AsyncIterable<MistralAIChatCompletionEvent>
  > {
    const client = new MistralClient({
      apiKey: this.apiKey,
      serverURL: this.serverURL,
    });

    return this.caller.call(async () => {
      try {
        let res:
          | MistralChatCompletionResponse
          | AsyncIterable<MistralAIChatCompletionEvent>;
        if (streaming) {
          res = await client.chat.stream(input);
        } else {
          res = await client.chat.complete(input);
        }
        return res;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        console.log(e, e.status, e.code, e.statusCode, e.message);
        if (
          e.message?.includes("status: 400") ||
          e.message?.toLowerCase().includes("status 400") ||
          e.message?.includes("validation failed")
        ) {
          e.status = 400;
        }
        throw e;
      }
    });
  }

  /** @ignore */
  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const tokenUsage: TokenUsage = {};
    const params = this.invocationParams(options);
    const mistralMessages = convertMessagesToMistralMessages(messages);
    const input = {
      ...params,
      messages: mistralMessages,
    };

    // Enable streaming for signal controller or timeout due
    // to SDK limitations on canceling requests.
    const shouldStream = options.signal ?? !!options.timeout;

    // Handle streaming
    if (this.streaming || shouldStream) {
      const stream = this._streamResponseChunks(messages, options, runManager);
      const finalChunks: Record<number, ChatGenerationChunk> = {};
      for await (const chunk of stream) {
        const index =
          (chunk.generationInfo as NewTokenIndices)?.completion ?? 0;
        if (finalChunks[index] === undefined) {
          finalChunks[index] = chunk;
        } else {
          finalChunks[index] = finalChunks[index].concat(chunk);
        }
      }
      const generations = Object.entries(finalChunks)
        .sort(([aKey], [bKey]) => parseInt(aKey, 10) - parseInt(bKey, 10))
        .map(([_, value]) => value);

      return { generations, llmOutput: { estimatedTokenUsage: tokenUsage } };
    }

    // Not streaming, so we can just call the API once.
    const response = await this.completionWithRetry(input, false);

    const { completionTokens, promptTokens, totalTokens } =
      response?.usage ?? {};

    if (completionTokens) {
      tokenUsage.completionTokens =
        (tokenUsage.completionTokens ?? 0) + completionTokens;
    }

    if (promptTokens) {
      tokenUsage.promptTokens = (tokenUsage.promptTokens ?? 0) + promptTokens;
    }

    if (totalTokens) {
      tokenUsage.totalTokens = (tokenUsage.totalTokens ?? 0) + totalTokens;
    }

    const generations: ChatGeneration[] = [];
    for (const part of response?.choices ?? []) {
      if ("delta" in part) {
        throw new Error("Delta not supported in non-streaming mode.");
      }
      if (!("message" in part)) {
        throw new Error("No message found in the choice.");
      }
      const text = part.message?.content ?? "";
      const generation: ChatGeneration = {
        text,
        message: mistralAIResponseToChatMessage(part, response?.usage),
      };
      if (part.finishReason) {
        generation.generationInfo = { finishReason: part.finishReason };
      }
      generations.push(generation);
    }
    return {
      generations,
      llmOutput: { tokenUsage },
    };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const mistralMessages = convertMessagesToMistralMessages(messages);
    const params = this.invocationParams(options);
    const input = {
      ...params,
      messages: mistralMessages,
    };

    const streamIterable = await this.completionWithRetry(input, true);
    for await (const { data } of streamIterable) {
      if (options.signal?.aborted) {
        throw new Error("AbortError");
      }
      const choice = data?.choices[0];
      if (!choice || !("delta" in choice)) {
        continue;
      }

      const { delta } = choice;
      if (!delta) {
        continue;
      }
      const newTokenIndices = {
        prompt: 0,
        completion: choice.index ?? 0,
      };
      const shouldStreamUsage = this.streamUsage || options.streamUsage;
      const message = _convertDeltaToMessageChunk(
        delta,
        shouldStreamUsage ? data.usage : null
      );
      if (message === null) {
        // Do not yield a chunk if the message is empty
        continue;
      }
      const generationChunk = new ChatGenerationChunk({
        message,
        text: delta.content ?? "",
        generationInfo: newTokenIndices,
      });
      yield generationChunk;
      // eslint-disable-next-line no-void
      void runManager?.handleLLMNewToken(
        generationChunk.text ?? "",
        newTokenIndices,
        undefined,
        undefined,
        undefined,
        { chunk: generationChunk }
      );
    }
  }

  /** @ignore */
  _combineLLMOutput() {
    return [];
  } 

  withStructuredOutput<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput extends Record<string, any> = Record<string, any>
  >(
    outputSchema:
      | StructuredOutputMethodParams<RunOutput, false>
      | z.ZodType<RunOutput>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | Record<string, any>,
    config?: StructuredOutputMethodOptions<false>
  ): Runnable<BaseLanguageModelInput, RunOutput>;

  withStructuredOutput<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput extends Record<string, any> = Record<string, any>
  >(
    outputSchema:
      | StructuredOutputMethodParams<RunOutput, true>
      | z.ZodType<RunOutput>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | Record<string, any>,
    config?: StructuredOutputMethodOptions<true>
  ): Runnable<BaseLanguageModelInput, { raw: BaseMessage; parsed: RunOutput }>;

  withStructuredOutput<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunOutput extends Record<string, any> = Record<string, any>
  >(
    outputSchema:
      | StructuredOutputMethodParams<RunOutput, boolean>
      | z.ZodType<RunOutput>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | Record<string, any>,
    config?: StructuredOutputMethodOptions<boolean>
  ):
    | Runnable<BaseLanguageModelInput, RunOutput>
    | Runnable<
        BaseLanguageModelInput,
        { raw: BaseMessage; parsed: RunOutput }
      > {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let schema: z.ZodType<RunOutput> | Record<string, any>;
    let name;
    let method;
    let includeRaw;
    if (isStructuredOutputMethodParams(outputSchema)) {
      schema = outputSchema.schema;
      name = outputSchema.name;
      method = outputSchema.method;
      includeRaw = outputSchema.includeRaw;
    } else {
      schema = outputSchema;
      name = config?.name;
      method = config?.method;
      includeRaw = config?.includeRaw;
    }
    let llm: Runnable<BaseLanguageModelInput>;
    let outputParser: BaseLLMOutputParser<RunOutput>;

    if (method === "jsonMode") {
      llm = this.bind({
        response_format: { type: "json_object" },
      } as Partial<CallOptions>);
      if (isZodSchema(schema)) {
        outputParser = StructuredOutputParser.fromZodSchema(schema);
      } else {
        outputParser = new JsonOutputParser<RunOutput>();
      }
    } else {
      let functionName = name ?? "extract";
      // Is function calling
      if (isZodSchema(schema)) {
        const asJsonSchema = zodToJsonSchema(schema);
        llm = this.bind({
          tools: [
            {
              type: "function" as const,
              function: {
                name: functionName,
                description: asJsonSchema.description,
                parameters: asJsonSchema,
              },
            },
          ],
          tool_choice: "any",
        } as Partial<CallOptions>);
        outputParser = new JsonOutputKeyToolsParser({
          returnSingle: true,
          keyName: functionName,
          zodSchema: schema,
        });
      } else {
        let openAIFunctionDefinition: FunctionDefinition;
        if (
          typeof schema.name === "string" &&
          typeof schema.parameters === "object" &&
          schema.parameters != null
        ) {
          openAIFunctionDefinition = schema as FunctionDefinition;
          functionName = schema.name;
        } else {
          openAIFunctionDefinition = {
            name: functionName,
            description: schema.description ?? "",
            parameters: schema,
          };
        }
        llm = this.bind({
          tools: [
            {
              type: "function" as const,
              function: openAIFunctionDefinition,
            },
          ],
          tool_choice: "any",
        } as Partial<CallOptions>);
        outputParser = new JsonOutputKeyToolsParser<RunOutput>({
          returnSingle: true,
          keyName: functionName,
        });
      }
    }

    if (!includeRaw) {
      return llm.pipe(outputParser) as Runnable<
        BaseLanguageModelInput,
        RunOutput
      >;
    }

    const parserAssign = RunnablePassthrough.assign({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parsed: (input: any, config) => outputParser.invoke(input.raw, config),
    });
    const parserNone = RunnablePassthrough.assign({
      parsed: () => null,
    });
    const parsedWithFallback = parserAssign.withFallbacks({
      fallbacks: [parserNone],
    });
    return RunnableSequence.from<
      BaseLanguageModelInput,
      { raw: BaseMessage; parsed: RunOutput }
    >([
      {
        raw: llm,
      },
      parsedWithFallback,
    ]);
  }
}

function isZodSchema<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput extends Record<string, any> = Record<string, any>
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: z.ZodType<RunOutput> | Record<string, any>
): input is z.ZodType<RunOutput> {
  // Check for a characteristic method of Zod schemas
  return typeof (input as z.ZodType<RunOutput>)?.parse === "function";
}

function isStructuredOutputMethodParams(
  x: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): x is StructuredOutputMethodParams<Record<string, any>> {
  return (
    x !== undefined &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeof (x as StructuredOutputMethodParams<Record<string, any>>).schema ===
      "object"
  );
}
