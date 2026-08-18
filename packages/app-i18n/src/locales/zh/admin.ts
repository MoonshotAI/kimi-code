// 会话管理页（/admin/sessions）——侧边栏「列表管理」菜单进入的跨工作空间管理视图。
// key 按页面区域分组，后续阶段按组扩展，不挪已有 key：
//   title/subtitle  页头
//   筛选栏          filter* / allWorkspaces / selectAll / searchWorkspace /
//                   noWorkspaceMatch / removeTag / status* / time*
//   表格            col* / empty / loading
//   分页            total / pageSize / prevPage / nextPage
//   多选+批量       selectPageAll / batch* / markDone(Count) / reopen(Count) /
//                   undo
//   行操作/右键     open / rename / fork / export / moreActions
export default {
  title: '会话管理',
  subtitle: '管理所有会话，把任务完成的会话标记完成。旧会话按更新时间筛选，即可批量清理。',
  // 描述行返回按钮（回到进入前的聊天视图）
  back: '返回',

  // 筛选栏
  filterWorkspace: '工作空间',
  filterStatus: '状态',
  filterTime: '更新时间',
  allWorkspaces: '全部工作空间',
  selectAll: '全选',
  // 工作空间多选：菜单首行搜索框、无匹配提示、触发器标签的移除按钮
  searchWorkspace: '搜索工作空间',
  noWorkspaceMatch: '没有匹配的工作空间',
  removeTag: '移除 {name}',
  statusAll: '全部状态',
  statusOpen: '进行中',
  statusDone: '已完成',
  // 更新时间 preset（最后更新在 N 天以前）
  timeAll: '全部时间',
  timeDaysAgo: '{n} 天以前',
  // 查询制按钮（筛选草稿只在点击后应用）
  query: '查询',
  reset: '重置',

  // 表格
  colStatus: '状态',
  colTitle: '会话名',
  colWorkspace: '工作空间',
  colPrompt: '最后一条 prompt',
  colUpdated: '最后更新',
  colCompleted: '完成时间',
  colActions: '操作',
  empty: '没有符合当前筛选条件的会话',
  loading: '加载中…',

  // 分页
  total: '共 {n} 条',
  pageSize: '{n} 条/页',
  prevPage: '上一页',
  nextPage: '下一页',

  // 多选 + 批量（P3）：表头 checkbox、批量条、toast
  selectPageAll: '全选本页',
  batchSelected: '已选 {n} 项',
  // 全选匹配（Gmail 式：全选本页后出现在批量条里的链接/态）
  selectAllMatching: '选中当前条件下的全部 {total} 项',
  materializingAll: '正在选中…',
  allMatchingSelected: '已选中全部 {n} 项',
  clearSelection: '清除选择',
  markDone: '标记完成',
  reopen: '恢复进行中',
  markDoneCount: '标记完成（{n}）',
  reopenCount: '恢复进行中（{n}）',
  // 批量 toast——计数随参数接入
  batchDoneToast: '已标记完成 {n} 个会话',
  batchReopenedToast: '已将 {n} 个会话恢复为进行中',
  batchFailedSuffix: '，{n} 个失败',
  batchDoneFailedNotice: '{n} 个会话未能标记完成',
  batchReopenFailedNotice: '{n} 个会话未能恢复为进行中',
  undo: '撤销',

  // 行操作 + 右键菜单（P3）
  open: '打开会话',
  rename: '重命名…',
  fork: 'Fork',
  export: '导出',
  moreActions: '更多操作',
} as const;
