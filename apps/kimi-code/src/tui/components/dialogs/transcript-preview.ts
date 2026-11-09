import type { Component } from '@moonshot-ai/pi-tui';

import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { TranscriptContainer } from '#/tui/components/messages/transcript-container';
import type { TranscriptConfig } from '#/tui/config';
import { hasDispose } from '#/tui/utils/component-capabilities';

const SAMPLE_FILE = 'src/app.ts';

function sampleTranscript(): Component[] {
  const thinking = new ThinkingComponent('Check how the app starts before changing it.');
  thinking.finalize({ known: true, ms: 3_000 });
  const call = (id: string, name: string, args: Record<string, unknown>, output: string): ToolCallComponent =>
    new ToolCallComponent({ id, name, args }, { tool_call_id: id, output, is_error: false });
  return [
    thinking,
    call('preview-read', 'Read', { path: SAMPLE_FILE }, 'export function start() {}'),
    call('preview-edit', 'Edit', { path: SAMPLE_FILE, old_string: 'start()', new_string: 'start(port = 3000)' }, ''),
    call('preview-bash', 'Bash', { command: 'npm test' }, '12 tests passed'),
  ];
}

class SampleTranscript {
  private readonly children = sampleTranscript();
  private readonly container = new TranscriptContainer(1, 1, {
    requestRender() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
  });
  private rendered: { readonly width: number; readonly lines: readonly string[] } | undefined;

  constructor(transcript: TranscriptConfig) {
    this.container.setPresentationOptions({ ...transcript, fullscreen: true });
    for (const child of this.children) this.container.addChild(child);
  }

  render(width: number): readonly string[] {
    if (this.rendered?.width !== width) {
      const lines = this.container.render(width);
      this.rendered = { width, lines: lines[0]?.trim() === '' ? lines.slice(1) : lines };
    }
    return this.rendered.lines;
  }

  invalidate(): void {
    this.rendered = undefined;
    this.container.invalidate();
  }

  dispose(): void {
    for (const child of this.children) if (hasDispose(child)) child.dispose();
    this.container.dispose();
  }
}

export class TranscriptPreview {
  private readonly samples: ReadonlyMap<string, SampleTranscript>;

  constructor(transcripts: ReadonlyMap<string, TranscriptConfig>) {
    this.samples = new Map(
      [...transcripts].map(([value, transcript]) => [value, new SampleTranscript(transcript)]),
    );
  }

  render(value: string, width: number): readonly string[] {
    return this.samples.get(value)?.render(width) ?? [];
  }

  invalidate(): void {
    for (const sample of this.samples.values()) sample.invalidate();
  }

  dispose(): void {
    for (const sample of this.samples.values()) sample.dispose();
  }
}
