import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { CoreErrors } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import type { SkippedAgentFile } from '#/app/agentProfileCatalog/agentProfileContribution';

export interface UserAgentProfileSummary {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

export interface UserAgentProfileDetail extends UserAgentProfileSummary {
  readonly prompt: string;
  readonly etag: string;
}

export interface UserAgentProfileList {
  readonly root: string;
  readonly agents: readonly UserAgentProfileSummary[];
  readonly skipped: readonly SkippedAgentFile[];
}

export interface UserAgentProfileBasicInput {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
}

export interface UserAgentProfileUpdateInput {
  readonly newName?: string;
  readonly description: string;
  readonly prompt: string;
  readonly etag: string;
}

export interface UserAgentProfileRefreshResult {
  readonly refreshError?: string;
}

export interface UserAgentProfileMutationResult extends UserAgentProfileRefreshResult {
  readonly agent: UserAgentProfileDetail;
}

export type UserAgentProfileErrorKind = 'not_found' | 'already_exists' | 'stale' | 'validation';

export class UserAgentProfileError extends Error2 {
  constructor(
    readonly kind: UserAgentProfileErrorKind,
    message: string,
  ) {
    super(CoreErrors.codes.VALIDATION_FAILED, message, { name: 'UserAgentProfileError' });
  }
}

export interface IUserAgentProfileManagementService {
  readonly _serviceBrand: undefined;
  list(): Promise<UserAgentProfileList>;
  getProfile(name: string): Promise<UserAgentProfileDetail>;
  create(input: UserAgentProfileBasicInput): Promise<UserAgentProfileMutationResult>;
  update(name: string, input: UserAgentProfileUpdateInput): Promise<UserAgentProfileMutationResult>;
  delete(name: string, etag: string): Promise<UserAgentProfileRefreshResult>;
  refresh(): Promise<UserAgentProfileRefreshResult>;
}

export const IUserAgentProfileManagementService: ServiceIdentifier<IUserAgentProfileManagementService> =
  createDecorator<IUserAgentProfileManagementService>('userAgentProfileManagement');
