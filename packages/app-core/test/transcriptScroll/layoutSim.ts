import {
  createDomScrollAdapter,
  createScrollController,
  LayoutModel,
  RowHeightCache,
  type ResizeEntryLike,
  type ResizeObserverLike,
  type ScrollController,
  type ScrollOptions,
  type ScrollWriteReason,
  type TranscriptLayout,
} from '../../src/lib/transcriptScroll';

export interface SimBlock {
  key: string;
  height?: number;
  children?: number[];
}

export interface SimRow {
  key: string;
  gap?: number;
  height?: number;
  blocks?: SimBlock[];
  mounted?: boolean;
  kind?: string;
  estimate?: number;
}

export interface SimOptions {
  rows: SimRow[];
  viewport?: number;
  width?: number;
  tail?: number;
  dock?: number;
  clientTop?: number;
  listTop?: number;
  controller?: Partial<ScrollOptions>;
}

type Box = { top: number; height: number };

export const DOCK_GAP = 48;

class FakeResizeObserver implements ResizeObserverLike {
  readonly observed = new Map<Element, { block: number; inline: number } | null>();
  constructor(readonly callback: (entries: readonly ResizeEntryLike[]) => void) {}
  observe(target: Element): void {
    this.observed.set(target, null);
  }
  unobserve(target: Element): void {
    this.observed.delete(target);
  }
  disconnect(): void {
    this.observed.clear();
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blockHeight(block: SimBlock): number {
  return block.children ? block.children.reduce((sum, h) => sum + h, 0) : block.height ?? 0;
}

function rowHeight(row: SimRow): number {
  return (row.gap ?? 0) + (row.blocks ? row.blocks.reduce((sum, b) => sum + blockHeight(b), 0) : row.height ?? 0);
}

export class LayoutSim {
  readonly scroller: HTMLElement;
  readonly list: HTMLElement;
  readonly tailEl: HTMLElement;
  readonly dockEl: HTMLElement;
  readonly contentEl: HTMLElement;
  contentWidth: number | null = null;
  readonly model: LayoutModel;
  readonly controller: ScrollController;
  rows: SimRow[];
  viewport: number;
  width: number;
  tail: number;
  dock: number;
  fontScale = 'medium';
  reducedMotion = false;
  clock = 0;
  readonly clientTop: number;
  readonly listTop: number;
  writes: Array<{ top: number; reason: ScrollWriteReason }> = [];
  writesPerCallback: number[] = [];
  callbacks = 0;
  assignments = 0;
  private raw = 0;
  private dispatchedTop = 0;
  private bottomPadding = DOCK_GAP;
  private ro!: FakeResizeObserver;
  private frames = new Map<number, () => void>();
  private nextFrame = 1;
  private readonly rowEls = new Map<string, HTMLElement>();
  private spacers = new Map<string, number>();
  private boxes = new Map<Element, Box>();
  private dirty = true;

  constructor(options: SimOptions) {
    this.rows = options.rows.map(row => ({ ...row, blocks: row.blocks?.map(b => ({ ...b, children: b.children?.slice() })) }));
    this.viewport = options.viewport ?? 400;
    this.width = options.width ?? 800;
    this.tail = options.tail ?? 0;
    this.dock = options.dock ?? 0;
    this.clientTop = options.clientTop ?? 40;
    this.listTop = options.listTop ?? 0;
    this.scroller = document.createElement('div');
    this.list = document.createElement('div');
    this.tailEl = document.createElement('div');
    this.dockEl = document.createElement('div');
    this.contentEl = document.createElement('div');
    this.scroller.append(this.list, this.tailEl, this.contentEl);
    document.body.replaceChildren(this.scroller, this.dockEl);
    this.stubScroller();
    for (const el of [this.list, this.tailEl, this.dockEl]) this.stubRect(el);
    this.model = new LayoutModel({ scope: 's', cache: new RowHeightCache() });
    this.syncModel();
    for (const row of this.rows) if (row.mounted !== false) this.createRow(row);
    this.orderDom();
    const adapter = createDomScrollAdapter({
      scroller: this.scroller,
      model: this.model,
      list: () => this.list,
      applyLayout: layout => this.applyLayout(layout),
    });
    this.controller = createScrollController(adapter, {
      createResizeObserver: callback => (this.ro = new FakeResizeObserver(callback)),
      requestFrame: callback => {
        const id = this.nextFrame++;
        this.frames.set(id, callback);
        return id;
      },
      cancelFrame: id => {
        this.frames.delete(id);
      },
      now: () => this.clock,
      reducedMotion: () => this.reducedMotion,
      fontScale: () => this.fontScale,
      supportsScrollEnd: true,
      onWrite: (top, reason) => this.writes.push({ top, reason }),
      ...options.controller,
    });
    for (const row of this.rows) {
      const el = this.rowEls.get(row.key);
      if (el) this.controller.observeRow(row.key, el);
    }
    this.controller.observeAux('tail', this.tailEl);
    this.controller.observeAux('dock', this.dockEl);
    this.frame();
  }

  get scrollTop(): number {
    return this.scroller.scrollTop;
  }

  get maxTop(): number {
    return Math.max(0, this.scrollHeight - this.viewport);
  }

  get scrollHeight(): number {
    this.layout();
    return this.contentHeight();
  }

  distanceFromBottom(): number {
    return this.maxTop - this.scrollTop;
  }

  rowEl(key: string): HTMLElement {
    return this.rowEls.get(key)!;
  }

  blockEl(key: string, block: string): HTMLElement {
    return this.rowEl(key).querySelector<HTMLElement>(`[data-block-key="${block}"]`)!;
  }

  childEl(key: string, block: string, index: number): HTMLElement {
    return this.blockEl(key, block).querySelector('.markdown-renderer')!.children[index] as HTMLElement;
  }

  visualTop(el: Element): number {
    return el.getBoundingClientRect().top - this.clientTop;
  }

  docTop(el: Element): number {
    this.layout();
    return this.boxes.get(el)!.top;
  }

  rowDocTop(key: string): number {
    this.layout();
    let top = this.listTop;
    for (const row of this.rows) {
      if (row.key === key) return top;
      top += this.occupied(row);
    }
    return top;
  }

  userScroll(top: number): void {
    this.raw = Math.min(Math.max(0, top), this.maxTop);
    this.dirty = true;
  }

  frame(ms = 16): void {
    this.clock += ms;
    this.dispatchScroll();
    const pending = [...this.frames.entries()];
    this.frames.clear();
    for (const [, callback] of pending) callback();
    this.flushResize();
  }

  hasPendingFrame(): boolean {
    return this.frames.size > 0;
  }

  dispatchScroll(): void {
    const top = this.scroller.scrollTop;
    if (top === this.dispatchedTop) return;
    this.dispatchedTop = top;
    this.controller.onScroll();
  }

  flushResize(): void {
    for (let pass = 0; pass < 8; pass++) {
      const entries: ResizeEntryLike[] = [];
      for (const [target, last] of this.ro.observed) {
        const size = this.sizeOf(target);
        if (last && last.block === size.block && last.inline === size.inline) continue;
        this.ro.observed.set(target, size);
        entries.push({
          target,
          borderBoxSize: [{ blockSize: size.block, inlineSize: size.inline }],
          contentBoxSize: [{ blockSize: size.block, inlineSize: size.inline }],
          contentRect: { width: size.inline, height: size.block },
        });
      }
      if (!entries.length) return;
      const before = this.writes.length;
      this.callbacks++;
      this.ro.callback(entries);
      this.writesPerCallback.push(this.writes.length - before);
    }
    throw new Error('resize loop');
  }

  setRowHeight(key: string, height: number): void {
    this.row(key).height = height;
    this.dirty = true;
  }

  setBlockHeight(key: string, block: string, height: number): void {
    this.block(key, block).height = height;
    this.dirty = true;
  }

  setChildHeight(key: string, block: string, index: number, height: number): void {
    this.block(key, block).children![index] = height;
    this.dirty = true;
  }

  insertRows(index: number, rows: SimRow[]): void {
    this.rows.splice(index, 0, ...rows);
    this.syncModel();
    for (const row of rows) if (row.mounted !== false) this.createRow(row);
    this.orderDom();
    for (const row of rows) {
      const el = this.rowEls.get(row.key);
      if (el) this.controller.observeRow(row.key, el);
    }
  }

  removeRow(key: string): void {
    this.rows = this.rows.filter(row => row.key !== key);
    const el = this.rowEls.get(key);
    this.rowEls.delete(key);
    el?.remove();
    this.controller.observeRow(key, null);
    this.syncModel();
  }

  unmount(key: string): void {
    const row = this.row(key);
    row.mounted = false;
    const el = this.rowEls.get(key);
    this.rowEls.delete(key);
    el?.remove();
    this.controller.observeRow(key, null);
    this.dirty = true;
  }

  mount(key: string): void {
    const row = this.row(key);
    row.mounted = true;
    this.createRow(row);
    this.orderDom();
    this.controller.observeRow(key, this.rowEls.get(key)!);
  }

  replaceMarkdown(key: string, block: string): void {
    const renderer = this.blockEl(key, block).querySelector('.markdown-renderer')!;
    const children = this.block(key, block).children!.map(() => {
      const child = document.createElement('div');
      this.stubRect(child);
      return child;
    });
    renderer.replaceChildren(...children);
    this.dirty = true;
  }

  setViewport(height: number): void {
    this.viewport = height;
    this.dirty = true;
  }

  setDock(height: number): void {
    this.dock = height;
    this.dirty = true;
  }

  setTail(height: number): void {
    this.tail = height;
    this.dirty = true;
  }

  setWidth(width: number): void {
    this.width = width;
    this.dirty = true;
  }

  private row(key: string): SimRow {
    return this.rows.find(row => row.key === key)!;
  }

  private block(key: string, block: string): SimBlock {
    return this.row(key).blocks!.find(b => b.key === block)!;
  }

  private syncModel(): void {
    this.model.setRows(this.rows.map(row => ({ key: row.key, estimate: row.estimate ?? 100, kind: row.kind })));
    this.spacers = new Map(this.rows.map((row, index) => [row.key, this.spacers.get(row.key) ?? this.model.height(index)]));
    this.dirty = true;
  }

  private applyLayout(layout: TranscriptLayout): void {
    this.bottomPadding = layout.dockHeight + DOCK_GAP;
    this.spacers = new Map(this.rows.map((row, index) => [row.key, this.model.height(index)]));
    this.dirty = true;
  }

  private occupied(row: SimRow): number {
    return row.mounted === false ? this.spacers.get(row.key) ?? 0 : rowHeight(row);
  }

  private contentHeight(): number {
    let height = this.listTop;
    for (const row of this.rows) height += this.occupied(row);
    return height + this.tail + this.bottomPadding;
  }

  private sizeOf(target: Element): { block: number; inline: number } {
    if (!target.isConnected) return { block: 0, inline: 0 };
    if (target === this.scroller) return { block: this.viewport, inline: this.width };
    if (target === this.dockEl) return { block: this.dock, inline: this.width };
    if (target === this.contentEl) return { block: 0, inline: this.contentWidth ?? this.width };
    this.layout();
    return { block: this.boxes.get(target)?.height ?? 0, inline: this.width };
  }

  private layout(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const boxes = new Map<Element, Box>();
    let top = this.listTop;
    for (const row of this.rows) {
      const el = this.rowEls.get(row.key);
      const height = this.occupied(row);
      if (el) {
        boxes.set(el, { top, height });
        let blockTop = top + (row.gap ?? 0);
        for (const block of row.blocks ?? []) {
          const blockEl = el.querySelector(`[data-block-key="${block.key}"]`)!;
          const bh = blockHeight(block);
          boxes.set(blockEl, { top: blockTop, height: bh });
          const renderer = blockEl.querySelector('.markdown-renderer');
          if (renderer && block.children) {
            boxes.set(renderer, { top: blockTop, height: bh });
            let childTop = blockTop;
            block.children.forEach((ch, i) => {
              const child = renderer.children[i];
              if (child) boxes.set(child, { top: childTop, height: ch });
              childTop += ch;
            });
          }
          blockTop += bh;
        }
      }
      top += height;
    }
    boxes.set(this.list, { top: this.listTop, height: top - this.listTop });
    boxes.set(this.tailEl, { top, height: this.tail });
    this.boxes = boxes;
  }

  private createRow(row: SimRow): void {
    const el = document.createElement('div');
    el.dataset['rowKey'] = row.key;
    this.stubRect(el);
    for (const block of row.blocks ?? []) {
      const blockEl = document.createElement('div');
      blockEl.dataset['blockKey'] = block.key;
      this.stubRect(blockEl);
      if (block.children) {
        const renderer = document.createElement('div');
        renderer.className = 'markdown-renderer';
        this.stubRect(renderer);
        for (const _ of block.children) {
          const child = document.createElement('div');
          this.stubRect(child);
          renderer.append(child);
        }
        blockEl.append(renderer);
      }
      el.append(blockEl);
    }
    this.rowEls.set(row.key, el);
    this.dirty = true;
  }

  private orderDom(): void {
    this.list.replaceChildren(...this.rows.flatMap(row => this.rowEls.get(row.key) ?? []));
    this.dirty = true;
  }

  private stubRect(el: Element): void {
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        this.layout();
        const box = this.boxes.get(el) ?? { top: 0, height: 0 };
        const top = this.clientTop + box.top - this.scroller.scrollTop;
        return { top, bottom: top + box.height, height: box.height, left: 0, right: this.width, width: this.width, x: 0, y: top, toJSON() {} } as DOMRect;
      },
    });
  }

  private stubScroller(): void {
    Object.defineProperties(this.scroller, {
      scrollTop: {
        configurable: true,
        get: () => {
          const max = this.maxTop;
          if (this.raw > max) this.raw = max;
          return this.raw;
        },
        set: (value: number) => {
          this.assignments++;
          this.raw = Math.min(Math.max(0, value), this.maxTop);
        },
      },
      scrollHeight: { configurable: true, get: () => this.scrollHeight },
      clientHeight: { configurable: true, get: () => this.viewport },
      clientWidth: { configurable: true, get: () => this.width },
      offsetWidth: { configurable: true, get: () => this.width + 10 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: this.clientTop, bottom: this.clientTop + this.viewport, height: this.viewport, left: 0, right: this.width + 10, width: this.width + 10, x: 0, y: this.clientTop, toJSON() {} }) as DOMRect,
      },
    });
  }
}

export function textRows(count: number, height = 100, prefix = 'r'): SimRow[] {
  return Array.from({ length: count }, (_, i) => ({ key: `${prefix}${i}`, height }));
}

export function blockRows(count: number, prefix = 'r'): SimRow[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `${prefix}${i}`,
    gap: 8,
    blocks: [
      { key: 'head', height: 30 },
      { key: 'md', children: [40, 60, 80, 40] },
      { key: 'foot', height: 20 },
    ],
  }));
}
