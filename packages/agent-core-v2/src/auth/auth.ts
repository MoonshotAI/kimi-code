/**
 * `auth` domain (cross-cutting) — core-scope OAuth + auth summary.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface AuthStatus {
  readonly loggedIn: boolean;
  readonly provider?: string;
}

export interface IOAuthService {
  readonly _serviceBrand: undefined;
  login(provider: string): Promise<void>;
  logout(provider: string): Promise<void>;
  status(): Promise<AuthStatus>;
}

export const IOAuthService: ServiceIdentifier<IOAuthService> =
  createDecorator<IOAuthService>('oauthService');

export interface IAuthSummaryService {
  readonly _serviceBrand: undefined;
  summarize(): Promise<readonly AuthStatus[]>;
}

export const IAuthSummaryService: ServiceIdentifier<IAuthSummaryService> =
  createDecorator<IAuthSummaryService>('authSummaryService');
