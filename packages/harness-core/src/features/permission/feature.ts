import {
  createFeature,
  useAgent,
  useSession,
  useStepStarting,
  useToolPermitting,
  type Feature,
} from '@moonshot-ai/agent-core/app/index';
import {
  createFacadeToken,
  useCleanup,
  useExpose,
  useFire,
  useInject,
  type ComputedRef,
} from '@moonshot-ai/agent-core/kernel/index';
import type { ToolCall } from '@moonshot-ai/agent-core/llm/message';
import { MAIN_AGENT_ID, type Agent } from '@moonshot-ai/agent-core/session/index';

import { ConfigRef, useConfigSection } from '#/features/config/index';
import { useInteractions } from '#/features/interaction/index';
import type { OsFsPort } from '#/features/os/host/index';
import type { PathClass } from '#/features/os/path-access';
import { useFeatureStore } from '#/runtime/index';

import { formatDenyMessage, requestToolApproval } from './ask';
import { evaluatePermissionPolicies } from './policies/chain';
import { createPermissionModeInjection, permissionModeReminderEnabled } from './remind';
import {
  configRules,
  defaultPermissionModeConfigSection,
  PERMISSION_CONFIG_SECTION,
  permissionConfigSection,
  type PermissionConfig,
} from './state/configSection';
import {
  PERMISSION_RECORD_APPROVAL_RESULT,
  PERMISSION_RULES_ADD,
  PERMISSION_SET_MODE,
  permissionProjection,
  type PermissionState,
} from './state/projection';
import type { PermissionEvent, PermissionMode, PermissionRule } from './types';

export interface PermissionFace {
  readonly state: ComputedRef<PermissionState>;
  mode(): PermissionMode;
  setMode(mode: PermissionMode): Promise<void>;
  setModeAndBroadcast(mode: PermissionMode): Promise<void>;
  addRules(rules: readonly PermissionRule[]): Promise<void>;
}

export const PermissionRef = createFacadeToken<PermissionFace>('permission');

export interface CreatePermissionProps {
  readonly interactive?: boolean;
  readonly workDir?: string;
  readonly additionalDirs?: readonly string[];
  readonly homeDir?: string;
  readonly fs?: OsFsPort;
}

export function createPermission(props: CreatePermissionProps = {}): Feature<void, PermissionEvent> {
  const faces = new WeakMap<Agent, PermissionFace>();
  return createFeature<PermissionEvent>('permission', {
    app() {
      useConfigSection(permissionConfigSection);
      useConfigSection(defaultPermissionModeConfigSection);
    },
    agent() {
      const agent = useAgent();
      const session = useSession();
      const store = useFeatureStore('agent', 'permission', permissionProjection);
      const state = store.state;
      const fire = useFire();
      const config = useInject(ConfigRef);
      const interactions = useInteractions().value;
      if (interactions === undefined) {
        throw new Error('permission feature requires the interaction feature');
      }
      const isMain = agent.id === MAIN_AGENT_ID;
      const pathClass: PathClass = process.platform === 'win32' ? 'win32' : 'posix';

      const permissionConfig = (): PermissionConfig | undefined =>
        config.value?.get<PermissionConfig>(PERMISSION_CONFIG_SECTION);

      const setMode = async (mode: PermissionMode): Promise<void> => {
        const current = state.value;
        if (mode === current.mode && current.configured) return;
        await store.dispatch([{ type: PERMISSION_SET_MODE, mode }]);
      };

      const face: PermissionFace = {
        state,
        mode: () => state.value.mode,
        setMode,
        setModeAndBroadcast: async (mode) => {
          await setMode(mode);
          if (!isMain) return;
          const pending: Promise<void>[] = [];
          for (const [id, target] of session.agents) {
            if (id === agent.id) continue;
            const targetFace = faces.get(target);
            if (targetFace !== undefined) pending.push(targetFace.setMode(mode));
          }
          await Promise.all(pending);
        },
        addRules: async (rules) => {
          if (rules.length === 0) return;
          await store.dispatch([{ type: PERMISSION_RULES_ADD, rules: [...rules] }]);
        },
      };
      faces.set(agent, face);
      useCleanup(() => {
        if (faces.get(agent) === face) faces.delete(agent);
      });

      useToolPermitting(async ({ toolCall }) => {
        const args = parseToolArgs(toolCall);
        const evaluation = await evaluatePermissionPolicies({
          toolCall,
          args,
          interactive: props.interactive ?? true,
          mode: state.value.mode,
          rules: [...configRules(permissionConfig()), ...state.value.rules],
          sessionApprovalRulePatterns: state.value.sessionApprovalRulePatterns,
          config: permissionConfig(),
          workDir: props.workDir,
          additionalDirs: props.additionalDirs ?? [],
          pathClass,
          homeDir: props.homeDir,
          fs: props.fs,
        });
        if (evaluation === undefined) return undefined;
        const { result } = evaluation;
        if (result.kind === 'approve') return undefined;
        if (result.kind === 'deny') {
          const text = formatDenyMessage(result.message, isMain);
          return {
            blocked: { reason: 'denied', message: text },
            result: { content: [{ type: 'text', text }] },
          };
        }
        return requestToolApproval(
          {
            interactions,
            fire,
            recordApprovalResult: async (record) => {
              await store.dispatch([{ type: PERMISSION_RECORD_APPROVAL_RESULT, ...record }]);
            },
            sessionId: session.id,
            agentId: agent.id,
            isMain,
          },
          { toolCall, args },
        );
      });

      if (permissionModeReminderEnabled()) {
        useStepStarting(createPermissionModeInjection({ state }));
      }
      useExpose(PermissionRef, face);
    },
  });
}

function parseToolArgs(toolCall: ToolCall): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(toolCall.arguments ?? '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
