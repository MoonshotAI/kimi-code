import { buildSwarmPrompt, handleSwarmCommand } from '#/tui/commands/swarm';
import { describe, expect, it, vi } from 'vitest';

describe('buildSwarmPrompt', () => {
  it('frames the task to force the Swarm tool', () => {
    const p = buildSwarmPrompt('compare three libraries');
    expect(p).toContain('Swarm');
    expect(p).toContain('compare three libraries');
  });
});

describe('handleSwarmCommand', () => {
  it('errors when there is no active session', async () => {
    const showError = vi.fn();
    await handleSwarmCommand({ session: undefined, showError } as never, 'do it');
    expect(showError).toHaveBeenCalled();
  });

  it('errors when args are empty', async () => {
    const showError = vi.fn();
    const prompt = vi.fn();
    await handleSwarmCommand({ session: { prompt }, showError } as never, '   ');
    expect(showError).toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('sends a framed prompt to the session', async () => {
    const prompt = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    const showError = vi.fn();
    const beginSessionRequest = vi.fn();
    const failSessionRequest = vi.fn();
    const appendUserTranscriptEntry = vi.fn();
    await handleSwarmCommand(
      {
        session: { prompt },
        showError,
        beginSessionRequest,
        failSessionRequest,
        appendUserTranscriptEntry,
      } as never,
      'compare libs',
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(String(prompt.mock.calls[0]?.[0])).toContain('compare libs');
  });

  it('begins the session request before prompting so a follow-up cannot race the swarm turn', async () => {
    const prompt = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    const showError = vi.fn();
    const beginSessionRequest = vi.fn();
    const failSessionRequest = vi.fn();
    const appendUserTranscriptEntry = vi.fn();
    await handleSwarmCommand(
      {
        session: { prompt },
        showError,
        beginSessionRequest,
        failSessionRequest,
        appendUserTranscriptEntry,
      } as never,
      'compare libs',
    );
    expect(beginSessionRequest).toHaveBeenCalledTimes(1);
    // The streamingPhase must flip out of 'idle' BEFORE the prompt is dispatched,
    // otherwise the input gate stays open during turn startup.
    expect(beginSessionRequest.mock.invocationCallOrder[0]).toBeLessThan(
      prompt.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(failSessionRequest).not.toHaveBeenCalled();
  });

  it('appends the user request to the transcript before prompting', async () => {
    const prompt = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    const showError = vi.fn();
    const beginSessionRequest = vi.fn();
    const failSessionRequest = vi.fn();
    const appendUserTranscriptEntry = vi.fn();
    await handleSwarmCommand(
      {
        session: { prompt },
        showError,
        beginSessionRequest,
        failSessionRequest,
        appendUserTranscriptEntry,
      } as never,
      'compare libs',
    );
    // The user's command must appear in the live transcript (as the readable
    // "/swarm <task>", not the verbose internal wrapper), before the turn starts.
    expect(appendUserTranscriptEntry).toHaveBeenCalledTimes(1);
    expect(String(appendUserTranscriptEntry.mock.calls[0]?.[0])).toBe('/swarm compare libs');
    expect(appendUserTranscriptEntry.mock.invocationCallOrder[0]).toBeLessThan(
      beginSessionRequest.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('fails the session request when the prompt rejects', async () => {
    const prompt = vi.fn<(text: string) => Promise<void>>(async () => {
      throw new Error('boom');
    });
    const showError = vi.fn();
    const beginSessionRequest = vi.fn();
    const failSessionRequest = vi.fn();
    const appendUserTranscriptEntry = vi.fn();
    await handleSwarmCommand(
      {
        session: { prompt },
        showError,
        beginSessionRequest,
        failSessionRequest,
        appendUserTranscriptEntry,
      } as never,
      'compare libs',
    );
    expect(beginSessionRequest).toHaveBeenCalledTimes(1);
    expect(failSessionRequest).toHaveBeenCalledTimes(1);
    expect(String(failSessionRequest.mock.calls[0]?.[0])).toContain('boom');
  });
});
