import { OAuthUnauthorizedError } from './errors';

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
