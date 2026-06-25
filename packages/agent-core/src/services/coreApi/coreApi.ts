import type { CoreRPC, SDKAPI } from '../../rpc';
import type { CoreProcessServiceOptions } from '../coreProcess/coreProcess';

export interface ServicesCoreAdapterOptions {
  readonly coreProcessOptions: CoreProcessServiceOptions;
  readonly sdk: SDKAPI;
  readonly homeDir: string;
  readonly configPath: string;
}

export interface ServicesCoreAdapter {
  readonly rpc: CoreRPC;
  ready(): Promise<void>;
  dispose(): void;
}
