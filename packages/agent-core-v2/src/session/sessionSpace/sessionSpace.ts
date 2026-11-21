import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { SessionSpace } from '@moonshot-ai/core/session/index';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';

export interface HostSessionSpace extends SessionSpace<SessionMeta> {
  keyFor(scope: string): string;
  set(key: string, record: SessionMeta): Promise<void>;
}

export interface ISessionSpace extends HostSessionSpace {
  readonly _serviceBrand: undefined;
}

export const ISessionSpace: ServiceIdentifier<ISessionSpace> =
  createDecorator<ISessionSpace>('sessionSpace');
