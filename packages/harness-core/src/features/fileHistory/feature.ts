import {
  createFeature,
  useAgent,
  useSession,
  useToolStarting,
  type Feature,
} from '@moonshot-ai/agent-core/app/index';
import { useCleanup, useExpose } from '@moonshot-ai/agent-core/kernel/index';
import type { ToolCall } from '@moonshot-ai/agent-core/llm/message';
import { MAIN_AGENT_ID, type Session } from '@moonshot-ai/agent-core/session/index';

import type { OsFsPort } from '#/features/os/host/index';
import { useBlobs, useFeatureStore, useLoopEvent } from '#/runtime/index';

import { FileHistoryRef, type FileHistoryFace } from './fileHistory';
import { fileHistoryProjection } from './projection';
import { createFileHistoryService } from './service';

export interface CreateFileHistoryProps {
  readonly workDir: string;
  readonly fs: OsFsPort;
}

export function createFileHistory(props: CreateFileHistoryProps): Feature<void> {
  const mains = new WeakMap<Session, FileHistoryFace>();
  return createFeature('fileHistory', {
    agent() {
      const agent = useAgent();
      const session = useSession();
      const store = useFeatureStore('agent', 'file-history', fileHistoryProjection);
      let activeTurnId: number | undefined = agent.loop.state.turn?.id;
      const service = createFileHistoryService({
        workDir: props.workDir,
        fs: props.fs,
        blobs: useBlobs(),
        ready: store.ready,
        state: () => store.state.value,
        dispatch: async (event) => store.dispatch([event]),
        activeTurnId: () => activeTurnId,
      });
      useExpose(FileHistoryRef, service.face);
      if (agent.id !== MAIN_AGENT_ID) {
        useToolStarting(async ({ toolCall }) => {
          const path = editTargetPath(toolCall);
          if (path === undefined) return undefined;
          const face = mains.get(session);
          if (face === undefined) return undefined;
          await face.captureForActiveTurn(path);
          return undefined;
        });
        return;
      }
      mains.set(session, service.face);
      useCleanup(() => {
        if (mains.get(session) === service.face) mains.delete(session);
      });
      useToolStarting(async ({ toolCall }) => {
        const path = editTargetPath(toolCall);
        if (path === undefined || activeTurnId === undefined) return undefined;
        await service.capture(path, activeTurnId);
        return undefined;
      });
      useLoopEvent('turn.started', (event) => {
        activeTurnId = event.turnId;
      });
      useLoopEvent('turn.ended', (event) => {
        if (activeTurnId === event.turnId) activeTurnId = undefined;
        void service.endCheckpoint(event.turnId);
      });
    },
  });
}

const CAPTURED_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write']);

function editTargetPath(toolCall: ToolCall): string | undefined {
  if (!CAPTURED_TOOLS.has(toolCall.name)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.arguments ?? '{}');
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const filePath = record['file_path'];
  if (typeof filePath === 'string') return filePath;
  const path = record['path'];
  return typeof path === 'string' ? path : undefined;
}
