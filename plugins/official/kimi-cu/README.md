# Kimi Computer Use

让 AI agent 在 macOS 上安静地操作图形界面：读取任意 app 的界面状态（无障碍树 + 截图），并在后台完成点击、输入、滚动、拖拽 —— 全程不移动你的鼠标、不把目标 app 切到前台，你可以继续正常使用电脑。

## 前置：安装 KimiCU.app

本插件依赖本机已安装的 KimiCU.app。一键安装：

```bash
curl -fsSL https://cdn.kimi.com/kimi-computer-use/latest/setup_macos.sh | bash
```

安装后，在 **系统设置 → 隐私与安全性** 中为 KimiCU 开启 **辅助功能** 与 **屏幕录制**。

## 工具

`list_apps` · `get_app_state` · `click` · `type_text` · `press_key` · `scroll` · `set_value` · `perform_secondary_action` · `select_text` · `drag`
