import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FAKE_MODEL_ID = 'fake';
export const FAKE_MODEL_ALT_ID = 'fake-alt';

export interface FakeModelConfigOptions {
  readonly thinking?: boolean;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly image?: boolean;
  readonly altThinking?: boolean;
  readonly altSupportEfforts?: readonly string[];
  readonly altDefaultEffort?: string;
  readonly baseUrl?: string;
  readonly defaultPlanMode?: boolean;
  readonly defaultPermissionMode?: 'manual' | 'yolo';
}

const configToml = (options?: FakeModelConfigOptions): string => {
  const thinking = options?.thinking === true;
  const capabilities = [
    ...(thinking ? ['thinking'] : []),
    ...(options?.image === true ? ['image_in'] : []),
  ];
  const capabilitiesToml =
    capabilities.length === 0
      ? ''
      : `capabilities = [${capabilities.map((capability) => `"${capability}"`).join(', ')}]\n`;
  const efforts = options?.supportEfforts;
  const defaultEffort = options?.defaultEffort;
  const altThinking = options?.altThinking === true;
  const altEfforts = options?.altSupportEfforts;
  const altDefaultEffort = options?.altDefaultEffort;
  const baseUrl = options?.baseUrl ?? 'http://localhost';
  return `defaultModel = "${FAKE_MODEL_ID}"
${options?.defaultPlanMode === true ? 'default_plan_mode = true\n' : ''}${options?.defaultPermissionMode === undefined ? '' : `default_permission_mode = "${options.defaultPermissionMode}"\n`}
[models.${FAKE_MODEL_ID}]
name = "fake-model"
protocol = "openai"
baseUrl = "${baseUrl}"
apiKey = "test-token"
maxContextSize = 262144
${capabilitiesToml}${efforts !== undefined ? `supportEfforts = [${efforts.map((e) => `"${e}"`).join(', ')}]\n` : ''}${defaultEffort !== undefined ? `defaultEffort = "${defaultEffort}"\n` : ''}[models.${FAKE_MODEL_ALT_ID}]
name = "fake-model-alt"
protocol = "openai"
baseUrl = "${baseUrl}"
apiKey = "test-token"
maxContextSize = 262144
${altThinking ? 'capabilities = ["thinking"]\n' : ''}${altEfforts !== undefined ? `supportEfforts = [${altEfforts.map((e) => `"${e}"`).join(', ')}]\n` : ''}${altDefaultEffort !== undefined ? `defaultEffort = "${altDefaultEffort}"\n` : ''}`;
};

export async function writeFakeModelConfig(
  homeDir: string,
  options?: FakeModelConfigOptions,
): Promise<void> {
  await mkdir(homeDir, { recursive: true });
  await writeFile(join(homeDir, 'config.toml'), configToml(options), 'utf8');
}
