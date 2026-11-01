import type { GenerateContentParameters } from '@google/genai';
import { shake } from 'radashi';

import type { Message, TextPart, ToolDescription } from '#/llm/message';
import type { LlmSampling } from '#/llm/request';
import type { ResponseFormat } from '#/llm/request';
import { SyntaxRequestFormatError, ThinkingConfigError } from '#/llm/protocol/errors';
import type { ThinkingEffort } from '#/llm/request';
import { mediaUrlOf } from '#/llm/protocol/kit/media';
import { withExtras } from '#/llm/protocol/kit/params';
import { mergeConsecutiveUsers } from '#/llm/protocol/patterns';
import type { NativeModule, PipelineSpec } from '#/llm/protocol/pipeline';
import type { LlmModule } from '#/llm/protocol/protocol';
import type { Pattern } from '#/llm/protocol/pattern';
import type { MediaSupport } from '#/llm/protocol/rules/media';

import type { GoogleContent, GooglePart } from './contract';
import { googleGenAIModelLegality, sortToolRunByCallOrder } from './legalize';
import type { GoogleGenAIOptions } from './index';

export type NativeMessage = GoogleContent;

export type NativePart = GooglePart;

export type NativeTool = Readonly<Record<string, unknown>>;

export type GoogleGenAIParams = {
  readonly thinkingConfig?: Record<string, unknown>;
  readonly responseMimeType?: string;
  readonly responseJsonSchema?: Record<string, unknown>;
  readonly responseSchema?: unknown;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly stopSequences?: readonly string[];
  readonly seed?: number;
  readonly presencePenalty?: number;
  readonly frequencyPenalty?: number;
} & Readonly<Record<string, unknown>>;

export interface Request {
  readonly params: GenerateContentParameters;
}

type GoogleGenAIModule = LlmModule<GoogleGenAIOptions>;

function toolCallIdToName(toolCallId: string, messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    const toolCall = message.toolCalls.findLast((call) => call.id === toolCallId);
    if (toolCall !== undefined) return toolCall.name;
  }
  const withoutEntropy = toolCallId.replace(/_[0-9a-f]{8}$/, '');
  const match = /^(.+)_[^_]+$/.exec(withoutEntropy);
  return match?.[1] ?? withoutEntropy;
}

function convertMediaUrl(url: string, fallbackMimeType: string): NativePart {
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    if (commaIndex === -1) {
      return { fileData: { fileUri: url, mimeType: fallbackMimeType } };
    }
    const meta = url.slice(0, commaIndex);
    const data = url.slice(commaIndex + 1);
    const colonIndex = meta.indexOf(':');
    const semiIndex = meta.indexOf(';');
    const mimeType =
      colonIndex !== -1 && semiIndex !== -1
        ? meta.slice(colonIndex + 1, semiIndex)
        : fallbackMimeType;
    return { inlineData: { mimeType, data } };
  }
  let mimeType = fallbackMimeType;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.png')) mimeType = 'image/png';
    else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (pathname.endsWith('.gif')) mimeType = 'image/gif';
    else if (pathname.endsWith('.webp')) mimeType = 'image/webp';
    else if (pathname.endsWith('.mp3') || pathname.endsWith('.mpeg')) mimeType = 'audio/mpeg';
    else if (pathname.endsWith('.wav')) mimeType = 'audio/wav';
    else if (pathname.endsWith('.ogg')) mimeType = 'audio/ogg';
  } catch {}
  return { fileData: { fileUri: url, mimeType } };
}

export function lowerMessage(message: Message, module: GoogleGenAIModule): NativeMessage[] {
  if (message.role === 'tool') {
    let textOutput = '';
    const mediaParts: NativePart[] = [];
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
          if (part.text) textOutput += part.text;
          break;
        case 'image_url':
          mediaParts.push(convertMediaUrl(mediaUrlOf(part), 'image/jpeg'));
          break;
        case 'audio_url':
          mediaParts.push(convertMediaUrl(mediaUrlOf(part), 'audio/mpeg'));
          break;
        case 'video_url':
          mediaParts.push(convertMediaUrl(mediaUrlOf(part), 'video/mp4'));
          break;
        case 'think':
          break;
      }
    }
    return [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: toolCallIdToName(message.toolCallId, module.content.messages),
              response: { output: textOutput },
              parts: [],
            },
          },
          ...mediaParts,
        ],
      },
    ];
  }

  if (message.role === 'system') {
    const text = message.content
      .filter((part): part is TextPart => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (text.length === 0) return [];
    return [
      {
        role: 'user',
        parts: [{ text: `<system>${text}</system>` }],
      },
    ];
  }

  const role = message.role === 'assistant' ? 'model' : 'user';
  const parts: NativePart[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        parts.push({ text: part.text });
        break;
      case 'think': {
        const thoughtPart: NativePart = { text: part.think, thought: true };
        if (part.encrypted !== undefined && part.encrypted.length > 0) {
          thoughtPart.thoughtSignature = part.encrypted;
        }
        parts.push(thoughtPart);
        break;
      }
      case 'image_url':
        parts.push(convertMediaUrl(mediaUrlOf(part), 'image/jpeg'));
        break;
      case 'audio_url':
        parts.push(convertMediaUrl(mediaUrlOf(part), 'audio/mpeg'));
        break;
      case 'video_url':
        parts.push(convertMediaUrl(mediaUrlOf(part), 'video/mp4'));
        break;
    }
  }

  if (message.role === 'assistant') {
    for (const toolCall of message.toolCalls) {
      let args: Record<string, unknown> = {};
      if (toolCall.arguments) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(toolCall.arguments);
        } catch {
          throw new SyntaxRequestFormatError('Tool call arguments must be valid JSON.');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new SyntaxRequestFormatError('Tool call arguments must be a JSON object.');
        }
        args = parsed as Record<string, unknown>;
      }

      const functionCallPart: NativePart = {
        functionCall: {
          name: toolCall.name,
          args,
        },
      };

      if (toolCall.extras && 'thought_signature_b64' in toolCall.extras) {
        functionCallPart['thoughtSignature'] = toolCall.extras['thought_signature_b64'] as string;
      }

      parts.push(functionCallPart);
    }
  }

  return [{ role, parts }];
}

function defaultTool(tool: ToolDescription): Record<string, unknown> {
  return {
    functionDeclarations: [
      {
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      },
    ],
  };
}

const mergeTurnPatterns: readonly Pattern<NativeMessage>[] = [
  mergeConsecutiveUsers({
    isUser: (content) => content.role === 'user',
    isToolResultOnly: (content) => content.parts[0]?.functionResponse !== undefined,
    merge: (last, next) => {
      const lastStartsWithFunctionResponse = last.parts[0]?.functionResponse !== undefined;
      const nextHasFunctionResponse = next.parts.some(
        (part) => part.functionResponse !== undefined,
      );
      if (lastStartsWithFunctionResponse && !nextHasFunctionResponse) {
        return { ...next, parts: [...next.parts, ...last.parts] };
      }
      return { ...last, parts: [...last.parts, ...next.parts] };
    },
  }),
];

function encodeThinking(model: string, effort: ThinkingEffort): Record<string, unknown> {
  if (model.includes('gemini-3') || model.includes('gemini-4')) {
    if (effort === 'off' && model.includes('gemini-4')) {
      throw new ThinkingConfigError(
        'thinking-cannot-disable',
        `Model '${model}' always reasons and thinking cannot be turned off. Choose a concrete thinking effort (low, medium, high) instead of 'off'.`,
      );
    }
    switch (effort) {
      case 'off':
        return { includeThoughts: false, thinkingLevel: 'MINIMAL' };
      case 'low':
        return { includeThoughts: true, thinkingLevel: 'LOW' };
      case 'medium':
        return { includeThoughts: true, thinkingLevel: 'MEDIUM' };
      case 'high':
      case 'xhigh':
      case 'max':
        return { includeThoughts: true, thinkingLevel: 'HIGH' };
      default:
        return { includeThoughts: true };
    }
  }
  switch (effort) {
    case 'off':
      return { includeThoughts: false, thinkingBudget: 0 };
    case 'low':
      return { includeThoughts: true, thinkingBudget: 1024 };
    case 'medium':
      return { includeThoughts: true, thinkingBudget: 4096 };
    case 'high':
    case 'xhigh':
    case 'max':
      return { includeThoughts: true, thinkingBudget: 32_000 };
    default:
      return { includeThoughts: true };
  }
}

function applyResponseFormat(params: GoogleGenAIParams, format: ResponseFormat): GoogleGenAIParams {
  const { responseSchema: _dropSchema, responseJsonSchema: _dropJsonSchema, ...rest } = params;
  return {
    ...rest,
    responseMimeType: 'application/json',
    responseJsonSchema: format.type === 'json_schema' ? format.jsonSchema.schema : undefined,
  };
}

function encodeSampling(sampling: LlmSampling): Partial<GoogleGenAIParams> {
  return shake({
    temperature: sampling.temperature,
    topP: sampling.topP,
    topK: sampling.topK,
    stopSequences: sampling.stop,
    seed: sampling.seed,
    presencePenalty: sampling.presencePenalty,
    frequencyPenalty: sampling.frequencyPenalty,
  });
}

function flatten(
  native: NativeModule<NativeMessage, NativeTool, GoogleGenAIParams>,
  module: GoogleGenAIModule,
): Request {
  const config = withExtras(
    {
      systemInstruction: native.system ? native.system : undefined,
      tools: native.tools.length === 0 ? undefined : native.tools,
      ...native.params,
    },
    module.options?.extras,
  );
  const params = { model: module.model.spec.name, contents: native.messages, config };
  return { params: params as unknown as GenerateContentParameters };
}

export const googleGenAIMedia: MediaSupport = {
  kinds: {
    image: { mimes: 'any', sources: ['url', 'inline', 'file'], inToolResult: 'native' },
    video: { mimes: 'any', sources: ['url', 'inline', 'file'], inToolResult: 'native' },
    audio: { mimes: 'any', sources: ['url', 'inline', 'file'], inToolResult: 'native' },
  },
};

export const googleGenAIPipeline: PipelineSpec<
  GoogleGenAIOptions,
  NativeMessage,
  NativeTool,
  GoogleGenAIParams,
  Request
> = {
  media: googleGenAIMedia,
  patterns: () => [sortToolRunByCallOrder],
  legality: googleGenAIModelLegality,
  thinking: (thinking, module) =>
    thinking === undefined
      ? undefined
      : { thinkingConfig: encodeThinking(module.model.spec.name, thinking.effort) },
  responseFormat: applyResponseFormat,
  maxOutputTokens: (cap) => ({ maxOutputTokens: cap }),
  sampling: encodeSampling,
  tool: defaultTool,
  message: lowerMessage,
  mergeTurns: mergeTurnPatterns,
  flatten,
};
