import { emissionsOf, type Emission } from '#/model/emission';
import { jsonResponse, SSE_HEADERS, type EncodeContext, type ProtocolCodec, type ResolvedUsage } from '#/model/protocols/codec';
import { asArray, asRecord, contentPartsOf, optionalString, stringOf } from '#/model/protocols/json';
import { argumentsText } from '#/model/steps';
import type { ErrorSpec, ReplyStep, RequestView, ToolCallSpec, ViewCall, ViewMessage, ViewPart } from '#/model/types';
import { textOfParts } from '#/model/view';

type OutputItem = Record<string, unknown>;

interface Terminal {
  readonly status: 'completed' | 'incomplete';
  readonly reason?: string;
}

interface OpenText {
  readonly kind: 'message' | 'reasoning';
  readonly outputIndex: number;
  readonly id: string;
  readonly signature?: string;
  text: string;
}

interface OpenCall {
  readonly outputIndex: number;
  readonly itemId: string;
  readonly callId: string;
  readonly call: ToolCallSpec;
  arguments: string;
}

export const openaiResponsesCodec: ProtocolCodec = {
  name: 'openai-responses',
  matches: (path) => path.endsWith('/responses'),
  parseRequest,
  encodeStream(step, context) {
    const writer = new EventWriter(context);
    const emissions = emissionsOf(step, (callIndex, call) => context.callId(callIndex, call));
    const segments = emissions.map((emission, unit) => {
      const opening = unit === 0 ? writer.created() : '';
      return { unit, data: opening + writer.emit(emission) };
    });
    const terminal = terminalOf(step);
    return {
      headers: SSE_HEADERS,
      segments,
      trailer: [
        (emissions.length === 0 ? writer.created() : '') + writer.closeAll(),
        ...(terminal === null ? [] : [writer.finished(terminal)]),
      ],
    };
  },
  encodeStreamError(error) {
    return sseEvent('error', { type: 'error', code: errorCode(error), message: error.message, param: null, sequence_number: 0 });
  },
  encodeJson(step, context) {
    const writer = new EventWriter(context);
    for (const emission of emissionsOf(step, (callIndex, call) => context.callId(callIndex, call))) writer.emit(emission);
    writer.closeAll();
    return jsonResponse(200, writer.response(terminalOf(step) ?? { status: 'completed' }));
  },
  encodeError(error) {
    return jsonResponse(error.status, error.body ?? { error: { message: error.message, type: error.type ?? 'testkit_error', code: errorCode(error), param: null } }, error.headers);
  },
};

class EventWriter {
  private sequence = 0;
  private readonly output: OutputItem[] = [];
  private open: OpenText | undefined;
  private readonly calls: OpenCall[] = [];

  constructor(private readonly context: EncodeContext) {}

  created(): string {
    return this.event('response.created', { response: this.response(undefined) });
  }

  emit(emission: Emission): string {
    switch (emission.type) {
      case 'text':
        return this.openText('message') + this.textDelta(emission.text);
      case 'think':
        return this.openText('reasoning', emission.signature) + this.reasoningDelta(emission.text);
      case 'call-start':
        return this.closeText() + this.startCall(emission.id, emission.call);
      case 'call-arguments':
        return this.callArguments(emission.id, emission.piece);
    }
  }

  closeAll(): string {
    return this.closeText() + this.closeCalls();
  }

  finished(terminal: Terminal): string {
    return this.event(terminal.status === 'completed' ? 'response.completed' : 'response.incomplete', { response: this.response(terminal) });
  }

  response(terminal: Terminal | undefined): Record<string, unknown> {
    return {
      id: this.context.responseId,
      object: 'response',
      created_at: 0,
      status: terminal?.status ?? 'in_progress',
      model: this.context.model,
      output: terminal === undefined ? [] : this.output,
      usage: terminal === undefined ? null : usageOf(this.context.usage),
      incomplete_details: terminal?.reason === undefined ? null : { reason: terminal.reason },
      error: null,
    };
  }

  private openText(kind: OpenText['kind'], signature?: string): string {
    if (this.open?.kind === kind && this.open.signature === signature) return '';
    const closing = this.closeAll();
    const outputIndex = this.nextOutputIndex();
    const id = `${kind === 'message' ? 'msg' : 'rs'}_${this.context.responseId}_${String(outputIndex)}`;
    this.open = { kind, outputIndex, id, signature, text: '' };
    if (kind === 'message') {
      return (
        closing +
        this.event('response.output_item.added', { output_index: outputIndex, item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] } }) +
        this.event('response.content_part.added', { item_id: id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      );
    }
    return (
      closing +
      this.event('response.output_item.added', { output_index: outputIndex, item: { type: 'reasoning', id, summary: [] } }) +
      this.event('response.reasoning_summary_part.added', { item_id: id, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } })
    );
  }

  private textDelta(text: string): string {
    const open = this.open!;
    open.text += text;
    return this.event('response.output_text.delta', { item_id: open.id, output_index: open.outputIndex, content_index: 0, delta: text });
  }

  private reasoningDelta(text: string): string {
    const open = this.open!;
    open.text += text;
    return this.event('response.reasoning_summary_text.delta', { item_id: open.id, output_index: open.outputIndex, summary_index: 0, delta: text });
  }

  private closeText(): string {
    const open = this.open;
    if (open === undefined) return '';
    this.open = undefined;
    if (open.kind === 'message') {
      const part = { type: 'output_text', text: open.text, annotations: [] };
      const item = { type: 'message', id: open.id, role: 'assistant', status: 'completed', content: [part] };
      this.output.push(item);
      return (
        this.event('response.output_text.done', { item_id: open.id, output_index: open.outputIndex, content_index: 0, text: open.text }) +
        this.event('response.content_part.done', { item_id: open.id, output_index: open.outputIndex, content_index: 0, part }) +
        this.event('response.output_item.done', { output_index: open.outputIndex, item })
      );
    }
    const summary = { type: 'summary_text', text: open.text };
    const item = { type: 'reasoning', id: open.id, summary: [summary], ...(open.signature === undefined ? {} : { encrypted_content: open.signature }) };
    this.output.push(item);
    return (
      this.event('response.reasoning_summary_text.done', { item_id: open.id, output_index: open.outputIndex, summary_index: 0, text: open.text }) +
      this.event('response.reasoning_summary_part.done', { item_id: open.id, output_index: open.outputIndex, summary_index: 0, part: summary }) +
      this.event('response.output_item.done', { output_index: open.outputIndex, item })
    );
  }

  private startCall(callId: string, call: ToolCallSpec): string {
    const outputIndex = this.nextOutputIndex();
    const pending: OpenCall = { outputIndex, itemId: `fc_${this.context.responseId}_${String(outputIndex)}`, callId, call, arguments: '' };
    this.calls.push(pending);
    return this.event('response.output_item.added', { output_index: outputIndex, item: callItem(pending, '', 'in_progress') });
  }

  private callArguments(callId: string, piece: string): string {
    const pending = this.calls.find((candidate) => candidate.callId === callId);
    if (pending === undefined) return '';
    pending.arguments += piece;
    return this.event('response.function_call_arguments.delta', { item_id: pending.itemId, output_index: pending.outputIndex, delta: piece });
  }

  private closeCalls(): string {
    let closing = '';
    for (const pending of this.calls.splice(0)) {
      const full = argumentsText(pending.call);
      const item = callItem(pending, full, 'completed');
      this.output.push(item);
      closing +=
        this.event('response.function_call_arguments.done', { item_id: pending.itemId, output_index: pending.outputIndex, arguments: full }) +
        this.event('response.output_item.done', { output_index: pending.outputIndex, item });
    }
    return closing;
  }

  private nextOutputIndex(): number {
    return this.output.length + (this.open === undefined ? 0 : 1) + this.calls.length;
  }

  private event(type: string, payload: Record<string, unknown>): string {
    const sequence = this.sequence;
    this.sequence += 1;
    return sseEvent(type, { type, sequence_number: sequence, ...payload });
  }
}

function callItem(pending: OpenCall, args: string, status: string): OutputItem {
  return { type: 'function_call', id: pending.itemId, call_id: pending.callId, name: pending.call.name, arguments: args, status };
}

function sseEvent(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function terminalOf(step: ReplyStep): Terminal | null {
  const finish = step.finish;
  if (finish === null) return null;
  if (finish === undefined) return { status: 'completed' };
  if (typeof finish === 'object') return finish.raw === 'completed' ? { status: 'completed' } : { status: 'incomplete', reason: finish.raw };
  switch (finish) {
    case 'completed':
    case 'tool_calls':
      return { status: 'completed' };
    case 'truncated':
      return { status: 'incomplete', reason: 'max_output_tokens' };
    case 'filtered':
      return { status: 'incomplete', reason: 'content_filter' };
    case 'paused':
      return { status: 'incomplete', reason: 'pause_turn' };
  }
}

function usageOf(usage: ResolvedUsage | null): Record<string, unknown> | null {
  if (usage === null) return null;
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    input_tokens: input,
    output_tokens: usage.output,
    total_tokens: input + usage.output,
    input_tokens_details: { cached_tokens: usage.cacheRead },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

function errorCode(error: ErrorSpec): string | null {
  return error.code === undefined ? null : String(error.code);
}

interface DraftMessage {
  role: ViewMessage['role'];
  text: string;
  parts: ViewPart[];
  calls: ViewCall[];
  callId?: string;
  reasoning?: string;
}

function parseRequest(body: unknown): RequestView {
  const record = asRecord(body);
  const system: string[] = [];
  const messages: DraftMessage[] = [];
  const pushSystem = (text: string, parts: ViewPart[]): void => {
    if (text !== '') system.push(text);
    messages.push({ role: 'system', text, parts, calls: [] });
  };
  const assistant = (): DraftMessage => {
    const last = messages.at(-1);
    if (last?.role === 'assistant') return last;
    const created: DraftMessage = { role: 'assistant', text: '', parts: [], calls: [] };
    messages.push(created);
    return created;
  };
  const instructions = optionalString(record['instructions']);
  if (instructions !== undefined && instructions !== '') pushSystem(instructions, [{ type: 'text', text: instructions }]);
  const input = record['input'];
  if (typeof input === 'string') messages.push({ role: 'user', text: input, parts: [{ type: 'text', text: input }], calls: [] });
  for (const raw of asArray(input)) {
    const item = asRecord(raw);
    switch (optionalString(item['type']) ?? 'message') {
      case 'message': {
        const parts = contentParts(item['content']);
        const text = textOfParts(parts);
        const role = item['role'];
        if (role === 'system' || role === 'developer') {
          pushSystem(text, parts);
        } else if (role === 'assistant') {
          const target = assistant();
          target.text += text;
          target.parts.push(...parts);
        } else {
          messages.push({ role: 'user', text, parts, calls: [] });
        }
        break;
      }
      case 'function_call':
        assistant().calls.push({ id: stringOf(item['call_id']), name: stringOf(item['name']), arguments: stringOf(item['arguments']) });
        break;
      case 'function_call_output': {
        const output = item['output'];
        const parts = typeof output === 'string' ? [{ type: 'text' as const, text: output }] : contentParts(output);
        messages.push({ role: 'tool', text: textOfParts(parts), parts, calls: [], callId: optionalString(item['call_id']) });
        break;
      }
      case 'reasoning': {
        const target = assistant();
        const summary = asArray(item['summary']).map((entry) => stringOf(asRecord(entry)['text'])).join('');
        target.reasoning = (target.reasoning ?? '') + summary;
        break;
      }
      default:
        break;
    }
  }
  return {
    model: optionalString(record['model']),
    stream: record['stream'] === true,
    system: system.join('\n'),
    tools: asArray(record['tools'])
      .map(asRecord)
      .filter((tool) => tool['type'] === 'function')
      .map((tool) => ({ name: stringOf(tool['name']), description: optionalString(tool['description']), parameters: tool['parameters'] })),
    messages,
  };
}

function contentParts(content: unknown): ViewPart[] {
  return contentPartsOf(content, (part, raw) => {
    switch (part['type']) {
      case 'input_text':
      case 'output_text':
        return { type: 'text', text: stringOf(part['text']) };
      case 'input_image':
        return { type: 'image', url: stringOf(part['image_url'] ?? part['file_id']) };
      default:
        return { type: 'other', raw };
    }
  });
}
