import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { LlmRequest } from '@moonshot-ai/core/llm/request';
import type { LlmOutcome, TokenUsage } from '@moonshot-ai/core/llm/response';

import type { ArtexLlmWireCapture } from './capture';

export const ARTEX_LLMREC_DEFAULT_MAX_INLINE_BYTES = 16 * 1024;
export const ARTEX_LLMREC_DEFAULT_MAX_BLOB_BYTES = 1024 * 1024;

export interface ArtexParsedSession {
  readonly taskId: string;
  readonly explorationId: number;
  readonly worker: string;
}

export interface ArtexLlmUsageEntry {
  readonly ts: string;
  readonly taskId: string;
  readonly explorationId: number;
  readonly worker: string;
  readonly model: string;
  readonly profileName: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly status: 'ok' | 'error';
}

export interface ArtexLlmRecordEntry {
  readonly id: string;
  readonly ts: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly explorationId: number;
  readonly worker: string;
  readonly model: string;
  readonly profileName: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly status: 'ok' | 'error';
  readonly error?: string;
  readonly stopReason?: string;
  readonly requestSummary: string;
  readonly responseSummary: string;
  readonly rawRequestPreview?: string;
  readonly rawResponsePreview?: string;
  readonly rawRequestBlob?: string;
  readonly rawResponseBlob?: string;
  readonly rawRequestBytes: number;
  readonly rawResponseBytes: number;
}

export interface ArtexLlmRecorderOptions {
  readonly recordDir: string;
  readonly enabled?: boolean | (() => boolean);
  readonly meterUsage?: boolean;
  readonly maxInlineBytes?: number;
  readonly maxBlobBytes?: number;
  readonly onUsage?: (entry: ArtexLlmUsageEntry) => void;
}

export interface ArtexLlmRecordCallInput {
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly worker?: string;
  readonly model?: string;
  readonly profileName?: string;
  readonly latencyMs: number;
  readonly request?: LlmRequest;
  readonly requestSummary?: string;
  readonly responseText?: string;
  readonly thinkingText?: string;
  readonly stopReason?: string;
  readonly usage?: Partial<TokenUsage>;
  readonly status: 'ok' | 'error';
  readonly error?: string;
  readonly capture?: ArtexLlmWireCapture;
}

export function parseArtexSessionId(sessionId: string): ArtexParsedSession {
  if (!sessionId.startsWith('exp')) {
    return { taskId: '', explorationId: 0, worker: '' };
  }
  const rest = sessionId.slice(3);
  const dashIndex = rest.indexOf('-');
  if (dashIndex < 0) {
    const expNum = Number.parseInt(rest, 10);
    return {
      taskId: rest,
      explorationId: Number.isInteger(expNum) && expNum > 0 ? expNum : 0,
      worker: '',
    };
  }
  const taskId = rest.slice(0, dashIndex);
  const tail = rest.slice(dashIndex + 1);
  const nextDash = tail.indexOf('-');
  const worker = nextDash >= 0 ? tail.slice(0, nextDash) : tail;
  const expNum = Number.parseInt(taskId, 10);
  return {
    taskId,
    explorationId: Number.isInteger(expNum) && expNum > 0 ? expNum : 0,
    worker,
  };
}

export function serializeArtexLlmRequest(request: LlmRequest): string {
  const summary: Record<string, unknown> = {
    provider: request.model.spec.provider,
    model: request.model.spec.name,
    maxOutputTokens: request.model.maxOutputTokens,
    messageCount: request.content.messages.length,
    messages: request.content.messages,
  };
  if (request.profile?.systemPrompt !== undefined) {
    summary['systemPrompt'] = request.profile.systemPrompt;
  }
  if (request.model.thinking !== undefined) {
    summary['thinking'] = request.model.thinking;
  }
  if (request.model.sampling !== undefined) {
    summary['sampling'] = request.model.sampling;
  }
  if (request.profile?.tools !== undefined && request.profile.tools.length > 0) {
    summary['tools'] = request.profile.tools.map((tool) => tool.name);
    summary['toolsCount'] = request.profile.tools.length;
  }
  return JSON.stringify(summary);
}

function clipUtf8(value: string, maxBytes: number): { readonly text: string; readonly bytes: number; readonly truncated: boolean } {
  const buf = Buffer.from(value, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return { text: value, bytes: buf.byteLength, truncated: false };
  }
  return {
    text: `${buf.subarray(0, maxBytes).toString('utf8')}…(truncated, ${String(buf.byteLength)} bytes total)`,
    bytes: buf.byteLength,
    truncated: true,
  };
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

export class ArtexLlmRecorder {
  readonly recordDir: string;
  private readonly recordsPath: string;
  private readonly usagePath: string;
  private readonly blobsDir: string;
  private readonly enabledPredicate: () => boolean;
  private readonly meterUsage: boolean;
  private readonly maxInlineBytes: number;
  private readonly maxBlobBytes: number;
  private readonly onUsage: ((entry: ArtexLlmUsageEntry) => void) | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private dirReady = false;

  constructor(options: ArtexLlmRecorderOptions) {
    this.recordDir = options.recordDir;
    this.recordsPath = path.join(this.recordDir, 'records.jsonl');
    this.usagePath = path.join(this.recordDir, 'usage.jsonl');
    this.blobsDir = path.join(this.recordDir, 'blobs');
    const enabled = options.enabled ?? false;
    this.enabledPredicate = typeof enabled === 'function' ? enabled : () => enabled;
    this.meterUsage = options.meterUsage ?? true;
    this.maxInlineBytes = Math.max(256, options.maxInlineBytes ?? ARTEX_LLMREC_DEFAULT_MAX_INLINE_BYTES);
    this.maxBlobBytes = Math.max(this.maxInlineBytes, options.maxBlobBytes ?? ARTEX_LLMREC_DEFAULT_MAX_BLOB_BYTES);
    this.onUsage = options.onUsage;
  }

  isRecording(): boolean {
    return this.enabledPredicate();
  }

  async recordCall(input: ArtexLlmRecordCallInput): Promise<ArtexLlmRecordEntry | undefined> {
    const parsed = parseArtexSessionId(input.sessionId ?? '');
    const taskId = nonEmptyTrimmed(input.taskId) ?? parsed.taskId;
    const worker = nonEmptyTrimmed(input.worker) ?? parsed.worker;
    const explorationId = parsed.explorationId;
    const model = input.model ?? input.request?.model.spec.name ?? '';
    const profileName = input.profileName ?? '';
    const inputTokens = (input.usage?.inputOther ?? 0) + (input.usage?.inputCacheRead ?? 0);
    const outputTokens = input.usage?.output ?? 0;
    const cacheReadTokens = input.usage?.inputCacheRead ?? 0;
    const cacheWriteTokens = input.usage?.inputCacheCreation ?? 0;
    const ts = new Date().toISOString();

    const hasMeterData =
      model.length > 0 ||
      inputTokens > 0 ||
      outputTokens > 0 ||
      cacheReadTokens > 0 ||
      cacheWriteTokens > 0;

    const usageEntry: ArtexLlmUsageEntry | undefined = hasMeterData
      ? {
          ts,
          taskId,
          explorationId,
          worker,
          model,
          profileName,
          latencyMs: Math.max(0, Math.round(input.latencyMs)),
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          status: input.status,
        }
      : undefined;

    if (usageEntry !== undefined) {
      this.onUsage?.(usageEntry);
    }

    const recordBodies = this.enabledPredicate();
    if (!recordBodies && (!this.meterUsage || usageEntry === undefined)) {
      return undefined;
    }

    return this.enqueueWrite(async () => {
      await this.ensureDirs(recordBodies);

      if (this.meterUsage && usageEntry !== undefined) {
        await appendFile(this.usagePath, `${JSON.stringify(usageEntry)}\n`, 'utf8');
      }

      if (!recordBodies) {
        return undefined;
      }

      const id = randomUUID();
      const rawReq = input.capture?.rawRequest() ?? '';
      const rawResp = input.capture?.rawResponse() ?? '';
      const rawReqClipped = clipUtf8(rawReq, this.maxInlineBytes);
      const rawRespClipped = clipUtf8(rawResp, this.maxInlineBytes);

      let rawRequestBlob: string | undefined;
      if (rawReq.length > 0) {
        const rel = path.join('blobs', `${id}-req.txt`);
        const bounded = clipUtf8(rawReq, this.maxBlobBytes).text;
        await writeFile(path.join(this.recordDir, rel), bounded, 'utf8');
        rawRequestBlob = rel;
      }

      let rawResponseBlob: string | undefined;
      if (rawResp.length > 0) {
        const rel = path.join('blobs', `${id}-resp.txt`);
        const bounded = clipUtf8(rawResp, this.maxBlobBytes).text;
        await writeFile(path.join(this.recordDir, rel), bounded, 'utf8');
        rawResponseBlob = rel;
      }

      const reqSerialized =
        input.requestSummary ?? (input.request === undefined ? '{}' : serializeArtexLlmRequest(input.request));
      const reqSummaryClipped = clipUtf8(reqSerialized, this.maxInlineBytes).text;

      const respPayload: Record<string, unknown> = {
        text: input.responseText ?? '',
        stop_reason: input.stopReason ?? '',
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: cacheReadTokens,
          cache_write_tokens: cacheWriteTokens,
        },
      };
      if (input.thinkingText !== undefined && input.thinkingText.length > 0) {
        respPayload['thinking'] = input.thinkingText;
      }
      const respSummaryClipped = clipUtf8(JSON.stringify(respPayload), this.maxInlineBytes).text;

      const entry: ArtexLlmRecordEntry = {
        id,
        ts,
        sessionId: input.sessionId ?? '',
        taskId,
        explorationId,
        worker,
        model,
        profileName,
        latencyMs: Math.max(0, Math.round(input.latencyMs)),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        status: input.status,
        error: input.error,
        stopReason: input.stopReason,
        requestSummary: reqSummaryClipped,
        responseSummary: respSummaryClipped,
        rawRequestPreview: rawReq.length > 0 ? rawReqClipped.text : undefined,
        rawResponsePreview: rawResp.length > 0 ? rawRespClipped.text : undefined,
        rawRequestBlob,
        rawResponseBlob,
        rawRequestBytes: rawReqClipped.bytes,
        rawResponseBytes: rawRespClipped.bytes,
      };
      await appendFile(this.recordsPath, `${JSON.stringify(entry)}\n`, 'utf8');
      return entry;
    });
  }

  async recordOutcome(
    outcome: LlmOutcome,
    meta: {
      readonly sessionId?: string;
      readonly taskId?: string;
      readonly worker?: string;
      readonly profileName?: string;
      readonly latencyMs: number;
      readonly request?: LlmRequest;
      readonly capture?: ArtexLlmWireCapture;
    },
  ): Promise<ArtexLlmRecordEntry | undefined> {
    let text = '';
    let thinking = '';
    const message = outcome.message;
    if (message !== undefined && message !== null) {
      for (const part of message.content) {
        if (part.type === 'text') text += part.text;
        else if (part.type === 'think') thinking += part.think;
      }
    }
    return this.recordCall({
      sessionId: meta.sessionId,
      taskId: meta.taskId,
      worker: meta.worker,
      model: meta.request?.model.spec.name,
      profileName: meta.profileName,
      latencyMs: meta.latencyMs,
      request: meta.request,
      responseText: text,
      thinkingText: thinking,
      stopReason: outcome.finish?.rawFinishReason ?? outcome.finish?.finishReason ?? undefined,
      usage: outcome.usage,
      status: outcome.type === 'done' ? 'ok' : 'error',
      error:
        outcome.type === 'failed'
          ? outcome.error.message
          : outcome.type === 'aborted'
            ? 'aborted'
            : undefined,
      capture: meta.capture,
    });
  }

  async readRecords(): Promise<ArtexLlmRecordEntry[]> {
    return readJsonlFile<ArtexLlmRecordEntry>(this.recordsPath);
  }

  async readUsage(): Promise<ArtexLlmUsageEntry[]> {
    return readJsonlFile<ArtexLlmUsageEntry>(this.usagePath);
  }

  async readBlob(relativePath: string): Promise<string> {
    const resolved = path.resolve(this.recordDir, relativePath);
    if (!resolved.startsWith(`${path.resolve(this.blobsDir)}${path.sep}`)) {
      throw new Error(`Invalid blob path: ${relativePath}`);
    }
    return readFile(resolved, 'utf8');
  }

  private async ensureDirs(includeBlobs: boolean): Promise<void> {
    if (!this.dirReady) {
      await mkdir(this.recordDir, { recursive: true });
      this.dirReady = true;
    }
    if (includeBlobs) {
      await mkdir(this.blobsDir, { recursive: true });
    }
  }

  private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const entries: T[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    entries.push(JSON.parse(trimmed) as T);
  }
  return entries;
}
