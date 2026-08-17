/**
 * `agentProfileCatalog` domain — `IAgentProfileRegistry` impl: the fold of
 * the agent-profile contribution point.
 *
 * App-scope singleton projecting the live `AgentProfileContribution`
 * collection view: storage keys encode the (sourceId, workspaceKey) pair so a
 * workspace-local source id (`workspace`, `extra`, `explicit`) coexists
 * across handlers, while global sources (`builtin`) appear once; a later
 * record for the same pair shadows the earlier one (the old
 * re-register-replaces semantics). The fold is pure storage — merging, name
 * dedup, and override rules live in the Session-scope catalog projection.
 * Change events reproduce the old registry's exactly: a pair fires only when
 * its winning record actually changes, so a reload's record swap fires once
 * while a shadowed record's withdrawal stays silent.
 */

import { type CollectionChange, type CollectionView } from '#/_base/di/collection';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  AgentProfileContribution,
  type AgentProfileContributionRecord,
} from './agentProfileContribution';

import type {
  AgentProfileRegistration,
  AgentProfileRegistryChange,
  IAgentProfileRegistry,
} from './agentProfileRegistry';
import { IAgentProfileRegistry as IAgentProfileRegistryDecorator } from './agentProfileRegistry';

function encodeKey(sourceId: string, workspaceKey: string | undefined): string {
  return JSON.stringify([sourceId, workspaceKey ?? null]);
}

function decodeKey(key: string): AgentProfileRegistryChange {
  const [sourceId, workspaceKey] = JSON.parse(key) as [string, string | null];
  return { sourceId, workspaceKey: workspaceKey ?? undefined };
}

export class AgentProfileRegistryService
  extends Service
  implements IAgentProfileRegistry
{
  declare readonly _serviceBrand: undefined;

  private readonly onDidChangeEmitter = this._register(
    new Emitter<AgentProfileRegistryChange>(),
  );
  readonly onDidChange: Event<AgentProfileRegistryChange> = this.onDidChangeEmitter.event;

  private folded: ReadonlyMap<string, AgentProfileContributionRecord> = new Map();
  private readonly direct = new Map<string, AgentProfileRegistration>();

  constructor(
    @AgentProfileContribution
    private readonly view: CollectionView<AgentProfileContributionRecord>,
  ) {
    super();
    this.refold();
    this._register(
      this.view.onDidChange((change) => {
        this.onViewChange(change);
      }),
    );
  }

  entries(): readonly AgentProfileRegistration[] {
    const entries = new Map<string, AgentProfileRegistration>();
    for (const record of this.folded.values()) {
      entries.set(encodeKey(record.sourceId, record.workspaceKey), {
        sourceId: record.sourceId,
        priority: record.priority ?? 0,
        workspaceKey: record.workspaceKey,
        contribution: record.contribution,
      });
    }
    for (const [key, registration] of this.direct) entries.set(key, registration);
    return [...entries.values()];
  }

  register(registration: AgentProfileRegistration): IDisposable {
    const key = encodeKey(registration.sourceId, registration.workspaceKey);
    this.direct.set(key, registration);
    this.onDidChangeEmitter.fire(decodeKey(key));
    let active = true;
    return {
      dispose: () => {
        if (!active || this.direct.get(key) !== registration) return;
        active = false;
        this.direct.delete(key);
        this.onDidChangeEmitter.fire(decodeKey(key));
      },
    };
  }

  private onViewChange(change: CollectionChange<AgentProfileContributionRecord>): void {
    const previous = this.folded;
    const affected = new Set<string>();
    for (const record of [...change.removed, ...change.added]) {
      affected.add(encodeKey(record.sourceId, record.workspaceKey));
    }
    this.refold();
    for (const key of affected) {
      if (previous.get(key) !== this.folded.get(key)) {
        this.onDidChangeEmitter.fire(decodeKey(key));
      }
    }
  }

  private refold(): void {
    const next = new Map<string, AgentProfileContributionRecord>();
    for (const record of this.view.records) {
      next.set(encodeKey(record.value.sourceId, record.value.workspaceKey), record.value);
    }
    this.folded = next;
  }
}

registerScopedService(
  LifecycleScope.App,
  IAgentProfileRegistryDecorator,
  AgentProfileRegistryService,
  ScopeActivation.OnScopeCreated,
  'agentProfileCatalog',
);
