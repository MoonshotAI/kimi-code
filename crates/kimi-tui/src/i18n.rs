//! Minimal i18n for the Rust TUI — a locale-aware `t()` over a built-in
//! en/zh dictionary. The key space (`tui.*`) is self-contained in Rust and
//! is the source of truth for the TUI's own strings (no TS dependency),
//! matching the migration direction where i18n data eventually lives in
//! Rust. Messages carry `{0}`-style positional placeholders; call sites use
//! `t!("key", …)` (a macro wrapper over `format!`-style runtime templates).
//!
//! The active locale is resolved once from `tui.toml` (`locale` field) on
//! first use; `set_locale` overrides it (the future `/locale` command).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// The supported UI locales.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    /// English (the default; also the fallback for missing entries).
    En,
    /// Simplified Chinese.
    Zh,
}

impl Locale {
    /// Parse a locale string (`en` / `zh`); anything else is `En`.
    pub fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("zh") => Locale::Zh,
            _ => Locale::En,
        }
    }
}

/// The active locale plus whether it has been resolved from config yet.
/// A `Mutex` (not `OnceLock`) so `set_locale` can genuinely switch locales
/// (the future `/locale` command) and tests stay independent.
static LOCALE: Mutex<Locale> = Mutex::new(Locale::En);
static LOCALE_RESOLVED: AtomicBool = AtomicBool::new(false);

/// Re-read `tui.toml` on the next `active_locale()` (the `/reload-tui`
/// command).
pub fn reload_locale() {
    LOCALE_RESOLVED.store(false, Ordering::Relaxed);
}

/// Override the active locale (persisted via tui.toml by the caller).
pub fn set_locale(locale: Locale) {
    *LOCALE.lock().unwrap() = locale;
    LOCALE_RESOLVED.store(true, Ordering::Relaxed);
}

/// The active locale; reads `tui.toml` on first use.
pub fn active_locale() -> Locale {
    let mut guard = LOCALE.lock().unwrap();
    if !LOCALE_RESOLVED.load(Ordering::Relaxed) {
        *guard = locale_from_config();
        LOCALE_RESOLVED.store(true, Ordering::Relaxed);
    }
    *guard
}

/// Resolve the locale from `~/.kimi-code/tui.toml` (`locale` field).
fn locale_from_config() -> Locale {
    let Some(path) = crate::theme::tui_config_path() else {
        return Locale::En;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Locale::En;
    };
    let Ok(value) = text.parse::<toml::Value>() else {
        return Locale::En;
    };
    Locale::parse(value.get("locale").and_then(|v| v.as_str()))
}

/// Persist the `locale` field to `tui.toml` (creates the file when absent)
/// so the choice survives restarts.
pub fn save_locale(locale: Locale) -> anyhow::Result<()> {
    let key = match locale {
        Locale::En => "en",
        Locale::Zh => "zh",
    };
    crate::theme::set_tui_config_field("locale", toml::Value::String(key.to_string()))
}

/// Look up `key` in the dictionary for the active locale. Falls back to the
/// key itself when missing — a visible signal that the entry is absent.
/// Linear scan: the dictionary is small (~100 entries) and grouped by
/// topic, so entries don't need to stay sorted.
pub fn t(key: &str) -> &str {
    t_for(active_locale(), key)
}

/// Locale-explicit lookup (pure — used by tests and hosts that pass a
/// concrete locale).
pub fn t_for(locale: Locale, key: &str) -> &str {
    match MESSAGES.iter().find(|(k, _, _)| *k == key) {
        Some((_, en, zh)) => match locale {
            Locale::En => en,
            Locale::Zh => zh,
        },
        None => key,
    }
}

/// Format a localized template (`{0}`-style positional placeholders) with
/// the given arguments. Unknown keys fall back to the key itself.
pub fn t_fmt(key: &str, args: &[String]) -> String {
    t_fmt_for(active_locale(), key, args)
}

/// Locale-explicit template formatting (pure — used by tests).
pub fn t_fmt_for(locale: Locale, key: &str, args: &[String]) -> String {
    let tpl = t_for(locale, key);
    if args.is_empty() {
        return tpl.to_string();
    }
    let mut out = String::with_capacity(tpl.len());
    let mut rest = tpl;
    while let Some(start) = rest.find('{') {
        // Only `{digit}` placeholders are substituted; anything else passes
        // through verbatim (e.g. literal braces in the template).
        let Some(end_rel) = rest[start + 1..].find('}') else {
            out.push_str(rest);
            return out;
        };
        let end = start + 1 + end_rel;
        match rest[start + 1..end].parse::<usize>().ok().and_then(|i| args.get(i)) {
            Some(arg) => {
                out.push_str(&rest[..start]);
                out.push_str(arg);
                rest = &rest[end + 1..];
            }
            None => {
                out.push_str(&rest[..=end]);
                rest = &rest[end + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `t!("key", arg1, arg2)` — localized, positionally-formatted text.
/// `format!` needs a literal format string, so runtime templates go through
/// this macro instead.
#[macro_export]
macro_rules! t {
    ($key:expr $(, $arg:expr)* $(,)?) => {
        $crate::i18n::t_fmt($key, &[$( $arg.to_string() ),*])
    };
}

/// `(key, en, zh)`, sorted by key for binary search. Placeholders use
/// `{0}`-style positional references, filled by `t!("key", …)`.
static MESSAGES: &[(&str, &str, &str)] = &[
    // ── Startup ────────────────────────────────────────────────────────
    ("tui.start.loggedIn", "kimi auth: logged in", "kimi 认证：已登录"),
    ("tui.start.notLoggedIn", "not logged in — type /login to authenticate", "未登录 — 输入 /login 进行认证"),
    ("tui.start.sessionReady", "session {0} ready — type /help", "会话 {0} 已就绪 — 输入 /help"),
    // ── General / help ─────────────────────────────────────────────────
    ("tui.help.commands", "commands: {0}", "命令：{0}"),
    ("tui.help.detailHint", "type /help <command> for a command's description", "输入 /help <命令> 查看单个命令的说明"),
    ("tui.help.unknown", "unknown command {0} — try /help", "未知命令 {0} — 输入 /help"),
    ("tui.err.unknownCommand", "unknown command {0} — try /help", "未知命令 {0} — 输入 /help"),
    ("tui.err.generic", "error: {0}", "错误：{0}"),
    ("tui.status.plan", "plan mode {0}", "计划模式{0}"),
    ("tui.status.swarm", "swarm mode {0}", "群组模式{0}"),
    ("tui.status.on", "on", "已开启"),
    ("tui.status.off", "off", "已关闭"),
    ("tui.plan.cleared", "plan mode cleared", "已清除计划模式"),
    ("tui.copy.none", "no assistant message to copy", "没有可复制的助手消息"),
    ("tui.copy.ok", "copied {0} chars to the clipboard", "已复制 {0} 个字符到剪贴板"),
    ("tui.err.copyFailed", "copy failed: {0}", "复制失败：{0}"),
    ("tui.exportMd.done", "exported to {0}", "已导出到 {0}"),
    ("tui.err.exportMdFailed", "export failed: {0}", "导出失败：{0}"),
    // ── Approvals ──────────────────────────────────────────────────────
    ("tui.approval.none", "no pending approvals", "没有待处理的审批"),
    ("tui.approval.listItem", "{0}  {1}  ({2})", "{0}  {1}  ({2})"),
    ("tui.approval.modalHint", "y = allow    n = deny    s = allow for session    Esc = close", "y=允许    n=拒绝    s=本会话允许    Esc=关闭"),
    ("tui.question.replyHint", "reply with a number, or free text", "输入数字或自由文本回答"),
    ("tui.approval.approveUsage", "usage: /approve <approval-id>", "用法：/approve <审批ID>"),
    ("tui.approval.denyUsage", "usage: /deny <approval-id>", "用法：/deny <审批ID>"),
    ("tui.approval.allowed", "approval allowed", "已允许该审批"),
    ("tui.approval.denied", "approval denied", "已拒绝该审批"),
    ("tui.approval.notFound", "approval not found", "未找到该审批"),
    ("tui.approval.requested", "approval requested: {0} ({1}) {2} — y/n, v=details, s=for-session", "审批请求：{0} ({1}) {2} — y=允许，n=拒绝，v=详情，s=本会话允许"),
    ("tui.approval.inspect", "approval requested — run /approvals to inspect", "有审批请求 — 运行 /approvals 查看"),
    ("tui.approval.ruleLabel", "Always allow", "始终允许"),
    ("tui.approval.allowedForSession", "{0} approved for session ({1} will auto-approve)", "{0} 已为本会话批准（{1} 将自动批准）"),
    ("tui.approval.noLongerPending", "{0} no longer pending", "{0} 不再待处理"),
    ("tui.approval.allowedAction", "{0} allowed", "{0} 已允许"),
    ("tui.approval.deniedAction", "{0} denied", "{0} 已拒绝"),
    // ── Status / info ───────────────────────────────────────────────────
    ("tui.status.summary", "model: {0} | mode: {1} | permission: {2} | thinking: {3} | ctx: {4}/{5}", "模型：{0} | 模式：{1} | 权限：{2} | 思考：{3} | 上下文：{4}/{5}"),
    ("tui.info.version", "kimi {0} — session {1}", "kimi {0} — 会话 {1}"),
    ("tui.err.infoFailed", "info failed: {0}", "info 失败：{0}"),
    ("tui.usage.session", "usage: /session [set <title>]", "用法：/session [set <标题>]"),
    ("tui.status.sessionId", "session {0}", "会话 {0}"),
    ("tui.status.sessionSet", "session {0}", "会话 {0}"),
    ("tui.err.renameFailed", "rename failed: {0}", "重命名失败：{0}"),
    ("tui.status.modelSummary", "model: {0}", "模型：{0}"),
    ("tui.status.modeSummary", "mode: {0}", "模式：{0}"),
    // ── Plugins ─────────────────────────────────────────────────────────
    ("tui.plugins.none", "no plugins installed", "未安装插件"),
    ("tui.plugins.list", "plugins ({0}): {1}", "插件（{0}）：{1}"),
    ("tui.err.pluginsFailed", "plugins failed: {0}", "插件操作失败：{0}"),
    ("tui.plugins.enabled", "enabled {0}", "已启用 {0}"),
    ("tui.plugins.disabled", "disabled {0}", "已禁用 {0}"),
    ("tui.plugins.removed", "removed {0}", "已移除 {0}"),
    ("tui.plugins.notFound", "removed {0} (not found)", "已移除 {0}（未找到）"),
    ("tui.plugins.reloaded", "plugins reloaded", "插件已重载"),
    ("tui.plugins.installed", "installed {0}", "已安装 {0}"),
    ("tui.plugins.usage", "usage: /plugins [list|enable|disable|remove|reload|install <source>]", "用法：/plugins [list|enable|disable|remove|reload|install <来源>]"),
    // ── Config / skills ─────────────────────────────────────────────────
    ("tui.config.show", "config: {0}", "配置：{0}"),
    ("tui.err.configFailed", "config failed: {0}", "读取配置失败：{0}"),
    ("tui.skills.none", "no skills registered", "没有注册的技能"),
    ("tui.skills.selected", "{0}: {1}", "{0}：{1}"),
    ("tui.skills.cancelled", "skill selection cancelled", "已取消技能选择"),
    ("tui.err.skillsFailed", "skills failed: {0}", "技能列表失败：{0}"),
    // ── Thinking / permission ───────────────────────────────────────────
    ("tui.thinking.usage", "usage: /thinking <low|medium|high>", "用法：/thinking <low|medium|high>"),
    ("tui.thinking.set", "thinking effort set to {0}", "思考强度已设为 {0}"),
    ("tui.permission.mode", "permission mode: {0}", "权限模式：{0}"),
    ("tui.permission.cancelled", "permission selection cancelled", "已取消权限选择"),
    ("tui.permission.yolo", "yolo mode {0}", "YOLO 模式{0}"),
    ("tui.permission.auto", "auto mode {0}", "自动模式{0}"),
    // ── Session lifecycle ───────────────────────────────────────────────
    ("tui.session.initialized", "session initialized (agents.md)", "会话已初始化（agents.md）"),
    ("tui.title.usage", "usage: /title <title>", "用法：/title <标题>"),
    ("tui.title.set", "session title: {0}", "会话标题：{0}"),
    ("tui.mcp.none", "no MCP servers configured", "没有配置 MCP 服务器"),
    ("tui.mcp.list", "MCP servers: {0}", "MCP 服务器：{0}"),
    ("tui.err.mcpFailed", "mcp failed: {0}", "MCP 操作失败：{0}"),
    ("tui.tasks.none", "no background tasks", "没有后台任务"),
    ("tui.tasks.listItem", "{0}  {1}  [{2}]", "{0}  {1}  [{2}]"),
    ("tui.tasks.noOutput", "task {0} has no output", "任务 {0} 没有输出"),
    ("tui.theme.set", "theme: {0}", "主题：{0}"),
    ("tui.theme.dark", "dark", "深色"),
    ("tui.theme.light", "light", "浅色"),
    ("tui.theme.auto", "auto", "自动"),
    ("tui.theme.usage", "usage: /theme <dark|light|auto>", "用法：/theme <dark|light|auto>"),
    ("tui.theme.cancelled", "theme selection cancelled", "已取消主题选择"),
    ("tui.picker.selectTheme", "select a theme", "选择主题"),
    ("tui.version.show", "kimi version: {0}", "kimi 版本：{0}"),
    ("tui.err.versionFailed", "version failed: {0}", "获取版本失败：{0}"),
    ("tui.models.none", "no model aliases configured", "没有配置模型别名"),
    ("tui.models.default", "default: {0}", "默认：{0}"),
    ("tui.models.set", "model set to {0}", "模型已设为 {0}"),
    ("tui.models.cancelled", "model selection cancelled", "已取消模型选择"),
    ("tui.reload.ok", "session reloaded", "会话已重载"),
    ("tui.err.reloadFailed", "reload failed: {0}", "重载失败：{0}"),
    ("tui.resume.usage", "usage: /resume <session-id>", "用法：/resume <会话ID>"),
    ("tui.resume.switched", "switched to session {0}", "已切换到会话 {0}"),
    // ── Goal ────────────────────────────────────────────────────────────
    ("tui.goal.usage", "usage: /goal <objective> | status|pause|resume|cancel|replace|next", "用法：/goal <目标> | status|pause|resume|cancel|replace|next"),
    ("tui.goal.status", "goal status: {0}", "目标状态：{0}"),
    ("tui.goal.paused", "goal paused", "目标已暂停"),
    ("tui.goal.resumed", "goal resumed", "目标已恢复"),
    ("tui.goal.cancelled", "goal cancelled", "目标已取消"),
    ("tui.goal.replaceUsage", "usage: /goal replace <objective>", "用法：/goal replace <目标>"),
    ("tui.goal.replaced", "goal replaced: {0}", "目标已替换：{0}"),
    ("tui.goal.created", "goal created: {0}", "目标已创建：{0}"),
    ("tui.goal.nextUnsupported", "goal queueing is not supported in the Rust TUI — use a plain objective", "Rust TUI 不支持目标排队 — 请直接输入目标"),
    ("tui.goal.show", "goal: {0}", "目标：{0}"),
    ("tui.goal.queued", "queued goal: {0} ({1} queued)", "已排队目标：{0}（队列 {1}）"),
    ("tui.goal.queueUsage", "usage: /goal next <objective> | manage | remove <id> | move <id> up|down | promote", "用法：/goal next <目标> | manage | remove <ID> | move <ID> up|down | promote"),
    ("tui.goal.queueEmpty", "no queued goals", "队列中没有目标"),
    ("tui.goal.queueList", "queued goals ({0}):", "排队目标（{0}）："),
    ("tui.goal.queueItem", "{0}  {1}", "{0}  {1}"),
    ("tui.goal.removed", "removed queued goal {0}", "已移除排队目标 {0}"),
    ("tui.goal.removedNotFound", "queued goal {0} not found", "未找到排队目标 {0}"),
    ("tui.goal.moved", "moved queued goal {0}", "已移动排队目标 {0}"),
    ("tui.goal.promoted", "promoted queued goal: {0}", "已提升排队目标：{0}"),
    ("tui.goal.noQueued", "no queued goals to promote", "没有可提升的排队目标"),
    // ── Context / history ───────────────────────────────────────────────
    ("tui.addDir.added", "added dir {0}", "已添加目录 {0}"),
    ("tui.err.addDirFailed", "add-dir failed: {0}", "add-dir 失败：{0}"),
    ("tui.addDir.usage", "usage: /add-dir <path>", "用法：/add-dir <路径>"),
    ("tui.clear.ok", "context cleared", "上下文已清空"),
    ("tui.compact.ok", "context compacted", "上下文已压缩"),
    ("tui.err.compactFailed", "compact failed: {0}", "压缩失败：{0}"),
    ("tui.undo.result", "undo: {0}", "撤销：{0}"),
    ("tui.usage.none", "usage: no tokens recorded", "用量：暂无 token 记录"),
    ("tui.usage.total", "usage: {0} total ({1} in / {2} out)", "用量：共 {0}（输入 {1} / 输出 {2}）"),
    ("tui.usage.context", "context: {0}/{1} tokens ({2}%)", "上下文：{0}/{1} tokens（{2}%）"),
    ("tui.fork.usage", "usage: /fork <new-session-id>", "用法：/fork <新会话ID>"),
    ("tui.fork.done", "forked to {0}", "已分叉到 {0}"),
    ("tui.steer.usage", "usage: /steer <text>", "用法：/steer <文本>"),
    ("tui.steer.queued", "steer queued: {0}", "已排队引导：{0}"),
    ("tui.import.usage", "usage: /import <text>", "用法：/import <文本>"),
    ("tui.import.done", "imported {0} chars", "已导入 {0} 个字符"),
    // ── Sessions / export / archive ─────────────────────────────────────
    ("tui.sessions.none", "no sessions", "没有会话"),
    ("tui.sessions.cancelled", "session selection cancelled", "已取消会话选择"),
    ("tui.sessions.switched", "session: {0}", "会话：{0}"),
    ("tui.export.done", "exported to {0} ({1} bytes)", "已导出到 {0}（{1} 字节）"),
    ("tui.err.exportWrite", "write failed: {0}", "写入失败：{0}"),
    ("tui.err.exportFailed", "export failed: {0}", "导出失败：{0}"),
    ("tui.archive.ok", "session archived", "会话已归档"),
    ("tui.err.archiveNotFound", "archive: session not found", "归档：未找到该会话"),
    ("tui.err.archiveFailed", "archive failed: {0}", "归档失败：{0}"),
    ("tui.err.archiveNoSession", "archive: no active session", "归档：没有活动会话"),
    // ── Auth ────────────────────────────────────────────────────────────
    ("tui.auth.already", "already logged in", "已登录"),
    ("tui.auth.openUrl", "open {0} and enter code {1}", "打开 {0} 并输入代码 {1}"),
    ("tui.auth.abandoned", "login abandoned", "已放弃登录"),
    ("tui.auth.ok", "logged in", "已登录"),
    ("tui.err.loginFailed", "login failed: {0}", "登录失败：{0}"),
    ("tui.auth.loggedOut", "logged out", "已退出登录"),
    ("tui.err.logoutFailed", "logout failed: {0}", "退出登录失败：{0}"),
    // ── Turn lifecycle ──────────────────────────────────────────────────
    ("tui.turn.cancelled", "turn cancelled", "已取消本轮"),
    ("tui.turn.exitConfirm", "press Ctrl-C again to exit", "再按一次 Ctrl-C 退出"),
    ("tui.turn.summary", "… {0} tools · {1} messages", "… {0} 次工具调用 · {1} 条消息"),
    ("tui.shell.done", "command finished", "命令执行完成"),
    ("tui.err.shellFailed", "shell failed: {0}", "命令执行失败：{0}"),
    ("tui.paste.image", "pasted image #{0} (Alt-V)", "已粘贴图片 #{0}（Alt-V）"),
    ("tui.paste.noImage", "no image on the clipboard", "剪贴板中没有图片"),
    ("tui.discuss.usage", "usage: /discuss <topic> [with <role1>,<role2>,...] [--debate]", "用法：/discuss <话题> [with <角色1>,<角色2>,...] [--debate]"),
    ("tui.discuss.needTopic", "discuss: need a topic", "讨论：需要一个话题"),
    ("tui.discuss.needRoles", "discuss: need at least 2 roles", "讨论：至少需要 2 个角色"),
    ("tui.err.discussSwarm", "could not enable swarm mode: {0}", "无法启用群组模式：{0}"),
    ("tui.workflow.usage", "usage: /workflow list | <name> [args...] | status <runId> | cancel <runId>", "用法：/workflow list | <名称> [参数...] | status <运行ID> | cancel <运行ID>"),
    ("tui.provider.none", "no providers configured", "没有配置任何提供商"),
    ("tui.provider.list", "providers ({0}):", "提供商（{0}）："),
    ("tui.provider.keySet", "apiKey set", "已设置 apiKey"),
    ("tui.provider.keyMissing", "no apiKey", "无 apiKey"),
    ("tui.provider.removed", "removed provider {0}", "已移除提供商 {0}"),
    ("tui.provider.usage", "usage: /provider [list|remove <name>|add]", "用法：/provider [list|remove <名称>|add]"),
    ("tui.provider.addHint", "add a provider via /login or config.toml (providers.<name>)", "通过 /login 或 config.toml（providers.<名称>）添加提供商"),
    ("tui.reloadTui.ok", "tui preferences reloaded", "界面偏好已重载"),
    ("tui.editor.noEditor", "no editor configured (set $EDITOR)", "未配置编辑器（请设置 $EDITOR）"),
    ("tui.err.editorFailed", "editor failed: {0}", "编辑器失败：{0}"),
    ("tui.editor.usage", "usage: /editor <command> (e.g. code --wait)", "用法：/editor <命令>（如 code --wait）"),
    ("tui.editor.set", "editor set to {0}", "编辑器已设为 {0}"),
    ("tui.editor.current", "editor: {0}", "编辑器：{0}"),
    // ── Locale ─────────────────────────────────────────────────────────
    ("tui.locale.usage", "usage: /locale <en|zh>", "用法：/locale <en|zh>"),
    ("tui.locale.set", "locale set to {0}", "语言已设为 {0}"),
    ("tui.picker.selectLocale", "select a language", "选择语言"),
    ("tui.locale.cancelled", "locale selection cancelled", "已取消语言选择"),
    ("tui.settings.model", "Switch model", "切换模型"),
    ("tui.settings.theme", "Set the theme", "设置主题"),
    ("tui.settings.editor", "Set the external editor", "设置外部编辑器"),
    ("tui.settings.language", "Switch the UI language", "切换界面语言"),
    ("tui.settings.permission", "Set permission mode", "设置权限模式"),
    ("tui.picker.selectSetting", "settings", "设置"),
    ("tui.settings.cancelled", "settings closed", "已关闭设置"),
    // ── Chat chrome ─────────────────────────────────────────────────────
    ("tui.chat.title", "chat", "对话"),
    ("tui.chat.inputTitle", "input — {0}", "输入 — {0}"),
    ("tui.footer.model", "model: {0}", "模型：{0}"),
    ("tui.footer.ctx", "ctx: {0}%", "上下文：{0}%"),
    ("tui.footer.turns", "turns", "轮"),
    ("tui.footer.tipPrefix", "tip: {0}", "提示：{0}"),
    ("tui.tip.0", "Press Esc or Ctrl-C to cancel a running turn", "按 Esc 或 Ctrl-C 取消进行中的回合"),
    ("tui.tip.1", "Type /help to list all commands", "输入 /help 列出全部命令"),
    ("tui.tip.2", "Tab completes commands and arguments", "Tab 补全命令和参数"),
    ("tui.tip.3", "Ctrl-O expands and collapses tool output", "Ctrl-O 展开/折叠工具输出"),
    ("tui.tip.4", "Ctrl-U clears the input line", "Ctrl-U 清空输入行"),
    ("tui.tip.5", "y = allow, n = deny when approvals are pending", "有待审批时 y=允许，n=拒绝"),
    ("tui.picker.selectSkill", "select a skill", "选择一个技能"),
    ("tui.picker.selectModel", "select a model", "选择一个模型"),
    ("tui.picker.selectSession", "select a session", "选择一个会话"),
    ("tui.picker.selectPermission", "select permission mode", "选择权限模式"),
    ("tui.picker.resumeSession", "resume a session (Esc = new)", "恢复会话（Esc = 新建）"),
    ("tui.picker.hint", "{0} — ↑/↓ pick · Enter select · Esc cancel", "{0} — ↑/↓ 选择 · Enter 确认 · Esc 取消"),
    // ── Command descriptions (completion popup / /help) ────────────────
    ("tui.cmd.quit", "Leave the chat", "退出聊天"),
    ("tui.cmd.exit", "Leave the chat", "退出聊天"),
    ("tui.cmd.help", "Show available commands", "显示可用命令"),
    ("tui.cmd.approvals", "List pending approvals", "列出待处理的审批"),
    ("tui.cmd.approve", "Approve a pending approval", "批准一个待处理的审批"),
    ("tui.cmd.deny", "Deny a pending approval", "拒绝一个待处理的审批"),
    ("tui.cmd.status", "Show session status", "显示会话状态"),
    ("tui.cmd.info", "Show session info", "显示会话信息"),
    ("tui.cmd.session", "Show or rename the session", "显示或重命名会话"),
    ("tui.cmd.plugins", "Manage plugins", "管理插件"),
    ("tui.cmd.config", "Show engine config", "显示引擎配置"),
    ("tui.cmd.skills", "List skills", "列出技能"),
    ("tui.cmd.plan", "Toggle plan mode", "切换计划模式"),
    ("tui.cmd.swarm", "Toggle swarm mode or run a task", "切换群组模式或运行任务"),
    ("tui.cmd.thinking", "Set thinking effort", "设置思考强度"),
    ("tui.cmd.permission", "Set permission mode", "设置权限模式"),
    ("tui.cmd.yolo", "Auto-approve all tool calls", "自动批准所有工具调用"),
    ("tui.cmd.auto", "Auto permission mode", "自动权限模式"),
    ("tui.cmd.new", "Start a fresh session", "开始新会话"),
    ("tui.cmd.init", "Generate AGENTS.md", "生成 AGENTS.md"),
    ("tui.cmd.title", "Rename the session", "重命名会话"),
    ("tui.cmd.mcp", "List MCP servers", "列出 MCP 服务器"),
    ("tui.cmd.tasks", "List background tasks", "列出后台任务"),
    ("tui.cmd.theme", "Toggle dark/light theme", "切换深色/浅色主题"),
    ("tui.cmd.version", "Show version", "显示版本"),
    ("tui.cmd.models", "List models", "列出模型"),
    ("tui.cmd.model", "Switch model", "切换模型"),
    ("tui.cmd.reload", "Reload session state", "重载会话状态"),
    ("tui.cmd.resume", "Switch to a session", "切换到某个会话"),
    ("tui.cmd.goal", "Start or manage a goal", "开始或管理目标"),
    ("tui.cmd.goal-cancel", "Cancel the goal", "取消目标"),
    ("tui.cmd.goal-pause", "Pause the goal", "暂停目标"),
    ("tui.cmd.goal-resume", "Resume the goal", "恢复目标"),
    ("tui.cmd.goal-status", "Show goal status", "显示目标状态"),
    ("tui.cmd.add-dir", "Add an additional directory", "添加附加目录"),
    ("tui.cmd.clear", "Clear session context", "清空会话上下文"),
    ("tui.cmd.compact", "Compact the conversation", "压缩对话"),
    ("tui.cmd.usage", "Show token usage", "显示 token 用量"),
    ("tui.cmd.undo", "Undo the last turn", "撤销上一轮"),
    ("tui.cmd.fork", "Fork the session", "分叉会话"),
    ("tui.cmd.steer", "Steer the active turn", "引导当前回合"),
    ("tui.cmd.import", "Import context", "导入上下文"),
    ("tui.cmd.sessions", "Switch sessions", "切换会话"),
    ("tui.cmd.export", "Export the session", "导出会话"),
    ("tui.cmd.archive", "Archive the session", "归档会话"),
    ("tui.cmd.login", "Authenticate with a platform", "使用平台登录"),
    ("tui.cmd.logout", "Log out of the current provider", "退出当前提供商登录"),
    ("tui.cmd.locale", "Switch the UI language", "切换界面语言"),
    ("tui.cmd.editor", "Set the external editor (Ctrl-G)", "设置外部编辑器（Ctrl-G）"),
    ("tui.cmd.settings", "Open the settings menu", "打开设置菜单"),
    ("tui.cmd.copy", "Copy the last assistant reply", "复制最近一条助手回复"),
    ("tui.cmd.export-md", "Export the session as Markdown", "将会话导出为 Markdown"),
    ("tui.cmd.discuss", "Run a multi-agent discussion", "运行多智能体讨论"),
    ("tui.cmd.workflow", "Run or manage workflows", "运行或管理工作流"),
    ("tui.cmd.provider", "Manage AI providers", "管理 AI 提供商"),
    ("tui.cmd.reload-tui", "Reload only the TUI preferences", "仅重载界面偏好"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dictionary_keys_are_unique() {
        let mut keys: Vec<&str> = MESSAGES.iter().map(|(k, _, _)| *k).collect();
        keys.sort_unstable();
        let dupes: Vec<&str> = keys.windows(2).filter(|w| w[0] == w[1]).map(|w| w[0]).collect();
        assert!(dupes.is_empty(), "duplicate dictionary keys: {dupes:?}");
    }

    #[test]
    fn lookup_returns_locale_text() {
        assert_eq!(
            t_for(Locale::En, "tui.start.notLoggedIn"),
            "not logged in — type /login to authenticate"
        );
        assert_eq!(t_for(Locale::Zh, "tui.start.notLoggedIn"), "未登录 — 输入 /login 进行认证");
    }

    #[test]
    fn lookup_missing_key_falls_back_to_key() {
        assert_eq!(t_for(Locale::En, "tui.does.not.exist"), "tui.does.not.exist");
    }

    #[test]
    fn locale_parses() {
        assert_eq!(Locale::parse(Some("zh")), Locale::Zh);
        assert_eq!(Locale::parse(Some("en")), Locale::En);
        assert_eq!(Locale::parse(Some("fr")), Locale::En);
        assert_eq!(Locale::parse(None), Locale::En);
    }

    #[test]
    fn templates_fill_positionally() {
        let args = vec!["https://example.test/device".to_string(), "ABCD-EFGH".to_string()];
        assert_eq!(
            t_fmt_for(Locale::En, "tui.auth.openUrl", &args),
            "open https://example.test/device and enter code ABCD-EFGH"
        );
        assert_eq!(
            t_fmt_for(Locale::Zh, "tui.auth.openUrl", &args),
            "打开 https://example.test/device 并输入代码 ABCD-EFGH"
        );
    }
}