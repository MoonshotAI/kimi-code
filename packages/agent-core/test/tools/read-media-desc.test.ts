import type { ModelCapability } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { ReadMediaFileTool } from '../../src/tools/builtin/file/read-media';
import { createFakeKaos, PERMISSIVE_WORKSPACE } from './fixtures/fake-kaos';

function capability(input: Partial<ModelCapability>): ModelCapability {
  return input as ModelCapability;
}

function makeTool(capabilities: Partial<ModelCapability>): ReadMediaFileTool {
  return new ReadMediaFileTool(createFakeKaos(), PERMISSIVE_WORKSPACE, capability(capabilities));
}

describe('ReadMediaFileTool description by capabilities', () => {
  it('throws when no image/video capability is present', () => {
    expect(() => makeTool({ image_in: false, video_in: false })).toThrow(/image_in or video_in/);
  });

  it('renders the media size limit and points text-file readers at the Read tool', () => {
    const tool = makeTool({ image_in: true, video_in: true });
    expect(tool.description).toContain('100MB');
    // TS renamed the sibling tool to `Read` (py was `ReadFile`); the
    // description must still point readers at the text-file tool.
    expect(tool.description).toContain('Read tool');
  });
});
