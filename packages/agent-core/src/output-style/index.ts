import { loadOutputStyles } from './loader';
import type { OutputStyle } from './types';

export type { OutputStyle, OutputStyleSource, ParsedOutputStyle } from './types';
export { parseOutputStyle, OutputStyleParseError } from './parser';
export { BUILTIN_OUTPUT_STYLES } from './builtin';
export { loadOutputStyles } from './loader';
export type { LoadOutputStylesOptions, OutputStylePathContext } from './loader';

export function resolveOutputStyle(styles: readonly OutputStyle[], name: string | undefined): OutputStyle | undefined {
  if (name === undefined || name.trim() === '') return undefined;
  return styles.find((s) => s.name === name.trim());
}

export interface LoadConfiguredOutputStyleInput {
  readonly name: string | undefined;
  readonly userHomeDir: string;
  readonly brandHomeDir?: string;
  readonly workDir: string;
  readonly onWarning?: (message: string, cause?: unknown) => void;
}

export async function loadConfiguredOutputStyleBody(
  input: LoadConfiguredOutputStyleInput,
): Promise<string | undefined> {
  if (input.name === undefined || input.name.trim() === '') return undefined;
  const styles = await loadOutputStyles({
    paths: { userHomeDir: input.userHomeDir, brandHomeDir: input.brandHomeDir, workDir: input.workDir },
    onWarning: input.onWarning,
  });
  return resolveOutputStyle(styles, input.name)?.body;
}
