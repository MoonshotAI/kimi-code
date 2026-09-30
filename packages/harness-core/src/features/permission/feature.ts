import { homedir } from 'node:os';

import {
  ConfigRef,
  createFeature,
  MAIN_AGENT_ID,
  useAgent,
  useAgentStore,
  useBeforeStep,
  useConfigSection,
  useSession,
  useSessionStore,
  useToolPermission,
  type FeatureSpec,
  type ToolCall,
} from '@moonshot-ai/agent-core';
import { createToken, useExpose, useFire, useNode, type Ref } from '@moonshot-ai/agent-core/kernel/index';

import { useInteractions } from '#/features/interaction/index';
import type { PathClass } from '#/features/os/path-access';

import { formatDenyMessage, requestToolApproval } from './ask';
import {
  configRules,
  defaultPermissionModeConfigSection,
  PERMISSION_CONFIG_SECTION,
  permissionConfigSection,
  type PermissionConfig,
} from './state/configSection';
import { evaluatePermissionPolicies } from './policies/chain';
import {
  PERMISSION_RECORD_APPROVAL_RESULT,
  PERMISSION_RULES_ADD,
  PERMISSION_SET_MODE,
  permissionProjection,
  type PermissionState,
} from './state/projection';
import { createPermissionModeInjection, permissionModeReminderEnabled } from './remind';
import type { PermissionEvent, PermissionMode, PermissionRule } from './types';

export interface PermissionFace {
  readonly state: Ref<PermissionState>;
  mode(): PermissionMode;
  setMode(mode: PermissionMode): Promise<void>;
  setModeAndBroadcast(mode: PermissionMode): Promise<void>;
  addRules(rules: readonly PermissionRule[]): Promise<void>;
}

export const PermissionRef = createToken<PermissionFace>('permission');

export interface CreatePermissionProps {
  readonly interactive?: boolean;
  readonly workDir?: string;
  readonly additionalDirs?: readonly string[];
  readonly homeDir?: string;
}

export function createPermission(props: CreatePermissionProps = {}): FeatureSpec<PermissionEvent> {
  return createFeature<PermissionEvent>('permission', {
    app() {
      useConfigSection(permissionConfigSection);
      useConfigSection(defaultPermissionModeConfigSection);
    },
    agent() {
      const agent = useAgent();
      const session = useSession();
      const store = useAgentStore();
      const sessionStore = useSessionStore();
      const configEntries = useNode().providerRef(ConfigRef);
      const state = store.fold(permissionProjection);
      const fire = useFire();
      const interactions = useInteractions();
      const isMain = agent.agentId === MAIN_AGENT_ID;
      const pathClass: PathClass = process.platform === 'win32' ? 'win32' : 'posix';

      const permissionConfig = (): PermissionConfig | undefined =>
        configEntries.value.at(-1)?.value.get<PermissionConfig>(PERMISSION_CONFIG_SECTION);

      const setMode = async (mode: PermissionMode): Promise<void> => {
        const current = state.value;
        if (mode === current.mode && current.configured) return;
        await store.dispatch({ type: PERMISSION_SET_MODE, mode });
      };

      const face: PermissionFace = {
        state,
        mode: () => state.value.mode,
        setMode,
        setModeAndBroadcast: async (mode) => {
          await setMode(mode);
          if (!isMain) return;
          const agents = sessionStore.getState().roster.agents;
          const pending: Promise<void>[] = [];
          for (const id of Object.keys(agents)) {
            if (id === agent.agentId) continue;
            try {
              const target = session.get(id)?.resolve(PermissionRef);
              if (target !== undefined) pending.push(target.setMode(mode));
            } catch {
            }
          }
          await Promise.all(pending);
        },
        addRules: async (rules) => {
          if (rules.length === 0) return;
          await store.dispatch({ type: PERMISSION_RULES_ADD, rules: [...rules] });
        },
      };

      useToolPermission(async ({ toolCall }) => {
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
          homeDir: props.homeDir ?? homedir(),
        });
        if (evaluation === undefined) return undefined;
        const { result } = evaluation;
        if (result.kind === 'approve') return undefined;
        if (result.kind === 'deny') {
          return {
            type: 'denied',
            result: {
              content: [{ type: 'text', text: formatDenyMessage(result.message, isMain) }],
            },
          };
        }
        return requestToolApproval(
          {
            interactions,
            fire,
            recordApprovalResult: async (record) => {
              await store.dispatch({ type: PERMISSION_RECORD_APPROVAL_RESULT, ...record });
            },
            sessionId: session.sessionId,
            agentId: agent.agentId,
            isMain,
          },
          { toolCall, args },
        );
      });

      if (permissionModeReminderEnabled()) {
        useBeforeStep(createPermissionModeInjection({ agent, state }));
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
