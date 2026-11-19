import { emissionsOf, type Emission } from '#/model/emission';
import {
  jsonResponse,
  objectArguments,
  SSE_HEADERS,
  sseData,
  type EncodeContext,
  type ProtocolCodec,
  type ResolvedUsage,
} from '#/model/protocols/codec';
import { asArray, asRecord, optionalString, stringOf } from '#/model/protocols/json';
import type { ErrorSpec, ReplyStep, RequestView, ViewCall, ViewMessage, ViewPart } from '#/model/types';
import { textOfParts } from '#/model/view';

export const googleCodec: ProtocolCodec = {
  name: 'google',
  matches: (path) => path.includes(':streamGenerateContent') || path.includes(':generateContent'),
  parseRequest,
  encodeStream(step, context) {
    const emissions = emissionsOf({ ...step, interleaveCalls: false }, (callIndex, call) => context.callId(callIndex, call));
    const segments = emissions.flatMap((emission, unit) => {
      const part = partOfEmission(emission);
      return part === undefined ? [] : [{ unit, data: sseData(responseOf(context, [part])) }];
    });
    return {
      headers: SSE_HEADERS,
      segments,
      trailer: [sseData(responseOf(context, [], finishReasonOf(step), usageOf(context.usage)))],
    };
  },
  encodeStreamError(error) {
    return JSON.stringify(errorBody(error));
  },
  encodeJson(step, context) {
    const emissions = emissionsOf({ ...step, interleaveCalls: false }, (callIndex, call) => context.callId(callIndex, call));
    const parts = emissions.flatMap((emission) => {
      const part = partOfEmission(emission);
      return part === undefined ? [] : [part];
    });
    return jsonResponse(200, responseOf(context, parts, finishReasonOf(step), usageOf(context.usage)));
  },
  encodeError(error) {
    return jsonResponse(error.status, error.body ?? errorBody(error), error.headers);
  },
};

function errorBody(error: ErrorSpec): Record<string, unknown> {
  const retryAfter = error.headers?.['retry-after'];
  const details = retryAfter === undefined ? undefined : [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${retryAfter}s` }];
  return { error: { code: error.status, message: error.message, status: error.type ?? statusOf(error.status), details } };
}

function responseOf(
  context: EncodeContext,
  parts: readonly Record<string, unknown>[],
  finishReason?: string | null,
  usageMetadata?: Record<string, number>,
): Record<string, unknown> {
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: finishReason ?? undefined, index: 0 }],
    usageMetadata,
    modelVersion: context.model,
    responseId: context.responseId,
  };
}

function partOfEmission(emission: Emission): Record<string, unknown> | undefined {
  switch (emission.type) {
    case 'text':
      return { text: emission.text };
    case 'think':
      return { text: emission.text, thought: true, thoughtSignature: emission.signature };
    case 'call-start':
      return { functionCall: { id: emission.id, name: emission.call.name, args: objectArguments(emission.call, 'google') } };
    case 'call-arguments':
      return undefined;
  }
}

function usageOf(usage: ResolvedUsage | null): Record<string, number> | undefined {
  if (usage === null) return undefined;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: usage.output,
    cachedContentTokenCount: usage.cacheRead,
    totalTokenCount: prompt + usage.output,
  };
}

function finishReasonOf(step: ReplyStep): string | null {
  const finish = step.finish;
  if (finish === null) return null;
  if (finish === undefined) return 'STOP';
  if (typeof finish === 'object') return finish.raw;
  switch (finish) {
    case 'completed':
    case 'tool_calls':
      return 'STOP';
    case 'truncated':
      return 'MAX_TOKENS';
    case 'filtered':
      return 'SAFETY';
    case 'paused':
      return 'OTHER';
  }
}

function statusOf(status: number): string {
  switch (status) {
    case 400:
      return 'INVALID_ARGUMENT';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'PERMISSION_DENIED';
    case 404:
      return 'NOT_FOUND';
    case 413:
    case 429:
      return 'RESOURCE_EXHAUSTED';
    case 503:
      return 'UNAVAILABLE';
    default:
      return 'INTERNAL';
  }
}

function parseRequest(body: unknown, path: string): RequestView {
  const record = asRecord(body);
  const messages: ViewMessage[] = [];
  for (const raw of asArray(record['contents'])) {
    const content = asRecord(raw);
    const role = content['role'] === 'model' ? 'assistant' : 'user';
    const wireParts = asArray(content['parts']);
    let parts: ViewPart[] = [];
    const calls: ViewCall[] = [];
    const reasoning: string[] = [];
    for (const rawPart of wireParts) {
      const part = asRecord(rawPart);
      if (part['functionCall'] !== undefined) {
        const functionCall = asRecord(part['functionCall']);
        const name = stringOf(functionCall['name']);
        calls.push({ id: optionalString(functionCall['id']) ?? name, name, arguments: JSON.stringify(functionCall['args'] ?? {}) });
      } else if (part['functionResponse'] !== undefined) {
        if (role === 'user' && parts.length > 0) {
          messages.push({ role, text: textOfParts(parts), parts, calls: [] });
          parts = [];
        }
        const response = asRecord(part['functionResponse']);
        const name = stringOf(response['name']);
        const text = JSON.stringify(response['response'] ?? {});
        messages.push({ role: 'tool', text, parts: [{ type: 'text', text }], calls: [], callId: optionalString(response['id']) ?? name });
      } else if (part['thought'] === true) {
        reasoning.push(stringOf(part['text']));
      } else {
        parts.push(viewPartOf(part));
      }
    }
    if (role === 'assistant') {
      messages.push({ role, text: textOfParts(parts), parts, calls, reasoning: reasoning.length === 0 ? undefined : reasoning.join('') });
    } else if (parts.length > 0 || wireParts.length === 0) {
      messages.push({ role, text: textOfParts(parts), parts, calls: [] });
    }
  }
  return {
    model: /\/models\/([^/:]+):/.exec(path)?.[1],
    stream: path.includes(':streamGenerateContent'),
    system: asArray(asRecord(record['systemInstruction'])['parts'])
      .map((part) => stringOf(asRecord(part)['text']))
      .join('\n'),
    tools: asArray(record['tools']).flatMap((tool) =>
      asArray(asRecord(tool)['functionDeclarations']).map((declaration) => {
        const fn = asRecord(declaration);
        return {
          name: stringOf(fn['name']),
          description: optionalString(fn['description']),
          parameters: fn['parameters'] ?? fn['parametersJsonSchema'],
        };
      }),
    ),
    messages,
  };
}

function viewPartOf(part: Record<string, unknown>): ViewPart {
  if (typeof part['text'] === 'string') return { type: 'text', text: part['text'] };
  const inline = asRecord(part['inlineData']);
  const file = asRecord(part['fileData']);
  const mediaType = optionalString(inline['mimeType']) ?? optionalString(file['mimeType']);
  const url = part['inlineData'] !== undefined ? `data:${mediaType ?? 'application/octet-stream'};base64,${stringOf(inline['data'])}` : stringOf(file['fileUri']);
  if (part['inlineData'] === undefined && part['fileData'] === undefined) return { type: 'other', raw: part };
  return { type: mediaType?.startsWith('video/') === true ? 'video' : 'image', url, mediaType };
}
