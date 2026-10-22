import { createFeature, useAgent, useSession, useToolPermitting, type Feature, useFeatureStore } from '#/app/index';
import {
  computed,
  useExpose,
  useFire,
  useInject,
  type ComputedRef,
} from '#/composition-api/index';
import type { ToolCall } from '@moonshot-ai/agent-core/llm/message';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import { ConfigRef, useConfigSection } from '#/todo-features/config/index';
import { useInteractions } from '#/todo-features/interaction/index';
import type { OsFsPort } from '#/todo-features/os/host/index';
import type { PathClass } from '#/todo-features/os/path-access';

import { formatDenyMessage, requestToolApproval } from './ask';
import { evaluatePermissionPolicies } from './policies/chain';
import { PermissionRef, type PermissionFace } from './ref';
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
} from './state/projection';
import type { PermissionEvent, PermissionMode } from './types';

export function usePermissionMode(): ComputedRef<PermissionMode> {
  const permission = useInject(PermissionRef).value;
  if (permission === undefined) {
    throw new Error('permission feature session slot is not installed');
  }
  return computed(() => permission.state.value.mode);
}

export interface CreatePermissionProps {
  readonly interactive?: boolean;
  readonly workDir?: string;
  readonly additionalDirs?: readonly string[];
  readonly homeDir?: string;
  readonly fs?: OsFsPort;
}

export function createPermission(props: CreatePermissionProps = {}): Feature<void, { agent: PermissionEvent }> {
  return createFeature<{ agent: PermissionEvent }>('permission', {
    app() {
      useConfigSection(permissionConfigSection);
      useConfigSection(defaultPermissionModeConfigSection);
    },
    session() {
      const store = useFeatureStore('session', 'permission', permissionProjection);
      const state = store.state;
      const face: PermissionFace = {
        state,
        mode: () => state.value.mode,
        setMode: async (mode) => {
          const current = state.value;
          if (mode === current.mode && current.configured) return;
          await store.dispatch([{ type: PERMISSION_SET_MODE, mode }]);
        },
        recordApprovalResult: async (record) => {
          await store.dispatch([{ type: PERMISSION_RECORD_APPROVAL_RESULT, ...record }]);
        },
        addRules: async (rules) => {
          if (rules.length === 0) return;
          await store.dispatch([{ type: PERMISSION_RULES_ADD, rules: [...rules] }]);
        },
      };
      useExpose(PermissionRef, face);
    },
    agent() {
      const agent = useAgent();
      const session = useSession();
      const permission = useInject(PermissionRef).value;
      if (permission === undefined) {
        throw new Error('permission feature session slot is not installed');
      }
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

      useToolPermitting(async ({ toolCall }) => {
        const args = parseToolArgs(toolCall);
        const evaluation = await evaluatePermissionPolicies({
          toolCall,
          args,
          interactive: props.interactive ?? true,
          mode: permission.state.value.mode,
          rules: [...configRules(permissionConfig()), ...permission.state.value.rules],
          sessionApprovalRulePatterns: permission.state.value.sessionApprovalRulePatterns,
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
            recordApprovalResult: permission.recordApprovalResult,
            sessionId: session.id,
            agentId: agent.id,
            isMain,
          },
          { toolCall, args },
        );
      });
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
