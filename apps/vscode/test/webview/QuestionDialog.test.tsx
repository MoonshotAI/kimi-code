import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionDialog } from '@/components/QuestionDialog';
import { useChatStore } from '@/stores';
import type { QuestionItem } from 'shared/legacy-sdk';

const respondQuestion = vi.fn().mockResolvedValue(undefined);

function makeQuestion(question: string, labels: string[], multiSelect = false): QuestionItem {
  return {
    question,
    options: labels.map((label) => ({ label })),
    multi_select: multiSelect,
  };
}

function setPendingQuestion(questions: QuestionItem[], id = 'request-1') {
  useChatStore.setState({
    pendingQuestion: { id, tool_call_id: 'tool-call-1', questions },
    respondQuestion,
  });
}

function renderQuestion(questions: QuestionItem[], id?: string) {
  setPendingQuestion(questions, id);
  return render(<QuestionDialog />);
}

function optionButton(label: string) {
  const button = screen.getByText(label).closest('button');
  if (!button) throw new Error(`No button contains ${label}`);
  return button;
}

function customResponseButton() {
  return screen.getByRole('button', { name: /Custom response/ }) as HTMLButtonElement;
}

function customInput() {
  return screen.getByPlaceholderText(/Enter your response/) as HTMLInputElement;
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('QuestionDialog', () => {
  beforeEach(() => {
    respondQuestion.mockReset();
    respondQuestion.mockResolvedValue(undefined);
    useChatStore.setState({ pendingQuestion: null, respondQuestion });
  });

  it('renders nothing without a pending question or question items', () => {
    const { container } = render(<QuestionDialog />);
    expect(container.firstChild).toBeNull();

    act(() => {
      setPendingQuestion([]);
    });
    expect(container.firstChild).toBeNull();
  });

  it('preserves single-select answers when navigating backward and forward', async () => {
    renderQuestion([
      {
        ...makeQuestion('First question', ['Alpha', 'Beta']),
        header: 'Setup',
        options: [{ label: 'Alpha', description: 'First option' }, { label: 'Beta' }],
      },
      makeQuestion('Second question', ['Gamma', 'Delta']),
      makeQuestion('Final question', ['Yes', 'No']),
    ]);

    expect(screen.getByText('Question 1 of 3')).toBeTruthy();
    expect(screen.getByText('Setup')).toBeTruthy();
    expect(screen.getByText('- First option')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();

    fireEvent.click(optionButton('Alpha'));
    fireEvent.click(optionButton('Gamma'));
    expect(screen.getByText('Final question')).toBeTruthy();
    expect(respondQuestion).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Second question')).toBeTruthy();
    expect(within(optionButton('Gamma')).getByText('✓')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('First question')).toBeTruthy();
    expect(within(optionButton('Alpha')).getByText('✓')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(optionButton('No'));

    await waitFor(() => {
      expect(respondQuestion).toHaveBeenCalledWith({
        'First question': 'Alpha',
        'Second question': 'Gamma',
        'Final question': 'No',
      });
    });
  });

  it('preserves custom drafts per question when navigating backward and forward', () => {
    renderQuestion([
      makeQuestion('First question', ['Alpha']),
      makeQuestion('Second question', ['Gamma']),
    ]);

    fireEvent.click(optionButton('Alpha'));
    fireEvent.click(customResponseButton());
    fireEvent.change(customInput(), { target: { value: 'Second draft' } });

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(customResponseButton());
    expect(customInput().value).toBe('');
    fireEvent.change(customInput(), { target: { value: 'First draft' } });
    fireEvent.keyDown(customInput(), { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(customResponseButton());
    expect(customInput().value).toBe('Second draft');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(customResponseButton());
    expect(customInput().value).toBe('First draft');
  });

  it('replaces an earlier single-select answer after going back', async () => {
    renderQuestion([
      makeQuestion('First question', ['Alpha', 'Beta']),
      makeQuestion('Final question', ['Gamma', 'Delta']),
    ]);

    fireEvent.click(optionButton('Alpha'));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(optionButton('Beta'));
    fireEvent.click(optionButton('Delta'));

    await waitFor(() => {
      expect(respondQuestion).toHaveBeenCalledWith({
        'First question': 'Beta',
        'Final question': 'Delta',
      });
    });
  });

  it('toggles multi-select options and submits them in selection order', async () => {
    renderQuestion([makeQuestion('Pick several', ['Alpha', 'Beta', 'Gamma'], true)]);

    const submit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText('Select all that apply')).toBeTruthy();

    fireEvent.click(optionButton('Alpha'));
    expect(submit.disabled).toBe(false);
    fireEvent.click(optionButton('Beta'));
    fireEvent.click(optionButton('Alpha'));
    fireEvent.click(optionButton('Gamma'));

    expect(screen.getByText('Pick several')).toBeTruthy();
    expect(respondQuestion).not.toHaveBeenCalled();
    expect(within(optionButton('Alpha')).queryByText('✓')).toBeNull();
    expect(within(optionButton('Beta')).getByText('✓')).toBeTruthy();
    expect(within(optionButton('Gamma')).getByText('✓')).toBeTruthy();

    fireEvent.click(submit);
    await waitFor(() => {
      expect(respondQuestion).toHaveBeenCalledWith({ 'Pick several': 'Beta, Gamma' });
    });
  });

  it('preserves and edits multi-select answers after going back', async () => {
    renderQuestion([
      makeQuestion('First multi', ['Alpha', 'Beta'], true),
      makeQuestion('Second single', ['Yes', 'No']),
    ]);

    fireEvent.click(optionButton('Alpha'));
    fireEvent.click(optionButton('Beta'));
    expect(screen.getByText('First multi')).toBeTruthy();
    expect(screen.queryByText('Second single')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(within(optionButton('Alpha')).getByText('✓')).toBeTruthy();
    expect(within(optionButton('Beta')).getByText('✓')).toBeTruthy();

    fireEvent.click(optionButton('Alpha'));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(optionButton('No'));

    await waitFor(() => {
      expect(respondQuestion).toHaveBeenCalledWith({
        'First multi': 'Beta',
        'Second single': 'No',
      });
    });
  });

  it('trims and submits a custom single-select answer with Enter', async () => {
    renderQuestion([makeQuestion('Custom single', ['Alpha'])]);
    fireEvent.click(customResponseButton());

    const input = customInput();
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(input, { target: { value: '   ' } });
    expect(send.disabled).toBe(true);

    fireEvent.change(input, { target: { value: '  My answer  ' } });
    expect(send.disabled).toBe(false);
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(respondQuestion).toHaveBeenCalledWith({ 'Custom single': 'My answer' });
    });
  });

  it('adds, deduplicates, and removes custom multi-select answers', async () => {
    renderQuestion([makeQuestion('Custom multi', ['Alpha'], true)]);

    fireEvent.click(customResponseButton());
    fireEvent.change(customInput(), { target: { value: '  Extra  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/Enter your response/)).toBeNull();
    });
    expect(optionButton('Extra')).toBeTruthy();

    fireEvent.click(customResponseButton());
    fireEvent.change(customInput(), { target: { value: 'Extra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/Enter your response/)).toBeNull();
    });
    expect(screen.getAllByText('Extra')).toHaveLength(1);

    fireEvent.click(customResponseButton());
    fireEvent.change(customInput(), { target: { value: 'Alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/Enter your response/)).toBeNull();
    });
    expect(screen.getAllByText('Alpha')).toHaveLength(1);
    expect(within(optionButton('Alpha')).getByText('✓')).toBeTruthy();

    fireEvent.click(optionButton('Extra'));
    expect(screen.queryByText('Extra')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    await waitFor(() => {
      expect(respondQuestion).toHaveBeenCalledWith({ 'Custom multi': 'Alpha' });
    });
  });

  it('ignores Enter during IME composition and closes custom input with Escape', async () => {
    renderQuestion([makeQuestion('Keyboard', ['Alpha'])]);
    fireEvent.click(customResponseButton());

    const input = customInput();
    fireEvent.change(input, { target: { value: '  Draft answer  ' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(respondQuestion).not.toHaveBeenCalled();
    expect(customInput().value).toBe('  Draft answer  ');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByPlaceholderText(/Enter your response/)).toBeNull();

    fireEvent.click(customResponseButton());
    expect(customInput().value).toBe('  Draft answer  ');
    fireEvent.keyDown(customInput(), { key: 'Enter' });

    await waitFor(() => {
      expect(respondQuestion).toHaveBeenCalledWith({ Keyboard: 'Draft answer' });
    });
  });

  it('disables answers and Back while a final single-select submission is pending', async () => {
    const response = createDeferred();
    respondQuestion.mockReturnValue(response.promise);
    renderQuestion([
      makeQuestion('First question', ['Alpha']),
      makeQuestion('Final question', ['Gamma', 'Delta']),
    ]);

    fireEvent.click(optionButton('Alpha'));
    fireEvent.click(optionButton('Delta'));

    const back = screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(optionButton('Gamma').disabled).toBe(true);
    expect(optionButton('Delta').disabled).toBe(true);
    expect(customResponseButton().disabled).toBe(true);

    fireEvent.click(back);
    fireEvent.click(optionButton('Gamma'));
    expect(screen.getByText('Final question')).toBeTruthy();
    expect(respondQuestion).toHaveBeenCalledTimes(1);

    await act(async () => {
      response.resolve();
    });
    expect(back.disabled).toBe(false);
    expect(optionButton('Gamma').disabled).toBe(false);
    expect(customResponseButton().disabled).toBe(false);
  });

  it('disables multi-select and custom controls while a final submission is pending', async () => {
    const response = createDeferred();
    respondQuestion.mockReturnValue(response.promise);
    renderQuestion([
      makeQuestion('First question', ['One']),
      makeQuestion('Final multi', ['Alpha', 'Beta'], true),
    ]);

    fireEvent.click(optionButton('One'));
    fireEvent.click(optionButton('Alpha'));
    fireEvent.click(customResponseButton());
    fireEvent.change(customInput(), { target: { value: 'Draft' } });
    const back = screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement;
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    const submit = screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    fireEvent.click(submit);

    expect(back.disabled).toBe(true);
    expect(optionButton('Alpha').disabled).toBe(true);
    expect(optionButton('Beta').disabled).toBe(true);
    expect(customInput().disabled).toBe(true);
    expect(send.disabled).toBe(true);
    expect(submit.disabled).toBe(true);

    fireEvent.click(submit);
    expect(respondQuestion).toHaveBeenCalledTimes(1);

    await act(async () => {
      response.resolve();
    });
    expect(back.disabled).toBe(false);
    expect(optionButton('Alpha').disabled).toBe(false);
    expect(customInput().disabled).toBe(false);
    expect(send.disabled).toBe(false);
    expect(submit.disabled).toBe(false);
  });

  it('resets navigation, answers, and custom drafts when a new question request arrives', async () => {
    renderQuestion([
      makeQuestion('Old first', ['One']),
      makeQuestion('Old second', ['Two']),
    ], 'old-request');
    fireEvent.click(optionButton('One'));
    expect(screen.getByText('Old second')).toBeTruthy();
    fireEvent.click(customResponseButton());
    fireEvent.change(customInput(), { target: { value: 'Old draft' } });

    act(() => {
      setPendingQuestion([makeQuestion('New first', ['Three'])], 'new-request');
    });
    expect(screen.getByText('New first')).toBeTruthy();
    expect(screen.queryByText('Old second')).toBeNull();
    expect(screen.queryByText('Question 1 of 1')).toBeNull();
    fireEvent.click(customResponseButton());
    expect(customInput().value).toBe('');
    fireEvent.keyDown(customInput(), { key: 'Escape' });

    fireEvent.click(optionButton('Three'));
    await waitFor(() => {
      expect(respondQuestion).toHaveBeenCalledExactlyOnceWith({ 'New first': 'Three' });
    });
  });
});
