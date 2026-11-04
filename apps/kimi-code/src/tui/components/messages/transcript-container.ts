import type {
  Component,
  TUI,
  TuiMouseDispatchResult,
  TuiMouseEvent,
  TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import {
  GutterContainer,
  type GutterLayout,
} from '#/tui/components/chrome/gutter-container';
import {
  DEFAULT_TRANSCRIPT_CONFIG,
  transcriptGroupingActive,
  type TranscriptPresentationOptions,
} from '#/tui/config';
import {
  itemText,
  TranscriptGroupComponent,
  type TranscriptGroupInteraction,
} from '#/tui/components/messages/transcript-group';
import { SkillActivationComponent } from '#/tui/components/messages/skill-activation';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import {
  countedByExpandHint,
  hasHiddenContent,
  isExpandable,
  isExpandedComponent,
} from '#/tui/utils/component-capabilities';
import {
  foregroundBashHintAt,
  TranscriptItemInspector,
  transcriptProjectionVersion,
  type LogicalTranscriptItem,
  type TranscriptItem,
} from '#/tui/utils/transcript-items';
import {
  canFoldItem,
  projectTranscript,
  summarizeGroup,
  type GroupProjection,
  type GroupSummary,
  type TranscriptProjection,
} from '#/tui/utils/transcript-projection';
import { isTurnBoundaryComponent } from '#/tui/utils/transcript-turns';
import {
  expandCutoffIndex,
  TRANSCRIPT_EXPAND_TURNS,
} from '#/tui/utils/transcript-window';

export interface TranscriptGroupingHost {
  withScrollAnchor(toggle: () => void): void;
  withBottomAnchor(toggle: () => void, removedLines: number): void;
  viewportRows(): number | undefined;
  track(event: string, properties: Record<string, string | number | boolean>): void;
  foldingChanged(): void;
}

interface GroupSummaryCache {
  readonly members: readonly LogicalTranscriptItem[];
  readonly summary: GroupSummary;
}

interface ProjectionCache {
  readonly sourceVersion: number;
  readonly options: TranscriptPresentationOptions;
  readonly componentVersions: readonly number[];
  readonly projections: readonly TranscriptProjection[];
  readonly viewChildren: readonly Component[];
  readonly viewSourceIndices: readonly number[];
}

export class TranscriptContainer implements Component, TranscriptGroupInteraction {
  private readonly sourceChildren: Component[] = [];
  private readonly gutter: GutterContainer;
  private readonly inspector = new TranscriptItemInspector();
  private groups = new Map<Component, TranscriptGroupComponent>();
  private summaries = new Map<Component, GroupSummaryCache>();
  private expandedGroups = new WeakMap<Component, boolean>();
  private openedMembers = new WeakSet<Component>();
  private options: TranscriptPresentationOptions = {
    ...DEFAULT_TRANSCRIPT_CONFIG,
    fullscreen: false,
  };
  private sourceVersion = 0;
  private projectionCache: ProjectionCache | undefined;
  private globalExpanded = false;
  private turnActive = false;
  private host: TranscriptGroupingHost | undefined;

  constructor(
    leftPad: number,
    rightPad: number,
    private readonly ui: Pick<TUI, 'requestRender' | 'requestAnimationFrame' | 'cancelAnimationFrame'>,
  ) {
    this.gutter = new GutterContainer(leftPad, rightPad);
    this.gutter.setUnhandledClick((index) => this.toggleViewIndex(index));
  }

  get children(): readonly Component[] {
    return this.sourceChildren;
  }

  get toolOutputExpanded(): boolean {
    return this.globalExpanded;
  }

  setHost(host: TranscriptGroupingHost): void {
    this.host = host;
  }

  setPresentationOptions(options: TranscriptPresentationOptions): void {
    if (samePresentation(this.options, options)) return;
    this.options = options;
    if (this.globalExpanded) {
      this.applyGlobalExpansion();
      this.projectionCache = undefined;
    }
    this.ui.requestRender();
    this.host?.foldingChanged();
  }

  setTurnActive(active: boolean): void {
    if (this.turnActive === active) return;
    this.turnActive = active;
    this.projectionCache = undefined;
    this.ui.requestRender();
  }

  addChild(child: Component): void {
    this.sourceChildren.push(child);
    this.initializeChild(child, this.sourceChildren.length - 1);
    this.sourceVersion += 1;
  }

  insertChild(index: number, child: Component): void {
    this.sourceChildren.splice(index, 0, child);
    this.initializeChild(child, index);
    this.sourceVersion += 1;
  }

  replaceChild(previous: Component, replacement: Component): void {
    const index = this.sourceChildren.indexOf(previous);
    if (index < 0) return;
    this.sourceChildren[index] = replacement;
    this.initializeChild(replacement, index);
    this.sourceVersion += 1;
  }

  moveChildToEnd(child: Component): void {
    const index = this.sourceChildren.indexOf(child);
    if (index < 0) return;
    this.sourceChildren.splice(index, 1);
    this.sourceChildren.push(child);
    this.sourceVersion += 1;
  }

  removeChild(child: Component): void {
    const index = this.sourceChildren.indexOf(child);
    if (index < 0) return;
    this.sourceChildren.splice(index, 1);
    this.sourceVersion += 1;
  }

  replaceChildren(children: readonly Component[]): void {
    this.sourceChildren.splice(0, this.sourceChildren.length, ...children);
    this.sourceVersion += 1;
  }

  dispose(): void {
    for (const group of this.groups.values()) group.dispose();
  }

  clear(): void {
    this.dispose();
    this.groups.clear();
    this.summaries.clear();
    this.expandedGroups = new WeakMap();
    this.openedMembers = new WeakSet();
    this.sourceChildren.splice(0);
    this.projectionCache = undefined;
    this.sourceVersion += 1;
    this.gutter.clear();
  }

  invalidate(): void {
    this.gutter.invalidate();
    for (const child of this.sourceChildren) child.invalidate();
  }

  render(width: number): string[] {
    this.ensureProjection();
    return this.gutter.render(width);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    this.ensureProjection();
    return this.gutter.handleMouse(event);
  }

  getRenderedLayout(): GutterLayout | undefined {
    this.ensureProjection();
    return this.gutter.getRenderedLayout();
  }

  toggleGroup(anchor: Component, fromBottom?: { readonly removedLines: number }): void {
    const group = this.ensureProjection().projections.find(
      (projection) => projection.kind === 'group' && projection.anchor === anchor,
    );
    const expanded = !(this.expandedGroups.get(anchor) ?? false);
    const only = group?.kind === 'group' && group.members.length === 1 ? group.members[0].display : undefined;
    const toggle = (): void => {
      this.expandedGroups.set(anchor, expanded);
      if (isExpandable(only)) only.setExpanded(expanded);
    };
    if (fromBottom !== undefined && this.host !== undefined) {
      this.host.withBottomAnchor(toggle, fromBottom.removedLines);
    } else {
      this.withScrollAnchor(toggle);
    }
    this.projectionCache = undefined;
    this.host?.track('transcript_group_toggle', { expanded });
    this.ui.requestRender();
  }

  toggleRow(item: LogicalTranscriptItem): boolean {
    const display = item.display;
    if (!isExpandable(display)) return false;
    this.withScrollAnchor(() => {
      display.setExpanded(!isExpandedComponent(display));
    });
    this.ui.requestRender();
    return true;
  }

  viewportRows(): number | undefined {
    const rows = this.host?.viewportRows();
    return rows !== undefined && rows > 0 ? rows : undefined;
  }

  toggleToolOutputExpansion(): boolean {
    this.globalExpanded = !this.globalExpanded;
    this.applyGlobalExpansion();
    this.projectionCache = undefined;
    if (transcriptGroupingActive(this.options)) {
      this.host?.track('transcript_expand_all', { expanded: this.globalExpanded });
    }
    this.ui.requestRender();
    this.host?.foldingChanged();
    return this.globalExpanded;
  }

  foldedBashHintAt(): number | undefined {
    if (!transcriptGroupingActive(this.options)) return undefined;
    // projectTranscript always groups a foldable, unopened Bash call. Its command event
    // gives the run a summary, and only running thinking stays outside the group.
    return foregroundBashHintAt(this.sourceChildren, (call) => {
      const [item] = this.inspector.read([call], this.options);
      return item?.kind === 'logical' && canFoldItem(item, this.options) && !this.openedMembers.has(call);
    });
  }

  toolOutputExpandHint(): 'expand' | 'collapse' | null {
    const cache = this.ensureProjection();
    if (this.globalExpanded) {
      return this.hasExpandedContentAnywhere(cache.projections) ? 'collapse' : null;
    }
    const cutoff = this.firstExpandableSourceIndex();
    for (const projection of cache.projections) {
      if (projection.kind === 'group' && projection.sourceIndex >= cutoff) return 'expand';
      for (const item of projectionItems(projection)) {
        if (item.sourceIndex >= cutoff && countedByExpandHint(item.display)) return 'expand';
      }
    }
    return null;
  }

  requestRender(): void {
    this.ui.requestRender();
  }

  requestAnimationFrame(callback: (time: number) => void): number {
    return this.ui.requestAnimationFrame(callback);
  }

  cancelAnimationFrame(handle: number): void {
    this.ui.cancelAnimationFrame(handle);
  }

  private ensureProjection(): ProjectionCache {
    const cached = this.projectionCache;
    const checkComponentVersions = transcriptGroupingActive(this.options);
    if (
      cached !== undefined &&
      cached.sourceVersion === this.sourceVersion &&
      samePresentation(cached.options, this.options) &&
      (!checkComponentVersions || (
        cached.componentVersions.length === this.sourceChildren.length &&
        cached.componentVersions.every((version, index) => {
          const child = this.sourceChildren[index];
          return child !== undefined && version === transcriptProjectionVersion(child);
        })
      ))
    ) {
      return cached;
    }

    const projections = this.project();
    const cutoff = this.firstExpandableSourceIndex();
    const viewChildren: Component[] = [];
    const viewSourceIndices: number[] = [];
    const nextGroups = new Map<Component, TranscriptGroupComponent>();
    const nextSummaries = new Map<Component, GroupSummaryCache>();
    for (const projection of projections) {
      if (projection.kind === 'single') {
        const { item } = projection;
        if (item.display instanceof ThinkingComponent) {
          item.display.setFinishedForm(
            this.isOpenedOutsideGroup(item) ? { kind: 'opened', title: itemText(item) } : { kind: 'standalone' },
          );
        }
        viewChildren.push(item.display);
        viewSourceIndices.push(item.sourceIndex);
        continue;
      }
      let expanded = this.expandedGroups.get(projection.anchor);
      if (expanded === undefined) {
        expanded = this.globalExpanded && projection.sourceIndex >= cutoff;
        this.expandedGroups.set(projection.anchor, expanded);
      }
      const cachedSummary = this.summaries.get(projection.anchor);
      const summary = cachedSummary !== undefined && sameGroupMembers(cachedSummary.members, projection.members)
        ? cachedSummary.summary
        : summarizeGroup(projection.members);
      nextSummaries.set(projection.anchor, { members: projection.members, summary });
      const active = this.isOpen(projection, projections) && projection.external.length === 0;
      const model = {
        anchor: projection.anchor,
        sourceIndex: projection.sourceIndex,
        members: projection.members,
        active,
        expanded,
        summary,
      };
      const group = this.groups.get(projection.anchor) ?? new TranscriptGroupComponent(model, this);
      group.setModel(model);
      nextGroups.set(projection.anchor, group);
      viewChildren.push(group);
      viewSourceIndices.push(projection.sourceIndex);
      for (const external of projection.external) {
        viewChildren.push(external.display);
        viewSourceIndices.push(external.sourceIndex);
      }
    }
    for (const [anchor, group] of this.groups) {
      if (!nextGroups.has(anchor)) group.dispose();
    }
    this.groups = nextGroups;
    this.summaries = nextSummaries;
    this.gutter.clear();
    for (const child of viewChildren) this.gutter.addChild(child);
    this.projectionCache = {
      sourceVersion: this.sourceVersion,
      options: this.options,
      componentVersions: this.sourceChildren.map(transcriptProjectionVersion),
      projections,
      viewChildren,
      viewSourceIndices,
    };
    return this.projectionCache;
  }

  private isOpen(
    projection: GroupProjection,
    projections: readonly TranscriptProjection[],
  ): boolean {
    return this.turnActive && projections.at(-1) === projection;
  }

  private hasExpandedContentAnywhere(projections: readonly TranscriptProjection[]): boolean {
    return projections.some((projection) =>
      (projection.kind === 'group' && this.expandedGroups.get(projection.anchor) === true) ||
      projectionItems(projection).some(
        (item) => isExpandedComponent(item.display) && countedByExpandHint(item.display),
      ));
  }

  private firstExpandableSourceIndex(): number {
    const boundaries: number[] = [];
    for (const [index, child] of this.sourceChildren.entries()) {
      if (!isTurnBoundaryComponent(child)) continue;
      if (child instanceof SkillActivationComponent && child.loadedByModel) continue;
      boundaries.push(index);
    }
    return expandCutoffIndex(this.sourceChildren.length, boundaries, TRANSCRIPT_EXPAND_TURNS);
  }

  private toggleViewIndex(index: number): TuiMouseEventResult | undefined {
    const cache = this.ensureProjection();
    const component = cache.viewChildren[index];
    const sourceIndex = cache.viewSourceIndices[index];
    if (component === undefined || sourceIndex === undefined || !isExpandable(component)) return undefined;
    const openedOutsideGroup = cache.projections.some((projection) =>
      projection.kind === 'single' && projection.item.display === component && this.isOpenedOutsideGroup(projection.item));
    if (!openedOutsideGroup && !hasHiddenContent(component)) return undefined;
    const expanded = !openedOutsideGroup && !isExpandedComponent(component);
    if (expanded && sourceIndex < this.firstExpandableSourceIndex()) return undefined;
    component.setExpanded(expanded);
    if (expanded) this.openedMembers.add(component);
    else {
      this.openedMembers.delete(component);
      this.keepMergedGroupExpanded(component, cache.projections);
    }
    this.projectionCache = undefined;
    this.ui.requestRender();
    this.host?.foldingChanged();
    return { handled: true };
  }

  private isOpenedOutsideGroup(item: TranscriptItem): item is LogicalTranscriptItem {
    return item.kind === 'logical' && this.openedMembers.has(item.display) && canFoldItem(item, this.options);
  }

  private keepMergedGroupExpanded(closed: Component, previous: readonly TranscriptProjection[]): void {
    const merged = this.project().find((projection): projection is GroupProjection =>
      projection.kind === 'group' && projectionItems(projection).some((item) => item.display === closed));
    if (merged === undefined) return;
    const members = new Set(merged.members.map((member) => member.display));
    const absorbedExpanded = previous.some((projection) =>
      projection.kind === 'group' &&
      this.expandedGroups.get(projection.anchor) === true &&
      projection.members.some((member) => members.has(member.display)));
    if (absorbedExpanded) this.expandedGroups.set(merged.anchor, true);
  }

  private project(): readonly TranscriptProjection[] {
    return projectTranscript(
      this.inspector.read(this.sourceChildren, this.options),
      this.options,
      (component) => this.openedMembers.has(component),
    );
  }

  private applyGlobalExpansion(): void {
    const cache = this.ensureProjection();
    const cutoff = this.firstExpandableSourceIndex();
    if (this.globalExpanded) {
      for (const projection of cache.projections) {
        if (projection.kind === 'group') {
          this.expandedGroups.set(projection.anchor, projection.sourceIndex >= cutoff);
        }
      }
    } else {
      this.expandedGroups = new WeakMap();
    }
    const visited = new Set<Component>();
    for (const projection of cache.projections) {
      for (const item of projectionItems(projection)) {
        const component = item.display;
        if (visited.has(component)) continue;
        visited.add(component);
        if (!isExpandable(component)) continue;
        component.setExpanded(this.globalExpanded && item.sourceIndex >= cutoff);
        if (!this.globalExpanded) this.openedMembers.delete(component);
      }
    }
  }

  private initializeChild(child: Component, sourceIndex: number): void {
    if (!isExpandable(child)) return;
    child.setExpanded(this.globalExpanded && sourceIndex >= this.firstExpandableSourceIndex());
  }

  private withScrollAnchor(toggle: () => void): void {
    if (this.host === undefined) {
      toggle();
      return;
    }
    this.host.withScrollAnchor(toggle);
  }
}

function projectionItems(projection: TranscriptProjection): readonly TranscriptItem[] {
  if (projection.kind === 'single') return [projection.item];
  return [...projection.members, ...projection.external];
}

function sameGroupMembers(
  left: readonly LogicalTranscriptItem[],
  right: readonly LogicalTranscriptItem[],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined &&
      item.display === other.display &&
      item.projectionVersion === other.projectionVersion &&
      item.current === other.current;
  });
}

function samePresentation(
  left: TranscriptPresentationOptions,
  right: TranscriptPresentationOptions,
): boolean {
  return left.fullscreen === right.fullscreen &&
    left.groupTools === right.groupTools &&
    left.groupThinking === right.groupThinking;
}
