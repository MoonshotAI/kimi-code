export default {
  /** Shared title of the right-side panel — both occupants are previews. */
  preview: '预览',
  /** Generic confirm / cancel button labels (used by ConfirmDialog). */
  confirm: '确认',
  cancel: '取消',
  /** app-ui 通用控件的无障碍标签（关闭按钮、加载指示等）。 */
  close: '关闭',
  dismiss: '关闭',
  loading: '加载中',
  copy: '复制',
  /** 错误边界 fallback 文案（components/ErrorBoundary.vue）。 */
  errorBoundaryTitle: '出错了',
  errorBoundaryRetry: '重试',
  /** defineAsyncComponent 的 errorComponent（如设计规范覆盖层）。 */
  asyncLoadFailed: '加载失败，请关闭后重试',
} as const;
