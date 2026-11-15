import type {
  ArtexAsset,
  ArtexAssetAuth,
  ArtexAssetParam,
  ArtexAssetType,
  ArtexCompanyScope,
  ArtexCoverageEntry,
  ArtexOpenPort,
  ArtexTaskConstraint,
  ArtexTaskConstraintKind,
  ArtexTaskCredential,
  ArtexTaskScope,
  ArtexTaskScopeKind,
  ArtexTaskScopeSource,
} from '#/features/artex/protocol/index';

export interface ArtexAssetInput {
  readonly type: ArtexAssetType;
  readonly domain?: string;
  readonly icp?: string;
  readonly recordType?: string;
  readonly recordValue?: readonly string[];
  readonly ip?: string;
  readonly boundDomains?: readonly string[];
  readonly openPorts?: readonly ArtexOpenPort[];
  readonly appName?: string;
  readonly bundleId?: string;
  readonly category?: string;
  readonly description?: string;
  readonly appIcp?: string;
  readonly companyId?: number;
  readonly url?: string;
  readonly technologies?: readonly string[];
  readonly statusCode?: number;
  readonly contentLength?: number;
  readonly pageTitle?: string;
  readonly faviconMmh3?: string;
  readonly auth?: readonly ArtexAssetAuth[];
  readonly serviceName?: string;
  readonly serviceIp?: string;
  readonly port?: number;
  readonly proto?: string;
  readonly method?: string;
  readonly params?: readonly ArtexAssetParam[];
}

export interface ArtexUpsertResult {
  readonly id: number;
  readonly created: boolean;
}

export interface ArtexCompanyScopeResult {
  readonly companyId: number;
  readonly added: number;
  readonly skipped: number;
  readonly invalid: number;
  readonly errors: readonly string[];
}

export interface ArtexCompanySummary {
  readonly id: number;
  readonly name: string;
  readonly assetCount: number;
  readonly scope: readonly string[];
}

export interface ArtexAssetQuery {
  readonly id?: number;
  readonly ids?: readonly number[];
  readonly type?: string;
  readonly text?: string;
  readonly taskId?: number;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ArtexCoverageDenominator {
  readonly denominator: number;
  readonly assetIds: readonly number[];
}

export interface ArtexUntestedAsset {
  readonly id: number;
  readonly type: ArtexAssetType;
  readonly label: string;
}

export interface ArtexUntestedResult {
  readonly assets: readonly ArtexUntestedAsset[];
  readonly total: number;
}

export interface ArtexTaskCredentialInput {
  readonly domain: string;
  readonly username: string;
  readonly password: string;
  readonly note?: string;
  readonly source?: 'user' | 'agent';
}

export interface ArtexConstraintInput {
  readonly kind: ArtexTaskConstraintKind;
  readonly text: string;
}

export type ArtexInterceptMatchTarget = 'tool_name' | 'tool_input';
export type ArtexInterceptMatchType = 'string' | 'regex' | 'argv';
export type ArtexInterceptAction = 'allow' | 'deny' | 'ask';

export interface ArtexInterceptRule {
  readonly id: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly matchTarget: ArtexInterceptMatchTarget;
  readonly matchType: ArtexInterceptMatchType;
  readonly pattern: string;
  readonly action: ArtexInterceptAction;
  readonly message: string;
  readonly builtin: boolean;
}

export type ArtexAssetInterceptKind =
  | 'exact_domain'
  | 'exact_ip'
  | 'exact_url'
  | 'fuzzy_domain'
  | 'fuzzy_ip'
  | 'fuzzy_url'
  | 'cidr';

export const ARTEX_ASSET_INTERCEPT_KINDS: readonly ArtexAssetInterceptKind[] = [
  'exact_domain',
  'exact_ip',
  'exact_url',
  'fuzzy_domain',
  'fuzzy_ip',
  'fuzzy_url',
  'cidr',
];

export interface ArtexAssetInterceptRule {
  readonly id: number;
  readonly enabled: boolean;
  readonly kind: ArtexAssetInterceptKind;
  readonly pattern: string;
  readonly note: string;
  readonly builtin: boolean;
  readonly action?: 'block' | 'allow';
}

export interface ArtexTaskInterceptRulesSplit {
  readonly block: readonly ArtexAssetInterceptRule[];
  readonly allow: readonly ArtexAssetInterceptRule[];
}

export type ArtexTargetPinStatus = 'active' | 'superseded' | 'revoked';

export interface ArtexTargetPin {
  readonly id: number;
  readonly taskId: number;
  readonly host: string;
  readonly port: number;
  readonly version: number;
  readonly pinnedIps: readonly string[];
  readonly resolver: string;
  readonly resolvedAt: string;
  readonly status: ArtexTargetPinStatus;
  readonly nameOnlyEffective: boolean;
  readonly createdAt: string;
}

export interface ArtexTargetPinInput {
  readonly taskId: number;
  readonly host: string;
  readonly port: number;
  readonly pinnedIps: readonly string[];
  readonly resolver: string;
  readonly nameOnlyEffective?: boolean;
}

/**
 * The ARTEX work store: the task-local record of assets, companies, scopes,
 * credentials, coverage and constraints, plus the safety-spine rows (intercept
 * rules, asset blacklist, target pins and exemptions) the gate reads. A file
 * backend owns the whole workspace; a database backend can replace it behind the
 * same interface.
 */
export interface IArtexWorkStore {
  readonly workspaceRoot: string;

  ensureSeeded(): Promise<void>;

  upsertCompany(name: string, logo?: string): Promise<ArtexUpsertResult>;
  addCompanyScope(
    companyId: number,
    lines: readonly string[],
    reason: string,
  ): Promise<ArtexCompanyScopeResult>;
  listCompanies(): Promise<readonly ArtexCompanySummary[]>;
  companyScopeOf(companyId: number): Promise<readonly ArtexCompanyScope[]>;

  upsertAsset(input: ArtexAssetInput, taskId?: number): Promise<ArtexUpsertResult>;
  getAsset(id: number): Promise<ArtexAsset | undefined>;
  listAssets(query: ArtexAssetQuery): Promise<readonly ArtexAsset[]>;
  assetsForTask(taskId: number): Promise<readonly ArtexAsset[]>;

  addTaskScope(
    taskId: number,
    kind: ArtexTaskScopeKind,
    value: string,
    reason: string,
    source: ArtexTaskScopeSource,
  ): Promise<ArtexTaskScope>;
  addAutoScope(
    taskId: number,
    assetType: ArtexAssetType,
    domain: string,
    url: string,
    ip: string,
  ): Promise<void>;
  listTaskScope(taskId: number): Promise<readonly ArtexTaskScope[]>;
  coverageDenominator(taskId: number): Promise<ArtexCoverageDenominator>;
  listUntestedAssets(
    taskId: number,
    testedAssetIds: readonly number[],
    type?: string,
    limit?: number,
    offset?: number,
  ): Promise<ArtexUntestedResult>;

  upsertTaskCredential(
    taskId: number,
    input: ArtexTaskCredentialInput,
  ): Promise<ArtexTaskCredential>;
  taskCredentials(taskId: number): Promise<readonly ArtexTaskCredential[]>;

  recordCoverage(taskId: number, entry: ArtexCoverageEntry): Promise<void>;
  coverageEntries(taskId: number): Promise<readonly ArtexCoverageEntry[]>;
  coverageHistory(taskId: number): Promise<readonly ArtexCoverageEntry[]>;
  coverageEntryCount(taskId: number): Promise<number>;

  setConstraints(
    taskId: number,
    entries: readonly ArtexConstraintInput[],
    origin: string,
  ): Promise<readonly ArtexTaskConstraint[]>;
  listConstraints(taskId: number): Promise<readonly ArtexTaskConstraint[]>;

  listInterceptRules(): Promise<readonly ArtexInterceptRule[]>;
  listAssetInterceptRules(): Promise<readonly ArtexAssetInterceptRule[]>;
  taskInterceptRulesSplit(taskId: number): Promise<ArtexTaskInterceptRulesSplit>;

  activeTargetPins(
    taskId: number,
    host: string,
    port: number,
  ): Promise<readonly ArtexTargetPin[]>;
  createTargetPin(input: ArtexTargetPinInput): Promise<ArtexTargetPin>;
  targetExemptions(): Promise<readonly string[]>;
}
