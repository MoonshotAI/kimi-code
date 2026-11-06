import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatMessage } from '@/components/ChatMessage';
import type { ChatMessage as ChatMessageData } from '@/stores/chat.store';

function assistantMessage(steps: ChatMessageData['steps']): ChatMessageData {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    timestamp: 1,
    steps,
  };
}

function expectNoDuplicateKeys(consoleError: { mock: { calls: unknown[][] } }): void {
  const duplicateKeyErrors = consoleError.mock.calls.filter((call) =>
    String(call[0]).includes('same key'));
  expect(duplicateKeyErrors).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChatMessage step identity', () => {
  it('keeps steps distinct when a follow-up turn reuses the engine step number', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const message = assistantMessage([
      { n: 1, items: [{ type: 'text', content: 'So Eve-C may still store data.', finished: true }] },
      { n: 1, items: [{ type: 'text', content: 'The next core turn remains visible.', finished: true }] },
    ]);

    const view = render(<ChatMessage message={message} isStreaming />);

    expect(view.container.textContent).toContain('So Eve-C may still store data.');
    expect(view.container.textContent).toContain('The next core turn remains visible.');
    expectNoDuplicateKeys(consoleError);
  });

  it('keeps subagent steps distinct when their engine step number repeats', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const message = assistantMessage([
      {
        n: 1,
        items: [{
          type: 'tool_use',
          id: 'task-1',
          call: { id: 'task-1', name: 'Task', arguments: '{}' },
          subagent_steps: [
            { n: 1, items: [{ type: 'text', content: 'First subagent turn.', finished: true }] },
            { n: 1, items: [{ type: 'text', content: 'Second subagent turn.', finished: true }] },
          ],
        }],
      },
    ]);
    render(<ChatMessage message={message} />);

    const taskDetailsToggle = screen.getByRole('button', { name: /2 steps/ });
    fireEvent.click(taskDetailsToggle);
    const subagentStepsToggle = screen.getByRole('button', { name: '2 steps' });
    fireEvent.click(subagentStepsToggle);

    expect(screen.getByText('First subagent turn.')).toBeTruthy();
    expect(screen.getByText('Second subagent turn.')).toBeTruthy();
    expectNoDuplicateKeys(consoleError);
  });
});
