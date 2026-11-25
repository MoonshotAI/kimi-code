import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { ISessionProjectInfo } from '#/session/projectInfo/projectInfo';

export interface ProjectAddDirInput {
  readonly path: string;
  readonly persist?: boolean;
}

export interface ProjectAdditionalDirsResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
  readonly persisted: boolean;
}

export interface IProjectDirs {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly primary: string;
  readonly additionalDirs: readonly string[];
  readonly sharedAdditionalDirs: readonly string[];
  readonly primaryByWorkspace: Readonly<Record<string, string>>;
  readonly onDidChange: Event<void>;
  addDir(input: ProjectAddDirInput): Promise<ProjectAdditionalDirsResult>;
  mergeAdditionalDirs(baseDir: string, dirs: readonly string[]): Promise<void>;
  reload(): Promise<void>;
  sessionInfo(): ISessionProjectInfo;
}

export const IProjectDirs: ServiceIdentifier<IProjectDirs> =
  createDecorator<IProjectDirs>('workspaceDirs');
