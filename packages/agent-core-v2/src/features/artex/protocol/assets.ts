export type ArtexAssetType =
  | 'root_domain'
  | 'ip'
  | 'subdomain'
  | 'app'
  | 'service'
  | 'endpoint';

export const ARTEX_ASSET_TYPES: readonly ArtexAssetType[] = [
  'root_domain',
  'ip',
  'subdomain',
  'app',
  'service',
  'endpoint',
];

export type ArtexAssetCompanySource = 'explicit' | 'scope';

export type ArtexServiceType = 'http' | 'other';

export interface ArtexOpenPort {
  readonly port: number;
  readonly protocol?: string;
  readonly service?: string;
  readonly [key: string]: unknown;
}

export interface ArtexAssetAuth {
  readonly [key: string]: unknown;
}

export interface ArtexAssetParam {
  readonly [key: string]: unknown;
}

export interface ArtexCompany {
  readonly id: number;
  name: string;
  readonly nkey: string;
  logo?: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface ArtexAsset {
  readonly id: number;
  type: ArtexAssetType;
  companyId?: number;
  companySource: ArtexAssetCompanySource;
  taskIds: readonly number[];
  domain?: string;
  rootDomain?: string;
  ip?: string;
  cSegment?: string;
  port?: number;
  icp?: string;
  boundDomains: readonly string[];
  openPorts: readonly ArtexOpenPort[];
  recordType?: string;
  recordValue: readonly string[];
  bundleId?: string;
  appName?: string;
  category?: string;
  appDescription?: string;
  appIcp?: string;
  url?: string;
  serviceType?: ArtexServiceType;
  serviceName?: string;
  faviconMmh3?: string;
  statusCode?: number;
  contentLength?: number;
  pageTitle?: string;
  technologies: readonly string[];
  auth: readonly ArtexAssetAuth[];
  method?: string;
  params: readonly ArtexAssetParam[];
  extra: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  lastSeen: string;
  updatedAt: string;
}

export type ArtexCompanyScopeKind = 'domain' | 'ip' | 'cidr' | 'icp' | 'keyword';

export const ARTEX_COMPANY_SCOPE_KINDS: readonly ArtexCompanyScopeKind[] = [
  'domain',
  'ip',
  'cidr',
  'icp',
  'keyword',
];

export interface ArtexCompanyScope {
  readonly id: number;
  readonly companyId: number;
  kind: ArtexCompanyScopeKind;
  domain?: string;
  net?: string;
  value?: string;
  raw: string;
  reason?: string;
  readonly createdAt: string;
}

export type ArtexTaskScopeKind =
  | 'company'
  | 'root_domain'
  | 'subdomain'
  | 'ip'
  | 'cidr'
  | 'icp'
  | 'keyword';

export const ARTEX_TASK_SCOPE_KINDS: readonly ArtexTaskScopeKind[] = [
  'company',
  'root_domain',
  'subdomain',
  'ip',
  'cidr',
  'icp',
  'keyword',
];

export type ArtexTaskScopeSource = 'auto' | 'agent' | 'manual';

export interface ArtexTaskScope {
  readonly id: number;
  readonly taskId: number;
  kind: ArtexTaskScopeKind;
  companyId?: number;
  domain?: string;
  net?: string;
  value?: string;
  source: ArtexTaskScopeSource;
  reason?: string;
  readonly createdAt: string;
}

export interface ArtexTaskRelation {
  readonly taskId: number;
  readonly sourceTaskId: number;
  readonly createdAt: string;
}

export type ArtexTaskAssetLinkSource = 'system' | 'legacy' | 'agent' | 'manual';

export interface ArtexTaskAssetLink {
  readonly taskId: number;
  readonly assetId: number;
  source: ArtexTaskAssetLinkSource;
  sourceSummary: string;
  sourceNodeId?: number;
  readonly createdAt: string;
  updatedAt: string;
}

export type ArtexTaskCredentialSource = 'user' | 'agent';

export interface ArtexTaskCredential {
  readonly id: number;
  readonly taskId: number;
  domain: string;
  username: string;
  password: string;
  source: ArtexTaskCredentialSource;
  note: string;
  readonly createdAt: string;
  updatedAt: string;
}

export function isValidArtexAssetType(value: string): value is ArtexAssetType {
  return (ARTEX_ASSET_TYPES as readonly string[]).includes(value);
}
