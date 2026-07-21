/**
 * `workspaceLocalConfig` test stubs — in-memory `IWorkspaceLocalConfigService`.
 *
 * Lives under `test/` (not `src/`). Import from a relative path.
 */

import {
  IWorkspaceLocalConfigService,
  type SubagentBinding,
} from '#/app/workspaceLocalConfig/workspaceLocalConfig';

export interface StubWorkspaceLocalConfigOptions {
  readonly bindings?: Readonly<Record<string, SubagentBinding>>;
  readonly slotBindings?: Readonly<Record<string, SubagentBinding>>;
}

export function stubWorkspaceLocalConfig(
  options: StubWorkspaceLocalConfigOptions = {},
): IWorkspaceLocalConfigService {
  const bindings = new Map(Object.entries(options.bindings ?? {}));
  const slotBindings = new Map(Object.entries(options.slotBindings ?? {}));
  return {
    _serviceBrand: undefined,
    readAdditionalDirs: (workDir: string) =>
      Promise.resolve({
        projectRoot: workDir,
        configPath: `${workDir}/.kimi-code/local.toml`,
        additionalDirs: [],
      }),
    resolveAdditionalDirs: (_baseDir: string, dirs: readonly string[]) =>
      Promise.resolve([...dirs]),
    appendAdditionalDir: () => Promise.reject(new Error('not implemented')),
    readSubagentBinding: (_workDir: string, agentType: string) =>
      Promise.resolve(bindings.get(agentType)),
    writeSubagentBinding: (_workDir: string, agentType: string, binding) => {
      if (binding === undefined) bindings.delete(agentType);
      else bindings.set(agentType, binding);
      return Promise.resolve({ configPath: '/stub/.kimi-code/local.toml' });
    },
    readSubagentSlotBinding: (_workDir: string, slot: string) =>
      Promise.resolve(slotBindings.get(slot)),
    writeSubagentSlotBinding: (_workDir: string, slot: string, binding) => {
      if (binding === undefined) slotBindings.delete(slot);
      else slotBindings.set(slot, binding);
      return Promise.resolve({ configPath: '/stub/.kimi-code/local.toml' });
    },
  };
}
