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
  it('mentions image and video when both capabilities are present', () => {
    const tool = makeTool({ image_in: true, video_in: true });
    expect(tool.description).toContain('supports image and video');
  });

  it('mentions image but flags video unsupported when only image_in is present', () => {
    const tool = makeTool({ image_in: true, video_in: false });
    expect(tool.description).toContain('supports image files for the current model');
    expect(tool.description).toContain('Video files are not supported');
  });

  it('mentions video but flags image unsupported when only video_in is present', () => {
    const tool = makeTool({ image_in: false, video_in: true });
    expect(tool.description).toContain('supports video files for the current model');
    expect(tool.description).toContain('Image files are not supported');
  });

  it('throws when no image/video capability is present', () => {
    expect(() => makeTool({ image_in: false, video_in: false })).toThrow(/image_in or video_in/);
  });

  it('description pins the stable contract phrases: image+video, 100MB, parallel reads, Read pointer', () => {
    const tool = makeTool({ image_in: true, video_in: true });
    expect(tool.description).toContain('image and video');
    expect(tool.description).toContain('100MB');
    expect(tool.description).toContain('parallel');
    // TS renamed the sibling tool to `Read` (py was `ReadFile`); the
    // description must still point readers at the text-file tool.
    expect(tool.description).toContain('Read tool');
  });

  it('mentions region support and full_resolution in the description', () => {
    const tool = makeTool({ image_in: true, video_in: true });
    expect(tool.description).toContain('region');
    expect(tool.description).toContain('full_resolution');
  });

  it('mentions the per-image byte limit for full_resolution guidance', () => {
    const tool = makeTool({ image_in: true, video_in: false });
    expect(tool.description).toMatch(/size limit|byte|limit|budget|per-image/i);
  });

  it('mentions compression limits in the description when both capabilities are present', () => {
    const tool = makeTool({ image_in: true, video_in: true });
    expect(tool.description).toMatch(/compress|limit|large|budget|size/i);
  });
});
