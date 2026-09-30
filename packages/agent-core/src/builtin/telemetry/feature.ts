import { z } from 'zod';

import {
  createCollection,
  createFacadeToken,
  lineage,
  useCleanup,
  useCollection,
  useExpose,
  useInject,
  watch,
  type ShallowRef,
  type UnitNode,
} from '#/kernel/index';
import { useNode } from '#/kernel/hooks';
import { ConfigRef, useConfigSection, type ConfigSectionContribution } from '#/builtin/config/index';
import { useAgent, useSession } from '#/feature/contribution-hooks';
import { createFeature, type FeatureSpec } from '#/feature/feature';

import { deriveAgentTelemetry } from './derive';
import {
  TelemetryEvents,
  machineTelemetryEvents,
  useTelemetryEvents,
  type TelemetryEventDefinition,
} from './events';
import {
  applyTelemetryPatch,
  composeTelemetryProperties,
  type MutableTelemetryContext,
  type TelemetryAppender,
  type TelemetryAppenderRecord,
  type TelemetryContextPatch,
  type TelemetryProperties,
} from './telemetry';

export const TelemetryRef = createFacadeToken<TelemetryFace>('telemetry');

export const TelemetryAppenders = createCollection<TelemetryAppender>('telemetry.appenders');

export interface TelemetryFace {
  track(event: string, properties?: TelemetryProperties): void;
  setContext(patch: TelemetryContextPatch): void;
  getContext(): Readonly<TelemetryContextPatch>;
  setEnabled(enabled: boolean): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  events(): readonly TelemetryEventDefinition[];
}

interface TelemetryView extends TelemetryFace {
  ambient(): TelemetryProperties;
  dispatch(
    event: string,
    ambient: TelemetryProperties,
    properties: TelemetryProperties | undefined,
  ): void;
}

export function useTelemetry(): Readonly<ShallowRef<TelemetryFace | undefined>> {
  return useInject(TelemetryRef);
}

export function useTelemetryAppender(appender: TelemetryAppender): void {
  useCleanup(
    ([...lineage(useNode())].at(-1) as UnitNode).contribute(TelemetryAppenders, appender, 0),
  );
}

const TELEMETRY_CONFIG_SECTION = 'telemetry';

const telemetryConfigSection: ConfigSectionContribution<boolean> = {
  name: TELEMETRY_CONFIG_SECTION,
  schema: z.boolean(),
  defaultValue: true,
  envBindings: {
    env: 'KIMI_DISABLE_TELEMETRY',
    parse: (raw) =>
      ['1', 'true', 't', 'yes', 'y'].includes(raw.trim().toLowerCase()) ? false : undefined,
  },
};

function createTelemetryHub(
  initialEnabled: boolean,
  seed: TelemetryContextPatch,
  appenders: () => readonly TelemetryAppender[],
  definitions: () => readonly TelemetryEventDefinition[],
): TelemetryView {
  const context: MutableTelemetryContext = applyTelemetryPatch({}, seed);
  let enabled = initialEnabled;
  const fanout = async (method: 'flush' | 'shutdown'): Promise<void> => {
    await Promise.all(
      appenders().map((appender) =>
        Promise.resolve()
          .then(() => appender[method]?.())
          .catch(() => undefined),
      ),
    );
  };
  const hub: TelemetryView = {
    ambient: () => ({ ...context }),
    dispatch: (event, ambient, properties) => {
      if (!enabled) {
        return;
      }
      const record: TelemetryAppenderRecord = {
        event,
        context: { ...ambient },
        properties: composeTelemetryProperties(ambient, properties),
      };
      for (const appender of appenders()) {
        try {
          appender.track(record);
        } catch (error) {
          void error;
        }
      }
    },
    track: (event, properties) => {
      hub.dispatch(event, hub.ambient(), properties);
    },
    setContext: (patch) => {
      applyTelemetryPatch(context, patch);
    },
    getContext: () => hub.ambient(),
    setEnabled: (value) => {
      enabled = value;
    },
    flush: () => fanout('flush'),
    shutdown: () => fanout('shutdown'),
    events: () => definitions(),
  };
  return hub;
}

function bindTelemetryView(parent: TelemetryView, seed: TelemetryContextPatch): TelemetryView {
  const fragment: MutableTelemetryContext = applyTelemetryPatch({}, seed);
  const view: TelemetryView = {
    ambient: () => ({ ...parent.ambient(), ...fragment }),
    dispatch: (event, ambient, properties) => {
      parent.dispatch(event, ambient, properties);
    },
    track: (event, properties) => {
      parent.dispatch(event, view.ambient(), properties);
    },
    setContext: (patch) => {
      applyTelemetryPatch(fragment, patch);
    },
    getContext: () => view.ambient(),
    setEnabled: (enabled) => {
      parent.setEnabled(enabled);
    },
    flush: () => parent.flush(),
    shutdown: () => parent.shutdown(),
    events: () => parent.events(),
  };
  return view;
}

export interface TelemetryProps {
  readonly enabled?: boolean;
  readonly context?: TelemetryContextPatch;
}

export function createTelemetry(props?: TelemetryProps): FeatureSpec {
  return createFeature('telemetry', {
    app() {
      const appenders = useCollection(TelemetryAppenders);
      const definitions = useCollection(TelemetryEvents);
      const hub = createTelemetryHub(
        props?.enabled ?? true,
        props?.context ?? {},
        () => appenders.value,
        () => definitions.value,
      );
      useTelemetryEvents(machineTelemetryEvents);
      useExpose(TelemetryRef, hub);
      useConfigSection(telemetryConfigSection);
      const config = useInject(ConfigRef);
      watch(
        () => config.value?.section<boolean>(TELEMETRY_CONFIG_SECTION).value,
        (value) => {
          if (typeof value === 'boolean') {
            hub.setEnabled(value);
          }
        },
        { immediate: true },
      );
    },
    session() {
      const parent = useInject(TelemetryRef).value as TelemetryView | undefined;
      if (parent === undefined) throw new Error("no provider for token 'telemetry'");
      useExpose(TelemetryRef, bindTelemetryView(parent, { session_id: useSession().sessionId }));
    },
    agent() {
      const parent = useInject(TelemetryRef).value as TelemetryView | undefined;
      if (parent === undefined) throw new Error("no provider for token 'telemetry'");
      const agent = useAgent();
      const view = bindTelemetryView(parent, { agent_id: agent.agentId });
      useExpose(TelemetryRef, view);
      deriveAgentTelemetry(agent, view);
    },
  });
}
