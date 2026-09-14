import type { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { ExecutableTool } from '#/tool/toolContract';
import type { AgentMachineSelf } from '#human/agent/machine';
import type { AgentEventStore } from '#human/agent/slices';
import {
  featureSpecs,
  mountAgentFeatures,
  type FeatureToolSink,
} from '#human/feature/index';
import type { EffectScope, UnitHandle } from '#human/kernel/index';
import type { ToolDefinition } from '#human/tool/tool';

export interface MountAgentFeatureUnitsOptions {
  readonly self: AgentMachineSelf;
  readonly store: AgentEventStore;
  readonly sessionId: string;
  readonly agentId: string;
  readonly toolRegistry: IAgentToolRegistryService;
  readonly scope: EffectScope;
}

export function asExecutableTool(definition: ToolDefinition): ExecutableTool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    resolveExecution: (args) => ({
      approvalRule: definition.name,
      execute: async (ctx) => {
        const result = await definition.execute({
          toolCall: {
            type: 'function',
            id: ctx.toolCallId,
            name: definition.name,
            arguments: JSON.stringify(args ?? {}),
          },
          signal: ctx.signal,
          onUpdate:
            ctx.onUpdate === undefined
              ? undefined
              : (update) => {
                  ctx.onUpdate?.({
                    kind: 'custom',
                    customKind: update.key,
                    text: update.text,
                    percent: update.percent,
                  });
                },
        });
        if (result.isError === true) {
          return { output: result.content, isError: true };
        }
        return { output: result.content };
      },
    }),
  };
}

export function mountAgentFeatureUnits(options: MountAgentFeatureUnitsOptions): UnitHandle {
  const toolSink: FeatureToolSink = {
    register: (definition) => {
      const registration = options.toolRegistry.register(asExecutableTool(definition), {
        disclosure: definition.deferred === true ? 'deferred' : undefined,
      });
      return () => {
        registration.dispose();
      };
    },
  };
  return mountAgentFeatures({
    self: options.self,
    store: options.store,
    sessionId: options.sessionId,
    agentId: options.agentId,
    features: featureSpecs,
    toolSink,
    scope: options.scope,
  });
}
