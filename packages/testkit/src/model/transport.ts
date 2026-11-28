import type { PlaybackSink } from '#/model/playback';

export interface IncomingRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bytes: Uint8Array;
}

export type RequestHandler = (incoming: IncomingRequest, sink: PlaybackSink) => Promise<void>;

export const CRASH_STATUS = 400;

export function connectionReset(): Error {
  return Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
}

export function crashBody(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({ error: { message: `testkit fake model crashed: ${message}`, type: 'testkit_error' } });
}
