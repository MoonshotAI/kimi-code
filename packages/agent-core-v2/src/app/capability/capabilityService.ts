import { homedir } from 'node:os';

import { KIMI_CODE_PROVIDER_NAME, resolveKimiRegion } from '@moonshot-ai/kimi-code-oauth';

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { Error2 } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IPluginService } from '#/app/plugin/plugin';
import { IProviderService } from '#/kosong/provider/provider';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { ICapabilityService } from './capability';
import { CapabilityErrors } from './errors';
import { createKimiCuEntry } from './entries/kimiCu';
import { createKimiWebbridgeEntry } from './entries/kimiWebbridge';
import type {
  CapabilityEntry,
  CapabilityId,
  CapabilityDescriptor,
  CapabilityInstallChange,
  CapabilityInstallProgress,
  CapabilityReadiness,
  CapabilityStatus,
} from './types';

const IDLE_PROGRESS: CapabilityInstallProgress = { running: false };

export class CapabilityService extends Disposable implements ICapabilityService {
  declare readonly _serviceBrand: undefined;

  private readonly onDidChangeInstallEmitter = this._register(
    new Emitter<CapabilityInstallChange>(),
  );
  readonly onDidChangeInstall: Event<CapabilityInstallChange> =
    this.onDidChangeInstallEmitter.event;

  private readonly entries: ReadonlyMap<CapabilityId, CapabilityEntry>;
  private readonly installProgress = new Map<CapabilityId, CapabilityInstallProgress>();
  private readonly runningInstalls = new Set<CapabilityId>();

  private setInstallProgress(id: CapabilityId, progress: CapabilityInstallProgress): void {
    this.installProgress.set(id, progress);
    this.onDidChangeInstallEmitter.fire({ id, install: progress });
  }

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IPluginService plugins: IPluginService,
    @IHostProcessService hostProcess: IHostProcessService,
    @ILogService private readonly log: ILogService,
    @IProviderService providers: IProviderService,
    entriesOverride?: readonly CapabilityEntry[],
  ) {
    super();
    if (entriesOverride !== undefined) {
      this.entries = new Map(entriesOverride.map((entry) => [entry.id, entry]));
    } else {
      const ctx = {
        platform: process.platform,
        arch: process.arch,
        kimiHomeDir: bootstrap.homeDir,
        userHomeDir: homedir(),
        plugins,
        hostProcess,
        resolveRegion: () => {
          const oauth = providers.get(KIMI_CODE_PROVIDER_NAME)?.oauth;
          return resolveKimiRegion({
            configuredOAuthHost: oauth?.oauthHost,
            configuredOAuthKey: oauth?.key,
            readMarker:
              (bootstrap.getEnv('KIMI_CODE_REGION_MARKER') ??
                process.env['KIMI_CODE_REGION_MARKER']) !== 'off',
            homeDir: bootstrap.homeDir,
          });
        },
      };
      this.entries = new Map<CapabilityId, CapabilityEntry>([
        ['kimi-cu', createKimiCuEntry(ctx)],
        ['kimi-webbridge', createKimiWebbridgeEntry(ctx)],
      ]);
    }
  }

  describeCapabilities(): readonly CapabilityDescriptor[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.id,
      pluginId: entry.pluginId,
      displayName: entry.displayName,
      description: entry.description,
      supported: entry.supported,
    }));
  }

  listCapabilities(): Promise<readonly CapabilityStatus[]> {
    return Promise.all([...this.entries.values()].map((entry) => this.statusOfSafe(entry)));
  }

  async getCapability(id: string): Promise<CapabilityStatus> {
    return this.statusOf(this.requireEntry(id));
  }

  async installCapability(id: string): Promise<CapabilityStatus> {
    const entry = this.requireEntry(id);
    if (!entry.supported) {
      throw new Error2(
        CapabilityErrors.codes.CAPABILITY_UNSUPPORTED,
        `Capability "${entry.id}" is not supported on ${process.platform}/${process.arch}`,
        { details: { id: entry.id } },
      );
    }
    if (this.runningInstalls.has(entry.id)) {
      throw new Error2(
        CapabilityErrors.codes.CAPABILITY_INSTALL_IN_PROGRESS,
        `Capability "${entry.id}" is already being installed`,
        { details: { id: entry.id } });
    }

    this.runningInstalls.add(entry.id);
    this.setInstallProgress(entry.id, { running: true });
    void (async () => {
      try {
        const note = await entry.install((step, percent) => {
          this.setInstallProgress(
            entry.id,
            percent === undefined ? { running: true, step } : { running: true, step, percent },
          );
        });
        this.setInstallProgress(entry.id, { running: false, note });
      } catch (error) {
        const step = this.installProgress.get(entry.id)?.step;
        this.log.warn('capability install failed', {
          capabilityId: entry.id,
          step,
          error,
        });
        this.setInstallProgress(entry.id, {
          running: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.runningInstalls.delete(entry.id);
      }
    })();

    return this.statusOf(entry);
  }

  private requireEntry(id: string): CapabilityEntry {
    const entry = this.entries.get(id as CapabilityId);
    if (entry === undefined) {
      throw new Error2(
        CapabilityErrors.codes.CAPABILITY_NOT_FOUND,
        `Capability "${id}" is not registered`,
        { details: { id } },
      );
    }
    return entry;
  }

  private async statusOf(entry: CapabilityEntry): Promise<CapabilityStatus> {
    const install = this.installProgress.get(entry.id) ?? IDLE_PROGRESS;
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
    const state: CapabilityReadiness = requiredOk ? 'ready' : anyOk ? 'partial' : 'not_installed';
    return {
      ...base,
      supported: true,
      state,
      steps: detected.steps,
      version: detected.version,
    };
  }

  private async statusOfSafe(entry: CapabilityEntry): Promise<CapabilityStatus> {
    try {
      return await this.statusOf(entry);
    } catch (error) {
      const install = this.installProgress.get(entry.id) ?? IDLE_PROGRESS;
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
  }
}

registerScopedService(
  LifecycleScope.App,
  ICapabilityService,
  CapabilityService,
  ScopeActivation.OnScopeCreated,
  'capability',
);
