import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ProjectAdditionalDirsLocation {
  readonly projectRoot: string;
  readonly configPath: string;
}

export interface ProjectAdditionalDirsLoadResult extends ProjectAdditionalDirsLocation {
  readonly additionalDirs: readonly string[];
}

export interface IProjectLocalConfigService {
  readonly _serviceBrand: undefined;

  locateAdditionalDirsConfig(workDir: string): Promise<ProjectAdditionalDirsLocation>;
  readAdditionalDirs(workDir: string): Promise<ProjectAdditionalDirsLoadResult>;
  resolveAdditionalDirs(baseDir: string, additionalDirs: readonly string[]): Promise<string[]>;
  appendAdditionalDir(
    workDir: string,
    inputPath: string,
  ): Promise<ProjectAdditionalDirsLoadResult>;
}

export const IProjectLocalConfigService: ServiceIdentifier<IProjectLocalConfigService> =
  createDecorator<IProjectLocalConfigService>('projectLocalConfigService');
