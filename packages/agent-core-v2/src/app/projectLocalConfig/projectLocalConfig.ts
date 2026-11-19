import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ProjectLocalConfigLocation {
  readonly projectRoot: string;
  readonly configPath: string;
}

export interface ProjectAdditionalDirsLoadResult extends ProjectLocalConfigLocation {
  readonly additionalDirs: readonly string[];
}

export interface ProjectPermissionRulesLoadResult extends ProjectLocalConfigLocation {
  readonly rules: readonly unknown[];
}

export interface IProjectLocalConfigService {
  readonly _serviceBrand: undefined;

  locate(workDir: string): Promise<ProjectLocalConfigLocation>;
  readAdditionalDirs(workDir: string): Promise<ProjectAdditionalDirsLoadResult>;
  resolveAdditionalDirs(baseDir: string, additionalDirs: readonly string[]): Promise<string[]>;
  readPermissionRules(workDir: string): Promise<ProjectPermissionRulesLoadResult>;
  appendPermissionRules(
    workDir: string,
    rules: readonly unknown[],
  ): Promise<ProjectPermissionRulesLoadResult>;
}

export const IProjectLocalConfigService: ServiceIdentifier<IProjectLocalConfigService> =
  createDecorator<IProjectLocalConfigService>('projectLocalConfigService');
