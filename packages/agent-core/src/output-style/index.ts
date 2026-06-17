export type { OutputStyle, OutputStyleSource, ParsedOutputStyle } from './types';
export { parseOutputStyle, OutputStyleParseError } from './parser';
export { BUILTIN_OUTPUT_STYLES } from './builtin';
export { loadOutputStyles } from './loader';
export type { LoadOutputStylesOptions, OutputStylePathContext } from './loader';
import type { OutputStyle } from './types';
export function resolveOutputStyle(styles: readonly OutputStyle[], name: string | undefined): OutputStyle | undefined {
  if (name === undefined || name.trim() === '') return undefined;
  return styles.find((s) => s.name === name.trim());
}
