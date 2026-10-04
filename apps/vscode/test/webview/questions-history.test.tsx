import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuestionsHistoryMenu } from '@/components/QuestionsHistoryMenu';
import type { ChatMessage } from '@/stores/chat.store';
import {
  collapseWhitespace,
  collectQuestionItems,
  filterQuestions,
  findCurrentQuestionIndex,
  useQuestionsHistory,
  type QuestionItem,
} from '@/components/inputarea/hooks/useQuestionsHistory';

const items: QuestionItem[] = [
  { id: 'a', text: 'fix the login bug' },
  { id: 'b', text: 'add unit tests' },
  { id: 'c', text: 'Fix the build' },
];

describe('collapseWhitespace', () => {
  it('collapses newlines and repeated spaces', () => {
    expect(collapseWhitespace('  hello\n\nworld\t ! ')).toBe('hello world !');
  });
});

const msg = (m: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage => ({ content: '', timestamp: 0, ...m });

describe('collectQuestionItems', () => {
  it('collects user messages and steer inputs in conversation order', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: 'first question' }),
      msg({ id: 'a1', role: 'assistant', steps: [{ n: 1, items: [{ type: 'steer', content: 'mid-turn\nfollow up' }] }] }),
      msg({ id: 'u2', role: 'user', content: '  second   question ' }),
    ];
    expect(collectQuestionItems(messages)).toEqual([
      { id: 'u1', text: 'first question' },
      { id: 'a1-steer-1-0', text: 'mid-turn follow up' },
      { id: 'u2', text: 'second question' },
    ]);
  });

  it('skips empty messages and non-steer step items', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '   ' }),
      msg({ id: 'a1', role: 'assistant', steps: [{ n: 1, items: [{ type: 'text', content: 'answer' }] }] }),
    ];
    expect(collectQuestionItems(messages)).toEqual([]);
  });
});

describe('filterQuestions', () => {
  it('returns all items for an empty query', () => {
    expect(filterQuestions(items, '', new Set())).toHaveLength(3);
  });

  it('matches case-insensitive substrings', () => {
    const result = filterQuestions(items, 'fix', new Set());
    expect(result.map((it) => it.id)).toEqual(['a', 'c']);
  });

  it('excludes hidden ids', () => {
    const result = filterQuestions(items, '', new Set(['b']));
    expect(result.map((it) => it.id)).toEqual(['a', 'c']);
  });
});

describe('findCurrentQuestionIndex', () => {
  it('returns -1 for no items', () => {
    expect(findCurrentQuestionIndex([])).toBe(-1);
  });

  it('falls back to the last item when no element is found', () => {
    expect(findCurrentQuestionIndex(items)).toBe(2);
  });
});

describe('useQuestionsHistory', () => {
  it('filters visible items by query and resets the active index', async () => {
    const { result } = renderHook(() => useQuestionsHistory(items));
    await act(() => result.current.moveActive(1));
    expect(result.current.activeIndex).toBe(0);
    await act(() => result.current.setQuery('tests'));
    expect(result.current.visibleItems.map((it) => it.id)).toEqual(['b']);
    expect(result.current.activeIndex).toBe(-1);
  });

  it('wraps around when moving past either end', async () => {
    const { result } = renderHook(() => useQuestionsHistory(items));
    await act(() => result.current.moveActive(1));
    expect(result.current.activeIndex).toBe(0);
    await act(() => result.current.moveActive(-1));
    expect(result.current.activeIndex).toBe(2);
    await act(() => result.current.moveActive(1));
    expect(result.current.activeIndex).toBe(0);
  });

  it('hides an item for the rest of the session', async () => {
    const { result } = renderHook(() => useQuestionsHistory(items));
    await act(() => result.current.hide('a'));
    expect(result.current.visibleItems.map((it) => it.id)).toEqual(['b', 'c']);
    expect(result.current.activeIndex).toBe(-1);
  });
});

describe('QuestionsHistoryMenu', () => {
  function renderMenu(overrides: Partial<Parameters<typeof QuestionsHistoryMenu>[0]> = {}) {
    const props = {
      items,
      totalCount: items.length,
      query: '',
      activeIndex: -1,
      onQueryChange: vi.fn(),
      onSelect: vi.fn(),
      onHide: vi.fn(),
      onHover: vi.fn(),
      onMoveActive: vi.fn(),
      onClose: vi.fn(),
      ...overrides,
    };
    render(<QuestionsHistoryMenu {...props} />);
    return props;
  }

  it('shows an empty-state hint when there are no questions', () => {
    renderMenu({ items: [], totalCount: 0 });
    expect(screen.getByText('No questions yet in this session')).toBeTruthy();
  });

  it('shows a no-match hint when filtering excludes everything', () => {
    renderMenu({ items: [], totalCount: 3 });
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('selects the single matching item on Enter without an active selection', async () => {
    const props = renderMenu({ items: [items[1]] });
    await userEvent.type(screen.getByRole('textbox'), '{Enter}');
    expect(props.onSelect).toHaveBeenCalledWith(items[1]);
  });

  it('delegates arrow keys and Escape', async () => {
    const props = renderMenu();
    const box = screen.getByRole('textbox');
    await userEvent.type(box, '{ArrowDown}{ArrowUp}{Escape}');
    expect(props.onMoveActive).toHaveBeenCalledWith(1);
    expect(props.onMoveActive).toHaveBeenCalledWith(-1);
    expect(props.onClose).toHaveBeenCalled();
  });

  it('hides an item via its hide button without selecting it', async () => {
    const props = renderMenu();
    await userEvent.click(screen.getAllByTitle('Hide for this session')[0]);
    expect(props.onHide).toHaveBeenCalledWith('a');
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});
