/**
 * Write a minimal `config.toml` that declares a single fake model backed by the
 * scripted-provider seam, so `AcpServer.bindDefaultModel()` binds it on
 * `session/new` and the turn loop resolves a runnable `Model`.
 *
 * Uses the flat model path (`baseUrl` + inline `apiKey` on the Model) so no
 * `[providers.*]` entry is required; the resolver synthesizes a Provider from
 * the `baseUrl` origin and builds a `StaticAuthProvider` from the inline key.
 * The `protocol` is any valid enum value — the scripted registry ignores it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FAKE_MODEL_ID = 'fake';

const CONFIG_TOML = `defaultModel = "${FAKE_MODEL_ID}"

[models.${FAKE_MODEL_ID}]
name = "fake-model"
protocol = "kimi"
baseUrl = "http://localhost"
apiKey = "test-token"
maxContextSize = 8192
`;

/**
 * Write the fake-model `config.toml` into `<homeDir>/config.toml`. Call BEFORE
 * booting the server (the ConfigService reads the file at first access).
 */
export async function writeFakeModelConfig(homeDir: string): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  await writeFile(join(homeDir, 'config.toml'), CONFIG_TOML, 'utf8');
}
