export const FALLBACK_MAX_CONTEXT_TOKENS = 262_144;

export function resolveEffectiveMaxContextTokens(args: {
  configured?: number;
  observed?: number;
}): number {
  const { configured, observed } = args;
  const configuredPositive = configured !== undefined && configured > 0;
  const observedPositive = observed !== undefined && observed > 0;
  if (configuredPositive && observedPositive) return Math.min(configured, observed);
  if (observedPositive) return observed;
  if (configuredPositive) return configured;
  return FALLBACK_MAX_CONTEXT_TOKENS;
}
