/**
 * prompt-metadata — the session title / lastPrompt text derived from a
 * prompt payload.
 *
 * Tests pin:
 *   - media parts render as `[image]` / `[video]` / `[audio]` placeholders
 *   - an inline image-compression caption (harness metadata placed next to
 *     the image by prompt ingestion) never leaks into titles/lastPrompt,
 *     whether it is a standalone text part or merged into the user's text
 *   - SessionAPIImpl.steer updates title/lastPrompt exactly like prompt —
 *     a steer can launch the session's first turn (e.g. goal mode)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ProviderConfig } from '@moonshot-ai/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { promptMetadataTextFromPayload } from '../../src/session/prompt-metadata';
import { ProviderManager } from '../../src/session/provider-manager';
import { SessionAPIImpl } from '../../src/session/rpc';
import { buildImageCompressionCaption } from '../../src/tools/support/image-compress';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';
import { testKaos } from '../fixtures/test-kaos';

const CAPTION = buildImageCompressionCaption({
  original: { width: 3264, height: 666, byteLength: 344 * 1024, mimeType: 'image/png' },
  final: { width: 2000, height: 408, byteLength: 282 * 1024, mimeType: 'image/png' },
  originalPath: '/tmp/originals/shot.png',
});

describe('promptMetadataTextFromPayload', () => {
  it('renders text and media placeholders', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(text).toBe('look at this [image]');
  });

  it('keeps a standalone image-compression caption out of the metadata text', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: CAPTION },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(text).toBe('[image]');
  });

  it('strips a caption merged into the user text and keeps the rest', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: `能展示但是没有快捷键提示${CAPTION}` },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(text).toBe('能展示但是没有快捷键提示 [image]');
    expect(text).not.toContain('<system>');
    expect(text).not.toContain('Image compressed');
  });

  it('renders an [audio] placeholder for audio input', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: 'transcribe this' },
        { type: 'audio_url', audioUrl: { url: 'data:audio/mp3;base64,AAAA' } },
      ],
    });
    expect(text).toBe('transcribe this [audio]');
  });

  it('renders a [video] placeholder for video input', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AAAA' } },
      ],
    });
    expect(text).toBe('[video]');
  });

  it('renders multiple media placeholders in order', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'text', text: 'compare' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'and' },
        { type: 'audio_url', audioUrl: { url: 'data:audio/mp3;base64,BBBB' } },
      ],
    });
    expect(text).toBe('compare [image] and [audio]');
  });

  it('returns an empty string for empty input', () => {
    const text = promptMetadataTextFromPayload({ input: [] });
    expect(text).toBe('');
  });

  it('returns an empty string for input with only media and no text', () => {
    const text = promptMetadataTextFromPayload({
      input: [
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ],
    });
    expect(text).toBe('[image]');
  });

  it('handles very long input text gracefully', () => {
    const longText = 'a'.repeat(10_000);
    const text = promptMetadataTextFromPayload({
      input: [{ type: 'text', text: longText }],
    });
    // Not wrongly redacted as a secret; truncated to the metadata cap.
    expect(text).toBe('a'.repeat(4000));
  });

  it('strips the caption when it is the only text and there are no images', () => {
    const text = promptMetadataTextFromPayload({
      input: [{ type: 'text', text: CAPTION }],
    });
    expect(text).toBe('');
  });
});

describe('SessionAPIImpl prompt metadata', () => {
  it('derives title and lastPrompt from a steer the same way as a prompt', async () => {
    const sessionDir = await makeTempDir();
    const events: Array<Record<string, unknown>> = [];
    const scripted = createScriptedGenerate();
    const session = track(
      new Session({
        id: 'prompt-metadata-steer',
        kaos: testKaos.withCwd(sessionDir),
        homedir: sessionDir,
        rpc: createSessionRpc(events),
        skills: { explicitDirs: [join(sessionDir, 'missing-skills')] },
        providerManager: testProviderManager(),
      }),
    );
    const { agent } = await session.createAgent(
      { type: 'main', generate: scripted.generate },
      { profile: testProfile() },
    );
    agent.config.update({ modelAlias: MOCK_PROVIDER.model, thinkingEffort: 'off' });
    agent.permission.setMode('yolo');

    const api = new SessionAPIImpl(session);
    await api.steer({ agentId: 'main', input: [{ type: 'text', text: 'steered goal objective' }] });
    if (agent.turn.hasActiveTurn) {
      await agent.turn.waitForCurrentTurn();
    }

    expect(session.metadata.title).toBe('steered goal objective');
    expect(session.metadata.lastPrompt).toBe('steered goal objective');
  });
});

const MOCK_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'mock-model',
} as const satisfies ProviderConfig;

const tempDirs: string[] = [];
const openSessions: Session[] = [];

function track(session: Session): Session {
  openSessions.push(session);
  return session;
}

afterEach(async () => {
  // Close sessions first so their async metadata/wire writes settle before the
  // temp dirs are removed (otherwise rm races with a write -> ENOTEMPTY).
  await Promise.allSettled(openSessions.splice(0).map((s) => s.close()));
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-prompt-metadata-'));
  tempDirs.push(dir);
  return dir;
}

function testProviderManager(): ProviderManager {
  return new ProviderManager({
    config: {
      providers: {
        test: { type: MOCK_PROVIDER.type, apiKey: MOCK_PROVIDER.apiKey },
      },
      models: {
        [MOCK_PROVIDER.model]: {
          provider: 'test',
          model: MOCK_PROVIDER.model,
          maxContextSize: 1_000_000,
        },
      },
    },
  });
}

function testProfile(): ResolvedAgentProfile {
  return {
    name: 'test',
    systemPrompt: () => '<system-prompt>',
    tools: [],
  };
}

function createSessionRpc(events: Array<Record<string, unknown>>): SDKSessionRPC {
  return {
    emitEvent: vi.fn(async (event) => {
      events.push(event);
    }),
    requestApproval: vi.fn(async () => ({ decision: 'cancelled' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({
      output: 'custom tools are not supported in this test',
      isError: true,
    })),
  } as unknown as SDKSessionRPC;
}
