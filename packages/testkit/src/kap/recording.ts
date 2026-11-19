import { readFile } from 'node:fs/promises';

import { TestkitError } from '#/errors';
import { createNormalizer, type Normalizer } from '#/fixtures/normalize';
import { CONVERSATION_FRAME_TYPES, type KapFrame } from '#/kap/frames';
import type { KapSocket } from '#/kap/socket';
import type { KapTurnsPage } from '#/kap/types';

export const KAP_RECORDING_FORMAT = 2;

export const UNKNOWN_FRAME_TYPE = 'testkit.unknown_frame';

const KAP_ID_KEYS = [
  'session_id', 'turn_id', 'turn_ids', 'removed_turn_ids', 'item_id', 'prompt_id', 'prompt_ids', 'interaction_id', 'tool_call_id',
  'parent_tool_call_id', 'child_agent_id', 'request_id', 'task_id', 'job_id', 'file_id', 'notification_id', 'workspace_id', 'host_id',
];

const KAP_TIME_KEYS = [
  'event_created_at', 'created_at', 'started_at', 'ended_at', 'updated_at', 'archived_at', 'expires_at', 'last_opened_at',
  'duration_ms', 'wall_clock_ms', 'delay_ms', 'first_token_ms', 'server_first_token_ms', 'stream_ms', 'request_build_ms',
  'server_decode_ms', 'client_blocked_ms', 'client_consume_ms',
];

export interface KapRecordingCheckpoint {
  readonly name: string;
  readonly frames: readonly KapFrame[];
}

export interface KapRecordingStream {
  readonly agentId: string;
  readonly initial: KapTurnsPage;
  readonly checkpoints: readonly KapRecordingCheckpoint[];
  readonly final: KapTurnsPage;
}

export interface KapRecording {
  readonly format: typeof KAP_RECORDING_FORMAT;
  readonly serverVersion: string;
  readonly kapVersion: string;
  readonly streams: Readonly<Record<string, KapRecordingStream>>;
}

export interface KapStreamPages {
  readonly initial: KapTurnsPage;
  readonly final: KapTurnsPage;
}

export interface KapRecordingMetadata {
  readonly serverVersion: string;
  readonly kapVersion: string;
  readonly pages: Readonly<Record<string, KapStreamPages>>;
}

export interface KapRecordingReducer<View> {
  start(page: KapTurnsPage): View;
  apply(view: View, frame: KapFrame): View;
}

export interface KapReplayCheckpoint<View> {
  readonly name: string;
  readonly view: View;
}

export interface KapFramesAt {
  readonly stream: string;
  readonly checkpoint: string;
}

interface Watched {
  readonly socket: KapSocket;
  readonly agentId: string;
  cursor: number;
  readonly checkpoints: KapRecordingCheckpoint[];
}

export function kapNormalizer(): Normalizer {
  return createNormalizer({ idKeys: KAP_ID_KEYS, timeKeys: KAP_TIME_KEYS, timePlaceholder: 'fixed' });
}

export class KapRecorder {
  private readonly sessionId: string;
  private readonly streams = new Map<string, Watched>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  watch(stream: string, socket: KapSocket, agentId = 'main'): void {
    if (this.streams.has(stream)) throw new TestkitError(`The recording already has a stream named ${stream}`);
    this.streams.set(stream, { socket, agentId, cursor: socket.mark(), checkpoints: [] });
  }

  checkpoint(name: string): Readonly<Record<string, readonly KapFrame[]>> {
    if (this.streams.size === 0) throw new TestkitError('Watch at least one socket before taking a checkpoint');
    const taken: Record<string, readonly KapFrame[]> = {};
    for (const [stream, watched] of this.streams) {
      const frames = watched.socket.frames
        .slice(watched.cursor)
        .filter((frame) => frame['session_id'] === this.sessionId && frame['agent_id'] === watched.agentId && CONVERSATION_FRAME_TYPES.has(frame.type));
      watched.cursor = watched.socket.mark();
      watched.checkpoints.push({ name, frames });
      taken[stream] = frames;
    }
    return taken;
  }

  recording(metadata: KapRecordingMetadata): KapRecording {
    const streams: Record<string, KapRecordingStream> = {};
    for (const [stream, watched] of this.streams) {
      const pages = metadata.pages[stream];
      if (pages === undefined) throw new TestkitError(`The recording has no REST pages for stream ${stream}`);
      streams[stream] = { agentId: watched.agentId, initial: pages.initial, checkpoints: watched.checkpoints, final: pages.final };
    }
    return kapNormalizer()({ format: KAP_RECORDING_FORMAT, serverVersion: metadata.serverVersion, kapVersion: metadata.kapVersion, streams });
  }
}

export async function readKapRecording(path: string): Promise<KapRecording> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const recording = fieldsOf(parsed);
  if (recording['format'] !== KAP_RECORDING_FORMAT) {
    throw new TestkitError(`${path} uses KAP recording format ${String(recording['format'])}; this testkit reads format ${KAP_RECORDING_FORMAT}`);
  }
  const streams = Object.values(fieldsOf(recording['streams']));
  const complete = typeof recording['serverVersion'] === 'string' && typeof recording['kapVersion'] === 'string'
    && streams.length > 0 && streams.every((stream) => isStream(stream));
  if (!complete) throw new TestkitError(`${path} is not a complete KAP recording`);
  return parsed as KapRecording;
}

export function replayKapRecording<View>(recording: KapRecording, stream: string, reducer: KapRecordingReducer<View>): KapReplayCheckpoint<View>[] {
  const recorded = streamOf(recording, stream);
  let view = reducer.start(recorded.initial);
  return recorded.checkpoints.map(({ name, frames }) => {
    for (const frame of frames) view = reducer.apply(view, frame);
    return { name, view };
  });
}

export function mutateKapRecording(recording: KapRecording, at: KapFramesAt, change: (frames: readonly KapFrame[]) => readonly KapFrame[]): KapRecording {
  const recorded = streamOf(recording, at.stream);
  if (!recorded.checkpoints.some((checkpoint) => checkpoint.name === at.checkpoint)) {
    throw new TestkitError(`Stream ${at.stream} has no checkpoint named ${at.checkpoint}`);
  }
  const checkpoints = recorded.checkpoints.map((checkpoint) => (checkpoint.name === at.checkpoint ? { ...checkpoint, frames: change(checkpoint.frames) } : checkpoint));
  return { ...recording, streams: { ...recording.streams, [at.stream]: { ...recorded, checkpoints } } };
}

export function dropFrames(matches: (frame: KapFrame) => boolean): (frames: readonly KapFrame[]) => readonly KapFrame[] {
  return (frames) => {
    const kept = frames.filter((frame) => !matches(frame));
    if (kept.length === frames.length) throw new TestkitError('dropFrames matched no frame');
    return kept;
  };
}

export function duplicateFrames(matches: (frame: KapFrame) => boolean): (frames: readonly KapFrame[]) => readonly KapFrame[] {
  return (frames) => {
    const doubled = frames.flatMap((frame) => (matches(frame) ? [frame, structuredClone(frame)] : [frame]));
    if (doubled.length === frames.length) throw new TestkitError('duplicateFrames matched no frame');
    return doubled;
  };
}

export function insertUnknownFrame(index: number): (frames: readonly KapFrame[]) => readonly KapFrame[] {
  return (frames) => {
    if (!Number.isInteger(index) || index < 0 || index > frames.length) throw new TestkitError(`insertUnknownFrame index ${index} is outside 0..${frames.length}`);
    const neighbour = frames[Math.min(index, frames.length - 1)];
    const unknown: KapFrame = { type: UNKNOWN_FRAME_TYPE, session_id: neighbour?.['session_id'], agent_id: neighbour?.['agent_id'] };
    return [...frames.slice(0, index), unknown, ...frames.slice(index)];
  };
}

function streamOf(recording: KapRecording, stream: string): KapRecordingStream {
  const recorded = recording.streams[stream];
  if (recorded === undefined) throw new TestkitError(`The recording has no stream named ${stream}; it has ${Object.keys(recording.streams).join(', ')}`);
  return recorded;
}

function fieldsOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isTurnsPage(value: unknown): boolean {
  return Array.isArray(fieldsOf(value)['turns']);
}

function isCheckpoint(value: unknown): boolean {
  const checkpoint = fieldsOf(value);
  return typeof checkpoint['name'] === 'string' && Array.isArray(checkpoint['frames']);
}

function isStream(value: unknown): boolean {
  const stream = fieldsOf(value);
  const checkpoints = stream['checkpoints'];
  return typeof stream['agentId'] === 'string' && isTurnsPage(stream['initial']) && isTurnsPage(stream['final'])
    && Array.isArray(checkpoints) && checkpoints.every((checkpoint: unknown) => isCheckpoint(checkpoint));
}
