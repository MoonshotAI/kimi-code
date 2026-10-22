import { createFeature, useAgent, useSession, useStepStarting, useToolStarting, type Feature, useAgentTools, useBlobs, useFeatureStore } from '#/app/index';
import { computed, createFacadeToken, useExpose, useInject, type ComputedRef } from '#/composition-api/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';

import { useConfigSection } from '#/todo-features/config/index';
import { useInteractions } from '#/todo-features/interaction/index';
import { PermissionRef } from '#/todo-features/permission/index';

import { defaultPlanModeSection } from './configSection';
import { createPlanGuard } from './guard';
import { createPlanInjection, createPlanInjectionState, type PlanInjectionState } from './injection';
import {
  PLAN_MODE_CANCEL,
  PLAN_MODE_ENTER,
  PLAN_MODE_EXIT,
  PLAN_REVISION,
  planProjection,
  type PlanEvent,
  type PlanState,
} from './projection';
import { createMemoryPlanStorage, type PlanData, type PlanStorage } from './storage';
import { createEnterPlanModeTool } from './tools/enter-plan-mode';
import { createExitPlanModeTool } from './tools/exit-plan-mode';

export interface PlanFace {
  readonly state: ComputedRef<PlanState>;
  enter(id?: string, createFile?: boolean): Promise<void>;
  cancel(id?: string): Promise<void>;
  clear(): Promise<void>;
  exit(id?: string): Promise<void>;
  recordRevision(): Promise<void>;
  status(): Promise<PlanData | null>;
}

export const PlanRef = createFacadeToken<PlanFace>('plan');

export interface CreatePlanProps {
  readonly storage?: PlanStorage;
}

export function createPlan(props: CreatePlanProps = {}): Feature<void, { agent: PlanEvent }> {
  const storage = props.storage ?? createMemoryPlanStorage();
  const injections = new WeakMap<Agent, PlanInjectionState>();
  return createFeature<{ agent: PlanEvent }>('plan', {
    app() {
      useConfigSection(defaultPlanModeSection);
    },
    agent() {
      const agent = useAgent();
      const session = useSession();
      const store = useFeatureStore('agent', 'plan', planProjection);
      const blobs = useBlobs();
      const interactions = useInteractions().value;
      if (interactions === undefined) {
        throw new Error('plan feature requires the interaction feature');
      }
      const permission = useInject(PermissionRef);
      const permissionMode = computed(() => permission.value?.state.value.mode);
      let injection = injections.get(agent);
      if (injection === undefined) {
        injection = createPlanInjectionState();
        injections.set(agent, injection);
      }
      const pathFor = (id: string): string => storage.pathFor(agent.id, id);
      const planPath = (): string | null => {
        const current = store.state.value;
        if (!current.active || current.id === undefined) return null;
        return pathFor(current.id);
      };
      const readPlanText = async (path: string): Promise<string> => {
        try {
          return await storage.readText(path);
        } catch (error) {
          if (isMissingFileError(error)) return '';
          throw error;
        }
      };
      const enter = async (id = crypto.randomUUID(), createFile = false): Promise<void> => {
        await store.ready;
        if (store.state.value.active) throw new Error('Already in plan mode');
        await store.dispatch([{ type: PLAN_MODE_ENTER, id }]);
        if (!createFile) return;
        try {
          await storage.writeText(pathFor(id), '');
        } catch (error) {
          void store.dispatch([{ type: PLAN_MODE_CANCEL, id }]);
          throw error;
        }
      };
      const cancel = async (id?: string): Promise<void> => {
        await store.dispatch([{ type: PLAN_MODE_CANCEL, id }]);
      };
      const clear = async (): Promise<void> => {
        await store.ready;
        const path = planPath();
        if (path === null) return;
        await storage.writeText(path, '');
      };
      const exit = async (id?: string): Promise<void> => {
        await store.dispatch([{ type: PLAN_MODE_EXIT, id }]);
      };
      const recordRevision = async (): Promise<void> => {
        await store.ready;
        const current = store.state.value;
        if (!current.active || current.id === undefined) return;
        const id = current.id;
        const content = await readPlanText(pathFor(id));
        const { ref, size } = await blobs.put({
          bytes: new TextEncoder().encode(content),
          mimeType: 'text/markdown',
        });
        const version = (current.revisionCount[id] ?? 0) + 1;
        await store.dispatch([
          {
            type: PLAN_REVISION,
            id,
            version,
            key: `plan/${id}/v${version}.md`,
            sha256: ref,
            bytes: size,
          },
        ]);
      };
      const status = async (): Promise<PlanData | null> => {
        await store.ready;
        const current = store.state.value;
        if (!current.active || current.id === undefined) return null;
        const path = pathFor(current.id);
        return { id: current.id, content: await readPlanText(path), path };
      };
      useAgentTools(
        createEnterPlanModeTool({ status, enter }),
        createExitPlanModeTool({ status, exit }),
      );
      useToolStarting(
        createPlanGuard({
          ready: store.ready,
          planPath,
          status,
          recordRevision,
          exit,
          interactions,
          sessionId: session.id,
          agentId: agent.id,
          permissionMode,
        }),
      );
      useStepStarting(
        createPlanInjection({
          ready: store.ready,
          planPath,
          status,
          planState: () => store.state.value,
          agent,
          state: injection,
        }),
      );
      useExpose(PlanRef, { state: store.state, enter, cancel, clear, exit, recordRevision, status });
    },
  });
}

function isMissingFileError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  return (error as { readonly code?: unknown }).code === 'ENOENT';
}
