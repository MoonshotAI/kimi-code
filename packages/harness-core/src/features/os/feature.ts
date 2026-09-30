import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigRef,
  createFeature,
  useAgentTools,
  useConfigSection,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import { createToken, useExpose, useNode, useReady } from '@moonshot-ai/agent-core/kernel/index';

import {
  legacyBackgroundConfigSection,
  readConfigSection,
  resolveAgentTaskConfig,
  taskConfigSection,
  type ReadSection,
  type TaskSection,
} from './configSections';
import { createNodeOsHost, type OsHost } from './host/index';
import {
  createBashTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  type BashPendingDetach,
} from './tools/index';

export const BashRef = createToken<BashPendingDetach>('bash');

export interface CreateOsProps {
  readonly workDir: string;
  readonly host?: OsHost;
  readonly additionalDirs?: readonly string[];
  readonly spillDir?: string;
}

export function createOs(props: CreateOsProps): FeatureSpec {
  const host = props.host ?? createNodeOsHost();
  return createFeature('os', {
    app() {
      useConfigSection(readConfigSection);
      useConfigSection(taskConfigSection);
      useConfigSection(legacyBackgroundConfigSection);
      useReady(host.environment.ready);
    },
    agent() {
      const node = useNode();
      const workspace = { workDir: props.workDir, additionalDirs: props.additionalDirs };
      const spillDir =
        props.spillDir ??
        join(process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code'), 'tool-results');
      const config = node.providerRef(ConfigRef);
      const readSection = (): ReadSection =>
        config.value.at(-1)?.value.get<ReadSection>('read') ?? {};
      const taskSection = (): TaskSection | undefined => {
        const store = config.value.at(-1)?.value;
        return store === undefined ? undefined : resolveAgentTaskConfig(store);
      };
      const bash = createBashTool({
        host,
        workspace,
        spillDir,
        autoBackgroundOnTimeout: () => taskSection()?.bashAutoBackgroundOnTimeout ?? true,
        backgroundTaskTimeoutS: () => taskSection()?.bashTaskTimeoutS ?? 600,
      });
      useAgentTools(
        bash,
        createGlobTool({ host, workspace }),
        createGrepTool({ host, workspace }),
        createReadTool({ host, workspace, limits: readSection }),
        createWriteTool({ host, workspace }),
      );
      useExpose(BashRef, bash.pending);
    },
  });
}
