import {
  createFacadeToken,
  createFeature,
  ProviderCatalogRef,
  useInject,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import {
  useExpose,
  useFire,
  useReady,
  type RuntimeEvent,
} from '@moonshot-ai/agent-core/kernel/index';
import {
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiRegion,
  type KimiRegion,
} from '@moonshot-ai/kimi-code-oauth';

import type { OsHost } from '#/features/os/host/index';
import { PluginRef, type PluginFace } from '#/features/plugin/index';

import { createKimiCuEntry } from './entries/kimiCu';
import { createKimiWebbridgeEntry } from './entries/kimiWebbridge';
import type { CapabilityEntryContext, CapabilityPluginsPort } from './entries/context';
import { CapabilityError } from './errors';
import type {
  CapabilityEntry,
  CapabilityId,
  CapabilityInstallProgress,
  CapabilityReadiness,
  CapabilityStatus,
} from './types';

export interface CapabilityChangedEvent extends RuntimeEvent {
  readonly type: 'capability.changed';
  readonly id: CapabilityId;
  readonly install: CapabilityInstallProgress;
}

export type CapabilitiesEvent = CapabilityChangedEvent;

export interface CapabilitiesFace {
  list(): Promise<readonly CapabilityStatus[]>;
  get(id: string): Promise<CapabilityStatus>;
  install(id: string): Promise<CapabilityStatus>;
}

export const CapabilitiesRef = createFacadeToken<CapabilitiesFace>('capabilities');

export interface CreateCapabilitiesProps {
  readonly homeDir: string;
  readonly host?: OsHost;
  readonly entries?: readonly CapabilityEntry[];
  readonly onWarn?: (
    message: string,
    payload?: { capabilityId: CapabilityId; step?: string; error: unknown },
  ) => void;
  readonly fetchImpl?: typeof fetch;
  readonly applicationsDir?: string;
  readonly webbridgeBaseUrl?: string;
  readonly detectProbeTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly resolveRegion?: () => KimiRegion | Promise<KimiRegion>;
}

const IDLE_PROGRESS: CapabilityInstallProgress = { running: false };

export function createCapabilities(props: CreateCapabilitiesProps): FeatureSpec<CapabilitiesEvent> {
  return createFeature<CapabilitiesEvent>('capabilities', {
    app() {
      const host = props.host;
      if (host === undefined) return;
      const fire = useFire();
      useReady(host.environment.ready);

      const installProgress = new Map<CapabilityId, CapabilityInstallProgress>();
      const runningInstalls = new Set<CapabilityId>();

      const setInstallProgress = (id: CapabilityId, progress: CapabilityInstallProgress): void => {
        installProgress.set(id, progress);
        fire({ type: 'capability.changed', id, install: progress });
      };

      const plugin = useInject(PluginRef);
      const pluginFace = (): PluginFace | undefined => plugin.value;

      const plugins: CapabilityPluginsPort = {
        listPlugins: async () => (await pluginFace()?.listPlugins()) ?? [],
        installPlugin: async (source) => {
          const face = pluginFace();
          if (face === undefined) throw new Error('plugin feature is not installed');
          return face.installPlugin(source);
        },
        setPluginEnabled: async (id, enabled) => {
          const face = pluginFace();
          if (face === undefined) throw new Error('plugin feature is not installed');
          await face.setPluginEnabled(id, enabled);
        },
        setPluginMcpServerEnabled: async (id, server, enabled) => {
          const face = pluginFace();
          if (face === undefined) throw new Error('plugin feature is not installed');
          await face.setPluginMcpServerEnabled(id, server, enabled);
        },
        getPluginInfo: async (id) => {
          const face = pluginFace();
          if (face === undefined) throw new Error('plugin feature is not installed');
          const info = await face.getPluginInfo(id);
          return {
            mcpServers: info.mcpServers.map((server) => ({
              name: server.name,
              enabled: server.enabled,
            })),
          };
        },
      };

      const providerCatalog = useInject(ProviderCatalogRef);
      const resolveRegion = (): KimiRegion | Promise<KimiRegion> => {
        if (props.resolveRegion !== undefined) return props.resolveRegion();
        const store = providerCatalog.value;
        const oauth = store?.providerInfo(KIMI_CODE_PROVIDER_NAME)?.oauth;
        return resolveKimiRegion({
          configuredOAuthHost: oauth?.oauthHost,
          configuredOAuthKey: oauth?.key,
          readMarker: process.env['KIMI_CODE_REGION_MARKER'] !== 'off',
          homeDir: props.homeDir,
        });
      };

      let resolvedEntries: ReadonlyMap<CapabilityId, CapabilityEntry> | undefined;
      const entriesMap = (): ReadonlyMap<CapabilityId, CapabilityEntry> => {
        if (resolvedEntries !== undefined) return resolvedEntries;
        if (props.entries !== undefined) {
          resolvedEntries = new Map(props.entries.map((entry) => [entry.id, entry]));
          return resolvedEntries;
        }
        const ctx: CapabilityEntryContext = {
          platform: host.environment.osKind,
          arch: host.environment.osArch,
          kimiHomeDir: props.homeDir,
          userHomeDir: host.environment.homeDir,
          plugins,
          hostProcess: host.process,
          fs: host.fs,
          fetchImpl: props.fetchImpl,
          applicationsDir: props.applicationsDir,
          webbridgeBaseUrl: props.webbridgeBaseUrl,
          detectProbeTimeoutMs: props.detectProbeTimeoutMs,
          commandTimeoutMs: props.commandTimeoutMs,
          resolveRegion,
        };
        resolvedEntries = new Map<CapabilityId, CapabilityEntry>([
          ['kimi-cu', createKimiCuEntry(ctx)],
          ['kimi-webbridge', createKimiWebbridgeEntry(ctx)],
        ]);
        return resolvedEntries;
      };

      const requireEntry = (id: string): CapabilityEntry => {
        const entry = entriesMap().get(id as CapabilityId);
        if (entry === undefined) {
          throw new CapabilityError('capability.not_found', `Capability "${id}" is not registered`, {
            details: { id },
          });
        }
        return entry;
      };

      const statusOf = async (entry: CapabilityEntry): Promise<CapabilityStatus> => {
        const install = installProgress.get(entry.id) ?? IDLE_PROGRESS;
        const base = {
          id: entry.id,
          pluginId: entry.pluginId,
          displayName: entry.displayName,
          description: entry.description,
          install,
        };
        if (!entry.supported) {
          return { ...base, supported: false, state: 'unsupported', steps: [] };
        }
        const detected = await entry.detect();
        const required = detected.steps.filter((step) => step.optional !== true);
        const requiredOk = required.length > 0 && required.every((step) => step.state === 'ok');
        const anyOk = detected.steps.some((step) => step.state === 'ok');
        const state: CapabilityReadiness = requiredOk
          ? 'ready'
          : anyOk
            ? 'partial'
            : 'not_installed';
        return {
          ...base,
          supported: true,
          state,
          steps: detected.steps,
          version: detected.version,
        };
      };

      const statusOfSafe = async (entry: CapabilityEntry): Promise<CapabilityStatus> => {
        try {
          return await statusOf(entry);
        } catch (error) {
          const install = installProgress.get(entry.id) ?? IDLE_PROGRESS;
          const detail = error instanceof Error ? error.message : String(error);
          const base = {
            id: entry.id,
            pluginId: entry.pluginId,
            displayName: entry.displayName,
            description: entry.description,
            install,
          };
          if (!entry.supported) {
            return { ...base, supported: false, state: 'unsupported', steps: [] };
          }
          return {
            ...base,
            supported: true,
            state: 'partial',
            steps: [{ id: 'detect', state: 'failed' as const, detail }],
          };
        }
      };

      useExpose(CapabilitiesRef, {
        list: () => Promise.all([...entriesMap().values()].map((entry) => statusOfSafe(entry))),
        get: async (id) => statusOf(requireEntry(id)),
        install: async (id) => {
          const entry = requireEntry(id);
          if (!entry.supported) {
            throw new CapabilityError(
              'capability.unsupported',
              `Capability "${entry.id}" is not supported on ${host.environment.osKind}/${host.environment.osArch}`,
              { details: { id: entry.id } },
            );
          }
          if (runningInstalls.has(entry.id)) {
            throw new CapabilityError(
              'capability.install_in_progress',
              `Capability "${entry.id}" is already being installed`,
              { details: { id: entry.id } },
            );
          }

          runningInstalls.add(entry.id);
          setInstallProgress(entry.id, { running: true });
          void (async () => {
            try {
              const note = await entry.install((step, percent) => {
                setInstallProgress(
                  entry.id,
                  percent === undefined ? { running: true, step } : { running: true, step, percent },
                );
              });
              setInstallProgress(entry.id, { running: false, note });
            } catch (error) {
              const step = installProgress.get(entry.id)?.step;
              props.onWarn?.('capability install failed', {
                capabilityId: entry.id,
                step,
                error,
              });
              setInstallProgress(entry.id, {
                running: false,
                error: error instanceof Error ? error.message : String(error),
              });
            } finally {
              runningInstalls.delete(entry.id);
            }
          })();

          return statusOf(entry);
        },
      } satisfies CapabilitiesFace);
    },
  });
}
