import {
  installGlobalProxyDispatcher as v2InstallGlobalProxyDispatcher,
  type InstallProxyDeps,
} from '@moonshot-ai/agent-core-v2/_base/utils/proxy';

type Env = Readonly<Record<string, string | undefined>>;

export function installGlobalProxyDispatcher(
  env: Env = process.env,
  deps?: InstallProxyDeps,
): boolean {
  return v2InstallGlobalProxyDispatcher(env, deps);
}
