export const ARTEX_PLATFORM_CONTROL_PREFIX = '[ARTEX platform control, not target defense]';

export const ARTEX_MAX_BLOCK_REASON_RUNES = 4000;

export function capArtexBlockReason(reason: string): string {
  const runes = Array.from(reason);
  if (runes.length <= ARTEX_MAX_BLOCK_REASON_RUNES) return reason;
  return runes.slice(0, ARTEX_MAX_BLOCK_REASON_RUNES).join('');
}

/**
 * Frames an intercept block as a platform-governance decision so the agent does
 * not mistake it for a target-side defense and try to evade it.
 */
export function artexSystemBlockMessage(reason: string): string {
  return (
    `${ARTEX_PLATFORM_CONTROL_PREFIX} This call was intercepted by the platform. ` +
    `Reason: ${capArtexBlockReason(reason)}. This operation is forbidden.`
  );
}

export interface ArtexTargetBlock {
  readonly code: string;
  readonly reason: string;
  readonly host?: string;
  readonly port?: number;
  readonly guidance?: string;
}

/**
 * The target-gate counterpart of {@link artexSystemBlockMessage}: a target block
 * is not always final (an approval can still arrive), so it does not end with
 * "This operation is forbidden."
 */
export function artexTargetBlockMessage(block: ArtexTargetBlock): string {
  let reason = capArtexBlockReason(block.reason);
  if (block.host && !reason.includes(block.host)) {
    const target = block.port ? `${block.host}:${String(block.port)}` : block.host;
    reason = `target ${target}: ${reason}`;
  }
  const guidance = block.guidance ?? '';
  return `${ARTEX_PLATFORM_CONTROL_PREFIX} ${block.code}: ${reason}. ${guidance}`;
}
