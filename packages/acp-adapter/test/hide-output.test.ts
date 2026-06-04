import { describe, expect, it } from 'vitest';

import { toolResultToAcpContent } from '../src/convert';
import { HideOutputMarker, isHideOutputMarker } from '../src/marker';

/**
 * Phase 4.3 — `HideOutputMarker` lets a tool implementation tell the
 * ACP adapter "I own my own UI surface, don't render my textual
 * output as a `tool_call_update` content entry". The chosen detection
 * mechanism (A) inspects `ToolResultEvent.output`: if `output` is an
 * array and any element matches the marker, the adapter returns an
 * empty content array.
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
  it('returns [] when output array contains the marker (reference identity)', () => {
    const content = toolResultToAcpContent({
      type: 'tool.result',
      turnId: 1,
      toolCallId: 'tc',
      output: [HideOutputMarker, 'fallback text we should NOT see'],
    } as never);
    expect(content).toEqual([]);
  });

  it('returns [] when output array contains a structural twin of the marker', () => {
    const content = toolResultToAcpContent({
      type: 'tool.result',
      turnId: 1,
      toolCallId: 'tc',
      output: [{ __kind: 'acp-hide-output' }, 'fallback'],
    } as never);
    expect(content).toEqual([]);
  });

  it('returns content normally when output array does NOT contain the marker', () => {
    const content = toolResultToAcpContent({
      type: 'tool.result',
      turnId: 1,
      toolCallId: 'tc',
      output: ['just', 'a', 'normal', 'array'],
    } as never);
    // Array outputs are JSON-stringified into a single text block.
    expect(content).toEqual([
      {
        type: 'content',
        content: { type: 'text', text: JSON.stringify(['just', 'a', 'normal', 'array']) },
      },
    ]);
  });

  it('does NOT trigger on string output containing the marker tag as substring', () => {
    // Reference / __kind identity ONLY — substring match would be a
    // false-positive denial of legitimate stdout text.
    const text = 'stdout contains __kind:acp-hide-output literal somewhere';
    const content = toolResultToAcpContent({
      type: 'tool.result',
      turnId: 1,
      toolCallId: 'tc',
      output: text,
    } as never);
    expect(content).toEqual([
      { type: 'content', content: { type: 'text', text } },
    ]);
  });
});
