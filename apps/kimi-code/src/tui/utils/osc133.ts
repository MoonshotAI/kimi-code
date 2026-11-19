import {
  OSC133_ZONE_END,
  OSC133_ZONE_FINAL,
  OSC133_ZONE_START,
} from '#/tui/constant/rendering';

const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

export function markOsc133Zone(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  lines[0] = OSC133_ZONE_START + lines[0]!;
  lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1]!;
  return lines;
}

export function prefixPreservingOsc133Zone(line: string, prefix: string): string {
  const zone = OSC133_ZONE_PREFIX.exec(line)?.[0];
  return zone === undefined ? prefix + line : zone + prefix + line.slice(zone.length);
}
