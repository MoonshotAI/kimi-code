import { describe, expect, it } from 'vitest';

import type { ContextItemSummary } from '../src/protocol/rest-context';
import { selectContextItems } from '../src/routes/contextItems';

function item(id: string, role: string): ContextItemSummary {
  return {
    id,
    role,
    preview: id,
    chars: id.length,
    has_media: false,
  };
}

const system = item('system', 'system');
const user = item('message-0', 'user');
const assistant = item('message-1', 'assistant');
const tool = item('tool-0', 'definition');
const nonTools = [system, user, assistant];
const tools = [tool];

describe('selectContextItems', () => {
  it('keeps tools separate from the unfiltered message page', () => {
    expect(selectContextItems(nonTools, tools, [])).toEqual({ items: nonTools, tools });
  });

  it('retains the existing single-role behavior', () => {
    expect(selectContextItems(nonTools, tools, ['user'])).toEqual({ items: [user], tools: [] });
    expect(selectContextItems(nonTools, tools, ['definition'])).toEqual({ items: tools, tools });
  });

  it('combines selected roles in context order', () => {
    expect(selectContextItems(nonTools, tools, ['user', 'definition', 'system'])).toEqual({
      items: [system, tool, user],
      tools,
    });
  });
});
