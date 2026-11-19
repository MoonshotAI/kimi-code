import { readFile } from 'node:fs/promises';

import { TestkitError } from '#/errors';
import { createNormalizer, type Normalizer } from '#/fixtures/normalize';
import { CONVERSATION_FRAME_TYPES, type KapFrame } from '#/kap/frames';
import type { KapSocket } from '#/kap/socket';
import type { KapTurnsPage } from '#/kap/types';

export const KAP_RECORDING_FORMAT = 1;

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

export interface KapRecording {
  readonly format: typeof KAP_RECORDING_FORMAT;
  readonly serverVersion: string;
  readonly kapVersion: string;
  readonly initial: KapTurnsPage;
  readonly checkpoints: readonly KapRecordingCheckpoint[];
  readonly final: KapTurnsPage;
}

export interface KapRecordingMetadata {
  readonly serverVersion: string;
  readonly kapVersion: string;
  readonly initial: KapTurnsPage;
  readonly final: KapTurnsPage;
}

export interface KapRecordingReducer<View> {
  start(page: KapTurnsPage): View;
  apply(view: View, frame: KapFrame): View;
}

export interface KapReplayCheckpoint<View> {
  readonly name: string;
  readonly view: View;
}

export function kapNormalizer(): Normalizer {
  return createNormalizer({ idKeys: KAP_ID_KEYS, timeKeys: KAP_TIME_KEYS, timePlaceholder: 'fixed' });
}

export class KapRecorder {
  private readonly socket: KapSocket;
  private readonly sessionId: string;
  private readonly agentId: string;
  private readonly checkpoints: KapRecordingCheckpoint[] = [];
  private cursor: number;

  constructor(socket: KapSocket, sessionId: string, agentId = 'main') {
    this.socket = socket;
    this.sessionId = sessionId;
    this.agentId = agentId;
    this.cursor = socket.mark();
  }

  checkpoint(name: string): readonly KapFrame[] {
    const frames = this.socket.frames
      .slice(this.cursor)
      .filter((frame) => frame['session_id'] === this.sessionId && frame['agent_id'] === this.agentId && CONVERSATION_FRAME_TYPES.has(frame.type));
    this.cursor = this.socket.mark();
    this.checkpoints.push({ name, frames });
    return frames;
  }

  recording(metadata: KapRecordingMetadata): KapRecording {
    return kapNormalizer()({ format: KAP_RECORDING_FORMAT, ...metadata, checkpoints: this.checkpoints });
  }
}

export async function readKapRecording(path: string): Promise<KapRecording> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const recording = fieldsOf(parsed);
  if (recording['format'] !== KAP_RECORDING_FORMAT) {
    throw new TestkitError(`${path} uses KAP recording format ${String(recording['format'])}; this testkit reads format ${KAP_RECORDING_FORMAT}`);
  }
  const checkpoints = recording['checkpoints'];
  const complete = typeof recording['serverVersion'] === 'string' && typeof recording['kapVersion'] === 'string'
    && isTurnsPage(recording['initial']) && isTurnsPage(recording['final'])
    && Array.isArray(checkpoints) && checkpoints.every((checkpoint: unknown) => isCheckpoint(checkpoint));
  if (!complete) throw new TestkitError(`${path} is not a complete KAP recording`);
  return parsed as KapRecording;
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

export function replayKapRecording<View>(recording: KapRecording, reducer: KapRecordingReducer<View>): KapReplayCheckpoint<View>[] {
  let view = reducer.start(recording.initial);
  return recording.checkpoints.map(({ name, frames }) => {
    for (const frame of frames) view = reducer.apply(view, frame);
    return { name, view };
  });
}
