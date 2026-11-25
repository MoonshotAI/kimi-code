import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScrollArea } from '@/components/ui/scroll-area';

describe('VS Code webview ScrollArea focus normalization', () => {
  it('renders ScrollArea viewport without focus-visible rings when Shift or keyboard keys are pressed', () => {
    const { container } = render(
      <ScrollArea>
        <div>Message stream</div>
      </ScrollArea>,
    );
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]');
    expect(viewport).not.toBeNull();
    expect(viewport!.className).toContain('outline-none');
    expect(viewport!.className).not.toContain('focus-visible:ring');
    expect(viewport!.className).not.toContain('focus-visible:outline');
  });
});
