import { emissionsOf, type Emission } from '#/model/emission';
import {
  jsonResponse,
  SSE_HEADERS,
  sseData,
  type ProtocolCodec,
  type ResolvedUsage,
} from '#/model/protocols/codec';
import { asArray, asRecord, optionalString, stringOf } from '#/model/protocols/json';
import { argumentsText } from '#/model/steps';
import type { ErrorSpec, FinishSpec, ReplyStep, RequestView, ToolCallSpec, ViewCall, ViewMessage, ViewPart } from '#/model/types';
import { textOfParts } from '#/model/view';

export const openaiCodec: ProtocolCodec = {
  name: 'openai',
  matches: (path) => path.endsWith('/chat/completions'),
  parseRequest,
  encodeStream(step, context) {
    const emissions = emissionsOf(step, (callIndex, call) => context.callId(callIndex, call));
    const chunk = (delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, unknown>): string =>
      sseData({
        id: context.responseId,
        object: 'chat.completion.chunk',
        created: 0,
        model: context.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        usage,
      });
    return {
      headers: SSE_HEADERS,
      segments: emissions.map((emission, unit) => ({
        unit,
        data: chunk(unit === 0 ? { role: 'assistant', ...deltaOf(emission) } : deltaOf(emission), null),
      })),
      trailer: [
        chunk(emissions.length === 0 ? { role: 'assistant' } : {}, finishReasonOf(step), usageOf(context.usage)),
        'data: [DONE]\n\n',
      ],
      usageOnly: context.usage === null ? undefined : chunk({}, null, usageOf(context.usage)),
    };
  },
  encodeStreamError(error) {
    return sseData({ error: errorBody(error) });
  },
  encodeJson(step, context) {
    const text = step.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
    const thinking = step.parts.filter((part) => part.type === 'think');
    const reasoning = thinking.map((part) => part.text).join('');
    const signed = thinking.flatMap(({ text, signature }) => signature === undefined ? [] : [{ text, signature }]);
    const calls = step.parts.flatMap((part) => (part.type === 'call' ? [part.call] : []));
    return jsonResponse(200, {
      id: context.responseId,
      object: 'chat.completion',
      created: 0,
      model: context.model,
      choices: [
        {
          index: 0,
          finish_reason: finishReasonOf(step),
          message: {
            role: 'assistant',
            content: text,
            reasoning_content: reasoning === '' ? undefined : reasoning,
            reasoning_details: signed.length === 0 ? undefined : signed.flatMap(({ text, signature }, index) => signedDetails(text, signature, index)),
            tool_calls:
              calls.length === 0
                ? undefined
                : calls.map((call, callIndex) => ({
                    id: context.callId(callIndex, call),
                    type: 'function',
                    function: { name: call.name, arguments: argumentsText(call) },
                    ...extrasOf(call),
                  })),
          },
        },
      ],
      usage: usageOf(context.usage),
    });
  },
  encodeError(error) {
    return jsonResponse(error.status, error.body ?? { error: errorBody(error) }, error.headers);
  },
};

function deltaOf(emission: Emission): Record<string, unknown> {
  switch (emission.type) {
    case 'text':
      return { content: emission.text };
    case 'think':
      if (emission.signature === undefined) return { reasoning_content: emission.text };
      return { reasoning_details: signedDetails(emission.text, emission.signature, 0) };
    case 'call-start':
      return {
        tool_calls: [{ index: emission.callIndex, id: emission.id, type: 'function', function: { name: emission.call.name, arguments: '' }, ...extrasOf(emission.call) }],
      };
    case 'call-arguments':
      return { tool_calls: [{ index: emission.callIndex, function: { arguments: emission.piece } }] };
  }
}

function signedDetails(text: string, signature: string, index: number) {
  return [
    { type: 'summary', index, summary: text },
    { type: 'encrypted', index, summary: '', encrypted: signature },
  ];
}

export function finishReasonOf(step: ReplyStep): string | null {
  const finish: FinishSpec | undefined = step.finish;
  if (finish === null) return null;
  if (finish === undefined) return step.parts.some((part) => part.type === 'call') ? 'tool_calls' : 'stop';
  if (typeof finish === 'object') return finish.raw;
  switch (finish) {
    case 'completed':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'truncated':
      return 'length';
    case 'filtered':
      return 'content_filter';
    case 'paused':
      return 'pause_turn';
  }
}

function usageOf(usage: ResolvedUsage | null): Record<string, unknown> | undefined {
  if (usage === null) return undefined;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.output,
    total_tokens: prompt + usage.output,
    cached_tokens: usage.cacheRead,
    prompt_tokens_details: { cached_tokens: usage.cacheRead },
  };
}

function errorBody(error: ErrorSpec): Record<string, unknown> {
  return { message: error.message, type: error.type ?? 'testkit_error', code: error.code ?? error.status };
}

function parseRequest(body: unknown): RequestView {
  const record = asRecord(body);
  const system: string[] = [];
  const messages: ViewMessage[] = [];
  for (const raw of asArray(record['messages'])) {
    const message = asRecord(raw);
    const parts = contentParts(message['content']);
    const text = textOfParts(parts);
    switch (message['role']) {
      case 'system':
      case 'developer':
        if (text !== '') system.push(text);
        messages.push({ role: 'system', text, parts, calls: [] });
        break;
      case 'assistant':
        messages.push({
          role: 'assistant',
          text,
          parts,
          calls: asArray(message['tool_calls']).map(callOf),
          reasoning: optionalString(message['reasoning_content']),
        });
        break;
      case 'tool':
        messages.push({ role: 'tool', text, parts, calls: [], callId: optionalString(message['tool_call_id']) });
        break;
      default:
        messages.push({ role: 'user', text, parts, calls: [] });
    }
  }
  return {
    model: optionalString(record['model']),
    stream: record['stream'] === true,
    system: system.join('\n'),
    tools: asArray(record['tools']).map((tool) => {
      const fn = asRecord(asRecord(tool)['function']);
      return { name: stringOf(fn['name']), description: optionalString(fn['description']), parameters: fn['parameters'] };
    }),
    messages,
  };
}

function callOf(raw: unknown): ViewCall {
  const call = asRecord(raw);
  const fn = asRecord(call['function']);
  return { id: stringOf(call['id']), name: stringOf(fn['name']), arguments: stringOf(fn['arguments']) };
}

function contentParts(content: unknown): ViewPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return asArray(content).map((raw): ViewPart => {
    const part = asRecord(raw);
    switch (part['type']) {
      case 'text':
        return { type: 'text', text: stringOf(part['text']) };
      case 'image_url':
        return { type: 'image', url: stringOf(asRecord(part['image_url'])['url']) };
      case 'video_url':
        return { type: 'video', url: stringOf(asRecord(part['video_url'])['url']) };
      default:
        return { type: 'other', raw };
    }
  });
}

function extrasOf(call: ToolCallSpec): { readonly extras?: Readonly<Record<string, unknown>> } {
  return call.extras === undefined ? {} : { extras: call.extras };
}
