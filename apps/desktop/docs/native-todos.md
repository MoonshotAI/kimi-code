# 桌面端原生功能待办与已知限制

## 已知限制

- **全局截屏标注（`src/main/screenshot.ts`）不支持 Linux Wayland**：portal 原生选择器驱动，Electron `desktopCapturer` 拿不到冻帧（见 [Electron 官方 Caveats](https://www.electronjs.org/docs/latest/api/desktop-capturer)）。Linux 下入口（composer add-menu 的「截屏」项）应当隐藏或降级提示；X11 理论可用但未列入验收。
