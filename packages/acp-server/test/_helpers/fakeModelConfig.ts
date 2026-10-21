import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FAKE_MODEL_ID = 'fake';
export const FAKE_MODEL_ALT_ID = 'fake-alt';

export interface FakeModelConfigOptions {
  readonly thinking?: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
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

export async function writeFakeModelConfig(
  homeDir: string,
  options?: FakeModelConfigOptions,
): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  await writeFile(join(homeDir, 'config.toml'), configToml(options), 'utf8');
}
