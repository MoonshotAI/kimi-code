import { describe, expect, it } from 'vitest';

import { toolResultToAcpContent } from '../src/convert';
import { HideOutputMarker, isHideOutputMarker } from '../src/marker';

/**
 * Phase 4.3 — `HideOutputMarker` lets a tool implementation tell the
 * ACP adapter "I own my own UI surface, don't render my textual
 * output as a `tool_call_update` content entry". With the engine's
 * string-`content` contract the tool emits the marker serialized as
 * JSON: if `session.tool.settled.content` equals
 * `JSON.stringify(HideOutputMarker)`, the adapter returns an empty
 * content array.
 */
describe('HideOutputMarker', () => {
  it('isHideOutputMarker returns true for the exported marker (reference identity)', () => {
    expect(isHideOutputMarker(HideOutputMarker)).toBe(true);
  });

  it('isHideOutputMarker accepts a structural twin (same __kind tag)', () => {
    // Defensive escape hatch — a structural clone (e.g. crossing a
    // worker_threads boundary) loses identity but preserves the tag.
    expect(isHideOutputMarker({ __kind: 'acp-hide-output' })).toBe(true);
  });

  it('isHideOutputMarker rejects null / undefined / primitives', () => {
    expect(isHideOutputMarker(null)).toBe(false);
    expect(isHideOutputMarker(undefined)).toBe(false);
    expect(isHideOutputMarker('x')).toBe(false);
    expect(isHideOutputMarker(0)).toBe(false);
    expect(isHideOutputMarker(false)).toBe(false);
  });

  it('isHideOutputMarker rejects objects without the __kind tag', () => {
    expect(isHideOutputMarker({})).toBe(false);
    expect(isHideOutputMarker({ kind: 'acp-hide-output' })).toBe(false);
    expect(isHideOutputMarker({ __kind: 'something-else' })).toBe(false);
  });
});

describe('toolResultToAcpContent + HideOutputMarker', () => {
  it('returns [] when content is the serialized marker (reference identity)', () => {
    const content = toolResultToAcpContent(JSON.stringify(HideOutputMarker));
    expect(content).toEqual([]);
  });

  it('returns [] when content is the serialized structural twin of the marker', () => {
    const content = toolResultToAcpContent(JSON.stringify({ __kind: 'acp-hide-output' }));
    expect(content).toEqual([]);
  });

  it('returns content normally when content does NOT match the marker', () => {
    const text = 'just a normal string';
    const content = toolResultToAcpContent(text);
    expect(content).toEqual([{ type: 'content', content: { type: 'text', text } }]);
  });

  it('does NOT trigger on content containing the marker tag as substring', () => {
    // Exact JSON match ONLY — substring match would be a false-positive
    // denial of legitimate stdout text.
    const text = 'stdout contains __kind:acp-hide-output literal somewhere';
    const content = toolResultToAcpContent(text);
    expect(content).toEqual([{ type: 'content', content: { type: 'text', text } }]);
  });
});
