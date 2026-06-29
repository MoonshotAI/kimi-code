import {
  Container,
  ProcessTerminal,
  TUI,
} from '@earendil-works/pi-tui';

import { FooterComponent } from './components/chrome/footer';
import { GutterContainer } from './components/chrome/gutter-container';
import type { MoonLoader, SpinnerStyle } from './components/chrome/moon-loader';
import { TodoPanelComponent } from './components/chrome/todo-panel';
import type { SessionRow } from './components/dialogs/session-picker';
import { CustomEditor } from './components/editor/custom-editor';
import { CHROME_GUTTER } from './constant/rendering';
import type { TasksBrowserState } from './controllers/tasks-browser';
import { currentTheme, type Theme } from './theme';
import { createTerminalState, type TerminalState } from './utils/terminal-state';
import {
  INITIAL_LIVE_PANE,
  type AppState,
  type KimiTUIOptions,
  type LivePaneState,
  type QueuedMessage,
  type TranscriptEntry,
  type TUIStartupState,
} from './types';

export interface TUIState {
  ui: TUI;
  terminal: ProcessTerminal;
  transcriptContainer: Container;
  activityContainer: Container;
  todoPanelContainer: Container;
  todoPanel: TodoPanelComponent;
  queueContainer: Container;
  btwPanelContainer: Container;
  editorContainer: Container;
  footer: FooterComponent;
  editor: CustomEditor;
  theme: Theme;
  appState: AppState;
  startupState: TUIStartupState;
  livePane: LivePaneState;
  transcriptEntries: TranscriptEntry[];
  terminalState: TerminalState;
  activitySpinner: { instance: MoonLoader; style: SpinnerStyle } | null;
  toolOutputExpanded: boolean;
  sessions: SessionRow[];
  loadingSessions: boolean;
  sessionsScope: 'cwd' | 'all';
  activeDialog: 'session-picker' | 'help' | null;
  tasksBrowser: TasksBrowserState | undefined;
  externalEditorRunning: boolean;
  queuedMessages: QueuedMessage[];
  swarmModeEntry: 'manual' | 'task' | undefined;
}

export function createTUIState(options: KimiTUIOptions): TUIState {
  const initialAppState = options.initialAppState;
  const theme = currentTheme;

  const terminal = new ProcessTerminal();
  const ui = new TUI(terminal);

  const transcriptContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const activityContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const todoPanel = new TodoPanelComponent();
  const queueContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const btwPanelContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editorContainer = new GutterContainer(CHROME_GUTTER, CHROME_GUTTER);
  const editor = new CustomEditor(ui);
  const footer = new FooterComponent({ ...initialAppState }, () => {
    ui.requestRender();
  });

  return {
    ui,
    terminal,
    transcriptContainer,
    activityContainer,
    todoPanelContainer,
    todoPanel,
    queueContainer,
    btwPanelContainer,
    editorContainer,
    editor,
    footer,
    theme,
    appState: { ...initialAppState },
    startupState: 'pending',
    livePane: { ...INITIAL_LIVE_PANE },
    transcriptEntries: [],
    terminalState: createTerminalState(),
    activitySpinner: null,
    toolOutputExpanded: false,
    sessions: [],
    loadingSessions: false,
    sessionsScope: 'cwd',
    activeDialog: null,
    tasksBrowser: undefined,
    externalEditorRunning: false,
    queuedMessages: [],
    swarmModeEntry: undefined,
  };
}
