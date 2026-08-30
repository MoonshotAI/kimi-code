import {
  Disposable,
  getScopedServiceDescriptors,
  IAgentBlobService,
  IAgentCommandService,
  IAgentContextProjectorService,
  IAgentPlanService,
  IAgentPluginCommandService,
  IAgentRuntimeBindingService,
  IAgentRuntimeService,
  IAgentShellCommandService,
  IAgentStateService,
  IAgentSwarmService,
  IAgentTelemetryContextService,
  IAgentTowerService,
  IEventBus,
  IEventDispatcher,
  IFeatureManager,
  ITelemetryService,
  IWireService,
  LifecycleScope,
} from '@moonshot-ai/agent-core-v2';

import type { Scope, ServiceIdentifier } from '@moonshot-ai/agent-core-v2';


export interface ChannelMethodDescriptor {
  readonly name: string;
  readonly kind: 'method' | 'property';
  readonly arity: number;
  readonly params: string;
}

export interface ChannelDescriptor {
  readonly name: string;
  readonly scope: 'app' | 'session' | 'agent';
  readonly domain: string;
  readonly methods: readonly ChannelMethodDescriptor[];
}

const SCOPE_NAME: Record<string, ChannelDescriptor['scope']> = {
  [LifecycleScope.App]: 'app',
  [LifecycleScope.Session]: 'session',
};

const AGENT_GRANULAR_TOKENS: readonly ServiceIdentifier<unknown>[] = [
  IAgentBlobService,
  IWireService,
  IAgentStateService,
  IEventBus,
  IEventDispatcher,
  ITelemetryService,
  IAgentTelemetryContextService,
  IAgentRuntimeBindingService,
  IAgentRuntimeService,
  IAgentContextProjectorService,
  IAgentPlanService,
  IAgentCommandService,
  IAgentShellCommandService,
  IAgentTowerService,
  IAgentPluginCommandService,
  IAgentSwarmService,
];

let serviceNameIndex: Map<string, ServiceIdentifier<unknown>> | undefined;

function scopedServiceNameIndex(): Map<string, ServiceIdentifier<unknown>> {
  serviceNameIndex ??= (() => {
    const map = new Map<string, ServiceIdentifier<unknown>>();
    for (const scope of [
      LifecycleScope.App,
      LifecycleScope.Session,
    ]) {
      for (const entry of getScopedServiceDescriptors(scope)) {
        const name = entry.id.toString();
        if (!map.has(name)) map.set(name, entry.id);
      }
    }
    for (const token of AGENT_GRANULAR_TOKENS) {
      const name = token.toString();
      if (!map.has(name)) map.set(name, token);
    }
    return map;
  })();
  return serviceNameIndex;
}

export function resolveAnyScopedServiceId(
  core: Scope,
  name: string,
): ServiceIdentifier<unknown> | undefined {
  return (
    scopedServiceNameIndex().get(name) ??
    core.accessor
      .get(IFeatureManager)
      .contributedServices()
      .find((entry) => entry.id.toString() === name)?.id
  );
}

function extractParams(fn: (...args: never[]) => unknown): string {
  const src = fn.toString();
  const start = src.indexOf('(');
  if (start === -1) return '';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return src.slice(start + 1, i).trim();
    }
  }
  return '';
}

function describeMethods(
  ctor: new (...args: any[]) => unknown,
): readonly ChannelMethodDescriptor[] {
  const methods = new Map<string, ChannelMethodDescriptor>();
  let proto: object | null = ctor.prototype;
  while (proto !== null && proto !== Object.prototype && proto !== Disposable.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || name.startsWith('_') || methods.has(name)) continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc === undefined) continue;
      if (typeof desc.get === 'function') {
        methods.set(name, { name, kind: 'property', arity: 0, params: '' });
      } else if (typeof desc.value === 'function') {
        const fn = desc.value as (...args: never[]) => unknown;
        methods.set(name, {
          name,
          kind: 'method',
          arity: fn.length,
          params: extractParams(fn),
        });
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return [...methods.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

export function describeAllChannels(): readonly ChannelDescriptor[] {
  const byName = new Map<string, { scope: ChannelDescriptor['scope']; domain: string; ctor: new (...args: any[]) => unknown }>();
  for (const scope of [LifecycleScope.App, LifecycleScope.Session]) {
    for (const entry of getScopedServiceDescriptors(scope)) {
      const name = entry.id.toString();
      if (!byName.has(name)) {
        byName.set(name, {
          scope: SCOPE_NAME[entry.scope] ?? 'app',
          domain: entry.domain,
          ctor: entry.descriptor.ctor,
        });
      }
    }
  }
  return [...byName.entries()]
    .map(([name, entry]) => ({
      name,
      scope: entry.scope,
      domain: entry.domain,
      methods: describeMethods(entry.ctor),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}
