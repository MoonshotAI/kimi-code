// PR 预览（仅 desktop dev 构建）：PrPreviewIndicator.vue 的文案。
// web 不渲染该组件；key 放共享包遵循 terminal.* 先例（docs/native-todos.md）。
export default {
  /** 侧栏 pill（空闲态）与对话框标题。 */
  title: 'PR 预览',
  intro: '在隔离 worktree 中构建本仓库某个 PR 的代码，并把它的界面加载进当前窗口。首次构建可能需要几分钟。',
  prLabel: 'PR 编号',
  prPlaceholder: '例如 123',
  invalidPr: '请输入有效的 PR 编号',
  start: '开始预览',
  cleanup: '清理预览缓存',
  cleanupConfirm: '删除除当前预览外的全部 PR 预览缓存？下次预览时会按需重新构建。',
  cleanupDone: '已清理 {count} 个预览缓存',
  fetching: '正在拉取 PR #{pr} 的代码…',
  installing: '正在安装依赖…',
  building: '正在构建渲染产物…',
  activeText: '正在预览 PR #{pr}',
  stop: '退出预览',
  rebuild: '重新拉取构建',
  errorTitle: '预览失败',
  retry: '重试',
  /** 阶段名，用于失败/卡死文案（errorStage）。 */
  stageFetch: '拉取 PR 代码',
  stageInstall: '安装依赖',
  stageBuild: '构建渲染产物',
  stageFailed: '{stage}失败',
  stageHung: '{stage}时卡住超过 5 分钟，已终止（请检查网络/代理）',
} as const;
