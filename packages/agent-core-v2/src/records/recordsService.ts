/**
 * `records` domain (L2) — `ISessionStore`, `ISessionMetaStore`, and
 * `IAgentRecords` implementations.
 *
 * Owns session state, session metadata, and the agent record stream; persists
 * through `kaos` and logs through `log`. Bound at Core (session store), Session
 * (session metadata), and Agent (agent records) scopes.
 */

import { createHash } from 'node:crypto';

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { slugifyWorkDirName } from '#/_base/utils/workdir-slug';
import { IKaosFactory, IAgentKaos, ISessionKaosService } from '#/kaos/kaos';
import { ILogService } from '#/log/log';

import {
  type AgentRecord,
  IAgentRecords,
  ISessionMetaStore,
  ISessionStore,
} from './records';

const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

export function encodeWorkDirKey(workDir: string): string {
  const normalized = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalized.split('/').pop() ?? normalized;
  const slug = slugifyWorkDirName(base);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

export class SessionStore implements ISessionStore {
  declare readonly _serviceBrand: undefined;
  constructor(@IKaosFactory _kaosFactory: IKaosFactory) {}

  sessionDir(sessionsRoot: string, workDir: string, sessionId: string): string {
    return `${sessionsRoot}/${encodeWorkDirKey(workDir)}/${sessionId}`;
  }

  read(_sessionId: string): Promise<unknown> {
    throw new Error('TODO: SessionStore.read');
  }
  write(_sessionId: string, _data: unknown): Promise<void> {
    throw new Error('TODO: SessionStore.write');
  }
}

export class SessionMetaStore extends Disposable implements ISessionMetaStore {
  declare readonly _serviceBrand: undefined;
  private data: Record<string, unknown> = {};
  private readonly path: string;

  constructor(
    @ISessionKaosService private readonly sessionKaos: ISessionKaosService,
    @ILogService _log: ILogService,
    path: string = 'state.json',
  ) {
    super();
    this.path = path;
  }

  async read(): Promise<Record<string, unknown>> {
    try {
      const text = await this.sessionKaos.persistenceKaos.readText(this.path);
      this.data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.data = {};
    }
    return this.data;
  }

  async write(patch: Record<string, unknown>): Promise<void> {
    this.data = { ...this.data, ...patch };
    await this.flush();
  }

  async flush(): Promise<void> {
    await this.sessionKaos.persistenceKaos.writeText(
      this.path,
      JSON.stringify(this.data, null, 2),
    );
  }
}

export class AgentRecords extends Disposable implements IAgentRecords {
  declare readonly _serviceBrand: undefined;
  private readonly path: string;

  constructor(
    @IAgentKaos private readonly agentKaos: IAgentKaos,
    @ILogService _log: ILogService,
    path: string = 'wire.jsonl',
  ) {
    super();
    this.path = path;
  }

  async logRecord(record: AgentRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    let existing = '';
    try {
      existing = await this.agentKaos.kaos.readText(this.path);
    } catch {
    }
    await this.agentKaos.kaos.writeText(this.path, existing + line);
  }

  async *replay(): AsyncIterable<AgentRecord> {
    let text: string;
    try {
      text = await this.agentKaos.kaos.readText(this.path);
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      yield JSON.parse(trimmed) as AgentRecord;
    }
  }

  restore(): Promise<void> {
    throw new Error('TODO: AgentRecords.restore');
  }
}

registerScopedService(LifecycleScope.Core, ISessionStore, SessionStore, InstantiationType.Delayed, 'records');
registerScopedService(LifecycleScope.Session, ISessionMetaStore, SessionMetaStore, InstantiationType.Delayed, 'records');
registerScopedService(LifecycleScope.Agent, IAgentRecords, AgentRecords, InstantiationType.Delayed, 'records');
