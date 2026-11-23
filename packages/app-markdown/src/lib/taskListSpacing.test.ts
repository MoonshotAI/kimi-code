import { describe, expect, it } from 'vitest';
import { getMarkdown } from 'stream-markdown-parser';
import { configureTaskListSpacing } from './taskListSpacing';

function texts(source: string): string[] {
  const md = getMarkdown();
  configureTaskListSpacing(md);
  configureTaskListSpacing(md);
  return md.parse(source, {}).flatMap(token => token.children ?? [])
    .filter(token => token.type === 'text').map(token => token.content);
}

describe('task list spacing', () => {
  it('consumes the separator for unchecked and checked tasks', () => {
    expect(texts('- [ ] 待完成\n- [x] 已完成\n- [X] 已完成')).toEqual(['待完成', '已完成', '已完成']);
  });

  it('preserves extra content whitespace and internal spaces', () => {
    expect(texts('- [ ]   keep  spaces')).toEqual(['  keep  spaces']);
  });

  it('handles formatted and nested task labels', () => {
    expect(texts('- [ ] **重点**\n  - [ ] [链接](https://example.com)').filter(Boolean)).toEqual(['重点', '链接']);
  });

  it('does not trim ordinary paragraph or list content', () => {
    expect(texts('[ ] 普通正文\n\n- 普通列表')).toEqual(['[ ] 普通正文', '普通列表']);
  });
});
