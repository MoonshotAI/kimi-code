/**
 * `faultInjection` domain (L4) — registers the `fault-injection` experimental
 * flag into `flag`.
 *
 * Gates the fault-injection Service's `arm`: deterministic provider-failure
 * simulation for exercising the requester's recovery projections over a live
 * channel. Off by default; enable via
 * `KIMI_CODE_EXPERIMENTAL_FAULT_INJECTION`, the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config section.
 * Imported for its side effect (registers the definition) from the package
 * barrel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const FAULT_INJECTION_FLAG_ID = 'fault-injection';
export const FAULT_INJECTION_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_FAULT_INJECTION';

export const faultInjectionFlag: FlagDefinitionInput = {
  id: FAULT_INJECTION_FLAG_ID,
  title: 'Fault injection (LLM request failures)',
  description:
    'Allow arming a one-shot deterministic provider failure (HTTP 413 body-size or image-format rejection) on the next LLM request, for testing the media-degraded / media-stripped recovery projections over a live channel.',
  env: FAULT_INJECTION_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(faultInjectionFlag);
