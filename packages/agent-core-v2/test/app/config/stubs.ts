import type { ServiceRegistration } from '#/_base/di/test';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { ConfigRegistry } from '#/app/config/configService';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';

export function registerConfigServices(reg: ServiceRegistration): void {
  reg.defineInstance(IConfigRegistry, new ConfigRegistry());
  reg.definePartialInstance(IConfigService, {});
  reg.define(IAtomicTomlDocumentStore, TomlAtomicDocumentStore);
}

export function stubConfigService(sections: Record<string, unknown> = {}): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: (domain: string) => sections[domain],
  } as unknown as IConfigService;
}
