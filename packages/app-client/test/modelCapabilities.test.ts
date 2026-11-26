import { describe, expect, it } from 'vitest';
import { modelCapabilityItems } from '../src/lib/modelCapabilities';

describe('modelCapabilityItems', () => {
  it('lists context, vision, tool use, and thinking in design order', () => {
    expect(
      modelCapabilityItems({
        id: 'a/b',
        provider: 'a',
        model: 'b',
        maxContextSize: 200 * 1024,
        capabilities: ['thinking', 'tool_use', 'image_in', 'video_in'],
      }),
    ).toEqual([
      { kind: 'context', size: '200K' },
      { kind: 'image' },
      { kind: 'tool' },
      { kind: 'thinking' },
    ]);
  });

  it('formats million-token context and prefers always-thinking over thinking', () => {
    expect(
      modelCapabilityItems({
        id: 'a/b',
        provider: 'a',
        model: 'b',
        maxContextSize: 1048576,
        capabilities: ['thinking', 'always_thinking', 'tool_use'],
      }),
    ).toEqual([
      { kind: 'context', size: '1M' },
      { kind: 'tool' },
      { kind: 'always-thinking' },
    ]);
  });

  it('omits unsupported capabilities and zero context', () => {
    expect(modelCapabilityItems({ id: 'a/b', provider: 'a', model: 'b', maxContextSize: 0 })).toEqual([]);
  });
});
