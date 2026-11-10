/**
 * OSC 133 zone marking for transcript messages. The fullscreen renderer
 * anchors previous/next-prompt navigation on lines whose first bytes are an
 * OSC 133;A zone marker (and strips the markers at paint), so the marks must
 * survive every container between the message component and the ScrollView.
 */

import {
  OSC133_ZONE_END,
  OSC133_ZONE_FINAL,
  OSC133_ZONE_START,
} from '#/tui/constant/rendering';

// One or more consecutive A/B/C zone markers anchored at the line start.
const OSC133_ZONE_PREFIX = /^(?:\x1B\]133;[ABC](?:\x07|\x1B\\))+/;

/**
 * Mark a message's rendered lines as a semantic zone: A on the first line,
 * B+C on the last. Mutates and returns the given array — call it on freshly
 * built lines before handing them to a render cache (cached lines then
 * already carry the marks, so they are never marked twice).
 */
export function markOsc133Zone(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  lines[0] = OSC133_ZONE_START + lines[0]!;
  lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines.at(-1)!;
  return lines;
}

/** Prefix a rendered line while keeping any leading OSC 133 zone at byte 0. */
export function prefixPreservingOsc133Zone(line: string, prefix: string): string {
  const zone = OSC133_ZONE_PREFIX.exec(line)?.[0];
  return zone === undefined ? prefix + line : zone + prefix + line.slice(zone.length);
}
