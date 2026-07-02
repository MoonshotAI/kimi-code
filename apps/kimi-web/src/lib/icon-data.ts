// GENERATED FILE — do not edit by hand.
// Source of truth: scripts/gen-icon-data.mjs (run `pnpm gen:icons`).
// Icons are Remix Icon (ri) — https://remixicon.com/ — Apache-2.0.

export type IconName =
  | "plus"
  | "chat-new"
  | "close"
  | "check"
  | "search"
  | "copy"
  | "link"
  | "external-link"
  | "download"
  | "undo"
  | "send"
  | "image"
  | "settings"
  | "sliders"
  | "log-in"
  | "chevron-down"
  | "chevron-right"
  | "arrow-up"
  | "arrow-down"
  | "arrow-right"
  | "minus"
  | "panel-collapse"
  | "panel-expand"
  | "expand"
  | "collapse"
  | "list"
  | "sort"
  | "grip"
  | "folder"
  | "folder-closed"
  | "folder-plus"
  | "folder-solid"
  | "file"
  | "file-text"
  | "file-plus"
  | "file-off"
  | "image-off"
  | "code"
  | "terminal"
  | "pencil"
  | "glob"
  | "globe"
  | "check-list"
  | "bolt"
  | "git-pull-request"
  | "message"
  | "mail"
  | "user"
  | "info"
  | "help-circle"
  | "alert-triangle"
  | "clock"
  | "sparkles"
  | "play"
  | "stop"
  | "star"
  | "star-outline"
  | "dots-horizontal";

export interface IconData {
  /** Inner SVG markup (paths/shapes), rendered inside our <svg> wrapper. */
  body: string;
  /** Source grid width in px. Remix icons are 24. */
  width?: number;
  /** Source grid height in px. Remix icons are 24. */
  height?: number;
}

/** Existing name → fully-qualified Remix icon id. */
export const NAME_TO_REMIX: Record<IconName, string> = {
  plus: "ri:add-line",
  "chat-new": "ri:chat-new-line",
  close: "ri:close-line",
  check: "ri:check-line",
  search: "ri:search-line",
  copy: "ri:file-copy-line",
  link: "ri:links-line",
  "external-link": "ri:external-link-line",
  download: "ri:download-line",
  undo: "ri:arrow-go-back-line",
  send: "ri:arrow-up-line",
  image: "ri:image-line",
  settings: "ri:settings-3-line",
  sliders: "ri:equalizer-line",
  "log-in": "ri:login-box-line",
  "chevron-down": "ri:arrow-down-s-line",
  "chevron-right": "ri:arrow-right-s-line",
  "arrow-up": "ri:arrow-up-line",
  "arrow-down": "ri:arrow-down-line",
  "arrow-right": "ri:arrow-right-line",
  minus: "ri:subtract-line",
  "panel-collapse": "ri:contract-left-line",
  "panel-expand": "ri:expand-right-line",
  expand: "ri:expand-diagonal-line",
  collapse: "ri:collapse-diagonal-line",
  list: "ri:list-unordered",
  sort: "ri:sort-desc",
  grip: "ri:draggable",
  folder: "ri:folder-open-line",
  "folder-closed": "ri:folder-line",
  "folder-plus": "ri:folder-add-line",
  "folder-solid": "ri:folder-fill",
  file: "ri:file-line",
  "file-text": "ri:file-text-line",
  "file-plus": "ri:file-add-line",
  "file-off": "ri:file-line",
  "image-off": "ri:image-line",
  code: "ri:code-line",
  terminal: "ri:terminal-box-line",
  pencil: "ri:pencil-line",
  glob: "ri:braces-line",
  globe: "ri:global-line",
  "check-list": "ri:list-check",
  bolt: "ri:flashlight-line",
  "git-pull-request": "ri:git-pull-request-line",
  message: "ri:message-line",
  mail: "ri:mail-line",
  user: "ri:user-line",
  info: "ri:information-line",
  "help-circle": "ri:question-line",
  "alert-triangle": "ri:alert-line",
  clock: "ri:time-line",
  sparkles: "ri:sparkling-line",
  play: "ri:play-fill",
  stop: "ri:stop-fill",
  star: "ri:star-fill",
  "star-outline": "ri:star-line",
  "dots-horizontal": "ri:more-line",
};

/** Per-icon SVG data, pulled from @iconify-json/ri. */
export const ICON_DATA: Record<IconName, IconData> = {
  plus: { body: "<path fill=\"currentColor\" d=\"M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z\"/>", width: 24, height: 24 },
  "chat-new": { body: "<path fill=\"currentColor\" d=\"M14 3v2H4v13.385L5.763 17H20v-7h2v8a1 1 0 0 1-1 1H6.455L2 22.5V4a1 1 0 0 1 1-1zm5 0V0h2v3h3v2h-3v3h-2V5h-3V3z\"/>", width: 24, height: 24 },
  close: { body: "<path fill=\"currentColor\" d=\"m12 10.587l4.95-4.95l1.414 1.414l-4.95 4.95l4.95 4.95l-1.415 1.414l-4.95-4.95l-4.949 4.95l-1.414-1.415l4.95-4.95l-4.95-4.95L7.05 5.638z\"/>", width: 24, height: 24 },
  check: { body: "<path fill=\"currentColor\" d=\"m10 15.17l9.192-9.191l1.414 1.414L10 17.999l-6.364-6.364l1.414-1.414z\"/>", width: 24, height: 24 },
  search: { body: "<path fill=\"currentColor\" d=\"m18.031 16.617l4.283 4.282l-1.415 1.415l-4.282-4.283A8.96 8.96 0 0 1 11 20c-4.968 0-9-4.032-9-9s4.032-9 9-9s9 4.032 9 9a8.96 8.96 0 0 1-1.969 5.617m-2.006-.742A6.98 6.98 0 0 0 18 11c0-3.867-3.133-7-7-7s-7 3.133-7 7s3.133 7 7 7a6.98 6.98 0 0 0 4.875-1.975z\"/>", width: 24, height: 24 },
  copy: { body: "<path fill=\"currentColor\" d=\"M7 6V3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3v3c0 .552-.45 1-1.007 1H4.007A1 1 0 0 1 3 21l.003-14c0-.552.45-1 1.006-1zM5.002 8L5 20h10V8zM9 6h8v10h2V4H9z\"/>", width: 24, height: 24 },
  link: { body: "<path fill=\"currentColor\" d=\"m13.06 8.111l1.415 1.414a7 7 0 0 1 0 9.9l-.354.353a7 7 0 1 1-9.9-9.9l1.415 1.415a5 5 0 1 0 7.071 7.071l.354-.354a5 5 0 0 0 0-7.07l-1.415-1.415zm6.718 6.01l-1.414-1.414a5 5 0 0 0-7.071-7.07l-.354.353a5 5 0 0 0 0 7.07l1.415 1.415l-1.415 1.414l-1.414-1.414a7 7 0 0 1 0-9.9l.354-.353a7 7 0 1 1 9.9 9.9\"/>", width: 24, height: 24 },
  "external-link": { body: "<path fill=\"currentColor\" d=\"M10 6v2H5v11h11v-5h2v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm11-3v8h-2V6.413l-7.793 7.794l-1.414-1.414L17.585 5H13V3z\"/>", width: 24, height: 24 },
  download: { body: "<path fill=\"currentColor\" d=\"M3 19h18v2H3zm10-5.828L19.071 7.1l1.414 1.414L12 17L3.515 8.515L4.929 7.1L11 13.173V2h2z\"/>", width: 24, height: 24 },
  undo: { body: "<path fill=\"currentColor\" d=\"m5.828 7l2.536 2.535L6.95 10.95L2 6l4.95-4.95l1.414 1.415L5.828 5H13a8 8 0 1 1 0 16H4v-2h9a6 6 0 0 0 0-12z\"/>", width: 24, height: 24 },
  send: { body: "<path fill=\"currentColor\" d=\"M13 7.828V20h-2V7.828l-5.364 5.364l-1.414-1.414L12 4l7.778 7.778l-1.414 1.414z\"/>", width: 24, height: 24 },
  image: { body: "<path fill=\"currentColor\" d=\"M2.992 21A.993.993 0 0 1 2 20.007V3.993A1 1 0 0 1 2.992 3h18.016c.548 0 .992.445.992.993v16.014a1 1 0 0 1-.992.993zM20 15V5H4v14L14 9zm0 2.828l-6-6L6.828 19H20zM8 11a2 2 0 1 1 0-4a2 2 0 0 1 0 4\"/>", width: 24, height: 24 },
  settings: { body: "<path fill=\"currentColor\" d=\"M3.34 17a10 10 0 0 1-.979-2.326a3 3 0 0 0 .003-5.347a10 10 0 0 1 2.5-4.337a3 3 0 0 0 4.632-2.674a10 10 0 0 1 5.007.003a3 3 0 0 0 4.632 2.671a10.06 10.06 0 0 1 2.503 4.336a3 3 0 0 0-.002 5.347a10 10 0 0 1-2.501 4.337a3 3 0 0 0-4.632 2.674a10 10 0 0 1-5.007-.002a3 3 0 0 0-4.631-2.672A10 10 0 0 1 3.339 17m5.66.196a5 5 0 0 1 2.25 2.77q.75.07 1.499.002a5 5 0 0 1 2.25-2.772a5 5 0 0 1 3.526-.564q.435-.614.748-1.298A5 5 0 0 1 18 12c0-1.26.47-2.437 1.273-3.334a8 8 0 0 0-.75-1.298A5 5 0 0 1 15 6.804a5 5 0 0 1-2.25-2.77q-.75-.071-1.5-.001A5 5 0 0 1 9 6.804a5 5 0 0 1-3.526.564q-.436.614-.747 1.298A5 5 0 0 1 6 12c0 1.26-.471 2.437-1.273 3.334a8 8 0 0 0 .75 1.298A5 5 0 0 1 9 17.196M12 15a3 3 0 1 1 0-6a3 3 0 0 1 0 6m0-2a1 1 0 1 0 0-2a1 1 0 0 0 0 2\"/>", width: 24, height: 24 },
  sliders: { body: "<path fill=\"currentColor\" d=\"M6.17 18a3.001 3.001 0 0 1 5.66 0H22v2H11.83a3.001 3.001 0 0 1-5.66 0H2v-2zm6-7a3.001 3.001 0 0 1 5.66 0H22v2h-4.17a3.001 3.001 0 0 1-5.66 0H2v-2zm-6-7a3.001 3.001 0 0 1 5.66 0H22v2H11.83a3.001 3.001 0 0 1-5.66 0H2V4zM9 6a1 1 0 1 0 0-2a1 1 0 0 0 0 2m6 7a1 1 0 1 0 0-2a1 1 0 0 0 0 2m-6 7a1 1 0 1 0 0-2a1 1 0 0 0 0 2\"/>", width: 24, height: 24 },
  "log-in": { body: "<path fill=\"currentColor\" d=\"M4 15h2v5h12V4H6v5H4V3a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zm6-4V8l5 4l-5 4v-3H2v-2z\"/>", width: 24, height: 24 },
  "chevron-down": { body: "<path fill=\"currentColor\" d=\"m12 13.171l4.95-4.95l1.414 1.415L12 16L5.636 9.636L7.05 8.222z\"/>", width: 24, height: 24 },
  "chevron-right": { body: "<path fill=\"currentColor\" d=\"m13.172 12l-4.95-4.95l1.414-1.413L16 12l-6.364 6.364l-1.414-1.415z\"/>", width: 24, height: 24 },
  "arrow-up": { body: "<path fill=\"currentColor\" d=\"M13 7.828V20h-2V7.828l-5.364 5.364l-1.414-1.414L12 4l7.778 7.778l-1.414 1.414z\"/>", width: 24, height: 24 },
  "arrow-down": { body: "<path fill=\"currentColor\" d=\"m13 16.172l5.364-5.364l1.414 1.414L12 20l-7.778-7.778l1.414-1.414L11 16.172V4h2z\"/>", width: 24, height: 24 },
  "arrow-right": { body: "<path fill=\"currentColor\" d=\"m16.172 11l-5.364-5.364l1.414-1.414L20 12l-7.778 7.778l-1.414-1.414L16.172 13H4v-2z\"/>", width: 24, height: 24 },
  minus: { body: "<path fill=\"currentColor\" d=\"M5 11v2h14v-2z\"/>", width: 24, height: 24 },
  "panel-collapse": { body: "<path fill=\"currentColor\" d=\"m15.071 4.929l1.414 1.414L11.83 11H21v2h-9.17l4.656 4.657l-1.414 1.414L8.001 12zm-11.07 14.07V5h2v14z\"/>", width: 24, height: 24 },
  "panel-expand": { body: "<path fill=\"currentColor\" d=\"m17.172 11l-4.657-4.657l1.414-1.414L21 12l-7.071 7.071l-1.414-1.414L17.172 13H8v-2zM4 19V5h2v14z\"/>", width: 24, height: 24 },
  expand: { body: "<path fill=\"currentColor\" d=\"M17.586 5H14V3h7v7h-2V6.414l-4.293 4.293l-1.414-1.414zM3 14h2v3.586l4.293-4.293l1.414 1.414L6.414 19H10v2H3z\"/>", width: 24, height: 24 },
  collapse: { body: "<path fill=\"currentColor\" d=\"M15 4h-2v7h7V9h-3.586l4.293-4.293l-1.414-1.414L15 7.586zM4 15h3.586l-4.293 4.293l1.414 1.414L9 16.414V20h2v-7H4z\"/>", width: 24, height: 24 },
  list: { body: "<path fill=\"currentColor\" d=\"M8 4h13v2H8zM4.5 6.5a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0 7a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3m0 6.9a1.5 1.5 0 1 1 0-3a1.5 1.5 0 0 1 0 3M8 11h13v2H8zm0 7h13v2H8z\"/>", width: 24, height: 24 },
  sort: { body: "<path fill=\"currentColor\" d=\"M20 4v12h3l-4 5l-4-5h3V4zm-8 14v2H3v-2zm2-7v2H3v-2zm0-7v2H3V4z\"/>", width: 24, height: 24 },
  grip: { body: "<path fill=\"currentColor\" d=\"M8.5 7a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3m0 6.5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3m1.5 5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0M15.5 7a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3m1.5 5a1.5 1.5 0 1 1-3 0a1.5 1.5 0 0 1 3 0m-1.5 8a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3\"/>", width: 24, height: 24 },
  folder: { body: "<path fill=\"currentColor\" d=\"M3 21a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h7.414l2 2H20a1 1 0 0 1 1 1v3h-2V7h-7.414l-2-2H4v11.998L5.5 11h17l-2.31 9.243a1 1 0 0 1-.97.757zm16.938-8H7.062l-1.5 6h12.876z\"/>", width: 24, height: 24 },
  "folder-closed": { body: "<path fill=\"currentColor\" d=\"M4 5v14h16V7h-8.414l-2-2zm8.414 0H21a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h7.414z\"/>", width: 24, height: 24 },
  "folder-plus": { body: "<path fill=\"currentColor\" d=\"M12.414 5H21a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h7.414zM4 5v14h16V7h-8.414l-2-2zm7 7V9h2v3h3v2h-3v3h-2v-3H8v-2z\"/>", width: 24, height: 24 },
  "folder-solid": { body: "<path fill=\"currentColor\" d=\"M12.414 5H21a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h7.414z\"/>", width: 24, height: 24 },
  file: { body: "<path fill=\"currentColor\" d=\"M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z\"/>", width: 24, height: 24 },
  "file-text": { body: "<path fill=\"currentColor\" d=\"M21 8v12.993A1 1 0 0 1 20.007 22H3.993A.993.993 0 0 1 3 21.008V2.992C3 2.455 3.449 2 4.002 2h10.995zm-2 1h-5V4H5v16h14zM8 7h3v2H8zm0 4h8v2H8zm0 4h8v2H8z\"/>", width: 24, height: 24 },
  "file-plus": { body: "<path fill=\"currentColor\" d=\"M15 4H5v16h14V8h-4zM3 2.992C3 2.444 3.447 2 3.999 2H16l5 5v13.993A1 1 0 0 1 20.007 22H3.993A1 1 0 0 1 3 21.008zM11 11V8h2v3h3v2h-3v3h-2v-3H8v-2z\"/>", width: 24, height: 24 },
  "file-off": { body: "<path fill=\"currentColor\" d=\"M9 2.003V2h10.998C20.55 2 21 2.455 21 2.992v18.016a.993.993 0 0 1-.993.992H3.993A1 1 0 0 1 3 20.993V8zM5.83 8H9V4.83zM11 4v5a1 1 0 0 1-1 1H5v10h14V4z\"/>", width: 24, height: 24 },
  "image-off": { body: "<path fill=\"currentColor\" d=\"M2.992 21A.993.993 0 0 1 2 20.007V3.993A1 1 0 0 1 2.992 3h18.016c.548 0 .992.445.992.993v16.014a1 1 0 0 1-.992.993zM20 15V5H4v14L14 9zm0 2.828l-6-6L6.828 19H20zM8 11a2 2 0 1 1 0-4a2 2 0 0 1 0 4\"/>", width: 24, height: 24 },
  code: { body: "<path fill=\"currentColor\" d=\"m23 12l-7.071 7.071l-1.414-1.414L20.172 12l-5.657-5.657l1.414-1.414zM3.828 12l5.657 5.657l-1.414 1.414L1 12l7.071-7.071l1.414 1.414z\"/>", width: 24, height: 24 },
  terminal: { body: "<path fill=\"currentColor\" d=\"M3 3h18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1m1 2v14h16V5zm8 10h6v2h-6zm-3.333-3L5.838 9.172l1.415-1.415L11.495 12l-4.242 4.243l-1.415-1.415z\"/>", width: 24, height: 24 },
  pencil: { body: "<path fill=\"currentColor\" d=\"m15.728 9.576l-1.414-1.414L5 17.476v1.414h1.414zm1.414-1.414l1.414-1.414l-1.414-1.414l-1.414 1.414zm-9.9 12.728H3v-4.243L16.435 3.212a1 1 0 0 1 1.414 0l2.829 2.829a1 1 0 0 1 0 1.414z\"/>", width: 24, height: 24 },
  glob: { body: "<path fill=\"currentColor\" d=\"M4 18v-3.7a1.5 1.5 0 0 0-1.5-1.5H2v-1.6h.5A1.5 1.5 0 0 0 4 9.7V6a3 3 0 0 1 3-3h1v2H7a1 1 0 0 0-1 1v4.1A2 2 0 0 1 4.626 12A2 2 0 0 1 6 13.9V18a1 1 0 0 0 1 1h1v2H7a3 3 0 0 1-3-3m16-3.7V18a3 3 0 0 1-3 3h-1v-2h1a1 1 0 0 0 1-1v-4.1a2 2 0 0 1 1.374-1.9A2 2 0 0 1 18 10.1V6a1 1 0 0 0-1-1h-1V3h1a3 3 0 0 1 3 3v3.7a1.5 1.5 0 0 0 1.5 1.5h.5v1.6h-.5a1.5 1.5 0 0 0-1.5 1.5\"/>", width: 24, height: 24 },
  globe: { body: "<path fill=\"currentColor\" d=\"M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m-2.29-2.333A17.9 17.9 0 0 1 8.027 13H4.062a8.01 8.01 0 0 0 5.648 6.667M10.03 13c.151 2.439.848 4.73 1.97 6.752A15.9 15.9 0 0 0 13.97 13zm9.908 0h-3.965a17.9 17.9 0 0 1-1.683 6.667A8.01 8.01 0 0 0 19.938 13M4.062 11h3.965A17.9 17.9 0 0 1 9.71 4.333A8.01 8.01 0 0 0 4.062 11m5.969 0h3.938A15.9 15.9 0 0 0 12 4.248A15.9 15.9 0 0 0 10.03 11m4.259-6.667A17.9 17.9 0 0 1 15.973 11h3.965a8.01 8.01 0 0 0-5.648-6.667\"/>", width: 24, height: 24 },
  "check-list": { body: "<path fill=\"currentColor\" d=\"M8 4h13v2H8zm-5-.5h3v3H3zm0 7h3v3H3zm0 7h3v3H3zM8 11h13v2H8zm0 7h13v2H8z\"/>", width: 24, height: 24 },
  bolt: { body: "<path fill=\"currentColor\" d=\"M13 9h8L11 24v-9H4l9-15zm-2 2V7.22L7.532 13H13v4.394L17.263 11z\"/>", width: 24, height: 24 },
  "git-pull-request": { body: "<path fill=\"currentColor\" d=\"M15 5h2a2 2 0 0 1 2 2v8.17a3.001 3.001 0 1 1-2 0V7h-2v3l-4.5-4L15 2zM5 8.83a3.001 3.001 0 1 1 2 0v6.34a3.001 3.001 0 1 1-2 0zM6 7a1 1 0 1 0 0-2a1 1 0 0 0 0 2m0 12a1 1 0 1 0 0-2a1 1 0 0 0 0 2m12 0a1 1 0 1 0 0-2a1 1 0 0 0 0 2\"/>", width: 24, height: 24 },
  message: { body: "<path fill=\"currentColor\" d=\"M6.455 19L2 22.5V4a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1zm-.692-2H20V5H4v13.385zM8 10h8v2H8z\"/>", width: 24, height: 24 },
  mail: { body: "<path fill=\"currentColor\" d=\"M3 3h18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1m17 4.238l-7.928 7.1L4 7.216V19h16zM4.511 5l7.55 6.662L19.502 5z\"/>", width: 24, height: 24 },
  user: { body: "<path fill=\"currentColor\" d=\"M4 22a8 8 0 1 1 16 0h-2a6 6 0 0 0-12 0zm8-9c-3.315 0-6-2.685-6-6s2.685-6 6-6s6 2.685 6 6s-2.685 6-6 6m0-2c2.21 0 4-1.79 4-4s-1.79-4-4-4s-4 1.79-4 4s1.79 4 4 4\"/>", width: 24, height: 24 },
  info: { body: "<path fill=\"currentColor\" d=\"M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m0-2a8 8 0 1 0 0-16a8 8 0 0 0 0 16M11 7h2v2h-2zm0 4h2v6h-2z\"/>", width: 24, height: 24 },
  "help-circle": { body: "<path fill=\"currentColor\" d=\"M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m0-2a8 8 0 1 0 0-16a8 8 0 0 0 0 16m-1-5h2v2h-2zm2-1.645V14h-2v-1.5a1 1 0 0 1 1-1a1.5 1.5 0 1 0-1.471-1.794l-1.962-.393A3.501 3.501 0 1 1 13 13.355\"/>", width: 24, height: 24 },
  "alert-triangle": { body: "<path fill=\"currentColor\" d=\"m12.866 3l9.526 16.5a1 1 0 0 1-.866 1.5H2.474a1 1 0 0 1-.866-1.5L11.134 3a1 1 0 0 1 1.732 0m-8.66 16h15.588L12 5.5zM11 16h2v2h-2zm0-7h2v5h-2z\"/>", width: 24, height: 24 },
  clock: { body: "<path fill=\"currentColor\" d=\"M12 22C6.477 22 2 17.523 2 12S6.477 2 12 2s10 4.477 10 10s-4.477 10-10 10m0-2a8 8 0 1 0 0-16a8 8 0 0 0 0 16m1-8h4v2h-6V7h2z\"/>", width: 24, height: 24 },
  sparkles: { body: "<path fill=\"currentColor\" d=\"M14 4.438A2.437 2.437 0 0 0 16.438 2h1.125A2.437 2.437 0 0 0 20 4.438v1.125A2.437 2.437 0 0 0 17.563 8h-1.125A2.437 2.437 0 0 0 14 5.563zM1 11a6 6 0 0 0 6-6h2a6 6 0 0 0 6 6v2a6 6 0 0 0-6 6H7a6 6 0 0 0-6-6zm3.876 1A8.04 8.04 0 0 1 8 15.124A8.04 8.04 0 0 1 11.124 12A8.04 8.04 0 0 1 8 8.876A8.04 8.04 0 0 1 4.876 12m12.374 2A3.25 3.25 0 0 1 14 17.25v1.5A3.25 3.25 0 0 1 17.25 22h1.5A3.25 3.25 0 0 1 22 18.75v-1.5A3.25 3.25 0 0 1 18.75 14z\"/>", width: 24, height: 24 },
  play: { body: "<path fill=\"currentColor\" d=\"M19.376 12.416L8.777 19.482A.5.5 0 0 1 8 19.066V4.934a.5.5 0 0 1 .777-.416l10.599 7.066a.5.5 0 0 1 0 .832\"/>", width: 24, height: 24 },
  stop: { body: "<path fill=\"currentColor\" d=\"M6 5h12a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1\"/>", width: 24, height: 24 },
  star: { body: "<path fill=\"currentColor\" d=\"m12 18.26l-7.053 3.948l1.575-7.928L.588 8.792l8.027-.952L12 .5l3.385 7.34l8.027.952l-5.934 5.488l1.575 7.928z\"/>", width: 24, height: 24 },
  "star-outline": { body: "<path fill=\"currentColor\" d=\"m12 18.26l-7.053 3.948l1.575-7.928L.588 8.792l8.027-.952L12 .5l3.385 7.34l8.027.952l-5.934 5.488l1.575 7.928zm0-2.292l4.247 2.377l-.948-4.773l3.573-3.305l-4.833-.573l-2.038-4.419l-2.039 4.42l-4.833.572l3.573 3.305l-.948 4.773z\"/>", width: 24, height: 24 },
  "dots-horizontal": { body: "<path fill=\"currentColor\" d=\"M4.5 10.5c-.825 0-1.5.675-1.5 1.5s.675 1.5 1.5 1.5S6 12.825 6 12s-.675-1.5-1.5-1.5m15 0c-.825 0-1.5.675-1.5 1.5s.675 1.5 1.5 1.5S21 12.825 21 12s-.675-1.5-1.5-1.5m-7.5 0c-.825 0-1.5.675-1.5 1.5s.675 1.5 1.5 1.5s1.5-.675 1.5-1.5s-.675-1.5-1.5-1.5\"/>", width: 24, height: 24 },
};
