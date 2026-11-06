import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatArea } from '@/components/ChatArea';
import { bridge } from '@/services';
import { useChatStore } from '@/stores';
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

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

describe('chat clipboard', () => {
  function renderChatText(content: string): void {
    const message = assistantMessage([
      { n: 1, items: [{ type: 'text', content, finished: true }] },
    ]);
    useChatStore.setState({ messages: [message] });
    render(<ChatArea />);
  }

  function selectText(element: Element): void {
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()?.addRange(range);
  }

  it('offers only Copy and copies the selected Markdown text', async () => {
    const copyText = vi.spyOn(bridge, 'copyText').mockResolvedValue(undefined);
    renderChatText('Copy only this selection');
    const text = screen.getByText('Copy only this selection');
    selectText(text);

    fireEvent.contextMenu(text);
    const copy = await screen.findByRole('menuitem', { name: 'Copy' });
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    expect(screen.queryByText('Cut')).toBeNull();
    expect(screen.queryByText('Paste')).toBeNull();
    fireEvent.click(copy);

    await waitFor(() => {
      expect(copyText).toHaveBeenCalledExactlyOnceWith('Copy only this selection');
    });
  });

  it('copies the Markdown source when there is no selection', async () => {
    const copyText = vi.spyOn(bridge, 'copyText').mockResolvedValue(undefined);
    renderChatText('**Copy the source**');

    fireEvent.contextMenu(screen.getByText('Copy the source'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy' }));

    await waitFor(() => {
      expect(copyText).toHaveBeenCalledExactlyOnceWith('**Copy the source**');
    });
  });

  it('copies a selected message header through the same context menu', async () => {
    const copyText = vi.spyOn(bridge, 'copyText').mockResolvedValue(undefined);
    renderChatText('Response text');
    const header = screen.getByText('Kimi');
    selectText(header);

    fireEvent.contextMenu(header);
    const copy = await screen.findByRole('menuitem', { name: 'Copy' });
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    fireEvent.click(copy);

    await waitFor(() => {
      expect(copyText).toHaveBeenCalledExactlyOnceWith('Kimi');
    });
  });

  it('copies a chat selection with Ctrl+C', async () => {
    const copyText = vi.spyOn(bridge, 'copyText').mockResolvedValue(undefined);
    renderChatText('Keyboard clipboard text');
    selectText(screen.getByText('Keyboard clipboard text'));

    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });

    await waitFor(() => {
      expect(copyText).toHaveBeenCalledExactlyOnceWith('Keyboard clipboard text');
    });
  });
});
