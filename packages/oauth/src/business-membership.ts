import { OAuthUnauthorizedError, OAuthWorkspaceSwitchError } from './errors';

export const BUSINESS_MEMBERSHIP_REVOKED_CODES = [
  'REASON_BUSINESS_MEMBER_REMOVED',
  'REASON_BUSINESS_MEMBER_DISABLED',
] as const;

export type BusinessMembershipRevokedCode = (typeof BUSINESS_MEMBERSHIP_REVOKED_CODES)[number];

export const BUSINESS_MEMBERSHIP_REVOKED_MESSAGE =
  'You have been removed from Business Membership. Your access to the workspace will no longer be available. Please log in again. If you have any questions, please contact your business administrator.';

export function isBusinessMembershipRevokedCode(
  code: unknown,
): code is BusinessMembershipRevokedCode {
  return (
    code === 'REASON_BUSINESS_MEMBER_REMOVED' || code === 'REASON_BUSINESS_MEMBER_DISABLED'
  );
}

export class BusinessMembershipRevokedError extends OAuthUnauthorizedError {
  readonly reasonCode: BusinessMembershipRevokedCode;

  constructor(reasonCode: BusinessMembershipRevokedCode) {
    super(BUSINESS_MEMBERSHIP_REVOKED_MESSAGE);
    this.name = 'BusinessMembershipRevokedError';
    this.reasonCode = reasonCode;
  }
}

export interface ManagedOAuthFailureInfo {
  readonly status?: number;
  readonly errorCode?: string;
  readonly message: string;
}

export function describeManagedOAuthFailure(error: unknown): ManagedOAuthFailureInfo {
  if (error instanceof BusinessMembershipRevokedError) {
    return { status: 401, errorCode: error.reasonCode, message: error.message };
  }
  if (error instanceof OAuthWorkspaceSwitchError) {
    return {
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.oauthError !== undefined ? { errorCode: error.oauthError } : {}),
      message: error.message,
    };
  }
  if (error instanceof OAuthUnauthorizedError) {
    return { status: 401, message: error.message };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}
