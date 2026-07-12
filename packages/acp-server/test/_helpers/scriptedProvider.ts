/**
 * Scripted LLM provider seam for "real" ACP turn tests.
 *
 * Boots the full engine + ACP wire but replaces the wire `ChatProvider` with a
 * deterministic one that replays a FIFO queue of scripted responses. This keeps
 * the entire real stack — JSON-RPC, `AcpSession`, the agent turn loop,
 * `ModelImpl.request`, the real `generate()` stream-merge, `IEventBus`
 * `assistant.delta` → ACP `session/update`, tool execution, and the
 * approval / question bridge — and fakes only the network LLM call.
 *
 * Usage:
 *   const { seed, mockNextResponse } = createScriptedProvider();
 *   mockNextResponse({ type: 'text', text: 'hi' });
 *   const client = await createTestClient({ homeDir, extraSeeds: [seed] });
 *
 * The seed shadows the App-scope `IProtocolAdapterRegistry`, so every Model the
 * resolver builds routes its `createChatProvider()` call into the scripted
 * provider regardless of protocol.
 */

import {
  type FinishReason,
  IProtocolAdapterRegistry,
  type IProtocolAdapterRegistry as IProtocolAdapterRegistryType,
  type Message,
  type ProtocolAdapterConfig,
  type StreamedMessagePart,
  type TokenUsage,
  type Tool,
} from '@moonshot-ai/agent-core-v2';

interface ScriptedResponse {
  readonly parts: readonly StreamedMessagePart[];
  readonly finishReason?: FinishReason | null;
  readonly rawFinishReason?: string | null;
}

const SUPPORTED_PROTOCOLS = [
  'kimi',
  'anthropic',
  'openai',
  'openai_responses',
  'google-genai',
  'vertexai',
] as const;

const ZERO_USAGE: TokenUsage = {
  inputOther: 0,
  output: 0,
  inputCacheRead: 0,
  inputCacheCreation: 0,
};

/**
 * Async-iterable `StreamedMessage` backed by a fixed part list. Terminal fields
 * (`id` / `usage` / `finishReason` / `rawFinishReason`) are populated when the
 * iterator completes — matching the real `generate()` driver, which reads them
 * after its `for await` loop drains the stream.
 */
class ScriptedStream {
  id: string | null = null;
  usage: TokenUsage | null = null;
  finishReason: FinishReason | null = null;
  rawFinishReason: string | null = null;

  constructor(
    private readonly parts: readonly StreamedMessagePart[],
    private readonly response: ScriptedResponse,
    private readonly index: number,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    for (const part of this.parts) {
      yield part;
    }
    const hasToolCall = this.parts.some((p) => p.type === 'function');
    this.id = `scripted-${String(this.index)}`;
    this.usage = { ...ZERO_USAGE, output: this.parts.length };
    this.finishReason =
      this.response.finishReason ?? (hasToolCall ? 'tool_calls' : 'completed');
    this.rawFinishReason =
      this.response.rawFinishReason ?? (this.finishReason === 'completed' ? 'stop' : this.finishReason);
  }
}

class ScriptedChatProvider {
  readonly name = 'scripted';
  readonly modelName = 'scripted';
  readonly thinkingEffort = null;

  constructor(
    private readonly queue: ScriptedResponse[],
    private readonly calls: Array<readonly Message[]>,
  ) {}

  async generate(
    _systemPrompt: string,
    _tools: readonly Tool[],
    history: readonly Message[],
    options?: { signal?: AbortSignal },
  ): Promise<ScriptedStream> {
    options?.signal?.throwIfAborted();
    const response = this.queue.shift();
    if (response === undefined) {
      throw new Error(
        `scriptedProvider: unexpected generate() call #${String(this.calls.length + 1)} — ` +
          `queue exhausted. Push another response via mockNextResponse().`,
      );
    }
    this.calls.push(history);
    return new ScriptedStream(response.parts, response, this.calls.length);
  }

  withThinking(): ScriptedChatProvider {
    return this;
  }

  withMaxCompletionTokens(): ScriptedChatProvider {
    return this;
  }
}

export interface ScriptedProvider {
  /** App-scope seed tuple to pass as `extraSeeds: [seed]`. */
  readonly seed: readonly [typeof IProtocolAdapterRegistry, IProtocolAdapterRegistryType];
  /** Push a text-only assistant response onto the queue. */
  mockNextText(text: string): void;
  /** Push a response assembled from arbitrary streamed parts. */
  mockNextResponse(...parts: StreamedMessagePart[]): void;
  /** Push a response with an explicit finish reason. */
  mockNextProviderResponse(response: {
    readonly parts?: readonly StreamedMessagePart[];
    readonly finishReason?: FinishReason | null;
    readonly rawFinishReason?: string | null;
  }): void;
  /** Number of `generate()` calls the engine has made so far. */
  callCount(): number;
}

export function createScriptedProvider(): ScriptedProvider {
  const queue: ScriptedResponse[] = [];
  const calls: Array<readonly Message[]> = [];
  // Single shared provider so every ModelImpl in the process (main agent,
  // sub-agents) draws from the same FIFO queue.
  const provider = new ScriptedChatProvider(queue, calls);
  const registry: IProtocolAdapterRegistryType = {
    _serviceBrand: undefined,
    supportedProtocols: () => SUPPORTED_PROTOCOLS,
    // `createChatProvider` is called by `ModelImpl` (a package-internal method
    // not on the public interface); present at runtime, cast for the type gap.
    createChatProvider: (_input: ProtocolAdapterConfig) => provider,
  } as unknown as IProtocolAdapterRegistryType;

  return {
    seed: [IProtocolAdapterRegistry, registry],
    mockNextText: (text) => {
      queue.push({ parts: [{ type: 'text', text }] });
    },
    mockNextResponse: (...parts) => {
      queue.push({ parts: structuredClone(parts) });
    },
    mockNextProviderResponse: (response) => {
      queue.push({
        parts: structuredClone(response.parts ?? []),
        finishReason: response.finishReason,
        rawFinishReason: response.rawFinishReason,
      });
    },
    callCount: () => calls.length,
  };
}
