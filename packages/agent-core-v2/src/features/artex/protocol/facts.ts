export type ArtexFactSource =
  | 'target_response'
  | 'tool_output'
  | 'third_party_intel'
  | 'operator_input'
  | 'inference';

export const ARTEX_FACT_SOURCES: readonly ArtexFactSource[] = [
  'target_response',
  'tool_output',
  'third_party_intel',
  'operator_input',
  'inference',
];

export const ARTEX_DEFAULT_FACT_SOURCE: ArtexFactSource = 'inference';

export type ArtexFactConfidence = 'observed' | 'inferred';

export const ARTEX_FACT_CONFIDENCES: readonly ArtexFactConfidence[] = ['observed', 'inferred'];

export interface ArtexFactPayload {
  readonly summary: string;
  readonly detail?: string;
  readonly evidence?: string;
  readonly confidence?: ArtexFactConfidence;
  readonly source: ArtexFactSource;
  readonly assetIds?: readonly number[];
}

export interface ArtexNormalizedFactSource {
  readonly source: ArtexFactSource;
  readonly error?: string;
}

export function normalizeArtexFactSource(raw: string | undefined): ArtexNormalizedFactSource {
  const norm = (raw ?? '').trim().toLowerCase();
  if (norm === '') return { source: ARTEX_DEFAULT_FACT_SOURCE };
  for (const source of ARTEX_FACT_SOURCES) {
    if (norm === source) return { source };
  }
  return {
    source: ARTEX_DEFAULT_FACT_SOURCE,
    error: `source ${JSON.stringify(raw)} is not valid: use one of ${ARTEX_FACT_SOURCES.join(
      ', ',
    )} (omit it for inference)`,
  };
}

export function isAuthoritativeFactForGoal(
  confidence: ArtexFactConfidence | undefined,
  source: ArtexFactSource,
): boolean {
  return confidence === 'observed' && source !== 'target_response';
}
