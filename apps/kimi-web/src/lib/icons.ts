// apps/kimi-web/src/lib/icons.ts
// Single source of truth for apps/kimi-web icons (design-system §02).
//
// Icons come from Remix Icon (https://remixicon.com/, Apache-2.0) and are
// bundled by unplugin-icons at build time — only the icons listed below end up
// in the production bundle. Each icon is imported twice: once as a Vue
// component (for <Icon name=... />) and once as a `?raw` SVG string (for
// iconSvg() in v-html contexts such as lib/toolMeta.ts).
//
// Remix icons are fill-based (fill="currentColor") on a 24x24 source grid; the
// rendered size comes from the size token prop. Colour follows text.
//
// Two consumers share this registry:
//   - the <Icon> Vue component (components/ui/Icon.vue) for template use;
//   - iconSvg() below, for v-html contexts (e.g. lib/toolMeta.ts).

import type { Component } from 'vue';

// Components (Vue) ---------------------------------------------------------
import RiAddLine from '~icons/ri/add-line';
import RiAlertLine from '~icons/ri/alert-line';
import RiArrowDownLine from '~icons/ri/arrow-down-line';
import RiArrowDownSLine from '~icons/ri/arrow-down-s-line';
import RiArrowGoBackLine from '~icons/ri/arrow-go-back-line';
import RiArrowRightLine from '~icons/ri/arrow-right-line';
import RiArrowRightSLine from '~icons/ri/arrow-right-s-line';
import RiArrowUpLine from '~icons/ri/arrow-up-line';
import RiBracesLine from '~icons/ri/braces-line';
import RiCalendarCloseLine from '~icons/ri/calendar-close-line';
import RiCalendarScheduleLine from '~icons/ri/calendar-schedule-line';
import RiCalendarTodoLine from '~icons/ri/calendar-todo-line';
import RiChatNewLine from '~icons/ri/chat-new-line';
import RiCheckLine from '~icons/ri/check-line';
import RiCloseLine from '~icons/ri/close-line';
import RiCodeLine from '~icons/ri/code-line';
import RiCollapseDiagonalLine from '~icons/ri/collapse-diagonal-line';
import RiContractLeftLine from '~icons/ri/contract-left-line';
import RiDownloadLine from '~icons/ri/download-line';
import RiDraggable from '~icons/ri/draggable';
import RiEqualizerLine from '~icons/ri/equalizer-line';
import RiExpandDiagonalLine from '~icons/ri/expand-diagonal-line';
import RiExpandRightLine from '~icons/ri/expand-right-line';
import RiExternalLinkLine from '~icons/ri/external-link-line';
import RiFileAddLine from '~icons/ri/file-add-line';
import RiFileCopyLine from '~icons/ri/file-copy-line';
import RiFileLine from '~icons/ri/file-line';
import RiFileTextLine from '~icons/ri/file-text-line';
import RiFlashlightLine from '~icons/ri/flashlight-line';
import RiFolderAddLine from '~icons/ri/folder-add-line';
import RiFolderFill from '~icons/ri/folder-fill';
import RiFolderLine from '~icons/ri/folder-line';
import RiFolderOpenLine from '~icons/ri/folder-open-line';
import RiGitPullRequestLine from '~icons/ri/git-pull-request-line';
import RiGlobalLine from '~icons/ri/global-line';
import RiImageLine from '~icons/ri/image-line';
import RiInformationLine from '~icons/ri/information-line';
import RiLinksLine from '~icons/ri/links-line';
import RiListCheck from '~icons/ri/list-check';
import RiListUnordered from '~icons/ri/list-unordered';
import RiLoginBoxLine from '~icons/ri/login-box-line';
import RiMailLine from '~icons/ri/mail-line';
import RiMessageLine from '~icons/ri/message-line';
import RiMoreLine from '~icons/ri/more-line';
import RiPencilLine from '~icons/ri/pencil-line';
import RiPlayFill from '~icons/ri/play-fill';
import RiQuestionLine from '~icons/ri/question-line';
import RiSearchLine from '~icons/ri/search-line';
import RiSettings3Line from '~icons/ri/settings-3-line';
import RiSortDesc from '~icons/ri/sort-desc';
import RiSparklingLine from '~icons/ri/sparkling-line';
import RiStarFill from '~icons/ri/star-fill';
import RiStarLine from '~icons/ri/star-line';
import RiStopFill from '~icons/ri/stop-fill';
import RiSubtractLine from '~icons/ri/subtract-line';
import RiTerminalBoxLine from '~icons/ri/terminal-box-line';
import RiTimeLine from '~icons/ri/time-line';
import RiToolsLine from '~icons/ri/tools-line';
import RiUserLine from '~icons/ri/user-line';

// Raw SVG strings ----------------------------------------------------------
import RawAddLine from '~icons/ri/add-line?raw';
import RawAlertLine from '~icons/ri/alert-line?raw';
import RawArrowDownLine from '~icons/ri/arrow-down-line?raw';
import RawArrowDownSLine from '~icons/ri/arrow-down-s-line?raw';
import RawArrowGoBackLine from '~icons/ri/arrow-go-back-line?raw';
import RawArrowRightLine from '~icons/ri/arrow-right-line?raw';
import RawArrowRightSLine from '~icons/ri/arrow-right-s-line?raw';
import RawArrowUpLine from '~icons/ri/arrow-up-line?raw';
import RawBracesLine from '~icons/ri/braces-line?raw';
import RawCalendarCloseLine from '~icons/ri/calendar-close-line?raw';
import RawCalendarScheduleLine from '~icons/ri/calendar-schedule-line?raw';
import RawCalendarTodoLine from '~icons/ri/calendar-todo-line?raw';
import RawChatNewLine from '~icons/ri/chat-new-line?raw';
import RawCheckLine from '~icons/ri/check-line?raw';
import RawCloseLine from '~icons/ri/close-line?raw';
import RawCodeLine from '~icons/ri/code-line?raw';
import RawCollapseDiagonalLine from '~icons/ri/collapse-diagonal-line?raw';
import RawContractLeftLine from '~icons/ri/contract-left-line?raw';
import RawDownloadLine from '~icons/ri/download-line?raw';
import RawDraggable from '~icons/ri/draggable?raw';
import RawEqualizerLine from '~icons/ri/equalizer-line?raw';
import RawExpandDiagonalLine from '~icons/ri/expand-diagonal-line?raw';
import RawExpandRightLine from '~icons/ri/expand-right-line?raw';
import RawExternalLinkLine from '~icons/ri/external-link-line?raw';
import RawFileAddLine from '~icons/ri/file-add-line?raw';
import RawFileCopyLine from '~icons/ri/file-copy-line?raw';
import RawFileLine from '~icons/ri/file-line?raw';
import RawFileTextLine from '~icons/ri/file-text-line?raw';
import RawFlashlightLine from '~icons/ri/flashlight-line?raw';
import RawFolderAddLine from '~icons/ri/folder-add-line?raw';
import RawFolderFill from '~icons/ri/folder-fill?raw';
import RawFolderLine from '~icons/ri/folder-line?raw';
import RawFolderOpenLine from '~icons/ri/folder-open-line?raw';
import RawGitPullRequestLine from '~icons/ri/git-pull-request-line?raw';
import RawGlobalLine from '~icons/ri/global-line?raw';
import RawImageLine from '~icons/ri/image-line?raw';
import RawInformationLine from '~icons/ri/information-line?raw';
import RawLinksLine from '~icons/ri/links-line?raw';
import RawListCheck from '~icons/ri/list-check?raw';
import RawListUnordered from '~icons/ri/list-unordered?raw';
import RawLoginBoxLine from '~icons/ri/login-box-line?raw';
import RawMailLine from '~icons/ri/mail-line?raw';
import RawMessageLine from '~icons/ri/message-line?raw';
import RawMoreLine from '~icons/ri/more-line?raw';
import RawPencilLine from '~icons/ri/pencil-line?raw';
import RawPlayFill from '~icons/ri/play-fill?raw';
import RawQuestionLine from '~icons/ri/question-line?raw';
import RawSearchLine from '~icons/ri/search-line?raw';
import RawSettings3Line from '~icons/ri/settings-3-line?raw';
import RawSortDesc from '~icons/ri/sort-desc?raw';
import RawSparklingLine from '~icons/ri/sparkling-line?raw';
import RawStarFill from '~icons/ri/star-fill?raw';
import RawStarLine from '~icons/ri/star-line?raw';
import RawStopFill from '~icons/ri/stop-fill?raw';
import RawSubtractLine from '~icons/ri/subtract-line?raw';
import RawTerminalBoxLine from '~icons/ri/terminal-box-line?raw';
import RawTimeLine from '~icons/ri/time-line?raw';
import RawToolsLine from '~icons/ri/tools-line?raw';
import RawUserLine from '~icons/ri/user-line?raw';

// Public types -------------------------------------------------------------
export type IconName =
  | 'plus'
  | 'chat-new'
  | 'calendar-close'
  | 'calendar-schedule'
  | 'calendar-todo'
  | 'close'
  | 'check'
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
  | 'log-in'
  | 'chevron-down'
  | 'chevron-right'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-right'
  | 'minus'
  | 'panel-collapse'
  | 'panel-expand'
  | 'expand'
  | 'collapse'
  | 'list'
  | 'sort'
  | 'grip'
  | 'folder'
  | 'folder-closed'
  | 'folder-plus'
  | 'folder-solid'
  | 'file'
  | 'file-text'
  | 'file-plus'
  | 'file-off'
  | 'image-off'
  | 'code'
  | 'terminal'
  | 'pencil'
  | 'tool'
  | 'glob'
  | 'globe'
  | 'check-list'
  | 'bolt'
  | 'git-pull-request'
  | 'message'
  | 'mail'
  | 'user'
  | 'info'
  | 'help-circle'
  | 'alert-triangle'
  | 'clock'
  | 'sparkles'
  | 'play'
  | 'stop'
  | 'star'
  | 'star-outline'
  | 'dots-horizontal';

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
  plus: entry(RiAddLine, RawAddLine),
  'chat-new': entry(RiChatNewLine, RawChatNewLine),
  'calendar-close': entry(RiCalendarCloseLine, RawCalendarCloseLine),
  'calendar-schedule': entry(RiCalendarScheduleLine, RawCalendarScheduleLine),
  'calendar-todo': entry(RiCalendarTodoLine, RawCalendarTodoLine),
  close: entry(RiCloseLine, RawCloseLine),
  check: entry(RiCheckLine, RawCheckLine),
  search: entry(RiSearchLine, RawSearchLine),
  copy: entry(RiFileCopyLine, RawFileCopyLine),
  link: entry(RiLinksLine, RawLinksLine),
  'external-link': entry(RiExternalLinkLine, RawExternalLinkLine),
  download: entry(RiDownloadLine, RawDownloadLine),
  undo: entry(RiArrowGoBackLine, RawArrowGoBackLine),
  send: entry(RiArrowUpLine, RawArrowUpLine),
  image: entry(RiImageLine, RawImageLine),
  settings: entry(RiSettings3Line, RawSettings3Line),
  sliders: entry(RiEqualizerLine, RawEqualizerLine),
  'log-in': entry(RiLoginBoxLine, RawLoginBoxLine),
  'chevron-down': entry(RiArrowDownSLine, RawArrowDownSLine),
  'chevron-right': entry(RiArrowRightSLine, RawArrowRightSLine),
  'arrow-up': entry(RiArrowUpLine, RawArrowUpLine),
  'arrow-down': entry(RiArrowDownLine, RawArrowDownLine),
  'arrow-right': entry(RiArrowRightLine, RawArrowRightLine),
  minus: entry(RiSubtractLine, RawSubtractLine),
  'panel-collapse': entry(RiContractLeftLine, RawContractLeftLine),
  'panel-expand': entry(RiExpandRightLine, RawExpandRightLine),
  expand: entry(RiExpandDiagonalLine, RawExpandDiagonalLine),
  collapse: entry(RiCollapseDiagonalLine, RawCollapseDiagonalLine),
  list: entry(RiListUnordered, RawListUnordered),
  sort: entry(RiSortDesc, RawSortDesc),
  grip: entry(RiDraggable, RawDraggable),
  folder: entry(RiFolderOpenLine, RawFolderOpenLine),
  'folder-closed': entry(RiFolderLine, RawFolderLine),
  'folder-plus': entry(RiFolderAddLine, RawFolderAddLine),
  'folder-solid': entry(RiFolderFill, RawFolderFill),
  file: entry(RiFileLine, RawFileLine),
  'file-text': entry(RiFileTextLine, RawFileTextLine),
  'file-plus': entry(RiFileAddLine, RawFileAddLine),
  'file-off': entry(RiFileLine, RawFileLine),
  'image-off': entry(RiImageLine, RawImageLine),
  code: entry(RiCodeLine, RawCodeLine),
  terminal: entry(RiTerminalBoxLine, RawTerminalBoxLine),
  pencil: entry(RiPencilLine, RawPencilLine),
  tool: entry(RiToolsLine, RawToolsLine),
  glob: entry(RiBracesLine, RawBracesLine),
  globe: entry(RiGlobalLine, RawGlobalLine),
  'check-list': entry(RiListCheck, RawListCheck),
  bolt: entry(RiFlashlightLine, RawFlashlightLine),
  'git-pull-request': entry(RiGitPullRequestLine, RawGitPullRequestLine),
  message: entry(RiMessageLine, RawMessageLine),
  mail: entry(RiMailLine, RawMailLine),
  user: entry(RiUserLine, RawUserLine),
  info: entry(RiInformationLine, RawInformationLine),
  'help-circle': entry(RiQuestionLine, RawQuestionLine),
  'alert-triangle': entry(RiAlertLine, RawAlertLine),
  clock: entry(RiTimeLine, RawTimeLine),
  sparkles: entry(RiSparklingLine, RawSparklingLine),
  play: entry(RiPlayFill, RawPlayFill),
  stop: entry(RiStopFill, RawStopFill),
  star: entry(RiStarFill, RawStarFill),
  'star-outline': entry(RiStarLine, RawStarLine),
  'dots-horizontal': entry(RiMoreLine, RawMoreLine),
};

export function getIcon(name: IconName): IconEntry {
  return ICONS[name];
}

function applySize(svg: string, px: number): string {
  return svg
    .replace(/\s(?:width|height)="[^"]*"/g, '')
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
    ],
  ],
  [
    'Navigation & layout',
    [
      'chevron-down',
      'chevron-right',
      'arrow-up',
      'arrow-down',
      'arrow-right',
      'minus',
      'panel-collapse',
      'panel-expand',
      'expand',
      'collapse',
      'list',
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
      'git-pull-request',
      'calendar-schedule',
      'calendar-todo',
      'calendar-close',
    ],
  ],
  ['Communication', ['message', 'mail', 'user']],
  [
    'Status & media',
    [
      'info',
      'help-circle',
      'alert-triangle',
      'clock',
      'sparkles',
      'play',
      'stop',
      'star',
      'star-outline',
      'dots-horizontal',
    ],
  ],
];
