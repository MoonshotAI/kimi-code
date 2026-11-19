import type { HoldRegistry } from '#/model/holds';
import type { EncodeContext, ProtocolCodec } from '#/model/protocols/codec';
import type { RecordedRequest } from '#/model/record';
import { unitsOf } from '#/model/steps';
import type { ErrorSpec, ReplyStep, ScriptedStep } from '#/model/types';

export interface PlaybackSink {
  readonly headSent: boolean;
  readonly gone: boolean;
  readonly goneSignal: AbortSignal;
  head(status: number, headers: Readonly<Record<string, string>>): void;
  write(data: string): void;
  end(): void;
  disconnect(): void;
  resetConnection(): void;
}

export interface Playback {
  readonly codec: ProtocolCodec;
  readonly request: RecordedRequest;
  readonly holds: HoldRegistry;
  readonly context: EncodeContext;
  readonly defaultIntervalMs: number;
  readonly sink: PlaybackSink;
  problem(message: string): void;
}

export async function play(step: ScriptedStep, playback: Playback): Promise<void> {
  const { request, sink } = playback;
  if (step.timing.delayMs !== undefined && step.timing.delayMs > 0) await pause(step.timing.delayMs, sink.goneSignal);
  if (sink.gone) return;
  switch (step.kind) {
    case 'network-error':
      if (!(await holdAt(step, 0, playback))) return;
      request.transition('failed');
      sink.resetConnection();
      return;
    case 'error':
      if (!(await holdAt(step, 0, playback))) return;
      respondError(step.error, playback);
      return;
    case 'raw':
      if (!(await holdAt(step, 0, playback))) return;
      sink.head(step.status, step.headers);
      request.transition('streaming');
      for (const [index, chunk] of step.chunks.entries()) {
        if (sink.gone) return;
        sink.write(chunk);
        if (index < step.chunks.length - 1) await pace(step, playback);
      }
      sink.end();
      request.transition('finished');
      return;
    case 'reply':
      if (playback.request.view.stream) await streamReply(step, playback);
      else await jsonReply(step, playback);
      return;
  }
}

export function respondError(error: ErrorSpec, playback: Playback): void {
  const { sink, request } = playback;
  const response = playback.codec.encodeError(error);
  sink.head(response.status, response.headers);
  sink.write(response.body);
  sink.end();
  request.transition('failed');
}

async function streamReply(step: ReplyStep, playback: Playback): Promise<void> {
  const { sink, request } = playback;
  const encoding = playback.codec.encodeStream(step, playback.context);
  const units = unitsOf(step);
  const byUnit = Array.from({ length: units }, (): string[] => []);
  for (const segment of encoding.segments) byUnit[segment.unit]?.push(segment.data);
  const ensureHead = (): void => {
    if (sink.headSent) return;
    sink.head(200, encoding.headers);
    request.transition('streaming');
  };
  for (let unit = 0; unit <= units; unit += 1) {
    if (!(await holdAt(step, unit, playback))) return;
    if (unit === units) break;
    for (const data of byUnit[unit] ?? []) {
      if (sink.gone) return;
      ensureHead();
      sink.write(data);
    }
    if (unit < units - 1) await pace(step, playback);
    if (sink.gone) return;
  }
  switch (step.ending.type) {
    case 'complete':
      ensureHead();
      for (const data of encoding.trailer) sink.write(data);
      sink.end();
      request.transition('finished');
      return;
    case 'stream-error':
      ensureHead();
      await letPeerDrain();
      if (sink.gone) return;
      sink.write(playback.codec.encodeStreamError(step.ending.error));
      sink.end();
      request.transition('failed');
      return;
    case 'disconnect':
      ensureHead();
      request.transition('cut');
      sink.disconnect();
      return;
  }
}

async function letPeerDrain(): Promise<void> {
  for (let turn = 0; turn < 2; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function jsonReply(step: ReplyStep, playback: Playback): Promise<void> {
  const { sink, request } = playback;
  if (!(await holdAt(step, step.hold?.beforeUnit ?? 0, playback))) return;
  switch (step.ending.type) {
    case 'complete': {
      const response = playback.codec.encodeJson(step, playback.context);
      sink.head(response.status, response.headers);
      sink.write(response.body);
      sink.end();
      request.transition('finished');
      return;
    }
    case 'stream-error':
      respondError(step.ending.error, playback);
      return;
    case 'disconnect':
      request.transition('cut');
      sink.resetConnection();
      return;
  }
}

async function holdAt(step: ScriptedStep, unit: number, playback: Playback): Promise<boolean> {
  const { request, sink, holds } = playback;
  if (step.hold?.beforeUnit !== unit) return true;
  const resumeState = request.state;
  request.transition('held');
  const result = await holds.arrive(step.hold.name, request, sink.goneSignal);
  switch (result.type) {
    case 'release':
      request.transition(resumeState);
      return !sink.gone;
    case 'fail':
      if (sink.headSent) {
        playback.problem(`hold ${JSON.stringify(step.hold.name)} failed after the response headers were sent`);
        request.transition('cut');
        sink.disconnect();
        return false;
      }
      respondError({ status: result.status, message: `testkit hold ${JSON.stringify(step.hold.name)} failed with status ${result.status}` }, playback);
      return false;
    case 'cut':
      request.transition('cut');
      if (sink.headSent) sink.disconnect();
      else sink.resetConnection();
      return false;
    case 'stopped':
      return false;
  }
}

function pace(step: ScriptedStep, playback: Playback): Promise<void> {
  const intervalMs = step.timing.intervalMs ?? playback.defaultIntervalMs;
  return intervalMs > 0 ? pause(intervalMs, playback.sink.goneSignal) : Promise.resolve();
}

function pause(ms: number, gone: AbortSignal): Promise<void> {
  if (gone.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      gone.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    gone.addEventListener('abort', done, { once: true });
  });
}
