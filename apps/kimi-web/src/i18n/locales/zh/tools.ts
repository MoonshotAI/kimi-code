export default {
  label: {
    read: '读取',
    bash: '运行',
    edit: '编辑',
    write: '写入',
    grep: '搜索',
    glob: '查找',
    ls: '列目录',
    web_fetch: '抓取',
    search: '搜索',
    todo: '待办',
    task: '任务',
  },
  chip: {
    lines: '{count} 行',
    results: '{count} 结果',
    edited: '已编辑',
    created: '已创建',
    todos: '{count} 项',
  },
  group: {
    title: '{count} 个工具调用',
    running: '运行中',
    error: '有失败',
    done: '已完成',
  },
} as const;
