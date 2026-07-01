/**
 * `_base/execEnv` (L0) — pure execution-environment primitives.
 *
 * Vendored helpers previously imported from `@moonshot-ai/kaos`. None of them
 * carry DI dependencies; higher layers wrap them into services:
 *   - `app/hostEnvironment` — memoises the OS/shell probe as `IHostEnvironment`
 *   - `session/agentFs` — reuses the fs helpers to implement the session fs
 *   - `session/process` — reuses `BufferedReadable` for the spawned process
 */

export { BufferedReadable } from './bufferedReadable';
export { decodeTextWithErrors, type TextDecodeErrors } from './decodeText';
export { globPatternToRegex } from './globPattern';
export {
  probeHostEnvironment,
  probeHostEnvironmentFromNode,
  type HostEnvironmentInfo,
  type HostEnvironmentProbeDeps,
  type OsKind,
  type PathClass,
  type ShellName,
} from './environmentProbe';
