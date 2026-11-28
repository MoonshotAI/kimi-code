import {
  Container,
  ProcessTerminal,
  type Component,
  TuiAltScreen,
  VStack,
  type TUI,
} from '@moonshot-ai/pi-tui';

import { TranscriptContainer } from '#/tui/components/messages/transcript-container';
import { TranscriptView } from '#/tui/components/messages/transcript-view';

import { DockSection } from './components/chrome/dock-section';
import { FooterComponent } from './components/chrome/footer';
import { GutterContainer } from './components/chrome/gutter-container';
import type { MoonLoader, SpinnerStyle } from './components/chrome/moon-loader';
import { NotifyPanelComponent } from './components/chrome/notify-panel';
import { BtwPanelComponent } from './components/panes/btw-panel';
import { QueuePaneComponent } from './components/panes/queue-pane';
import type { SessionRow, SessionsScope } from './components/dialogs/session-picker';
import { CustomEditor } from './components/editor/custom-editor';
import { DEFAULT_MARKDOWN_CONFIG, DEFAULT_TUI_CONFIG, resolveWheelScrollLines } from './config';
import { CHROME_GUTTER, DOCK_QUEUE_ROWS, DOCK_UPDATES_ROWS } from './constant/rendering';
import type { TasksBrowserState } from './controllers/tasks-browser';
import { currentTheme, type Theme } from './theme';
import { TuiRendererSession } from './tui-renderer';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type KimiTUIOptions,
  type LivePaneState,
  type QueuedMessage,
  type TranscriptEntry,
  type TUIStartupState,
} from './types';
import {
  setMarkdownAltScreenActive,
  setMarkdownMermaidMode,
  setMarkdownRenderLatex,
  setMarkdownRenderRequester,
} from './utils/markdown-options';
import { createTerminalState, type TerminalState } from './utils/terminal-state';

const EDITOR_SLOT_ENTRY = { shrink: 1, minSize: 3 } as const;

class DockSlotContainer extends VStack {
  private gutter = 0;

  setGutter(gutter: number): void {
    if (this.gutter === gutter) return;
    this.gutter = gutter;
    this.invalidate();
  }

  override render(width: number): string[] {
    if (this.gutter === 0) return super.render(width);
    const inner = Math.max(1, width - this.gutter * 2);
    const lead = ' '.repeat(this.gutter);
    return super.render(inner).map((line) => `${lead}${line}`);
  }
}

export class TuiLayoutShell {
  private readonly footerWrap: GutterContainer;
  private readonly dockSlots: readonly DockSlotContainer[];
  private footerMounted = false;
  private disposeLayoutEffect: (() => void) | undefined;

  constructor(footer: FooterComponent, dockSlots: readonly DockSlotContainer[] = []) {
    this.footerWrap = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
    this.footerWrap.addChild(footer);
    this.dockSlots = dockSlots;
  }

  mount(state: TUIState): void {
    this.disposeLayoutEffect?.();
    this.disposeLayoutEffect = undefined;

    const slotted = editorSlotComponent(state);
    const fullscreen = state.ui instanceof TuiAltScreen;
    setMarkdownAltScreenActive(fullscreen);
    state.footer.setRunningFullscreen(fullscreen);
    state.queuePane.setLayout(fullscreen ? { maxBodyRows: DOCK_QUEUE_ROWS } : undefined);
    state.notifyPanel.setLayout(
      fullscreen
        ? { maxBodyRows: DOCK_UPDATES_ROWS, screenRows: () => state.ui.terminal.rows }
        : undefined,
    );
    for (const child of state.btwPanelContainer.children) {
      if (child instanceof BtwPanelComponent) child.setFullscreen(fullscreen);
    }
    const slotGutter = fullscreen ? 0 : CHROME_GUTTER;
    for (const slot of this.dockSlots) {
      slot.setGutter(slotGutter);
    }

    if (state.ui instanceof TuiAltScreen) {
      const ui = state.ui;
      const fullscreenView = new TranscriptView(state.transcriptContainer);
      const dockContainer = new VStack();
      dockContainer.addChild(state.activityContainer, { shrink: 1, minSize: 0 });
      dockContainer.addChild(state.notifyPanelContainer, { shrink: 1, minSize: 0 });
      const unlessBlocked = (): boolean => !isBlockingPromptPending(state);
      dockContainer.addChild(state.queueContainer, { shrink: 1, minSize: 0, visible: unlessBlocked });
      dockContainer.addChild(state.btwPanelContainer, {
        shrink: 1,
        minSize: 0,
        visible: unlessBlocked,
      });
      dockContainer.addChild(state.surveyContainer, { shrink: 0, minSize: 0 });
      const editorSlot = new VStack();
      editorSlot.addChild(state.editorContainer, EDITOR_SLOT_ENTRY);
      dockContainer.addChild(editorSlot, EDITOR_SLOT_ENTRY);
      if (this.footerMounted) {
        this.attachFooterToDock(dockContainer, state);
      }
      const root = new VStack();
      root.addChild(fullscreenView, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
      root.addChild(dockContainer, { basis: 'auto', grow: 0, shrink: 1, minSize: 1 });
      state.transcriptView = fullscreenView;
      state.dockContainer = dockContainer;
      state.editorSlot = editorSlot;
      if (slotted !== undefined) {
        setEditorSlot(state, slotted);
      }
      ui.clear();
      ui.setLayoutRoot(root);
      this.disposeLayoutEffect = ui.addLayoutEffect(() => {
        if (ui.getLayoutRoot() !== root) return;
        const stickyChanged = fullscreenView.updateStickyMessage();
        const dockOverflowChanged = consumeDockOverflowChange(state);
        if (stickyChanged || dockOverflowChanged) ui.requestRender();
      });
      return;
    }

    state.transcriptView = undefined;
    state.dockContainer = undefined;
    state.editorSlot = undefined;
    if (slotted !== undefined) {
      setEditorSlot(state, slotted);
    }
    state.ui.clear();
    state.ui.addChild(state.transcriptContainer);
    state.ui.addChild(state.activityContainer);
    state.ui.addChild(state.notifyPanelContainer);
    state.ui.addChild(state.queueContainer);
    state.ui.addChild(state.btwPanelContainer);
    state.ui.addChild(state.surveyContainer);
    state.ui.addChild(state.editorContainer);
    if (this.footerMounted) {
      state.ui.addChild(this.footerWrap);
    }
  }

  mountFooter(state: TUIState): void {
    if (this.footerMounted) return;
    this.footerMounted = true;
    const dock = state.dockContainer;
    if (dock === undefined) {
      state.ui.addChild(this.footerWrap);
      return;
    }
    this.attachFooterToDock(dock, state);
  }

  private attachFooterToDock(dock: VStack, state: TUIState): void {
    dock.addChild(this.footerWrap, {
      shrink: 1,
      minSize: 1,
      visible: () => !isBlockingPromptPending(state),
    });
  }
}

export interface TUIState {
  ui: TUI;
  readonly rendererSession: TuiRendererSession;
  readonly layoutShell: TuiLayoutShell;
  terminal: ProcessTerminal;
  transcriptContainer: TranscriptContainer;
  transcriptView?: TranscriptView;
  activityContainer: Container;
  notifyPanelContainer: Container;
  notifyPanel: NotifyPanelComponent;
  queueContainer: Container;
  queuePane: QueuePaneComponent;
  btwPanelContainer: Container;
  surveyContainer: Container;
  editorContainer: Container;
  dockContainer: VStack | undefined;
  editorSlot: VStack | undefined;
  footer: FooterComponent;
  editor: CustomEditor;
  theme: Theme;
  appState: AppState;
  startupState: TUIStartupState;
  livePane: LivePaneState;
  transcriptEntries: TranscriptEntry[];
  terminalState: TerminalState;
  activitySpinner: { instance: MoonLoader; style: SpinnerStyle } | null;
  sessions: SessionRow[];
  loadingSessions: boolean;
  sessionsNextCursor: string | undefined;
  sessionsLoadingMore: boolean;
  sessionsScope: SessionsScope;
  activeDialog:
    | 'session-picker'
    | 'help'
    | 'trust-prompt'
    | 'cache-hint'
    | 'model-switch-confirm'
    | 'goal-start'
    | null;
  editorReplacementMounted: boolean;
  tasksBrowser: TasksBrowserState | undefined;
  externalEditorRunning: boolean;
  queuedMessages: QueuedMessage[];
  queuedMessageDispatchPending: boolean;
  swarmModeEntry: 'manual' | 'task' | undefined;
}

export function createTUIState(options: KimiTUIOptions): TUIState {
  const initialAppState = options.initialAppState;
  const theme = currentTheme;

  const terminal = new ProcessTerminal();
  setMarkdownRenderLatex(initialAppState.renderLatex ?? DEFAULT_TUI_CONFIG.renderLatex ?? true);
  setMarkdownMermaidMode(initialAppState.markdown?.mermaid ?? DEFAULT_MARKDOWN_CONFIG.mermaid);
  const initialMode =
    (options.resolvedTuiMode ?? initialAppState.tuiMode) === 'fullscreen' ? 'fullscreen' : 'regular';
  const rendererSession = new TuiRendererSession({
    terminal,
    initialMode,
    copyOnSelect: (initialAppState.copyOnSelect ?? DEFAULT_TUI_CONFIG.copyOnSelect) !== false,
    wheelScrollLines: resolveWheelScrollLines(initialAppState.wheelScrollLines),
    animationFrameRate: options.animationFrameRate,
  });
  const ui = rendererSession.ui;

  setMarkdownRenderRequester(() => {
    ui.requestRender(true);
  });

  const transcriptContainer = new TranscriptContainer(CHROME_GUTTER, CHROME_GUTTER, ui);
  const activityContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const queueContainer = new DockSlotContainer();
  const queuePane = new QueuePaneComponent();
  const notifyPanelContainer = new DockSlotContainer();
  const notifyPanel = new NotifyPanelComponent();
  const btwPanelContainer = new DockSlotContainer();
  const surveyContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editorContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editor = new CustomEditor(ui, {
    disablePasteBurst: initialAppState.disablePasteBurst ?? DEFAULT_TUI_CONFIG.disablePasteBurst,
  });
  const footer = new FooterComponent(
    { ...initialAppState },
    () => {
      ui.requestRender();
    },
    initialMode === 'fullscreen',
  );
  const layoutShell = new TuiLayoutShell(footer, [
    notifyPanelContainer,
    queueContainer,
    btwPanelContainer,
  ]);

  const state: TUIState = {
    ui,
    rendererSession,
    layoutShell,
    terminal,
    transcriptContainer,
    transcriptView: undefined,
    activityContainer,
    notifyPanelContainer,
    notifyPanel,
    queueContainer,
    queuePane,
    btwPanelContainer,
    surveyContainer,
    editorContainer,
    dockContainer: undefined,
    editorSlot: undefined,
    editor,
    footer,
    theme,
    appState: { ...initialAppState },
    startupState: 'pending',
    livePane: { ...INITIAL_LIVE_PANE },
    transcriptEntries: [],
    terminalState: createTerminalState(),
    activitySpinner: null,
    sessions: [],
    loadingSessions: false,
    sessionsNextCursor: undefined,
    sessionsLoadingMore: false,
    sessionsScope: 'cwd',
    activeDialog: null,
    editorReplacementMounted: false,
    tasksBrowser: undefined,
    externalEditorRunning: false,
    queuedMessages: [],
    queuedMessageDispatchPending: false,
    swarmModeEntry: undefined,
  };
  layoutShell.mount(state);
  return state;
}

export function mountFooter(state: TUIState): void {
  state.layoutShell.mountFooter(state);
}

export function setEditorSlot(
  state: Pick<TUIState, 'editorContainer' | 'editorSlot'>,
  component: Component,
): void {
  const { editorContainer, editorSlot } = state;
  editorContainer.clear();
  if (editorSlot === undefined) {
    editorContainer.addChild(component);
    return;
  }
  editorSlot.clear();
  if (component instanceof DockSection && component.layout !== undefined) {
    editorSlot.addChild(component, EDITOR_SLOT_ENTRY);
    return;
  }
  editorContainer.addChild(component);
  editorSlot.addChild(editorContainer, EDITOR_SLOT_ENTRY);
}

export function editorSlotComponent(
  state: Pick<TUIState, 'editorContainer' | 'editorSlot'>,
): Component | undefined {
  const slotted = state.editorSlot?.children[0];
  return slotted === undefined || slotted === state.editorContainer
    ? state.editorContainer.children[0]
    : slotted;
}

export function isBlockingPromptPending(state: Pick<TUIState, 'livePane' | 'activeDialog'>): boolean {
  return (
    state.livePane.pendingApproval !== null ||
    state.livePane.pendingQuestion !== null ||
    state.activeDialog === 'goal-start'
  );
}

function consumeDockOverflowChange(
  state: Pick<
    TUIState,
    'notifyPanel' | 'queuePane' | 'btwPanelContainer' | 'editorContainer' | 'editorSlot'
  >,
): boolean {
  let changed = state.notifyPanel.consumeOverflowChange();
  if (state.queuePane.consumeOverflowChange()) changed = true;
  for (const child of state.btwPanelContainer.children) {
    if (child instanceof BtwPanelComponent && child.consumeOverflowChange()) changed = true;
  }
  const active = editorSlotComponent(state);
  if (active instanceof DockSection && active.consumeOverflowChange()) changed = true;
  return changed;
}
