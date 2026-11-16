import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';

import type {
  ArtexAsset,
  ArtexAssetType,
  ArtexCompany,
  ArtexCompanyScope,
  ArtexCompanyScopeKind,
  ArtexCoverageEntry,
  ArtexTaskAssetLink,
  ArtexTaskConstraint,
  ArtexTaskCredential,
  ArtexTaskScope,
  ArtexTaskScopeKind,
  ArtexTaskScopeSource,
} from '#/features/artex/protocol/index';
import { normalizeCoverageField, normalizeRiskArea } from '#/features/artex/logic/coverageLedger';

import {
  cidrContainsIp,
  cidrSubsetOf,
  domainKey,
  ipToHostCidr,
  isIPv4,
  isIpLiteral,
  maskedCidr,
  normalizeIcp,
  parseCidr,
  rootDomain,
  stripHostPort,
} from '#/features/artex/safety/net';
import type {
  ArtexAssetInput,
  ArtexAssetInterceptRule,
  ArtexAssetQuery,
  ArtexCompanyScopeResult,
  ArtexCompanySummary,
  ArtexConstraintInput,
  ArtexCoverageDenominator,
  ArtexInterceptRule,
  ArtexTaskCredentialInput,
  ArtexTaskInterceptRulesSplit,
  ArtexTargetPin,
  ArtexTargetPinInput,
  ArtexUntestedAsset,
  ArtexUntestedResult,
  ArtexUpsertResult,
  IArtexWorkStore,
} from './artexWorkStore';
import {
  ARTEX_BUILTIN_ASSET_INTERCEPT_RULE_SEEDS,
  ARTEX_BUILTIN_INTERCEPT_RULE_SEEDS,
} from './seeds';
import {
  ARTEX_WORK_STORE_SCHEMA_VERSION,
  artexRootDir,
  artexWorkStoreFile,
  artexWorkStoreLockPath,
} from './paths';

export const ARTEX_WORK_LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
export const ARTEX_WORK_LOCK_RETRY_INTERVAL_MS = 20;
export const ARTEX_WORK_LOCK_STALE_MS = 30_000;

interface CoverageRow extends ArtexCoverageEntry {
  readonly taskId: number;
}

interface CoverageHistoryRow extends CoverageRow {
  readonly historyId: number;
  readonly recordedAt: string;
}

interface AssetInterceptRow extends ArtexAssetInterceptRule {
  readonly taskId?: number;
}

interface Counters {
  company: number;
  asset: number;
  companyScope: number;
  taskScope: number;
  credential: number;
  constraint: number;
  interceptRule: number;
  assetInterceptRule: number;
  targetPin: number;
  coverageHistory: number;
}

interface ArtexWorkState {
  schemaVersion: number;
  seeded: boolean;
  counters: Counters;
  companies: ArtexCompany[];
  companyScope: ArtexCompanyScope[];
  assets: ArtexAsset[];
  taskScope: ArtexTaskScope[];
  taskAssetLinks: ArtexTaskAssetLink[];
  credentials: ArtexTaskCredential[];
  constraints: ArtexTaskConstraint[];
  coverage: CoverageRow[];
  coverageHistory: CoverageHistoryRow[];
  interceptRules: ArtexInterceptRule[];
  assetInterceptRules: AssetInterceptRow[];
  targetPins: ArtexTargetPin[];
  exemptions: string[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function emptyState(): ArtexWorkState {
  return {
    schemaVersion: ARTEX_WORK_STORE_SCHEMA_VERSION,
    seeded: false,
    counters: {
      company: 1,
      asset: 1,
      companyScope: 1,
      taskScope: 1,
      credential: 1,
      constraint: 1,
      interceptRule: 1,
      assetInterceptRule: 1,
      targetPin: 1,
      coverageHistory: 1,
    },
    companies: [],
    companyScope: [],
    assets: [],
    taskScope: [],
    taskAssetLinks: [],
    credentials: [],
    constraints: [],
    coverage: [],
    coverageHistory: [],
    interceptRules: [],
    assetInterceptRules: [],
    targetPins: [],
    exemptions: [],
  };
}

const inProcessWorkLockChains = new Map<string, Promise<void>>();

export class FileArtexWorkStore implements IArtexWorkStore {
  readonly workspaceRoot: string;
  private readonly dir: string;
  private readonly stateFile: string;
  private readonly lockPath: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.dir = artexRootDir(workspaceRoot);
    this.stateFile = artexWorkStoreFile(workspaceRoot);
    this.lockPath = artexWorkStoreLockPath(workspaceRoot);
  }

  async ensureSeeded(): Promise<void> {
    if ((await this.readState()).seeded) return;
    await this.mutate((state) => {
      if (state.seeded) return;
      for (const seed of ARTEX_BUILTIN_INTERCEPT_RULE_SEEDS) {
        state.interceptRules.push({
          id: state.counters.interceptRule++,
          name: seed.name,
          enabled: seed.enabled,
          priority: seed.priority,
          matchTarget: seed.matchTarget,
          matchType: seed.matchType,
          pattern: seed.pattern,
          action: seed.action,
          message: seed.message,
          builtin: true,
        });
      }
      for (const seed of ARTEX_BUILTIN_ASSET_INTERCEPT_RULE_SEEDS) {
        state.assetInterceptRules.push({
          id: state.counters.assetInterceptRule++,
          enabled: true,
          kind: seed.kind,
          pattern: seed.pattern,
          note: seed.note,
          builtin: true,
        });
      }
      state.seeded = true;
    });
  }

  async upsertCompany(name: string, logo?: string): Promise<ArtexUpsertResult> {
    const trimmed = name.trim();
    const nkey = trimmed.toLowerCase();
    return this.mutate((state) => {
      const existing = state.companies.find((company) => company.nkey === nkey);
      if (existing) {
        if (logo !== undefined && logo !== '') existing.logo = logo;
        existing.updatedAt = this.now();
        return { id: existing.id, created: false };
      }
      const now = this.now();
      const id = state.counters.company++;
      state.companies.push({ id, name: trimmed, nkey, logo, createdAt: now, updatedAt: now });
      return { id, created: true };
    });
  }

  async addCompanyScope(
    companyId: number,
    lines: readonly string[],
    reason: string,
  ): Promise<ArtexCompanyScopeResult> {
    return this.mutate((state) => {
      const company = state.companies.find((candidate) => candidate.id === companyId);
      if (!company) {
        return { companyId, added: 0, skipped: 0, invalid: lines.length, errors: ['unknown company'] };
      }
      let added = 0;
      let skipped = 0;
      let invalid = 0;
      const errors: string[] = [];
      for (const raw of lines) {
        const parsed = parseCompanyScopeLine(raw);
        if (parsed === undefined) {
          invalid += 1;
          errors.push(`cannot classify scope line: ${raw}`);
          continue;
        }
        const dup = state.companyScope.some(
          (scope) =>
            scope.companyId === companyId &&
            scope.kind === parsed.kind &&
            (scope.domain ?? '') === (parsed.domain ?? '') &&
            (scope.net ?? '') === (parsed.net ?? '') &&
            (scope.value ?? '') === (parsed.value ?? ''),
        );
        if (dup) {
          skipped += 1;
          continue;
        }
        state.companyScope.push({
          id: state.counters.companyScope++,
          companyId,
          kind: parsed.kind,
          domain: parsed.domain,
          net: parsed.net,
          value: parsed.value,
          raw: raw.trim(),
          reason: reason || undefined,
          createdAt: this.now(),
        });
        added += 1;
      }
      return { companyId, added, skipped, invalid, errors };
    });
  }

  async listCompanies(): Promise<readonly ArtexCompanySummary[]> {
    const state = await this.readState();
    return state.companies
      .toSorted((a, b) => a.id - b.id)
      .map((company) => ({
        id: company.id,
        name: company.name,
        assetCount: state.assets.filter((asset) => asset.companyId === company.id).length,
        scope: state.companyScope
          .filter((scope) => scope.companyId === company.id)
          .map((scope) => scope.raw),
      }));
  }

  async companyScopeOf(companyId: number): Promise<readonly ArtexCompanyScope[]> {
    const state = await this.readState();
    return state.companyScope.filter((scope) => scope.companyId === companyId);
  }

  async upsertAsset(input: ArtexAssetInput, taskId?: number): Promise<ArtexUpsertResult> {
    return this.mutate((state) => {
      const candidate = this.buildAsset(state, input);
      const key = assetDedupKey(candidate);
      const existing = state.assets.find((asset) => assetDedupKey(asset) === key);
      const now = this.now();
      if (existing) {
        mergeAsset(existing, candidate, now);
        if (taskId !== undefined && taskId > 0) {
          this.linkAssetToTask(state, taskId, existing.id, 'agent', now);
          if (!existing.taskIds.includes(taskId)) {
            existing.taskIds = [...existing.taskIds, taskId];
          }
        }
        return { id: existing.id, created: false };
      }
      const id = state.counters.asset++;
      const stored: ArtexAsset = {
        ...candidate,
        id,
        taskIds: taskId !== undefined && taskId > 0 ? [taskId] : [],
        createdAt: now,
        lastSeen: now,
        updatedAt: now,
      };
      state.assets.push(stored);
      if (taskId !== undefined && taskId > 0) {
        this.linkAssetToTask(state, taskId, id, 'agent', now);
      }
      return { id, created: true };
    });
  }

  async getAsset(id: number): Promise<ArtexAsset | undefined> {
    const state = await this.readState();
    return state.assets.find((asset) => asset.id === id);
  }

  async listAssets(query: ArtexAssetQuery): Promise<readonly ArtexAsset[]> {
    const state = await this.readState();
    let assets = state.assets;
    if (query.id !== undefined) assets = assets.filter((asset) => asset.id === query.id);
    if (query.ids !== undefined) {
      const wanted = new Set(query.ids);
      assets = assets.filter((asset) => wanted.has(asset.id));
    }
    if (query.type !== undefined && query.type !== '') {
      assets = assets.filter((asset) => asset.type === query.type);
    }
    if (query.taskId !== undefined) {
      assets = assets.filter((asset) => asset.taskIds.includes(query.taskId as number));
    }
    if (query.text !== undefined && query.text.trim() !== '') {
      const needle = query.text.trim().toLowerCase();
      assets = assets.filter((asset) => assetHaystack(asset).includes(needle));
    }
    assets = assets.toSorted((a, b) => a.id - b.id);
    const offset = query.offset !== undefined && query.offset > 0 ? query.offset : 0;
    const limited = offset > 0 ? assets.slice(offset) : assets;
    if (query.limit !== undefined && query.limit > 0) return limited.slice(0, query.limit);
    return limited;
  }

  async assetsForTask(taskId: number): Promise<readonly ArtexAsset[]> {
    const state = await this.readState();
    return state.assets.filter((asset) => asset.taskIds.includes(taskId));
  }

  async addTaskScope(
    taskId: number,
    kind: ArtexTaskScopeKind,
    value: string,
    reason: string,
    source: ArtexTaskScopeSource,
  ): Promise<ArtexTaskScope> {
    return this.mutate((state) => {
      const fields = this.resolveTaskScopeFields(state, kind, value);
      return this.insertTaskScope(state, taskId, kind, fields, reason, source);
    });
  }

  async addAutoScope(
    taskId: number,
    assetType: ArtexAssetType,
    domain: string,
    url: string,
    ip: string,
  ): Promise<void> {
    await this.mutate((state) => {
      for (const auto of autoScopesFor(assetType, domain, url, ip)) {
        this.insertTaskScope(state, taskId, auto.kind, auto, '', 'auto');
      }
    });
  }

  async listTaskScope(taskId: number): Promise<readonly ArtexTaskScope[]> {
    const state = await this.readState();
    return state.taskScope.filter((scope) => scope.taskId === taskId);
  }

  async coverageDenominator(taskId: number): Promise<ArtexCoverageDenominator> {
    const state = await this.readState();
    const ids = this.inScopeAssetIds(state, taskId);
    return { denominator: ids.length, assetIds: ids };
  }

  async listUntestedAssets(
    taskId: number,
    testedAssetIds: readonly number[],
    type?: string,
    limit?: number,
    offset?: number,
  ): Promise<ArtexUntestedResult> {
    const state = await this.readState();
    const tested = new Set(testedAssetIds);
    const inScope = this.inScopeAssetIds(state, taskId);
    let untested = inScope.filter((id) => !tested.has(id));
    const byId = new Map(state.assets.map((asset) => [asset.id, asset]));
    if (type !== undefined && type !== '') {
      untested = untested.filter((id) => byId.get(id)?.type === type);
    }
    const total = untested.length;
    const start = offset !== undefined && offset > 0 ? offset : 0;
    const sliced = untested.slice(start, limit !== undefined && limit > 0 ? start + limit : undefined);
    const assets: ArtexUntestedAsset[] = [];
    for (const id of sliced) {
      const asset = byId.get(id);
      if (asset) assets.push({ id, type: asset.type, label: assetLabel(asset) });
    }
    return { assets, total };
  }

  async upsertTaskCredential(
    taskId: number,
    input: ArtexTaskCredentialInput,
  ): Promise<ArtexTaskCredential> {
    return this.mutate((state) => {
      const domain = domainKey(input.domain);
      const username = input.username.trim();
      const now = this.now();
      const existing = state.credentials.find(
        (cred) => cred.taskId === taskId && cred.domain === domain && cred.username === username,
      );
      if (existing) {
        existing.password = input.password;
        existing.note = input.note ?? existing.note;
        existing.source = input.source ?? existing.source;
        existing.updatedAt = now;
        return existing;
      }
      const credential: ArtexTaskCredential = {
        id: state.counters.credential++,
        taskId,
        domain,
        username,
        password: input.password,
        source: input.source ?? 'agent',
        note: input.note ?? '',
        createdAt: now,
        updatedAt: now,
      };
      state.credentials.push(credential);
      return credential;
    });
  }

  async taskCredentials(taskId: number): Promise<readonly ArtexTaskCredential[]> {
    const state = await this.readState();
    return state.credentials.filter((cred) => cred.taskId === taskId);
  }

  async recordCoverage(taskId: number, entry: ArtexCoverageEntry): Promise<void> {
    await this.mutate((state) => {
      const row: CoverageRow = {
        taskId,
        surface: normalizeCoverageField(entry.surface),
        riskArea: normalizeRiskArea(entry.riskArea),
        outcome: entry.outcome,
        evidence: entry.evidence,
        reason: entry.reason,
        worker: entry.worker,
        intentId: entry.intentId,
        updatedAt: this.now(),
      };
      const index = state.coverage.findIndex(
        (existing) =>
          existing.taskId === taskId &&
          existing.surface === row.surface &&
          existing.riskArea === row.riskArea,
      );
      if (index >= 0) state.coverage[index] = row;
      else state.coverage.push(row);
      state.coverageHistory.push({
        ...row,
        historyId: state.counters.coverageHistory++,
        recordedAt: row.updatedAt ?? this.now(),
      });
    });
  }

  async coverageEntries(taskId: number): Promise<readonly ArtexCoverageEntry[]> {
    const state = await this.readState();
    return state.coverage.filter((row) => row.taskId === taskId).map(stripCoverageRow);
  }

  async coverageHistory(taskId: number): Promise<readonly ArtexCoverageEntry[]> {
    const state = await this.readState();
    return state.coverageHistory.filter((row) => row.taskId === taskId).map(stripCoverageRow);
  }

  async coverageEntryCount(taskId: number): Promise<number> {
    const state = await this.readState();
    return state.coverage.filter((row) => row.taskId === taskId).length;
  }

  async setConstraints(
    taskId: number,
    entries: readonly ArtexConstraintInput[],
    origin: string,
  ): Promise<readonly ArtexTaskConstraint[]> {
    return this.mutate((state) => {
      state.constraints = state.constraints.filter(
        (constraint) => !(constraint.explorationId === taskId && constraint.origin === origin),
      );
      const now = this.now();
      for (const entry of entries) {
        const text = entry.text.trim();
        if (text === '') continue;
        state.constraints.push({
          id: state.counters.constraint++,
          explorationId: taskId,
          kind: entry.kind,
          text,
          origin: origin || undefined,
          createdAt: now,
          updatedAt: now,
        });
      }
      return state.constraints.filter((constraint) => constraint.explorationId === taskId);
    });
  }

  async listConstraints(taskId: number): Promise<readonly ArtexTaskConstraint[]> {
    const state = await this.readState();
    return state.constraints.filter((constraint) => constraint.explorationId === taskId);
  }

  async listInterceptRules(): Promise<readonly ArtexInterceptRule[]> {
    const state = await this.readState();
    return state.interceptRules.toSorted((a, b) => b.priority - a.priority || a.id - b.id);
  }

  async listAssetInterceptRules(): Promise<readonly ArtexAssetInterceptRule[]> {
    const state = await this.readState();
    return state.assetInterceptRules.filter((rule) => rule.taskId === undefined);
  }

  async taskInterceptRulesSplit(taskId: number): Promise<ArtexTaskInterceptRulesSplit> {
    const state = await this.readState();
    const scoped = state.assetInterceptRules.filter((rule) => rule.taskId === taskId);
    return {
      block: scoped.filter((rule) => rule.action === 'block'),
      allow: scoped.filter((rule) => rule.action === 'allow'),
    };
  }

  async activeTargetPins(
    taskId: number,
    host: string,
    port: number,
  ): Promise<readonly ArtexTargetPin[]> {
    const state = await this.readState();
    const normalizedHost = domainKey(host);
    return state.targetPins.filter(
      (pin) =>
        pin.taskId === taskId &&
        pin.status === 'active' &&
        domainKey(pin.host) === normalizedHost &&
        pin.port === port,
    );
  }

  async createTargetPin(input: ArtexTargetPinInput): Promise<ArtexTargetPin> {
    return this.mutate((state) => {
      const normalizedHost = domainKey(input.host);
      for (const pin of state.targetPins) {
        if (
          pin.taskId === input.taskId &&
          pin.status === 'active' &&
          domainKey(pin.host) === normalizedHost &&
          pin.port === input.port
        ) {
          (pin as { status: ArtexTargetPin['status'] }).status = 'superseded';
        }
      }
      const prior = state.targetPins.filter(
        (pin) =>
          pin.taskId === input.taskId &&
          domainKey(pin.host) === normalizedHost &&
          pin.port === input.port,
      );
      const version = prior.reduce((max, pin) => Math.max(max, pin.version), 0) + 1;
      const now = this.now();
      const pin: ArtexTargetPin = {
        id: state.counters.targetPin++,
        taskId: input.taskId,
        host: normalizedHost,
        port: input.port,
        version,
        pinnedIps: [...input.pinnedIps].map((ip) => ip.trim()).filter((ip) => ip !== ''),
        resolver: input.resolver,
        resolvedAt: now,
        status: 'active',
        nameOnlyEffective: input.nameOnlyEffective ?? false,
        createdAt: now,
      };
      state.targetPins.push(pin);
      return pin;
    });
  }

  async targetExemptions(): Promise<readonly string[]> {
    const state = await this.readState();
    return state.exemptions;
  }

  private linkAssetToTask(
    state: ArtexWorkState,
    taskId: number,
    assetId: number,
    source: ArtexTaskAssetLink['source'],
    now: string,
  ): void {
    const existing = state.taskAssetLinks.find(
      (link) => link.taskId === taskId && link.assetId === assetId,
    );
    if (existing) {
      existing.updatedAt = now;
      return;
    }
    state.taskAssetLinks.push({
      taskId,
      assetId,
      source,
      sourceSummary: '',
      createdAt: now,
      updatedAt: now,
    });
  }

  private buildAsset(state: ArtexWorkState, input: ArtexAssetInput): ArtexAsset {
    const base: ArtexAsset = {
      id: 0,
      type: input.type,
      companyId: input.companyId,
      companySource: 'explicit',
      taskIds: [],
      boundDomains: dedupeStrings(input.boundDomains),
      openPorts: input.openPorts ?? [],
      recordValue: dedupeStrings(input.recordValue),
      technologies: dedupeStrings(input.technologies),
      auth: input.auth ?? [],
      params: input.params ?? [],
      extra: {},
      createdAt: '',
      lastSeen: '',
      updatedAt: '',
    };
    applyAssetShape(base, input);
    this.attributeCompany(state, base);
    return base;
  }

  private attributeCompany(state: ArtexWorkState, asset: ArtexAsset): void {
    if (asset.companyId !== undefined) return;
    for (const scope of state.companyScope) {
      if (companyScopeMatchesAsset(scope, asset)) {
        asset.companyId = scope.companyId;
        asset.companySource = 'scope';
        return;
      }
    }
  }

  private resolveTaskScopeFields(
    state: ArtexWorkState,
    kind: ArtexTaskScopeKind,
    value: string,
  ): TaskScopeFields {
    switch (kind) {
      case 'company': {
        const name = value.trim();
        const company =
          state.companies.find((candidate) => String(candidate.id) === name) ??
          state.companies.find((candidate) => candidate.nkey === name.toLowerCase());
        return { companyId: company?.id, value: name };
      }
      case 'root_domain':
        return { domain: rootDomain(stripHostPort(value)) };
      case 'subdomain':
        return { domain: domainKey(stripHostPort(value)) };
      case 'ip':
        return { net: ipToHostCidr(stripHostPort(value)) || value.trim() };
      case 'cidr':
        return { net: maskedCidr(value) };
      case 'icp':
        return { value: normalizeIcp(value) };
      case 'keyword':
        return { value: value.trim() };
      default: {
        const exhaustive: never = kind;
        return exhaustive;
      }
    }
  }

  private insertTaskScope(
    state: ArtexWorkState,
    taskId: number,
    kind: ArtexTaskScopeKind,
    fields: TaskScopeFields,
    reason: string,
    source: ArtexTaskScopeSource,
  ): ArtexTaskScope {
    const dup = state.taskScope.find(
      (scope) =>
        scope.taskId === taskId &&
        scope.kind === kind &&
        (scope.domain ?? '') === (fields.domain ?? '') &&
        (scope.net ?? '') === (fields.net ?? '') &&
        (scope.companyId ?? 0) === (fields.companyId ?? 0) &&
        (scope.value ?? '') === (fields.value ?? ''),
    );
    if (dup) return dup;
    const scope: ArtexTaskScope = {
      id: state.counters.taskScope++,
      taskId,
      kind,
      companyId: fields.companyId,
      domain: fields.domain,
      net: fields.net,
      value: fields.value,
      source,
      reason: reason || undefined,
      createdAt: this.now(),
    };
    state.taskScope.push(scope);
    return scope;
  }

  private inScopeAssetIds(state: ArtexWorkState, taskId: number): number[] {
    const counted = countedScopes(state.taskScope.filter((scope) => scope.taskId === taskId));
    const ids: number[] = [];
    const seen = new Set<number>();
    for (const asset of state.assets) {
      if (!asset.taskIds.includes(taskId)) continue;
      if (seen.has(asset.id)) continue;
      if (counted.some((scope) => taskScopeMatchesAsset(scope, asset))) {
        seen.add(asset.id);
        ids.push(asset.id);
      }
    }
    return ids.toSorted((a, b) => a - b);
  }

  private now(): string {
    return new Date().toISOString();
  }

  private mutate<T>(fn: (state: ArtexWorkState) => T): Promise<T> {
    const previous = inProcessWorkLockChains.get(this.lockPath) ?? Promise.resolve();
    const run = previous.then(async () => {
      const token = await this.acquireLock();
      try {
        const state = await this.readState();
        const result = fn(state);
        await this.writeState(state);
        return result;
      } finally {
        await this.releaseLock(token);
      }
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    inProcessWorkLockChains.set(this.lockPath, tail);
    void tail.finally(() => {
      if (inProcessWorkLockChains.get(this.lockPath) === tail) {
        inProcessWorkLockChains.delete(this.lockPath);
      }
    });
    return run;
  }

  private async readState(): Promise<ArtexWorkState> {
    let raw: string;
    try {
      raw = await readFile(this.stateFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
    const parsed = JSON.parse(raw) as ArtexWorkState;
    return { ...emptyState(), ...parsed, counters: { ...emptyState().counters, ...parsed.counters } };
  }

  private async writeState(state: ArtexWorkState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.stateFile}.tmp-${String(process.pid)}-${randomUUID()}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, this.stateFile);
  }

  private async acquireLock(): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const token = randomUUID();
    const deadline = Date.now() + ARTEX_WORK_LOCK_ACQUIRE_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await open(this.lockPath, 'wx');
        try {
          await handle.writeFile(
            `pid=${String(process.pid)} since=${this.now()} token=${token}`,
            'utf8',
          );
        } finally {
          await handle.close();
        }
        return token;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.reapStaleLock();
        if (Date.now() >= deadline) {
          throw new Error(`timed out acquiring artex work-store lock at ${this.lockPath}`, {
            cause: error,
          });
        }
        await delay(ARTEX_WORK_LOCK_RETRY_INTERVAL_MS);
      }
    }
  }

  private async reapStaleLock(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.lockPath, 'utf8');
    } catch {
      return;
    }
    const pid = Number(/pid=(\d+)/.exec(content)?.[1]);
    const since = Date.parse(/since=(\S+)/.exec(content)?.[1] ?? '');
    const dead =
      Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && this.pidIsDead(pid);
    const expired = Number.isFinite(since) && Date.now() - since > ARTEX_WORK_LOCK_STALE_MS;
    if (dead || expired) {
      await rm(this.lockPath, { force: true });
    }
  }

  private pidIsDead(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private async releaseLock(token: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.lockPath, 'utf8');
    } catch {
      return;
    }
    if (!content.includes(`token=${token}`)) return;
    await rm(this.lockPath, { force: true });
  }
}

interface TaskScopeFields {
  companyId?: number;
  domain?: string;
  net?: string;
  value?: string;
}

interface AutoScope extends TaskScopeFields {
  readonly kind: ArtexTaskScopeKind;
}

function stripCoverageRow(row: CoverageRow): ArtexCoverageEntry {
  return {
    surface: row.surface,
    riskArea: row.riskArea,
    outcome: row.outcome,
    evidence: row.evidence,
    reason: row.reason,
    worker: row.worker,
    intentId: row.intentId,
    updatedAt: row.updatedAt,
  };
}

function dedupeStrings(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function applyAssetShape(asset: ArtexAsset, input: ArtexAssetInput): void {
  switch (input.type) {
    case 'root_domain': {
      const host = rootDomain(domainKey(input.domain ?? ''));
      asset.domain = host;
      asset.rootDomain = host;
      asset.icp = input.icp;
      break;
    }
    case 'subdomain': {
      const host = domainKey(input.domain ?? '');
      asset.domain = host;
      asset.rootDomain = rootDomain(host);
      asset.recordType = input.recordType;
      break;
    }
    case 'ip': {
      const ip = (input.ip ?? '').trim();
      asset.ip = ip;
      asset.cSegment = cSegmentOf(ip);
      break;
    }
    case 'app': {
      asset.appName = input.appName;
      asset.bundleId = input.bundleId;
      asset.category = input.category;
      asset.appDescription = input.description;
      asset.appIcp = input.appIcp;
      break;
    }
    case 'service': {
      applyServiceShape(asset, input);
      break;
    }
    case 'endpoint': {
      const url = (input.url ?? '').trim();
      asset.url = url;
      asset.method = (input.method ?? 'GET').toUpperCase();
      const host = hostFromUrl(url);
      if (host !== '') {
        asset.domain = host;
        asset.rootDomain = rootDomain(host);
      }
      break;
    }
    default: {
      const exhaustive: never = input.type;
      return exhaustive;
    }
  }
}

function applyServiceShape(asset: ArtexAsset, input: ArtexAssetInput): void {
  const url = (input.url ?? '').trim();
  if (url !== '') {
    asset.serviceType = 'http';
    asset.url = url;
    asset.statusCode = input.statusCode;
    asset.contentLength = input.contentLength;
    asset.pageTitle = input.pageTitle;
    asset.faviconMmh3 = input.faviconMmh3;
    const host = hostFromUrl(url);
    if (host !== '') {
      if (isIpLiteral(host)) asset.ip = host;
      else {
        asset.domain = host;
        asset.rootDomain = rootDomain(host);
      }
    }
    asset.port = input.port ?? portFromUrl(url);
    return;
  }
  asset.serviceType = 'other';
  asset.serviceName = input.serviceName;
  asset.port = input.port;
  asset.ip = (input.serviceIp ?? input.ip ?? '').trim() || undefined;
  const host = domainKey(input.domain ?? '');
  if (host !== '') {
    asset.domain = host;
    asset.rootDomain = rootDomain(host);
  }
}

function mergeAsset(target: ArtexAsset, source: ArtexAsset, now: string): void {
  target.boundDomains = mergeStringLists(target.boundDomains, source.boundDomains);
  target.recordValue = mergeStringLists(target.recordValue, source.recordValue);
  target.technologies = mergeStringLists(target.technologies, source.technologies);
  target.openPorts = mergeJsonList(target.openPorts, source.openPorts);
  target.auth = mergeJsonList(target.auth, source.auth);
  target.params = mergeJsonList(target.params, source.params);
  if (source.companyId !== undefined && target.companyId === undefined) {
    target.companyId = source.companyId;
    target.companySource = source.companySource;
  }
  target.icp = target.icp ?? source.icp;
  target.appIcp = target.appIcp ?? source.appIcp;
  target.category = target.category ?? source.category;
  target.appDescription = target.appDescription ?? source.appDescription;
  target.appName = target.appName ?? source.appName;
  target.pageTitle = target.pageTitle ?? source.pageTitle;
  target.statusCode = target.statusCode ?? source.statusCode;
  target.contentLength = target.contentLength ?? source.contentLength;
  target.faviconMmh3 = target.faviconMmh3 ?? source.faviconMmh3;
  target.serviceName = target.serviceName ?? source.serviceName;
  target.recordType = target.recordType ?? source.recordType;
  target.lastSeen = now;
  target.updatedAt = now;
}

function mergeStringLists(
  current: readonly string[],
  incoming: readonly string[],
): readonly string[] {
  return dedupeStrings([...current, ...incoming]);
}

function mergeJsonList<T>(current: readonly T[], incoming: readonly T[]): readonly T[] {
  const seen = new Set(current.map((item) => JSON.stringify(item)));
  const out = [...current];
  for (const item of incoming) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function assetDedupKey(asset: ArtexAsset): string {
  switch (asset.type) {
    case 'root_domain':
      return `root_domain|${domainKey(asset.domain ?? '')}`;
    case 'ip':
      return `ip|${(asset.ip ?? '').trim()}`;
    case 'subdomain':
      return `subdomain|${domainKey(asset.domain ?? '')}|${asset.recordType ?? ''}`;
    case 'app':
      return asset.bundleId !== undefined && asset.bundleId !== ''
        ? `app|bundle|${asset.bundleId}`
        : `app|name|${(asset.appName ?? '').trim().toLowerCase()}`;
    case 'service':
      return asset.serviceType === 'http'
        ? `service|http|${(asset.url ?? '').trim()}`
        : `service|other|${domainKey(asset.domain ?? '')}|${(asset.ip ?? '').trim()}|${String(asset.port ?? 0)}|${(asset.serviceName ?? '').trim().toLowerCase()}`;
    case 'endpoint':
      return `endpoint|${(asset.url ?? '').trim()}|${(asset.method ?? 'GET').toUpperCase()}`;
    default: {
      const exhaustive: never = asset.type;
      return exhaustive;
    }
  }
}

function assetHaystack(asset: ArtexAsset): string {
  return [
    asset.domain,
    asset.rootDomain,
    asset.ip,
    asset.url,
    asset.appName,
    asset.bundleId,
    asset.serviceName,
    asset.icp,
    asset.appIcp,
    asset.pageTitle,
    ...asset.boundDomains,
    ...asset.technologies,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

function assetLabel(asset: ArtexAsset): string {
  switch (asset.type) {
    case 'root_domain':
    case 'subdomain':
      return asset.domain ?? '';
    case 'ip':
      return asset.ip ?? '';
    case 'app':
      return asset.appName ?? asset.bundleId ?? '';
    case 'service':
      return asset.url ?? `${asset.domain ?? asset.ip ?? ''}:${String(asset.port ?? '')}`;
    case 'endpoint':
      return `${asset.method ?? 'GET'} ${asset.url ?? ''}`.trim();
    default: {
      const exhaustive: never = asset.type;
      return exhaustive;
    }
  }
}

function autoScopesFor(
  assetType: ArtexAssetType,
  domain: string,
  url: string,
  ip: string,
): readonly AutoScope[] {
  switch (assetType) {
    case 'root_domain': {
      const host = rootDomain(domainKey(domain));
      return host === '' ? [] : [{ kind: 'root_domain', domain: host }];
    }
    case 'subdomain': {
      const host = domainKey(domain);
      return host === '' ? [] : [{ kind: 'subdomain', domain: host }];
    }
    case 'ip': {
      const net = ipToHostCidr(ip.trim());
      return net === '' ? [] : [{ kind: 'ip', net }];
    }
    case 'service':
    case 'endpoint': {
      const host = hostFromUrl(url) || domainKey(domain);
      if (host !== '' && !isIpLiteral(host)) {
        return [{ kind: 'subdomain', domain: host }];
      }
      const addr = isIpLiteral(host) ? host : ip.trim();
      const net = ipToHostCidr(addr);
      return net === '' ? [] : [{ kind: 'ip', net }];
    }
    case 'app':
      return [];
    default: {
      const exhaustive: never = assetType;
      return exhaustive;
    }
  }
}

function countedScopes(scopes: readonly ArtexTaskScope[]): readonly ArtexTaskScope[] {
  const declared = scopes.filter((scope) => scope.source !== 'auto');
  return scopes.filter((scope) => {
    if (scope.source !== 'auto') return true;
    return declared.some((parent) => declaredCoversAuto(parent, scope));
  });
}

function declaredCoversAuto(declared: ArtexTaskScope, auto: ArtexTaskScope): boolean {
  switch (auto.kind) {
    case 'root_domain':
    case 'subdomain':
      return auto.domain !== undefined && declaredCoversHost(declared, auto.domain);
    case 'ip':
    case 'cidr':
      return auto.net !== undefined && declaredCoversNet(declared, auto.net);
    case 'company':
      return declared.kind === 'company' && declared.companyId === auto.companyId;
    case 'icp':
    case 'keyword':
      return false;
    default: {
      const exhaustive: never = auto.kind;
      return exhaustive;
    }
  }
}

function declaredCoversHost(declared: ArtexTaskScope, host: string): boolean {
  const normalized = domainKey(host);
  switch (declared.kind) {
    case 'root_domain':
      return (
        declared.domain !== undefined &&
        (rootDomain(normalized) === declared.domain ||
          normalized === declared.domain ||
          normalized.endsWith(`.${declared.domain}`))
      );
    case 'subdomain':
      return (
        declared.domain !== undefined &&
        (normalized === declared.domain || normalized.endsWith(`.${declared.domain}`))
      );
    default:
      return false;
  }
}

function declaredCoversNet(declared: ArtexTaskScope, net: string): boolean {
  if (declared.net === undefined) return false;
  if (declared.kind !== 'ip' && declared.kind !== 'cidr') return false;
  return cidrSubsetOf(net, declared.net);
}

function taskScopeMatchesAsset(scope: ArtexTaskScope, asset: ArtexAsset): boolean {
  switch (scope.kind) {
    case 'company':
      return scope.companyId !== undefined && asset.companyId === scope.companyId;
    case 'root_domain':
      return (
        scope.domain !== undefined &&
        (asset.rootDomain === scope.domain || asset.domain === scope.domain)
      );
    case 'subdomain':
      return scope.domain !== undefined && asset.domain === scope.domain;
    case 'ip':
    case 'cidr':
      return (
        scope.net !== undefined && asset.ip !== undefined && cidrContainsIp(scope.net, asset.ip)
      );
    case 'icp': {
      if (scope.value === undefined) return false;
      const target = normalizeIcp(scope.value);
      return (
        (asset.icp !== undefined && normalizeIcp(asset.icp) === target) ||
        (asset.appIcp !== undefined && normalizeIcp(asset.appIcp) === target)
      );
    }
    case 'keyword':
      return false;
    default: {
      const exhaustive: never = scope.kind;
      return exhaustive;
    }
  }
}

function companyScopeMatchesAsset(scope: ArtexCompanyScope, asset: ArtexAsset): boolean {
  switch (scope.kind) {
    case 'domain':
      return (
        scope.domain !== undefined &&
        (asset.rootDomain === scope.domain ||
          asset.domain === scope.domain ||
          (asset.domain !== undefined && asset.domain.endsWith(`.${scope.domain}`)))
      );
    case 'ip':
    case 'cidr':
      return (
        scope.net !== undefined && asset.ip !== undefined && cidrContainsIp(scope.net, asset.ip)
      );
    case 'icp': {
      if (scope.value === undefined) return false;
      const target = normalizeIcp(scope.value);
      return (
        (asset.icp !== undefined && normalizeIcp(asset.icp) === target) ||
        (asset.appIcp !== undefined && normalizeIcp(asset.appIcp) === target)
      );
    }
    case 'keyword':
      return false;
    default: {
      const exhaustive: never = scope.kind;
      return exhaustive;
    }
  }
}

function parseCompanyScopeLine(raw: string): CompanyScopeFields | undefined {
  const value = raw.trim();
  if (value === '') return undefined;
  if (value.includes('/') && parseCidr(value) !== undefined) {
    return { kind: 'cidr', net: maskedCidr(value) };
  }
  const host = stripHostPort(value);
  if (isIpLiteral(host)) {
    return { kind: 'ip', net: ipToHostCidr(host) };
  }
  if (/^[0-9a-z\u4E00-\u9FA5]+icp[\u5907\w-]*\d/i.test(value.replaceAll(/\s+/g, ''))) {
    return { kind: 'icp', value: normalizeIcp(value) };
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
    return { kind: 'domain', domain: rootDomain(host) };
  }
  return { kind: 'keyword', value };
}

interface CompanyScopeFields {
  readonly kind: ArtexCompanyScopeKind;
  readonly domain?: string;
  readonly net?: string;
  readonly value?: string;
}

function cSegmentOf(ip: string): string | undefined {
  if (!isIPv4(ip)) return undefined;
  const octets = ip.split('.');
  if (octets.length !== 4) return undefined;
  return `${octets[0] ?? ''}.${octets[1] ?? ''}.${octets[2] ?? ''}.0/24`;
}

function hostFromUrl(raw: string): string {
  const value = raw.trim();
  if (value === '') return '';
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    const hostname = url.hostname;
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      return hostname.slice(1, -1).toLowerCase();
    }
    return hostname.toLowerCase();
  } catch {
    return stripHostPort(value).toLowerCase();
  }
}

function portFromUrl(raw: string): number | undefined {
  const value = raw.trim();
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    if (url.port !== '') return Number(url.port);
    switch (url.protocol) {
      case 'https:':
      case 'wss:':
        return 443;
      case 'http:':
      case 'ws:':
        return 80;
      case 'ftp:':
        return 21;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
