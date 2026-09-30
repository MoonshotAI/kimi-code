import {
  MAIN_AGENT_ID,
  createFeature,
  useAgent,
  useAgentStore,
  useBeforeTool,
  useBlobs,
  useSession,
  type FeatureSpec,
  type ToolCall,
} from '@moonshot-ai/agent-core';
import { pushCleanup, useExpose, useNode } from '@moonshot-ai/agent-core/kernel/index';

import type { OsFsPort } from '#/features/os/host/index';

import { FileHistoryRef, type FileHistoryFace } from './fileHistory';
import { fileHistoryProjection } from './projection';
import { createFileHistoryService } from './service';

export interface CreateFileHistoryProps {
  readonly workDir: string;
  readonly fs: OsFsPort;
}

export function createFileHistory(props: CreateFileHistoryProps): FeatureSpec {
  return createFeature('fileHistory', {
    agent() {
      const node = useNode();
      const agent = useAgent();
      const session = useSession();
      const store = useAgentStore();
      const blobs = useBlobs();
      const state = store.fold(fileHistoryProjection);
      let activeTurnId: number | undefined;
      const service = createFileHistoryService({
        workDir: props.workDir,
        fs: props.fs,
        blobs,
        state: () => state.value,
        dispatch: (event) => store.dispatch(event),
        activeTurnId: () => activeTurnId,
      });
      useExpose(FileHistoryRef, service.face);
      if (agent.agentId !== MAIN_AGENT_ID) {
        useBeforeTool(async ({ toolCall }) => {
          const path = editTargetPath(toolCall);
          if (path === undefined) return undefined;
          const main = session.get(MAIN_AGENT_ID);
          if (main === undefined) return undefined;
          let face: FileHistoryFace;
          try {
            face = main.resolve(FileHistoryRef);
          } catch {
            return undefined;
          }
          await face.captureForActiveTurn(path);
          return undefined;
        });
        return;
      }
      useBeforeTool(async ({ toolCall }) => {
        const path = editTargetPath(toolCall);
        if (path === undefined || activeTurnId === undefined) return undefined;
        await service.capture(path, activeTurnId);
        return undefined;
      });
      const turnStarted = agent.on('turn.started', (event) => {
        activeTurnId = event.turnId;
      });
      pushCleanup(node, () => {
        turnStarted.unsubscribe();
      });
      const turnDone = agent.on('turn.done', (event) => {
        if (activeTurnId === event.turnId) activeTurnId = undefined;
        void service.endCheckpoint(event.turnId);
      });
      pushCleanup(node, () => {
        turnDone.unsubscribe();
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
