/**
 * Write a minimal `config.toml` that declares a single fake model backed by the
 * scripted-provider seam, so `AcpServer.bindDefaultModel()` binds it on
 * `session/new` and the turn loop resolves a runnable `Model`.
 *
 * Uses the flat model path (`baseUrl` + inline `apiKey` on the Model) so no
 * `[providers.*]` entry is required; the resolver synthesizes a Provider from
 * the `baseUrl` origin and builds a `StaticAuthProvider` from the inline key.
 * The `protocol` is any current `ProtocolSchema` enum value (`'kimi'` was
 * removed from the enum — use `'openai'`) — the scripted registry ignores it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FAKE_MODEL_ID = 'fake';
/** Second configured model — lets tests assert an actual model switch. */
export const FAKE_MODEL_ALT_ID = 'fake-alt';

export interface FakeModelConfigOptions {
  /**
   * Declare the 'thinking' capability on FAKE_MODEL_ID so the ACP host
   * advertises the thinking toggle for it.
   */
  readonly thinking?: boolean;
  /** Declared selectable effort levels (`supportEfforts`) on FAKE_MODEL_ID. */
  readonly supportEfforts?: readonly string[];
  /** Declared default effort (`defaultEffort`) on FAKE_MODEL_ID. */
  readonly defaultEffort?: string;
  /** Same three declarations, applied to FAKE_MODEL_ALT_ID instead. */
  readonly altThinking?: boolean;
  readonly altSupportEfforts?: readonly string[];
  readonly altDefaultEffort?: string;
}

const configToml = (options?: FakeModelConfigOptions): string => {
  const thinking = options?.thinking === true;
  const efforts = options?.supportEfforts;
  const defaultEffort = options?.defaultEffort;
  const altThinking = options?.altThinking === true;
  const altEfforts = options?.altSupportEfforts;
  const altDefaultEffort = options?.altDefaultEffort;
  return `defaultModel = "${FAKE_MODEL_ID}"

[models.${FAKE_MODEL_ID}]
name = "fake-model"
protocol = "openai"
baseUrl = "http://localhost"
apiKey = "test-token"
maxContextSize = 8192
${thinking ? 'capabilities = ["thinking"]\n' : ''}${efforts !== undefined ? `supportEfforts = [${efforts.map((e) => `"${e}"`).join(', ')}]\n` : ''}${defaultEffort !== undefined ? `defaultEffort = "${defaultEffort}"\n` : ''}[models.${FAKE_MODEL_ALT_ID}]
name = "fake-model-alt"
protocol = "openai"
baseUrl = "http://localhost"
apiKey = "test-token"
maxContextSize = 8192
${altThinking ? 'capabilities = ["thinking"]\n' : ''}${altEfforts !== undefined ? `supportEfforts = [${altEfforts.map((e) => `"${e}"`).join(', ')}]\n` : ''}${altDefaultEffort !== undefined ? `defaultEffort = "${altDefaultEffort}"\n` : ''}`;
};

/**
 * Write the fake-model `config.toml` into `<homeDir>/config.toml`. Call BEFORE
 * booting the server (the ConfigService reads the file at first access).
 */
export async function writeFakeModelConfig(
  homeDir: string,
  options?: FakeModelConfigOptions,
): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  await writeFile(join(homeDir, 'config.toml'), configToml(options), 'utf8');
}
