export default {
  // Switcher
  switcherTitle: '切换工作区',
  switchTooltip: '切换工作区',
  eyebrow: '工作区',
  branchLabel: '分支: {branch}',
  noBranch: '无分支',
  sessionCount: '{count} 个会话',
  allWorkspaces: '全部工作区',
  currentWorkspace: '仅当前工作区',
  addWorkspace: '添加工作区…',
  noWorkspace: '暂无工作区',
  deleteHasSessions: '工作区内还有会话，请先归档这些会话再删除',
  // 二次确认（弹窗）
  removeWorkspaceConfirm: '移除工作区「{name}」？',
  swarmEnableConfirm: '启用 swarm 模式？Agent 将并行运行多个子 agent。',
  goalStartConfirm: '启动 goal：「{objective}」？Agent 将自主执行。',
  // Column-header scope toggle
  scopeCurrent: '当前工作区',
  scopeAll: '全部工作区',
  // Group headers (all-workspaces scope)
  newInGroup: '在此工作区新建会话',
  // Add-workspace dialog
  addTitle: '添加工作区',
  recentLabel: '最近的文件夹',
  cancel: '取消',
  addFailed: '无法打开此文件夹，请检查路径后重试。',
  // Folder browser
  openThisFolder: '打开此文件夹',
  up: '上一级',
  browsing: '加载中…',
  filterPlaceholder: '过滤子文件夹…',
  searchPlaceholder: '模糊搜索子文件夹，或粘贴绝对路径…',
  searching: '搜索中…',
  noFilterMatch: '没有匹配「{q}」的子文件夹',
  noSubfolders: '此处没有子文件夹',
  browseHint: '点击文件夹进入，再点"打开此文件夹"将其添加为工作区。',
  // Path entry (absolute path typed into the same box)
  checkingPath: '检查路径…',
  pathPickHint: '此路径不存在，你是不是想找：',
  noPathMatch: '此路径不存在，「{parent}」下没有匹配的文件夹',
  badParent: '上级目录不存在：{parent}',
  pathFollowHint: '已定位到目标文件夹，按回车或点击"打开此文件夹"完成添加。',
  degradedPlaceholder: '输入绝对路径，回车添加…',
  degradedHint: '守护进程无法浏览文件系统，请直接输入绝对路径后回车添加。',
  // Attention marker
  attentionTitle: '{count} 项待处理',
  // Per-session pending tags (sidebar)
  awaitingAnswer: '待回答',
  awaitingAnswerTitle: '有提问等待你回答',
  awaitingPermission: '待授权',
  awaitingPermissionTitle: '有操作等待你授权',
  aborted: '已中断',
  abortedTitle: '此会话在完成前被中断',
};
