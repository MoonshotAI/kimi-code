import { ScrollView, VStack, type Component, type TuiMouseEvent } from '@moonshot-ai/pi-tui';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { StickyUserMessageComponent } from '#/tui/components/messages/sticky-user-message';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { StickyUserMessageIndex } from '#/tui/utils/sticky-user-message';

export class TranscriptView extends VStack {
  private readonly scrollView: ScrollView;
  private readonly pill: StickyUserMessageComponent;
  private readonly messages = new StickyUserMessageIndex();
  private paddingTop = 1;

  constructor(private readonly transcript: GutterContainer) {
    super();
    let cachedBody: string[] | undefined;
    let paddedBody: string[] | undefined;
    const content = {
      children: [transcript],
      render: (width: number) => {
        const lines = transcript.render(width);
        if (cachedBody !== lines) {
          cachedBody = lines;
          paddedBody = undefined;
        }
        if (this.paddingTop === 0) return lines;
        return (paddedBody ??= ['', ...lines]);
      },
      invalidate: () => {
        transcript.invalidate();
      },
      handleMouse: (event: TuiMouseEvent) => {
        if (event.y < this.paddingTop) return undefined;
        return transcript.handleMouse({
          ...event,
          y: event.y - this.paddingTop,
          height: event.height - this.paddingTop,
        });
      },
    } satisfies Component & { children: Component[] };
    this.scrollView = new ScrollView(content, {
      follow: 'end',
      primary: true,
      overscroll: 'chain',
      scrollbar: 'auto',
    });
    this.pill = new StickyUserMessageComponent((y) => {
      this.scrollView.scrollTo(y);
    });
    const pillContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    pillContainer.addChild(this.pill);
    this.addChild(pillContainer, { shrink: 0, minSize: 0 });
    this.addChild(this.scrollView, { basis: 0, grow: 1, shrink: 1, minSize: 0 });
  }

  updateStickyMessage(): boolean {
    const layout = this.transcript.getRenderedLayout();
    if (!layout) return false;
    const height = this.scrollView.viewportHeight + (this.paddingTop === 0 ? 1 : 0);
    const judgment =
      height < 2
        ? null
        : this.messages.getJudgment(
            layout,
            this.scrollView.scrollTop,
            this.scrollView.isFollowingEnd,
          );
    this.paddingTop = judgment === null ? 1 : 0;
    return this.pill.setJudgment(judgment);
  }
}
