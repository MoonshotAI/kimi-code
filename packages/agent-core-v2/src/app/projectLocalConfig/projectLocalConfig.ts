import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ProjectAdditionalDirsLoadResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
}

export interface ProjectPermissionRulesLoadResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly rules: readonly unknown[];
}

export interface IProjectLocalConfigService {
  readonly _serviceBrand: undefined;

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
