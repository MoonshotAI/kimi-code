import { t } from '../i18n';
import type { FlagDefinitionInput } from './types';

/**
 * Experimental feature flags.
 *
 * To add one, append an entry and gate runtime behavior through the scoped
 * resolver available on `KimiCore`, `Session`, or `Agent`:
 *   { id: 'my_feature', title: 'My feature', description: '...', env: 'KIMI_CODE_EXPERIMENTAL_MY_FEATURE', default: false, surface: 'both' }
 *
 * Keep the `as const satisfies` — it derives the literal `FlagId` union that gives `enabled()`
 * autocomplete and typo-checking. `env` must start with 'KIMI_CODE_EXPERIMENTAL_', be unique, and
 * not equal the master switch 'KIMI_CODE_EXPERIMENTAL_FLAG'; `id` must not be 'flag'.
 */
export const FLAG_DEFINITIONS = [
  // Micro compaction has been disabled and removed: the capability cannot be
  // enabled via env, config, or the master experimental switch. The entry is
  // kept here commented out so it can be restored if the feature is revived.
  // {
  //   id: 'micro_compaction',
  //   title: 'Micro compaction',
  //   description: 'Trim older large tool results from context while keeping recent conversation intact.',
  //   env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
  //   default: false,
  //   surface: 'core',
  // },
  {
    id: 'tool-select',
    titleKey: 'flags.toolSelectTitle',
    descKey: 'flags.toolSelectDesc',
    env: 'KIMI_CODE_EXPERIMENTAL_TOOL_SELECT',
    default: false,
    surface: 'core',
  },
  {
    id: 'native_tools',
    titleKey: 'flags.nativeToolsTitle',
    descKey: 'flags.nativeToolsDesc',
    env: 'KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS',
    default: true,
    surface: 'core',
  },
  {
    id: 'rpc_microtask',
    titleKey: 'flags.rpcMicrotaskTitle',
    descKey: 'flags.rpcMicrotaskDesc',
    env: 'KIMI_CODE_EXPERIMENTAL_RPC_MICROTASK',
    default: false,
    surface: 'core',
  },
  {
    id: 'github_tools',
    title: 'GitHub tools',
    description:
      'Built-in GitHub REST tools (repos, files, issues, pull requests, search) backed by the native engine. Requires a GITHUB_TOKEN or GH_TOKEN environment variable, or set github_token in the [experimental] config section.',
    env: 'KIMI_CODE_EXPERIMENTAL_GITHUB_TOOLS',
    default: false,
    surface: 'core',
  },
  {
    id: 'goal_completion_verifier',
    title: 'Goal completion verifier',
    description:
      'Before a goal is marked complete, an isolated verifier agent independently checks the work against the objective and completion criterion, and rejects the completion if it is not verifiably done.',
    env: 'KIMI_CODE_EXPERIMENTAL_GOAL_COMPLETION_VERIFIER',
    default: true,
    surface: 'core',
  },
  {
    id: 'xunfei_coding_plan',
    title: 'Xunfei Coding Plan',
    description:
      'Enable iFlytek Astron Coding Plan as an API provider option. Requires an API key from xfyun.cn.',
    env: 'KIMI_CODE_EXPERIMENTAL_XUNFEI_CODING_PLAN',
    default: false,
    surface: 'both',
  },
] as const satisfies readonly FlagDefinitionInput[];

/** Literal union of registered flag ids. */
export type FlagId = (typeof FLAG_DEFINITIONS)[number]['id'];
