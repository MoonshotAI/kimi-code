import { createFeature, useAgent, useSession, useToolPermitting, type Feature, useFeatureStore } from '#/app/index';
import { useExpose, useFire, useInject } from '#/composition-api/index';
import type { ToolCall } from '@moonshot-ai/agent-core/llm/message';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import { ConfigRef, useConfigSection } from '#/todo-features/config/index';
import { useInteractions } from '#/todo-features/interaction/index';
import type { OsFsPort } from '#/todo-features/os/host/index';
import type { PathClass } from '#/todo-features/os/path-access';
import { PermissionModeRef } from '#/todo-features/permission-mode/ref';

import { formatDenyMessage, requestToolApproval } from './ask';
import { evaluatePermissionPolicies } from './policies/chain';
import { PermissionPolicyRef, type PermissionPolicyFace } from './ref';
import {
  configRules,
  PERMISSION_CONFIG_SECTION,
  permissionConfigSection,
  type PermissionConfig,
} from './state/configSection';
import {
  PERMISSION_RECORD_APPROVAL_RESULT,
  PERMISSION_RULES_ADD,
  permissionPolicyProjection,
} from './state/projection';
import type { PermissionEvent } from './types';

export interface CreatePermissionPolicyProps {
  readonly interactive?: boolean;
  readonly workDir?: string;
  readonly additionalDirs?: readonly string[];
  readonly homeDir?: string;
  readonly fs?: OsFsPort;
}

export function createPermissionPolicy(
  props: CreatePermissionPolicyProps = {},
): Feature<void, { agent: PermissionEvent }> {
  return createFeature<{ agent: PermissionEvent }>('permission', {
    app() {
      useConfigSection(permissionConfigSection);
    },
    session() {
      const store = useFeatureStore('session', 'permission', permissionPolicyProjection);
      const state = store.state;
      const face: PermissionPolicyFace = {
        state,
        recordApprovalResult: async (record) => {
          await store.dispatch([{ type: PERMISSION_RECORD_APPROVAL_RESULT, ...record }]);
        },
        addRules: async (rules) => {
          if (rules.length === 0) return;
          await store.dispatch([{ type: PERMISSION_RULES_ADD, rules: [...rules] }]);
        },
      };
      useExpose(PermissionPolicyRef, face);
    },
    agent() {
      const agent = useAgent();
      const session = useSession();
      const policy = useInject(PermissionPolicyRef).value;
      if (policy === undefined) {
        throw new Error('permission policy feature session slot is not installed');
      }
      const permissionMode = useInject(PermissionModeRef).value;
      if (permissionMode === undefined) {
        throw new Error('permission policy feature requires the permission mode feature');
      }
      const fire = useFire();
      const config = useInject(ConfigRef);
      const interactions = useInteractions().value;
      if (interactions === undefined) {
        throw new Error('permission policy feature requires the interaction feature');
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
          mode: permissionMode.state.value.mode,
          rules: [...configRules(permissionConfig()), ...policy.state.value.rules],
          sessionApprovalRulePatterns: policy.state.value.sessionApprovalRulePatterns,
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
            recordApprovalResult: (record) => policy.recordApprovalResult(record),
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
