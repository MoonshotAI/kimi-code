import type { MarkdownIt } from 'markstream-vue';

const configured = new WeakSet<MarkdownIt>();

export function configureTaskListSpacing(md: MarkdownIt): void {
  if (configured.has(md)) return;
  configured.add(md);
  md.core.ruler.after('github-task-lists', 'task-list-spacing', state => {
    for (const token of state.tokens) {
      if (token.type !== 'inline' || token.children?.[0]?.type !== 'checkbox_input') continue;
      const text = token.children.find((child: { type: string; content: string }) => child.type === 'text');
      if (text) text.content = text.content.replace(/^[ \u00a0]/u, '');
    }
  });
}
