export type ArtexFindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export const ARTEX_FINDING_SEVERITIES: readonly ArtexFindingSeverity[] = [
  'critical',
  'high',
  'medium',
  'low',
];

export type ArtexFindingStatus =
  | 'pending'
  | 'in_progress'
  | 'confirmed'
  | 'resolved'
  | 'fixed'
  | 'false_positive'
  | 'ignored'
  | 'duplicate'
  | 'risk_accepted';

export const ARTEX_FINDING_STATUSES: readonly ArtexFindingStatus[] = [
  'pending',
  'in_progress',
  'confirmed',
  'resolved',
  'fixed',
  'false_positive',
  'ignored',
  'duplicate',
  'risk_accepted',
];

export type ArtexFindingVerificationStatus =
  | 'verified'
  | 'unverified'
  | 'blocked'
  | 'not_assessed'
  | 'false_positive';

export const ARTEX_FINDING_VERIFICATION_STATUSES: readonly ArtexFindingVerificationStatus[] = [
  'verified',
  'unverified',
  'blocked',
  'not_assessed',
  'false_positive',
];

export interface ArtexFinding {
  readonly id: number;
  taskId?: number;
  nodeId?: number;
  vulnclass: string;
  name: string;
  severity: ArtexFindingSeverity | '';
  summary: string;
  evidence: string;
  worker: string;
  assetIds: readonly number[];
  status: ArtexFindingStatus;
  report: string;
  poeLevel: number;
  verificationStatus: ArtexFindingVerificationStatus;
  verificationNote: string;
  counterevidence: string;
  confidenceRationale: string;
  evidenceVersion: number;
  reportEvidenceVersion: number;
  readonly createdAt: string;
}

export type ArtexFindingRetestStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped';

export const ARTEX_FINDING_RETEST_STATUSES: readonly ArtexFindingRetestStatus[] = [
  'pending',
  'running',
  'completed',
  'failed',
  'stopped',
];

export type ArtexFindingRetestVerdict = '' | 'reproduced' | 'fixed' | 'inconclusive';

export const ARTEX_FINDING_RETEST_VERDICTS: readonly ArtexFindingRetestVerdict[] = [
  '',
  'reproduced',
  'fixed',
  'inconclusive',
];

export interface ArtexFindingRetest {
  readonly id: number;
  readonly findingId: number;
  status: ArtexFindingRetestStatus;
  verdict: ArtexFindingRetestVerdict;
  notes: string;
  summary: string;
  evidence: string;
  error: string;
  readonly createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export function isValidArtexFindingSeverity(value: string): value is ArtexFindingSeverity {
  return (ARTEX_FINDING_SEVERITIES as readonly string[]).includes(value);
}

export function isValidArtexFindingStatus(value: string): value is ArtexFindingStatus {
  return (ARTEX_FINDING_STATUSES as readonly string[]).includes(value);
}
