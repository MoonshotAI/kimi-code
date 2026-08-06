// apps/desktop/src/renderer/lib/icons.ts
// Single source of truth for the desktop renderer icons (design-system §02).
//
// Icons come from three collections, all bundled by unplugin-icons at build
// time — only the icons listed below end up in the production bundle:
//   - `~icons/kimi/*` — Kimi Design System icons (24×24 outlined,
//     fill="currentColor"), local SVGs under src/renderer/icons/kimi/ copied
//     from the Kimi design-system icon set and registered as a custom
//     collection in vite.renderer.config.ts. Preferred whenever a Kimi glyph
//     exists for the intent. A few glyphs are filed under their intent rather
//     than the upstream asset name (terminal.svg is the upstream "Code" glyph,
//     mail.svg its "Message" envelope, clock.svg "History", comment.svg backs
//     message, task.svg backs sparkles).
//     dark-mode.svg, add-conversation.svg, left-panel.svg and
//     left-panel-expand.svg are newer designer exports that intentionally
//     diverge from the set's originals — do not overwrite them on the next
//     sync from the icon set.
//   - `~icons/tabler/*` — Tabler Icons (https://tabler.io/icons, MIT); only
//     the right-panel toggle, which the Kimi set does not cover.
//   - `~icons/ri/*` — Remix Icon (https://remixicon.com/, Apache-2.0) for the
//     remaining intents the Kimi set does not cover yet.
// Each icon is imported twice: once as a Vue component (for <Icon name=... />)
// and once as a `?raw` SVG string (for iconSvg() in v-html contexts such as
// lib/toolMeta.ts).
//
// All collections share the 24x24 source grid and follow currentColor; the
// rendered size comes from the size token prop. Colour follows text.
//
// Two consumers share this registry:
//   - the <Icon> Vue component (components/ui/Icon.vue) for template use;
//   - iconSvg() below, for v-html contexts (e.g. lib/toolMeta.ts).

import type { Component } from 'vue';

// Components (Kimi collection) ----------------------------------------------
import KimiAdd from '~icons/kimi/add';
import KimiAddConversation from '~icons/kimi/add-conversation';
import KimiArchive from '~icons/kimi/archive';
import KimiArrowDown from '~icons/kimi/arrow-down';
import KimiArrowLeft from '~icons/kimi/arrow-left';
import KimiArrowRight from '~icons/kimi/arrow-right';
import KimiArrowUp from '~icons/kimi/arrow-up';
import KimiCheck from '~icons/kimi/check';
import KimiChevronDown from '~icons/kimi/chevron-down';
import KimiChevronRight from '~icons/kimi/chevron-right';
import KimiChevronUp from '~icons/kimi/chevron-up';
import KimiClock from '~icons/kimi/clock';
import KimiClose from '~icons/kimi/close';
import KimiCollapse from '~icons/kimi/collapse';
import KimiComment from '~icons/kimi/comment';
import KimiCopy from '~icons/kimi/copy';
import KimiDarkMode from '~icons/kimi/dark-mode';
import KimiDownload from '~icons/kimi/download';
import KimiEdit from '~icons/kimi/edit';
import KimiExpand from '~icons/kimi/expand';
import KimiFile from '~icons/kimi/file';
import KimiFileText from '~icons/kimi/file-text';
import KimiFolder from '~icons/kimi/folder';
import KimiFolderOpen from '~icons/kimi/folder-open';
import KimiAddFolder from '~icons/kimi/folder-plus';
import KimiFollowSystem from '~icons/kimi/follow-system';
import KimiFullAccess from '~icons/kimi/full-access';
import KimiGlobe from '~icons/kimi/globe';
import KimiGrip from '~icons/kimi/grip';
import KimiHand from '~icons/kimi/hand';
import KimiHistogram from '~icons/kimi/histogram';
import KimiImage from '~icons/kimi/image';
import KimiImageFailed from '~icons/kimi/image-failed';
import KimiInfo from '~icons/kimi/info';
import KimiKeyboard from '~icons/kimi/keyboard';
import KimiLeftBar from '~icons/kimi/left-panel';
import KimiLeftPanelExpand from '~icons/kimi/left-panel-expand';
import KimiLightMode from '~icons/kimi/light-mode';
import KimiLink from '~icons/kimi/link';
import KimiList from '~icons/kimi/list';
import KimiMail from '~icons/kimi/mail';
import KimiMinus from '~icons/kimi/minus';
import KimiMicroscope from '~icons/kimi/microscope';
import KimiMore from '~icons/kimi/more';
import KimiMusic from '~icons/kimi/music';
import KimiPause from '~icons/kimi/pause';
import KimiPencil from '~icons/kimi/pencil';
import KimiPlay from '~icons/kimi/play';
import KimiQuestion from '~icons/kimi/question';
import KimiRobot from '~icons/kimi/robot';
import KimiSearch from '~icons/kimi/search';
import KimiSend from '~icons/kimi/send';
import KimiSetting from '~icons/kimi/setting';
import KimiShieldQuestion from '~icons/kimi/shield-question';
import KimiSignIn from '~icons/kimi/sign-in';
import KimiSignOut from '~icons/kimi/sign-out';
import KimiSliders from '~icons/kimi/sliders';
import KimiStop from '~icons/kimi/stop';
import KimiTarget from '~icons/kimi/target';
import KimiTask from '~icons/kimi/task';
import KimiTerminal from '~icons/kimi/terminal';
import KimiThinking from '~icons/kimi/thinking';
import KimiTodo from '~icons/kimi/todo';
import KimiTranslate from '~icons/kimi/translate';
import KimiTrash from '~icons/kimi/trash';
import KimiUndo from '~icons/kimi/undo';
import KimiUser from '~icons/kimi/user';
import KimiWarning from '~icons/kimi/warning';

// Components (Tabler) ---------------------------------------------------------
import TablerSidebarRightCollapse from '~icons/tabler/layout-sidebar-right-collapse';
import TablerPaperclip from '~icons/tabler/paperclip';

// Components (Remix) ---------------------------------------------------------
import RiBracesLine from '~icons/ri/braces-line';
import RiCalendarCloseLine from '~icons/ri/calendar-close-line';
import RiCalendarScheduleLine from '~icons/ri/calendar-schedule-line';
import RiCalendarTodoLine from '~icons/ri/calendar-todo-line';
import RiCodeLine from '~icons/ri/code-line';
import RiEmotionLine from '~icons/ri/emotion-line';
import RiExternalLinkLine from '~icons/ri/external-link-line';
import RiEyeLine from '~icons/ri/eye-line';
import RiEyeOffLine from '~icons/ri/eye-off-line';
import RiFileAddLine from '~icons/ri/file-add-line';
import RiFlashlightLine from '~icons/ri/flashlight-line';
import RiFolderFill from '~icons/ri/folder-fill';
import RiGitForkLine from '~icons/ri/git-fork-line';
import RiGitPullRequestLine from '~icons/ri/git-pull-request-line';
import RiListSettingsLine from '~icons/ri/list-settings-line';
import RiNodeTree from '~icons/ri/node-tree';
import RiPushpinLine from '~icons/ri/pushpin-line';
import RiSortDesc from '~icons/ri/sort-desc';
import RiStarFill from '~icons/ri/star-fill';
import RiStarLine from '~icons/ri/star-line';
import RiToolsLine from '~icons/ri/tools-line';
import RiUnpinLine from '~icons/ri/unpin-line';

// Raw SVG strings (Kimi collection) -----------------------------------------
import RawKimiAdd from '~icons/kimi/add?raw';
import RawKimiAddConversation from '~icons/kimi/add-conversation?raw';
import RawKimiArchive from '~icons/kimi/archive?raw';
import RawKimiArrowDown from '~icons/kimi/arrow-down?raw';
import RawKimiArrowLeft from '~icons/kimi/arrow-left?raw';
import RawKimiArrowRight from '~icons/kimi/arrow-right?raw';
import RawKimiArrowUp from '~icons/kimi/arrow-up?raw';
import RawKimiCheck from '~icons/kimi/check?raw';
import RawKimiChevronDown from '~icons/kimi/chevron-down?raw';
import RawKimiChevronRight from '~icons/kimi/chevron-right?raw';
import RawKimiChevronUp from '~icons/kimi/chevron-up?raw';
import RawKimiClock from '~icons/kimi/clock?raw';
import RawKimiClose from '~icons/kimi/close?raw';
import RawKimiCollapse from '~icons/kimi/collapse?raw';
import RawKimiComment from '~icons/kimi/comment?raw';
import RawKimiCopy from '~icons/kimi/copy?raw';
import RawKimiDarkMode from '~icons/kimi/dark-mode?raw';
import RawKimiDownload from '~icons/kimi/download?raw';
import RawKimiEdit from '~icons/kimi/edit?raw';
import RawKimiExpand from '~icons/kimi/expand?raw';
import RawKimiFile from '~icons/kimi/file?raw';
import RawKimiFileText from '~icons/kimi/file-text?raw';
import RawKimiFolder from '~icons/kimi/folder?raw';
import RawKimiFolderOpen from '~icons/kimi/folder-open?raw';
import RawKimiAddFolder from '~icons/kimi/folder-plus?raw';
import RawKimiFollowSystem from '~icons/kimi/follow-system?raw';
import RawKimiFullAccess from '~icons/kimi/full-access?raw';
import RawKimiGlobe from '~icons/kimi/globe?raw';
import RawKimiGrip from '~icons/kimi/grip?raw';
import RawKimiHand from '~icons/kimi/hand?raw';
import RawKimiHistogram from '~icons/kimi/histogram?raw';
import RawKimiImage from '~icons/kimi/image?raw';
import RawKimiImageFailed from '~icons/kimi/image-failed?raw';
import RawKimiInfo from '~icons/kimi/info?raw';
import RawKimiKeyboard from '~icons/kimi/keyboard?raw';
import RawKimiLeftBar from '~icons/kimi/left-panel?raw';
import RawKimiLeftPanelExpand from '~icons/kimi/left-panel-expand?raw';
import RawKimiLightMode from '~icons/kimi/light-mode?raw';
import RawKimiLink from '~icons/kimi/link?raw';
import RawKimiList from '~icons/kimi/list?raw';
import RawKimiMail from '~icons/kimi/mail?raw';
import RawKimiMinus from '~icons/kimi/minus?raw';
import RawKimiMicroscope from '~icons/kimi/microscope?raw';
import RawKimiMore from '~icons/kimi/more?raw';
import RawKimiMusic from '~icons/kimi/music?raw';
import RawKimiPause from '~icons/kimi/pause?raw';
import RawKimiPencil from '~icons/kimi/pencil?raw';
import RawKimiPlay from '~icons/kimi/play?raw';
import RawKimiQuestion from '~icons/kimi/question?raw';
import RawKimiRobot from '~icons/kimi/robot?raw';
import RawKimiSearch from '~icons/kimi/search?raw';
import RawKimiSend from '~icons/kimi/send?raw';
import RawKimiSetting from '~icons/kimi/setting?raw';
import RawKimiShieldQuestion from '~icons/kimi/shield-question?raw';
import RawKimiSignIn from '~icons/kimi/sign-in?raw';
import RawKimiSignOut from '~icons/kimi/sign-out?raw';
import RawKimiSliders from '~icons/kimi/sliders?raw';
import RawKimiStop from '~icons/kimi/stop?raw';
import RawKimiTarget from '~icons/kimi/target?raw';
import RawKimiTask from '~icons/kimi/task?raw';
import RawKimiTerminal from '~icons/kimi/terminal?raw';
import RawKimiThinking from '~icons/kimi/thinking?raw';
import RawKimiTodo from '~icons/kimi/todo?raw';
import RawKimiTranslate from '~icons/kimi/translate?raw';
import RawKimiTrash from '~icons/kimi/trash?raw';
import RawKimiUndo from '~icons/kimi/undo?raw';
import RawKimiUser from '~icons/kimi/user?raw';
import RawKimiWarning from '~icons/kimi/warning?raw';

// Raw SVG strings (Tabler) ----------------------------------------------------
import RawTablerSidebarRightCollapse from '~icons/tabler/layout-sidebar-right-collapse?raw';
import RawTablerPaperclip from '~icons/tabler/paperclip?raw';

// Raw SVG strings (Remix) ----------------------------------------------------
import RawBracesLine from '~icons/ri/braces-line?raw';
import RawCalendarCloseLine from '~icons/ri/calendar-close-line?raw';
import RawCalendarScheduleLine from '~icons/ri/calendar-schedule-line?raw';
import RawCalendarTodoLine from '~icons/ri/calendar-todo-line?raw';
import RawCodeLine from '~icons/ri/code-line?raw';
import RawEmotionLine from '~icons/ri/emotion-line?raw';
import RawExternalLinkLine from '~icons/ri/external-link-line?raw';
import RawEyeLine from '~icons/ri/eye-line?raw';
import RawEyeOffLine from '~icons/ri/eye-off-line?raw';
import RawFileAddLine from '~icons/ri/file-add-line?raw';
import RawFlashlightLine from '~icons/ri/flashlight-line?raw';
import RawFolderFill from '~icons/ri/folder-fill?raw';
import RawGitForkLine from '~icons/ri/git-fork-line?raw';
import RawGitPullRequestLine from '~icons/ri/git-pull-request-line?raw';
import RawListSettingsLine from '~icons/ri/list-settings-line?raw';
import RawNodeTree from '~icons/ri/node-tree?raw';
import RawPushpinLine from '~icons/ri/pushpin-line?raw';
import RawSortDesc from '~icons/ri/sort-desc?raw';
import RawStarFill from '~icons/ri/star-fill?raw';
import RawStarLine from '~icons/ri/star-line?raw';
import RawToolsLine from '~icons/ri/tools-line?raw';
import RawUnpinLine from '~icons/ri/unpin-line?raw';

// Public types -------------------------------------------------------------
export type IconName =
  | 'plus'
  | 'chat-new'
  | 'calendar-close'
  | 'calendar-schedule'
  | 'calendar-todo'
  | 'close'
  | 'check'
  | 'archive'
  | 'search'
  | 'copy'
  | 'link'
  | 'external-link'
  | 'download'
  | 'undo'
  | 'send'
  | 'image'
  | 'settings'
  | 'sliders'
  | 'light-mode'
  | 'dark-mode'
  | 'follow-system'
  | 'log-in'
  | 'log-out'
  | 'hand'
  | 'full-access'
  | 'shield-question'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-up'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-right'
  | 'arrow-left'
  | 'minus'
  | 'microscope'
  | 'panel-collapse'
  | 'panel-collapse-right'
  | 'panel-expand'
  | 'expand'
  | 'collapse'
  | 'list'
  | 'list-settings'
  | 'tree-view'
  | 'sort'
  | 'grip'
  | 'folder'
  | 'folder-closed'
  | 'folder-plus'
  | 'folder-solid'
  | 'file'
  | 'file-text'
  | 'file-edit'
  | 'file-plus'
  | 'file-off'
  | 'attachment'
  | 'image-off'
  | 'eye'
  | 'eye-off'
  | 'code'
  | 'terminal'
  | 'pencil'
  | 'tool'
  | 'glob'
  | 'globe'
  | 'translate'
  | 'check-list'
  | 'bolt'
  | 'keyboard'
  | 'trash'
  | 'git-fork'
  | 'git-pull-request'
  | 'message'
  | 'mail'
  | 'user'
  | 'info'
  | 'help-circle'
  | 'alert-triangle'
  | 'clock'
  | 'robot'
  | 'sparkles'
  | 'histogram'
  | 'music'
  | 'emoji'
  | 'target'
  | 'pause'
  | 'play'
  | 'pin'
  | 'stop'
  | 'star'
  | 'star-outline'
  | 'unpin'
  | 'dots-horizontal'
  | 'thinking';

export type IconSize = 'sm' | 'md' | 'lg';

export const SIZE_PX: Record<IconSize, number> = { sm: 14, md: 16, lg: 20 };

export interface IconEntry {
  /** Vue component that renders the icon (used by <Icon>). */
  component: Component;
  /** Raw `<svg>` string (used by iconSvg() in v-html contexts). */
  svg: string;
}

function entry(component: Component, svg: string): IconEntry {
  return { component, svg };
}

export const ICONS: Record<IconName, IconEntry> = {
  plus: entry(KimiAdd, RawKimiAdd),
  'chat-new': entry(KimiAddConversation, RawKimiAddConversation),
  'calendar-close': entry(RiCalendarCloseLine, RawCalendarCloseLine),
  'calendar-schedule': entry(RiCalendarScheduleLine, RawCalendarScheduleLine),
  'calendar-todo': entry(RiCalendarTodoLine, RawCalendarTodoLine),
  close: entry(KimiClose, RawKimiClose),
  check: entry(KimiCheck, RawKimiCheck),
  archive: entry(KimiArchive, RawKimiArchive),
  search: entry(KimiSearch, RawKimiSearch),
  copy: entry(KimiCopy, RawKimiCopy),
  link: entry(KimiLink, RawKimiLink),
  'external-link': entry(RiExternalLinkLine, RawExternalLinkLine),
  download: entry(KimiDownload, RawKimiDownload),
  undo: entry(KimiUndo, RawKimiUndo),
  send: entry(KimiSend, RawKimiSend),
  image: entry(KimiImage, RawKimiImage),
  settings: entry(KimiSetting, RawKimiSetting),
  sliders: entry(KimiSliders, RawKimiSliders),
  'light-mode': entry(KimiLightMode, RawKimiLightMode),
  'dark-mode': entry(KimiDarkMode, RawKimiDarkMode),
  'follow-system': entry(KimiFollowSystem, RawKimiFollowSystem),
  'log-in': entry(KimiSignIn, RawKimiSignIn),
  'log-out': entry(KimiSignOut, RawKimiSignOut),
  hand: entry(KimiHand, RawKimiHand),
  'full-access': entry(KimiFullAccess, RawKimiFullAccess),
  'shield-question': entry(KimiShieldQuestion, RawKimiShieldQuestion),
  'chevron-down': entry(KimiChevronDown, RawKimiChevronDown),
  'chevron-right': entry(KimiChevronRight, RawKimiChevronRight),
  'chevron-up': entry(KimiChevronUp, RawKimiChevronUp),
  'arrow-up': entry(KimiArrowUp, RawKimiArrowUp),
  'arrow-down': entry(KimiArrowDown, RawKimiArrowDown),
  'arrow-right': entry(KimiArrowRight, RawKimiArrowRight),
  'arrow-left': entry(KimiArrowLeft, RawKimiArrowLeft),
  minus: entry(KimiMinus, RawKimiMinus),
  microscope: entry(KimiMicroscope, RawKimiMicroscope),
  'panel-collapse': entry(KimiLeftBar, RawKimiLeftBar),
  'panel-collapse-right': entry(TablerSidebarRightCollapse, RawTablerSidebarRightCollapse),
  'panel-expand': entry(KimiLeftPanelExpand, RawKimiLeftPanelExpand),
  expand: entry(KimiExpand, RawKimiExpand),
  collapse: entry(KimiCollapse, RawKimiCollapse),
  list: entry(KimiList, RawKimiList),
  'list-settings': entry(RiListSettingsLine, RawListSettingsLine),
  'tree-view': entry(RiNodeTree, RawNodeTree),
  sort: entry(RiSortDesc, RawSortDesc),
  grip: entry(KimiGrip, RawKimiGrip),
  folder: entry(KimiFolderOpen, RawKimiFolderOpen),
  'folder-closed': entry(KimiFolder, RawKimiFolder),
  'folder-plus': entry(KimiAddFolder, RawKimiAddFolder),
  'folder-solid': entry(RiFolderFill, RawFolderFill),
  file: entry(KimiFile, RawKimiFile),
  'file-text': entry(KimiFileText, RawKimiFileText),
  'file-edit': entry(KimiEdit, RawKimiEdit),
  'file-plus': entry(RiFileAddLine, RawFileAddLine),
  'file-off': entry(KimiFile, RawKimiFile),
  attachment: entry(TablerPaperclip, RawTablerPaperclip),
  'image-off': entry(KimiImageFailed, RawKimiImageFailed),
  eye: entry(RiEyeLine, RawEyeLine),
  'eye-off': entry(RiEyeOffLine, RawEyeOffLine),
  code: entry(RiCodeLine, RawCodeLine),
  terminal: entry(KimiTerminal, RawKimiTerminal),
  pencil: entry(KimiPencil, RawKimiPencil),
  tool: entry(RiToolsLine, RawToolsLine),
  glob: entry(RiBracesLine, RawBracesLine),
  globe: entry(KimiGlobe, RawKimiGlobe),
  translate: entry(KimiTranslate, RawKimiTranslate),
  'check-list': entry(KimiTodo, RawKimiTodo),
  bolt: entry(RiFlashlightLine, RawFlashlightLine),
  keyboard: entry(KimiKeyboard, RawKimiKeyboard),
  trash: entry(KimiTrash, RawKimiTrash),
  'git-fork': entry(RiGitForkLine, RawGitForkLine),
  'git-pull-request': entry(RiGitPullRequestLine, RawGitPullRequestLine),
  message: entry(KimiComment, RawKimiComment),
  mail: entry(KimiMail, RawKimiMail),
  user: entry(KimiUser, RawKimiUser),
  info: entry(KimiInfo, RawKimiInfo),
  'help-circle': entry(KimiQuestion, RawKimiQuestion),
  'alert-triangle': entry(KimiWarning, RawKimiWarning),
  clock: entry(KimiClock, RawKimiClock),
  robot: entry(KimiRobot, RawKimiRobot),
  sparkles: entry(KimiTask, RawKimiTask),
  histogram: entry(KimiHistogram, RawKimiHistogram),
  music: entry(KimiMusic, RawKimiMusic),
  emoji: entry(RiEmotionLine, RawEmotionLine),
  target: entry(KimiTarget, RawKimiTarget),
  pause: entry(KimiPause, RawKimiPause),
  play: entry(KimiPlay, RawKimiPlay),
  pin: entry(RiPushpinLine, RawPushpinLine),
  stop: entry(KimiStop, RawKimiStop),
  star: entry(RiStarFill, RawStarFill),
  'star-outline': entry(RiStarLine, RawStarLine),
  unpin: entry(RiUnpinLine, RawUnpinLine),
  'dots-horizontal': entry(KimiMore, RawKimiMore),
  thinking: entry(KimiThinking, RawKimiThinking),
};

export function getIcon(name: IconName): IconEntry {
  return ICONS[name];
}

function applySize(svg: string, px: number): string {
  return svg
    .replace(/<svg\b[^>]*>/, (tag) => tag.replace(/\s(?:width|height)="[^"]*"/g, ''))
    .replace(/^<svg\b/, `<svg class="kw-icon" width="${px}" height="${px}" aria-hidden="true"`);
}

/** Render an icon to a full <svg> string for v-html contexts. Mirrors <Icon>. */
export function iconSvg(name: IconName, size: IconSize = 'md'): string {
  const entry = ICONS[name];
  if (!entry) return '';
  return applySize(entry.svg, SIZE_PX[size]);
}

// ---------------------------------------------------------------------------
// catalog grouping — single source of truth for design-system §02 icon list
// ---------------------------------------------------------------------------

/** Display order + grouping for the design-system §02 icon catalog. */
export const ICON_GROUPS: ReadonlyArray<readonly [string, readonly IconName[]]> = [
  [
    'Actions',
    [
      'plus',
      'attachment',
      'chat-new',
      'close',
      'check',
      'search',
      'copy',
      'link',
      'external-link',
      'download',
      'undo',
      'send',
      'image',
      'settings',
      'sliders',
      'log-in',
      'log-out',
      'eye',
      'eye-off',
    ],
  ],
  [
    'Navigation & layout',
    [
      'chevron-down',
      'chevron-right',
      'chevron-up',
      'arrow-up',
      'arrow-down',
      'arrow-right',
      'arrow-left',
      'minus',
      'panel-collapse',
      'panel-collapse-right',
      'panel-expand',
      'expand',
      'collapse',
      'list',
      'list-settings',
      'tree-view',
      'sort',
      'grip',
    ],
  ],
  [
    'Files & tools',
    [
      'folder',
      'folder-closed',
      'folder-plus',
      'folder-solid',
      'file',
      'file-text',
      'file-edit',
      'file-plus',
      'file-off',
      'image-off',
      'code',
      'terminal',
      'pencil',
      'tool',
      'glob',
      'globe',
      'check-list',
      'bolt',
      'git-fork',
      'git-pull-request',
      'archive',
      'pin',
      'unpin',
      'target',
      'calendar-schedule',
      'calendar-todo',
      'calendar-close',
      'keyboard',
      'trash',
      'microscope',
    ],
  ],
  ['Communication', ['message', 'mail', 'user', 'robot', 'emoji', 'translate']],
  [
    'Status & media',
    [
      'info',
      'help-circle',
      'alert-triangle',
      'hand',
      'full-access',
      'shield-question',
      'clock',
      'histogram',
      'music',
      'sparkles',
      'pause',
      'play',
      'stop',
      'star',
      'star-outline',
      'dots-horizontal',
      'thinking',
      'light-mode',
      'dark-mode',
      'follow-system',
    ],
  ],
];
