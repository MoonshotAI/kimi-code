/**
 * `capability` domain (L3) — `ICapabilityService` implementation.
 *
 * Holds the closed registry of built-in capability entries and serializes
 * install runs per entry. Install progress lives in memory only and is
 * polled by clients; a failed attempt leaves its error in the progress state
 * until the next attempt starts. Listing degrades a single entry's failing
 * detection to a failed step on that entry instead of rejecting the whole
 * list. Bound at App scope.
 */

import { homedir } from 'node:os';

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IPluginService } from '#/app/plugin/plugin';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { ICapabilityService } from './capability';
import { CapabilityErrors } from './errors';
import { createKimiCuEntry } from './entries/kimiCu';
import { createKimiWebbridgeEntry } from './entries/kimiWebbridge';
import type {
  CapabilityEntry,
  CapabilityId,
  CapabilityInstallProgress,
  CapabilityReadiness,
  CapabilityStatus,
} from './types';

const IDLE_PROGRESS: CapabilityInstallProgress = { running: false };

export class CapabilityService implements ICapabilityService {
  declare readonly _serviceBrand: undefined;

  private readonly entries: ReadonlyMap<CapabilityId, CapabilityEntry>;
  private readonly installProgress = new Map<CapabilityId, CapabilityInstallProgress>();
  private readonly runningInstalls = new Set<CapabilityId>();

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IPluginService plugins: IPluginService,
    @IHostProcessService hostProcess: IHostProcessService,
    entriesOverride?: readonly CapabilityEntry[],
  ) {
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
      };
      this.entries = new Map<CapabilityId, CapabilityEntry>([
        ['kimi-cu', createKimiCuEntry(ctx)],
        ['kimi-webbridge', createKimiWebbridgeEntry(ctx)],
      ]);
    }
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
    this.installProgress.set(entry.id, { running: true });
    void (async () => {
      try {
        await entry.install((step, percent) => {
          this.installProgress.set(
            entry.id,
            percent === undefined ? { running: true, step } : { running: true, step, percent },
          );
        });
        this.installProgress.set(entry.id, { running: false });
      } catch (error) {
        this.installProgress.set(entry.id, {
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
