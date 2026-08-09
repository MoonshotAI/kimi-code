//! Slash-command dispatch — the big `match` that routes a submitted line to
//! its handler (TS `commands/dispatch.ts` parity). Split out of `app.rs` so
//! the app shell stays thin; handlers reach the shared state through the
//! `pub(crate)` fields and helpers on `App`.

use std::io;

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use crate::app::{HelpPanel, Overlay, TranscriptLine, TranscriptVec};
use crate::i18n::t;
use crate::reports::{
    build_goal_report, build_mcp_report, build_plugins_report, build_status_report,
    build_usage_report, format_relative_time,
};
use crate::t;
use crate::util::{
    copy_to_clipboard, find_last_assistant_text, fresh_session_id, parse_discuss, resolve_alias,
    transcript_to_markdown,
};

impl super::app::App {

    pub(crate) fn dispatch<'a>(
        &'a mut self,
        terminal: &'a mut Terminal<CrosstermBackend<io::Stdout>>,
        line: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<bool>> + 'a>> {
        Box::pin(async move {
            if line.starts_with('/') {
                let (cmd, rest) = line
                    .split_once(' ')
                    .map(|(c, r)| (c, r.trim()))
                    .unwrap_or((line, ""));
                // Alias resolution (TS registry aliases parity).
                let cmd = resolve_alias(cmd);
                match cmd {
                    "/quit" | "/exit" => return Ok(true),
                    "/help" => {
                        if rest.is_empty() {
                            // Full help panel as a modal overlay (TS
                            // help-panel parity): shortcuts + command list.
                            self.overlay = Some(Overlay::Help(HelpPanel::new()));
                        } else {
                            // `/help <command>` shows that command's description.
                            let cmd = format!("/{rest}");
                            let found = crate::bottom_pane::command_descriptions()
                                .into_iter()
                                .find(|(name, _)| *name == cmd);
                            match found {
                                Some((name, desc)) => self
                                    .push_line(TranscriptLine::status(format!("{name}  {desc}"))),
                                None => self
                                    .push_line(TranscriptLine::error(t!("tui.help.unknown", cmd))),
                            }
                        }
                    }
                    "/approvals" => {
                        let items = self.harness.approvals(Some(&self.session_id)).await?;
                        if items.is_empty() {
                            self.push_line(TranscriptLine::status(t("tui.approval.none")));
                        }
                        for item in items.iter().take(10) {
                            let id = item["id"].as_str().unwrap_or("?");
                            let tool = item["tool_name"].as_str().unwrap_or("?");
                            let rule = item["approval_rule"].as_str().unwrap_or("?");
                            self.push_line(TranscriptLine::status(t!(
                                "tui.approval.listItem",
                                id,
                                tool,
                                rule
                            )));
                        }
                    }
                    "/approve" => {
                        if rest.is_empty() {
                            self.push_line(TranscriptLine::status(t("tui.approval.approveUsage")));
                        } else {
                            let resolved = self.harness.resolve_approval(rest, true, None).await?;
                            self.push_line(TranscriptLine::status(if resolved {
                                t("tui.approval.allowed")
                            } else {
                                t("tui.approval.notFound")
                            }));
                        }
                    }
                    "/deny" => {
                        if rest.is_empty() {
                            self.push_line(TranscriptLine::status(t("tui.approval.denyUsage")));
                        } else {
                            let resolved = self
                                .harness
                                .resolve_approval(rest, false, Some("denied by user"))
                                .await?;
                            self.push_line(TranscriptLine::status(if resolved {
                                t("tui.approval.denied")
                            } else {
                                t("tui.approval.notFound")
                            }));
                        }
                    }
                    "/status" => {
                        let status = self.session.as_mut().expect("session").get_status().await;
                        let version = self
                            .harness
                            .core_version()
                            .await
                            .unwrap_or_else(|_| "?".to_string());
                        for line in build_status_report(&status["result"], &version, &self.session_id)
                        {
                            self.push_line(TranscriptLine::status(line));
                        }
                    }
                    "/info" => match self.harness.core_version().await {
                        Ok(v) => self.push_line(TranscriptLine::status(t!(
                            "tui.info.version",
                            v,
                            self.session_id
                        ))),
                        Err(e) => self
                            .view
                            .transcript
                            .push_line(TranscriptLine::error(t!("tui.err.infoFailed", e))),
                    },
                    "/session" | "/new" | "/init" | "/title" | "/resume" | "/clear" | "/fork" | "/import" | "/sessions" | "/export" | "/archive" | "/btw" | "/endbtw" | "/copy" | "/export-md" => {
                        return self.cmd_session(terminal, cmd, rest).await;
                    }
                    "/plugins" => {
                        let parts: Vec<&str> = rest.split_whitespace().collect();
                        match parts.first().copied() {
                            None => {
                                // Interactive plugin browser (TS plugins panel
                                // parity, picker-based): pick a plugin, then an
                                // action; the action re-dispatches `/plugins
                                // <action> <id>` to reuse the command paths.
                                let plugins = self.harness.list_plugins().await?;
                                if plugins.is_empty() {
                                    self.push_line(TranscriptLine::status(t("tui.plugins.none")));
                                } else {
                                    let items: Vec<crate::picker::PickerItem> = plugins
                                        .iter()
                                        .filter_map(|p| {
                                            let id = p["id"].as_str()?.to_string();
                                            let enabled = p["enabled"].as_bool().unwrap_or(false);
                                            let state = if enabled {
                                                t("tui.status.on")
                                            } else {
                                                t("tui.status.off")
                                            };
                                            let version = p["version"].as_str().unwrap_or("");
                                            let mut item = crate::picker::PickerItem::new(
                                                id.clone(),
                                                format!("{id} [{state}]"),
                                            );
                                            if !version.is_empty() {
                                                item = item.with_description(version);
                                            }
                                            Some(item)
                                        })
                                        .collect();
                                    let opts = crate::picker::PickerOptions::new(t(
                                        "tui.picker.selectPlugin",
                                    ))
                                    .filterable()
                                    .paged(10);
                                    match crate::picker::select_picker(
                                        terminal,
                                        self.view.theme,
                                        &opts,
                                        &items,
                                    )? {
                                        Some(plugin_id) => {
                                            let actions: Vec<crate::picker::PickerItem> = [
                                                ("enable", "enable"),
                                                ("disable", "disable"),
                                                ("reload", "reload"),
                                                ("remove", "remove"),
                                            ]
                                            .iter()
                                            .map(|(v, l)| {
                                                crate::picker::PickerItem::new(*v, *l)
                                            })
                                            .collect();
                                            let action_opts = crate::picker::PickerOptions::new(t!(
                                                "tui.picker.selectAction",
                                                plugin_id
                                            ));
                                            if let Some(action) = crate::picker::select_picker(
                                                terminal,
                                                self.view.theme,
                                                &action_opts,
                                                &actions,
                                            )? {
                                                if action == "remove"
                                                    && !self
                                                        .confirm(
                                                            terminal,
                                                            &t!(
                                                                "tui.plugins.confirmRemove",
                                                                plugin_id
                                                            ),
                                                        )
                                                        .await?
                                                {
                                                    return Ok(false);
                                                }
                                                return self
                                                    .dispatch(
                                                        terminal,
                                                        &format!("/plugins {action} {plugin_id}"),
                                                    )
                                                    .await;
                                            }
                                        }
                                        None => self.push_line(TranscriptLine::status(t(
                                            "tui.plugins.cancelled",
                                        ))),
                                    }
                                }
                            }
                            Some("list") => match self.harness.list_plugins().await {
                                Ok(plugins) => {
                                    let lines = build_plugins_report(&plugins);
                                    for line in lines {
                                        self.push_line(TranscriptLine::status(line));
                                    }
                                }
                                Err(e) => self.view.transcript.push_line(TranscriptLine::error(
                                    t!("tui.err.pluginsFailed", e),
                                )),
                            },
                            Some(action) => {
                                let id = parts.get(1).copied().unwrap_or("");
                                let result = match action {
                                    "enable" if !id.is_empty() => self
                                        .harness
                                        .set_plugin_enabled(id, true)
                                        .await
                                        .map(|_| t!("tui.plugins.enabled", id)),
                                    "disable" if !id.is_empty() => self
                                        .harness
                                        .set_plugin_enabled(id, false)
                                        .await
                                        .map(|_| t!("tui.plugins.disabled", id)),
                                    "remove" if !id.is_empty() => {
                                        self.harness.remove_plugin(id).await.map(|removed| {
                                            if removed {
                                                t!("tui.plugins.removed", id)
                                            } else {
                                                t!("tui.plugins.notFound", id)
                                            }
                                        })
                                    }
                                    "reload" => self
                                        .harness
                                        .reload_plugins()
                                        .await
                                        .map(|_| t("tui.plugins.reloaded").to_string()),
                                    "install" if !id.is_empty() => {
                                        let source =
                                            parts.get(1).copied().unwrap_or("").to_string();
                                        self.harness
                                            .install_plugin(&source)
                                            .await
                                            .map(|_| t!("tui.plugins.installed", source))
                                    }
                                    _ => Err(anyhow::anyhow!(t("tui.plugins.usage"))),
                                };
                                match result {
                                    Ok(msg) => self.push_line(TranscriptLine::status(msg)),
                                    Err(e) => self.view.transcript.push_line(
                                        TranscriptLine::error(t!("tui.err.pluginsFailed", e)),
                                    ),
                                }
                            }
                        }
                    }
                    "/config" => {
                        let config = self.harness.config().await;
                        match config {
                            Ok(cfg) => self.push_line(TranscriptLine::status(t!(
                                "tui.config.show",
                                serde_json::to_string_pretty(&cfg).unwrap_or_default()
                            ))),
                            Err(e) => self
                                .view
                                .transcript
                                .push_line(TranscriptLine::error(t!("tui.err.configFailed", e))),
                        }
                    }
                    "/skills" => {
                        let skills = self.session.as_mut().expect("session").list_skills().await;
                        match skills {
                            Ok(skills) => {
                                let entries: Vec<(String, String)> = skills["skills"]
                                    .as_array()
                                    .map(|arr| {
                                        arr.iter()
                                            .map(|s| {
                                                let name =
                                                    s["name"].as_str().unwrap_or("?").to_string();
                                                let desc = s["description"]
                                                    .as_str()
                                                    .unwrap_or("")
                                                    .to_string();
                                                (name, desc)
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                if entries.is_empty() {
                                    self.push_line(TranscriptLine::status(t("tui.skills.none")));
                                } else {
                                    let items: Vec<crate::picker::PickerItem> = entries
                                        .into_iter()
                                        .map(|(name, desc)| {
                                            let mut item =
                                                crate::picker::PickerItem::new(name.clone(), name);
                                            if !desc.is_empty() {
                                                item = item.with_description(desc);
                                            }
                                            item
                                        })
                                        .collect();
                                    let opts = crate::picker::PickerOptions::new(t(
                                        "tui.picker.selectSkill",
                                    ))
                                    .filterable()
                                    .paged(10);
                                    match crate::picker::select_picker(
                                        terminal,
                                        self.view.theme,
                                        &opts,
                                        &items,
                                    )? {
                                        Some(name) => {
                                            let desc = items
                                                .iter()
                                                .find(|it| it.value == name)
                                                .and_then(|it| it.description.clone())
                                                .unwrap_or_default();
                                            self.push_line(TranscriptLine::status(t!(
                                                "tui.skills.selected",
                                                name,
                                                desc
                                            )));
                                        }
                                        None => self.view.transcript.push_line(
                                            TranscriptLine::status(t("tui.skills.cancelled")),
                                        ),
                                    }
                                }
                            }
                            Err(e) => self
                                .view
                                .transcript
                                .push_line(TranscriptLine::error(t!("tui.err.skillsFailed", e))),
                        }
                    }
                    "/plan" => {
                        if rest == "clear" {
                            // `/plan clear` drops the current plan (TS parity).
                            self.session.as_mut().expect("session").clear_plan().await?;
                            self.push_line(TranscriptLine::status(t("tui.plan.cleared")));
                            self.refresh_status().await;
                        } else {
                            let enabled = rest == "on" || rest.is_empty();
                            self.session
                                .as_mut()
                                .expect("session")
                                .set_plan_mode(enabled)
                                .await?;
                            self.push_line(TranscriptLine::status(t!(
                                "tui.status.plan",
                                t(if enabled {
                                    "tui.status.on"
                                } else {
                                    "tui.status.off"
                                })
                            )));
                            self.refresh_status().await;
                        }
                    }
                    "/swarm" => {
                        let enabled = rest == "on" || rest.is_empty();
                        self.session
                            .as_mut()
                            .expect("session")
                            .set_swarm_mode(enabled, None)
                            .await?;
                        self.push_line(TranscriptLine::status(t!(
                            "tui.status.swarm",
                            t(if enabled {
                                "tui.status.on"
                            } else {
                                "tui.status.off"
                            })
                        )));
                        self.refresh_status().await;
                    }
                    "/thinking" => {
                        if rest.is_empty() {
                            self.push_line(TranscriptLine::status(t("tui.thinking.usage")));
                        } else {
                            self.session
                                .as_mut()
                                .expect("session")
                                .set_thinking(Some(rest))
                                .await?;
                            self.push_line(TranscriptLine::status(t!("tui.thinking.set", rest)));
                        }
                    }
                    "/permission" => {
                        if rest.is_empty() {
                            // No arg: pick a permission mode (TS picker parity)
                            // with a mode description per row.
                            let items: Vec<crate::picker::PickerItem> = [
                                ("manual", "tui.permission.descManual"),
                                ("plan", "tui.permission.descPlan"),
                                ("auto", "tui.permission.descAuto"),
                                ("yolo", "tui.permission.descYolo"),
                            ]
                            .iter()
                            .map(|(mode, desc_key)| {
                                crate::picker::PickerItem::new(*mode, *mode)
                                    .with_description(t(desc_key))
                            })
                            .collect();
                            let opts =
                                crate::picker::PickerOptions::new(t("tui.picker.selectPermission"));
                            match crate::picker::select_picker(
                                terminal,
                                self.view.theme,
                                &opts,
                                &items,
                            )? {
                                Some(mode) => {
                                    self.session
                                        .as_mut()
                                        .expect("session")
                                        .set_permission(&mode)
                                        .await?;
                                    self.view.transcript.push_line(TranscriptLine::status(t!(
                                        "tui.permission.mode",
                                        mode
                                    )));
                                }
                                None => self.view.transcript.push_line(TranscriptLine::status(t(
                                    "tui.permission.cancelled",
                                ))),
                            }
                        } else {
                            let mode = rest;
                            self.session
                                .as_mut()
                                .expect("session")
                                .set_permission(mode)
                                .await?;
                            self.view
                                .transcript
                                .push_line(TranscriptLine::status(t!("tui.permission.mode", mode)));
                        }
                    }
                    "/yolo" => {
                        let current = self.session.as_mut().expect("session").get_status().await;
                        let on = current["result"]["permission"].as_str() != Some("yolo");
                        self.session
                            .as_mut()
                            .expect("session")
                            .set_permission(if on { "yolo" } else { "manual" })
                            .await?;
                        self.push_line(TranscriptLine::status(t!(
                            "tui.permission.yolo",
                            t(if on {
                                "tui.status.on"
                            } else {
                                "tui.status.off"
                            })
                        )));
                    }
                    "/auto" => {
                        let current = self.session.as_mut().expect("session").get_status().await;
                        let on = current["result"]["permission"].as_str() != Some("auto");
                        self.session
                            .as_mut()
                            .expect("session")
                            .set_permission(if on { "auto" } else { "manual" })
                            .await?;
                        self.push_line(TranscriptLine::status(t!(
                            "tui.permission.auto",
                            t(if on {
                                "tui.status.on"
                            } else {
                                "tui.status.off"
                            })
                        )));
                    }
                    "/mcp" => {
                        match self
                            .session
                            .as_mut()
                            .expect("session")
                            .list_mcp_servers()
                            .await
                        {
                            Ok(servers) => {
                                let list = servers["mcp_servers"]
                                    .as_array()
                                    .or_else(|| servers["result"]["mcp_servers"].as_array())
                                    .or_else(|| servers["servers"].as_array())
                                    .cloned()
                                    .unwrap_or_default();
                                let names: Vec<&str> = list
                                    .iter()
                                    .filter_map(|s| {
                                        s["name"].as_str().or_else(|| s["server_name"].as_str())
                                    })
                                    .collect();
                                if names.is_empty() {
                                    self.view
                                        .transcript
                                        .push_line(TranscriptLine::status(t("tui.mcp.none")));
                                } else {
                                    // Full report: reuse the parsed list for
                                    // the structured rows.
                                    let list: Vec<serde_json::Value> = servers["mcp_servers"]
                                        .as_array()
                                        .or_else(|| servers["result"]["mcp_servers"].as_array())
                                        .or_else(|| servers["servers"].as_array())
                                        .cloned()
                                        .unwrap_or_default();
                                    for line in build_mcp_report(&list) {
                                        self.push_line(TranscriptLine::status(line));
                                    }
                                }
                            }
                            Err(e) => self
                                .view
                                .transcript
                                .push_line(TranscriptLine::error(t!("tui.err.mcpFailed", e))),
                        }
                    }
                    "/tasks" => {
                        if !rest.is_empty() {
                            // `/tasks <id>` shows the task's output (TS
                            // task-output-viewer parity, simplified — a folded
                            // tool line, no full-screen viewer).
                            let body = self
                                .session
                                .as_mut()
                                .expect("session")
                                .get_background_task_output(rest)
                                .await;
                            let output = body["result"]["output"]
                                .as_str()
                                .or_else(|| body["output"].as_str())
                                .unwrap_or("");
                            if output.is_empty() {
                                self.push_line(TranscriptLine::status(t!(
                                    "tui.tasks.noOutput",
                                    rest
                                )));
                            } else {
                                self.view
                                    .transcript
                                    .push_line(TranscriptLine::tool_collapsed(output.to_string()));
                            }
                        } else {
                            let tasks = self
                                .session
                                .as_mut()
                                .expect("session")
                                .list_background_tasks()
                                .await;
                            let list = tasks["tasks"]
                                .as_array()
                                .or_else(|| tasks["result"]["tasks"].as_array())
                                .cloned()
                                .unwrap_or_default();
                            if list.is_empty() {
                                self.push_line(TranscriptLine::status(t("tui.tasks.none")));
                            } else {
                                // Interactive task browser (TS tasks-browser
                                // parity, picker-based): pick a task to view
                                // its output (re-dispatches `/tasks <id>`).
                                let items: Vec<crate::picker::PickerItem> = list
                                    .iter()
                                    .filter_map(|t| {
                                        let id = t["id"].as_str()?.to_string();
                                        let label = t["label"].as_str().unwrap_or("").to_string();
                                        let state = t["state"].as_str().unwrap_or("?");
                                        let mut item = crate::picker::PickerItem::new(
                                            id.clone(),
                                            format!("{id}  [{state}]"),
                                        );
                                        if !label.is_empty() {
                                            item = item.with_description(label);
                                        }
                                        Some(item)
                                    })
                                    .collect();
                                let opts = crate::picker::PickerOptions::new(t!(
                                    "tui.picker.selectTask"
                                ))
                                .filterable()
                                .paged(10);
                                match crate::picker::select_picker(
                                    terminal,
                                    self.view.theme,
                                    &opts,
                                    &items,
                                )? {
                                    Some(id) => {
                                        return self
                                            .dispatch(terminal, &format!("/tasks {id}"))
                                            .await;
                                    }
                                    None => {
                                        self.push_line(TranscriptLine::status(t(
                                            "tui.tasks.cancelled",
                                        )))
                                    }
                                }
                            }
                        }
                    }
                    "/theme" => {
                        // Pick dark / light / auto (persisted to tui.toml). A
                        // bare `/theme` opens the picker; an argument applies
                        // directly (TS theme-selector parity).
                        let apply = |app: &mut Self, choice: &str| match choice {
                            "light" => {
                                app.view.theme = crate::theme::Theme::light();
                                app.view.dark_mode = false;
                            }
                            _ => {
                                // dark, auto (auto approximates dark for now).
                                app.view.theme = crate::theme::Theme::dark();
                                app.view.dark_mode = true;
                            }
                        };
                        let choice = if rest.is_empty() {
                            let items: Vec<(String, String)> = ["dark", "light", "auto"]
                                .iter()
                                .map(|m| (m.to_string(), String::new()))
                                .collect();
                            match crate::picker::select(
                                terminal,
                                self.view.theme,
                                t("tui.picker.selectTheme"),
                                &items,
                            )? {
                                Some(choice) => choice,
                                None => {
                                    self.push_line(TranscriptLine::status(t(
                                        "tui.theme.cancelled",
                                    )));
                                    return Ok(false);
                                }
                            }
                        } else {
                            rest.to_string()
                        };
                        if !matches!(choice.as_str(), "dark" | "light" | "auto") {
                            self.push_line(TranscriptLine::status(t("tui.theme.usage")));
                            return Ok(false);
                        }
                        apply(self, &choice);
                        if let Err(e) = crate::theme::set_tui_config_field(
                            "theme",
                            toml::Value::String(choice.clone()),
                        ) {
                            self.push_line(TranscriptLine::error(format!(
                                "theme save failed: {e}"
                            )));
                        }
                        self.push_line(TranscriptLine::status(t!("tui.theme.set", choice)));
                    }
                    "/version" => match self.harness.core_version().await {
                        Ok(v) => self
                            .view
                            .transcript
                            .push_line(TranscriptLine::status(t!("tui.version.show", v))),
                        Err(e) => self
                            .view
                            .transcript
                            .push_line(TranscriptLine::error(t!("tui.err.versionFailed", e))),
                    },
                    "/models" => {
                        let (aliases, default_model) = self.harness.list_models().await?;
                        if aliases.is_empty() {
                            self.push_line(TranscriptLine::status(t("tui.models.none")));
                        }
                        for alias in aliases.iter().take(20) {
                            self.push_line(TranscriptLine::status(alias.clone()));
                        }
                        if let Some(default_model) = default_model {
                            self.push_line(TranscriptLine::status(t!(
                                "tui.models.default",
                                default_model
                            )));
                        }
                    }
                    "/model" => {
                        if rest.is_empty() {
                            // No arg: interactively pick a model from the aliases
                            // (TS `/model` picker parity) instead of a usage error.
                            let items: Vec<crate::picker::PickerItem> = self
                                .model_aliases
                                .iter()
                                .map(|alias| {
                                    crate::picker::PickerItem::new(alias.clone(), String::new())
                                })
                                .collect();
                            if items.is_empty() {
                                self.push_line(TranscriptLine::status(t("tui.models.none")));
                            } else {
                                let opts = crate::picker::PickerOptions::new(t(
                                    "tui.picker.selectModel",
                                ))
                                .filterable()
                                .paged(10);
                                match crate::picker::select_picker(
                                    terminal,
                                    self.view.theme,
                                    &opts,
                                    &items,
                                )? {
                                    Some(model) => {
                                        self.session
                                            .as_mut()
                                            .expect("session")
                                            .set_model(&model)
                                            .await?;
                                        self.view.transcript.push_line(TranscriptLine::status(t!(
                                            "tui.models.set",
                                            model
                                        )));
                                    }
                                    None => self.view.transcript.push_line(TranscriptLine::status(
                                        t("tui.models.cancelled"),
                                    )),
                                }
                            }
                        } else {
                            self.session
                                .as_mut()
                                .expect("session")
                                .set_model(rest)
                                .await?;
                            self.push_line(TranscriptLine::status(t!("tui.models.set", rest)));
                        }
                    }
                    "/reload" => {
                        // Re-load the persisted session state into the live agent
                        // (create already happened; load restores context + goal).
                        match self.session.as_mut().expect("session").load().await {
                            Ok(()) => self.push_line(TranscriptLine::status(t("tui.reload.ok"))),
                            Err(e) => {
                                self.push_line(TranscriptLine::error(t!("tui.err.reloadFailed", e)))
                            }
                        }
                    }
                    "/reload-tui" => {
                        // Re-read tui.toml preferences (theme + locale).
                        crate::i18n::reload_locale();
                        self.view.theme = crate::theme::load_theme();
                        self.view.dark_mode = !matches!(
                            crate::theme::tui_theme_choice(),
                            crate::theme::ThemeChoice::Light
                        );
                        self.push_line(TranscriptLine::status(t("tui.reloadTui.ok")));
                    }
                    "/goal" | "/goal-cancel" | "/goal-pause" | "/goal-resume" | "/goal-status" => {
                        return self.cmd_goal(terminal, cmd, rest).await;
                    }
                    "/add-dir" => {
                        if rest.is_empty() {
                            self.push_line(TranscriptLine::status(t("tui.addDir.usage")));
                        } else {
                            match self
                                .session
                                .as_mut()
                                .expect("session")
                                .add_additional_dir(rest)
                                .await
                            {
                                Ok(_) => self.push_line(TranscriptLine::status(t!(
                                    "tui.addDir.added",
                                    rest
                                ))),
                                Err(e) => self.push_line(TranscriptLine::error(t!(
                                    "tui.err.addDirFailed",
                                    e
                                ))),
                            }
                        }
                    }
                    "/compact" => {
                        // `/compact <instruction>` passes a custom compaction
                        // instruction (TS `compact({ instruction })` parity).
                        let instruction = (!rest.is_empty()).then_some(rest);
                        let result = self
                            .session
                            .as_mut()
                            .expect("session")
                            .compact_with_instruction(instruction)
                            .await;
                        match result {
                            Ok(_) => self.push_line(TranscriptLine::status(t("tui.compact.ok"))),
                            Err(e) => self
                                .push_line(TranscriptLine::error(t!("tui.err.compactFailed", e))),
                        }
                    }
                    "/usage" => {
                        let usage = self.session.as_mut().expect("session").get_usage().await?;
                        for line in build_usage_report(&usage["result"]) {
                            self.push_line(TranscriptLine::status(line));
                        }
                        // Context window readout (TS usage-panel parity).
                        let status = self.session.as_mut().expect("session").get_status().await;
                        let ctx = status["result"]["context_tokens"].as_u64().unwrap_or(0);
                        let max = status["result"]["max_context_tokens"].as_u64().unwrap_or(0);
                        if max > 0 {
                            let pct = ctx
                                .checked_mul(100)
                                .map(|v| v / max)
                                .unwrap_or(0)
                                .min(100);
                            self.push_line(TranscriptLine::status(format!(
                                "{} {}",
                                crate::reports::ctx_bar(ctx, max),
                                t!("tui.usage.context", ctx, max, pct)
                            )));
                        }
                    }
                    "/undo" => {
                        let undone = self
                            .session
                            .as_mut()
                            .expect("session")
                            .undo_history(1)
                            .await?;
                        self.push_line(TranscriptLine::status(t!(
                            "tui.undo.result",
                            serde_json::to_string(&undone).unwrap_or_default()
                        )));
                    }
                    "/steer" => {
                        if rest.is_empty() {
                            self.push_line(TranscriptLine::status(t("tui.steer.usage")));
                        } else {
                            let queued = self
                                .session
                                .as_mut()
                                .expect("session")
                                .steer(serde_json::json!([{ "type": "text", "text": rest }]))
                                .await?;
                            self.push_line(TranscriptLine::status(t!("tui.steer.queued", queued)));
                        }
                    }
                    "/login" => {
                        // Managed kimi auth: run the device flow, surface the
                        // verification URI + code as status lines, and let
                        // Esc/Ctrl-C abandon the wait (dropping the future stops
                        // the flow before approval).
                        let already = kimi_sdk::KimiAuth::new()
                            .status(&self.harness)
                            .await
                            .unwrap_or(false);
                        if already {
                            self.push_line(TranscriptLine::status(t("tui.auth.already")));
                        } else {
                            let info: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
                                Default::default();
                            let info_for_cb = info.clone();
                            let harness = self.harness.clone();
                            let auth = kimi_sdk::KimiAuth::new();
                            // 240 polls * 5s interval ≈ 20 minutes before timeout.
                            let login_fut = auth.login(&harness, Some(240), move |device| {
                                let uri = device
                                    .verification_uri_complete
                                    .clone()
                                    .unwrap_or_else(|| device.verification_uri.clone());
                                if let Ok(mut lines) = info_for_cb.lock() {
                                    lines.push(t!("tui.auth.openUrl", uri, device.user_code));
                                }
                            });
                            tokio::pin!(login_fut);
                            let mut outcome = None;
                            loop {
                                // Drain the verification lines the flow produced.
                                if let Ok(mut lines) = info.lock() {
                                    for line in lines.drain(..) {
                                        self.push_line(TranscriptLine::status(line));
                                    }
                                }
                                if event::poll(std::time::Duration::from_millis(0))? {
                                    if let Event::Key(key) = event::read()? {
                                        if key.kind == KeyEventKind::Press {
                                            let cancel = match key.code {
                                                KeyCode::Esc => true,
                                                KeyCode::Char('c')
                                                    if key
                                                        .modifiers
                                                        .contains(event::KeyModifiers::CONTROL) =>
                                                {
                                                    true
                                                }
                                                _ => false,
                                            };
                                            if cancel {
                                                self.push_line(TranscriptLine::status(t(
                                                    "tui.auth.abandoned",
                                                )));
                                                break;
                                            }
                                        }
                                    }
                                }
                                tokio::select! {
                                    r = &mut login_fut => {
                                        outcome = Some(r);
                                        break;
                                    }
                                    _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
                                }
                            }
                            match outcome {
                                Some(Ok(_)) => {
                                    self.push_line(TranscriptLine::status(t("tui.auth.ok")))
                                }
                                Some(Err(e)) => self
                                    .push_line(TranscriptLine::error(t!("tui.err.loginFailed", e))),
                                None => {}
                            }
                        }
                    }
                    "/logout" => match kimi_sdk::KimiAuth::new().logout(&self.harness).await {
                        Ok(()) => self.push_line(TranscriptLine::status(t("tui.auth.loggedOut"))),
                        Err(e) => {
                            self.push_line(TranscriptLine::error(t!("tui.err.logoutFailed", e)))
                        }
                    },
                    "/locale" => {
                        let locale = if rest.is_empty() {
                            // No arg: pick en/zh (TS locale-selector parity).
                            let items: Vec<(String, String)> = ["en", "zh"]
                                .iter()
                                .map(|m| (m.to_string(), String::new()))
                                .collect();
                            match crate::picker::select(
                                terminal,
                                self.view.theme,
                                t("tui.picker.selectLocale"),
                                &items,
                            )? {
                                Some(choice) => match choice.as_str() {
                                    "zh" => crate::i18n::Locale::Zh,
                                    _ => crate::i18n::Locale::En,
                                },
                                None => {
                                    self.push_line(TranscriptLine::status(t(
                                        "tui.locale.cancelled",
                                    )));
                                    return Ok(false);
                                }
                            }
                        } else {
                            match rest {
                                "zh" => crate::i18n::Locale::Zh,
                                "en" => crate::i18n::Locale::En,
                                _ => {
                                    self.push_line(TranscriptLine::status(t("tui.locale.usage")));
                                    return Ok(false);
                                }
                            }
                        };
                        // Persist to tui.toml first, then switch the runtime locale
                        // so subsequent renders use the new language immediately.
                        if let Err(e) = crate::i18n::save_locale(locale) {
                            self.push_line(TranscriptLine::error(format!(
                                "locale save failed: {e}"
                            )));
                        }
                        crate::i18n::set_locale(locale);
                        self.push_line(TranscriptLine::status(t!("tui.locale.set", rest)));
                    }
                    "/editor" => {
                        if rest.is_empty() {
                            // Show the current editor.
                            match crate::editor::resolve_editor() {
                                Some(cmd) => self.push_line(TranscriptLine::status(t!(
                                    "tui.editor.current",
                                    cmd
                                ))),
                                None => {
                                    self.push_line(TranscriptLine::status(t("tui.editor.noEditor")))
                                }
                            }
                        } else {
                            match crate::editor::save_editor(rest) {
                                Ok(()) => self
                                    .push_line(TranscriptLine::status(t!("tui.editor.set", rest))),
                                Err(e) => {
                                    self.push_line(TranscriptLine::error(format!("editor: {e}")))
                                }
                            }
                        }
                    }
                    "/settings" => {
                        // Unified settings menu (TS settings-selector parity):
                        // pick an entry and dispatch to the underlying command.
                        let items: Vec<(String, String)> = [
                            ("model", t("tui.settings.model")),
                            ("theme", t("tui.settings.theme")),
                            ("editor", t("tui.settings.editor")),
                            ("language", t("tui.settings.language")),
                            ("permission", t("tui.settings.permission")),
                        ]
                        .into_iter()
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect();
                        match crate::picker::select(
                            terminal,
                            self.view.theme,
                            t("tui.picker.selectSetting"),
                            &items,
                        )? {
                            Some(choice) => {
                                let cmd = match choice.as_str() {
                                    "model" => "/model",
                                    "theme" => "/theme",
                                    "editor" => "/editor",
                                    "language" => "/locale",
                                    "permission" => "/permission",
                                    _ => return Ok(false),
                                };
                                // Re-enter dispatch with the subcommand; a quit
                                // from within propagates.
                                if self.dispatch(terminal, cmd).await? {
                                    return Ok(true);
                                }
                            }
                            None => {
                                self.push_line(TranscriptLine::status(t("tui.settings.cancelled")))
                            }
                        }
                    }
                    "/discuss" => {
                        // Multi-agent discussion (TS `handleDiscussCommand`
                        // parity, simplified): enable swarm mode, then send the
                        // constructed prompt as a normal turn so the model runs
                        // the SwarmDiscussion tool.
                        let args = match parse_discuss(rest) {
                            Ok(args) => args,
                            Err(code) => {
                                let msg = match code {
                                    "need-topic" => t("tui.discuss.needTopic"),
                                    "need-roles" => t("tui.discuss.needRoles"),
                                    _ => t("tui.discuss.usage"),
                                };
                                self.push_line(TranscriptLine::error(msg));
                                return Ok(false);
                            }
                        };
                        if let Err(e) = self
                            .session
                            .as_mut()
                            .expect("session")
                            .set_swarm_mode(true, Some("task"))
                            .await
                        {
                            self.push_line(TranscriptLine::error(t!("tui.err.discussSwarm", e)));
                            return Ok(false);
                        }
                        self.refresh_status().await;
                        let mode = if args.debate { "debate" } else { "discussion" };
                        let prompt = format!(
                        "Start a {mode} on the following topic:\n\nTopic: {}\n\nParticipants: {}\n\nUse the SwarmDiscussion tool.",
                        args.topic,
                        args.roles.join(", ")
                    );
                        return self.dispatch(terminal, &prompt).await;
                    }
                    "/workflow" => {
                        // Workflow tool entry (TS `handleWorkflowCommand` parity):
                        // list / run / status / cancel all become a prompt that
                        // asks the model to drive the Workflow tool.
                        let trimmed = rest.trim();
                        if trimmed.is_empty() {
                            self.push_line(TranscriptLine::status(t("tui.workflow.usage")));
                            return Ok(false);
                        }
                        let prompt = if trimmed.eq_ignore_ascii_case("list") {
                            "List the available workflows using the Workflow tool.".to_string()
                        } else if let Some(id) = trimmed.strip_prefix("status ") {
                            format!(
                                "Check the status of workflow run {id} using the Workflow tool."
                            )
                        } else if let Some(id) = trimmed.strip_prefix("cancel ") {
                            format!("Cancel workflow run {id} using the Workflow tool.")
                        } else if trimmed.eq_ignore_ascii_case("status")
                            || trimmed.eq_ignore_ascii_case("cancel")
                        {
                            self.push_line(TranscriptLine::status(t("tui.workflow.usage")));
                            return Ok(false);
                        } else {
                            // `<name> [args...]` — run it.
                            format!("Run the workflow \"{trimmed}\" using the Workflow tool.")
                        };
                        return self.dispatch(terminal, &prompt).await;
                    }
                    "/provider" => {
                        // Provider management (TS `handleProviderCommand` parity,
                        // simplified): interactive picker, or list / remove /
                        // add as commands.
                        let parts: Vec<&str> = rest.split_whitespace().collect();
                        match parts.first().copied() {
                            None => {
                                // Interactive provider browser: pick a provider
                                // to remove it (with a y/N confirm); adding is
                                // pointed at /login / config.toml.
                                match self.harness.config().await {
                                    Ok(cfg) => {
                                        let providers =
                                            cfg["providers"].as_object().cloned().unwrap_or_default();
                                        if providers.is_empty() {
                                            self.push_line(TranscriptLine::status(t(
                                                "tui.provider.none",
                                            )));
                                        } else {
                                            let items: Vec<crate::picker::PickerItem> = providers
                                                .iter()
                                                .map(|(name, p)| {
                                                    let has_key = p["apiKey"]
                                                        .as_str()
                                                        .is_some_and(|k| !k.is_empty());
                                                    let key_state = if has_key {
                                                        t("tui.provider.keySet")
                                                    } else {
                                                        t("tui.provider.keyMissing")
                                                    };
                                                    let base =
                                                        p["baseUrl"].as_str().unwrap_or("");
                                                    crate::picker::PickerItem::new(
                                                        name.clone(),
                                                        format!("{name}  {key_state}"),
                                                    )
                                                    .with_description(base)
                                                })
                                                .collect();
                                            let opts = crate::picker::PickerOptions::new(t!(
                                                "tui.provider.select"
                                            ))
                                            .filterable()
                                            .paged(10);
                                            match crate::picker::select_picker(
                                                terminal,
                                                self.view.theme,
                                                &opts,
                                                &items,
                                            )? {
                                                Some(name) => {
                                                    if self
                                                        .confirm(
                                                            terminal,
                                                            &t!(
                                                                "tui.provider.confirmRemove",
                                                                name
                                                            ),
                                                        )
                                                        .await?
                                                    {
                                                        return self
                                                            .dispatch(
                                                                terminal,
                                                                &format!("/provider remove {name}"),
                                                            )
                                                            .await;
                                                    }
                                                }
                                                None => self.push_line(TranscriptLine::status(t(
                                                    "tui.provider.cancelled",
                                                ))),
                                            }
                                        }
                                    }
                                    Err(e) => self.push_line(TranscriptLine::error(t!(
                                        "tui.err.configFailed",
                                        e
                                    ))),
                                }
                            }
                            Some("list") => match self.harness.config().await {
                                Ok(cfg) => {
                                    let providers =
                                        cfg["providers"].as_object().cloned().unwrap_or_default();
                                    if providers.is_empty() {
                                        self.push_line(TranscriptLine::status(t(
                                            "tui.provider.none",
                                        )));
                                    } else {
                                        self.push_line(TranscriptLine::status(t!(
                                            "tui.provider.list",
                                            providers.len()
                                        )));
                                        for (name, p) in providers {
                                            let has_key =
                                                p["apiKey"].as_str().is_some_and(|k| !k.is_empty());
                                            let key_state = if has_key {
                                                t("tui.provider.keySet")
                                            } else {
                                                t("tui.provider.keyMissing")
                                            };
                                            let base = p["baseUrl"].as_str().unwrap_or("");
                                            self.push_line(TranscriptLine::status(format!(
                                                "  {name}  {key_state}  {base}"
                                            )));
                                        }
                                    }
                                }
                                Err(e) => self.push_line(TranscriptLine::error(t!(
                                    "tui.err.configFailed",
                                    e
                                ))),
                            },
                            Some("remove") if parts.len() >= 2 => {
                                let name = parts[1];
                                match self
                                    .harness
                                    .set_config(serde_json::json!({ "providers": { name: null } }))
                                    .await
                                {
                                    Ok(_) => self.push_line(TranscriptLine::status(t!(
                                        "tui.provider.removed",
                                        name
                                    ))),
                                    Err(e) => self.push_line(TranscriptLine::error(t!(
                                        "tui.err.configFailed",
                                        e
                                    ))),
                                }
                            }
                            Some("add") => {
                                self.push_line(TranscriptLine::status(t("tui.provider.addHint")))
                            }
                            _ => self.push_line(TranscriptLine::status(t("tui.provider.usage"))),
                        }
                    }
                    "/experiments" => {
                        // No engine data source in Rust yet (TS FlagId registry
                        // is retired with agent-core); point at config.toml.
                        self.push_line(TranscriptLine::status(t("tui.experiments.hint")));
                    }
                    "/multi-llm" => {
                        // Concurrent-provider settings live in config.toml.
                        self.push_line(TranscriptLine::status(t("tui.multiLlm.hint")));
                    }
                    "/feedback" => {
                        self.push_line(TranscriptLine::status(t("tui.feedback.hint")));
                    }
                    "/web" => {
                        self.push_line(TranscriptLine::status(t("tui.web.hint")));
                    }
                    other => self
                        .view
                        .transcript
                        .push_line(TranscriptLine::error(t!("tui.err.unknownCommand", other))),
                }
                return Ok(false);
            }
            // Bash mode: a leading `!` runs a shell command one-shot (TS
            // shell-run parity, simplified — output is not streamed).
            if let Some(raw) = line.strip_prefix('!') {
                let command = raw.trim();
                if !command.is_empty() {
                    self.push_line(TranscriptLine::tool(format!("! {command}")));
                    let result = self
                        .session
                        .as_mut()
                        .expect("session")
                        .run_shell(command)
                        .await;
                    if let Some(error) = result.get("error") {
                        self.push_line(TranscriptLine::error(t!(
                            "tui.err.shellFailed",
                            error["message"].as_str().unwrap_or("unknown")
                        )));
                    } else {
                        let output = result["result"]["output"].as_str().unwrap_or("");
                        let is_error = result["result"]["is_error"].as_bool().unwrap_or(false);
                        let line = if output.is_empty() {
                            t("tui.shell.done").to_string()
                        } else {
                            output.to_string()
                        };
                        let entry = if is_error {
                            TranscriptLine::error(line)
                        } else {
                            TranscriptLine::tool_collapsed(line)
                        };
                        self.view.transcript.push_line(entry);
                    }
                    return Ok(false);
                }
            }
            // A real prompt: run it and render the transcript (see
            // `run_turn`; the same path serves `/btw <question>`).
            self.run_turn(line).await?;
            Ok(false)
        })
    }}

impl super::app::App {
    /// `goal` command group (extracted from dispatch for readability).
    async fn cmd_goal(
        &mut self,
        _terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
        cmd: &str,
        rest: &str,
    ) -> anyhow::Result<bool> {
        match cmd {
            "/goal" => {
    // TS parity: `/goal <subcommand>` manages the goal;
    // anything else is the objective of a new goal.
    let (cmd, objective) = match rest.split_once(char::is_whitespace) {
        Some((c, o)) => (c, o.trim()),
        None => (rest, ""),
    };
    let session = self.session.as_mut().expect("session");
    match cmd {
        "" => {
            self.push_line(TranscriptLine::status(t("tui.goal.usage")));
        }
        "status" => {
            // Full goal panel (TS goal-panel parity,
            // simplified): objective + status + usage.
            let goal = session.goal().await?;
            let g = &goal["result"]["goal"];
            if g.is_null() || g.as_object().is_none() {
                self.push_line(TranscriptLine::status(t("tui.goal.none")));
            } else {
                for line in build_goal_report(g) {
                    self.push_line(TranscriptLine::status(line));
                }
            }
        }
        "pause" => {
            session.pause_goal(Some(objective)).await?;
            self.push_line(TranscriptLine::status(t("tui.goal.paused")));
        }
        "resume" => {
            session.resume_goal(Some(objective)).await?;
            self.push_line(TranscriptLine::status(t("tui.goal.resumed")));
        }
        "cancel" => {
            session.cancel_goal().await?;
            self.push_line(TranscriptLine::status(t("tui.goal.cancelled")));
        }
        "replace" => {
            if objective.is_empty() {
                self.push_line(TranscriptLine::status(t(
                    "tui.goal.replaceUsage",
                )));
            } else {
                let snapshot = session.create_goal(objective).await?;
                self.push_line(TranscriptLine::status(t!(
                    "tui.goal.replaced",
                    snapshot["objective"]
                )));
            }
        }
        "next" => {
            // Goal queueing (TS `goal-queue-store` parity):
            // a bare objective appends; subcommands manage
            // the queue. Auto-promotion on goal completion is
            // not wired yet.
            let parts: Vec<&str> = objective.split_whitespace().collect();
            match parts.first().copied() {
                None => self.push_line(TranscriptLine::status(t(
                    "tui.goal.queueUsage",
                ))),
                Some("manage") => {
                    match crate::goal_queue::read_queue(&self.session_id) {
                        Ok(goals) if goals.is_empty() => self.push_line(
                            TranscriptLine::status(t("tui.goal.queueEmpty")),
                        ),
                        Ok(goals) => {
                            self.push_line(TranscriptLine::status(t!(
                                "tui.goal.queueList",
                                goals.len()
                            )));
                            for g in goals {
                                self.push_line(TranscriptLine::status(t!(
                                    "tui.goal.queueItem",
                                    g.id,
                                    g.objective
                                )));
                            }
                        }
                        Err(e) => self.push_line(TranscriptLine::error(
                            format!("goal queue: {e}"),
                        )),
                    }
                }
                Some("remove") if parts.len() >= 2 => {
                    match crate::goal_queue::remove_goal(
                        &self.session_id,
                        parts[1],
                    ) {
                        Ok(true) => self.push_line(TranscriptLine::status(t!(
                            "tui.goal.removed",
                            parts[1]
                        ))),
                        _ => self.push_line(TranscriptLine::status(t!(
                            "tui.goal.removedNotFound",
                            parts[1]
                        ))),
                    }
                }
                Some("move") if parts.len() >= 3 => {
                    let up = match parts[2] {
                        "up" => true,
                        "down" => false,
                        _ => {
                            self.push_line(TranscriptLine::status(t(
                                "tui.goal.queueUsage",
                            )));
                            return Ok(false);
                        }
                    };
                    match crate::goal_queue::move_goal(
                        &self.session_id,
                        parts[1],
                        up,
                    ) {
                        Ok(true) => self.push_line(TranscriptLine::status(t!(
                            "tui.goal.moved",
                            parts[1]
                        ))),
                        _ => self.push_line(TranscriptLine::status(t!(
                            "tui.goal.removedNotFound",
                            parts[1]
                        ))),
                    }
                }
                Some("promote") => {
                    match crate::goal_queue::promote_top(&self.session_id) {
                        Ok(Some(g)) => {
                            let snapshot =
                                session.create_goal(&g.objective).await?;
                            self.push_line(TranscriptLine::status(t!(
                                "tui.goal.promoted",
                                snapshot["objective"]
                            )));
                        }
                        Ok(None) => self.push_line(TranscriptLine::status(t(
                            "tui.goal.noQueued",
                        ))),
                        Err(e) => self.push_line(TranscriptLine::error(
                            format!("goal queue: {e}"),
                        )),
                    }
                }
                Some(_) => {
                    // A bare objective queues it.
                    match crate::goal_queue::append_goal(
                        &self.session_id,
                        objective,
                    ) {
                        Ok(goal) => {
                            let count =
                                crate::goal_queue::read_queue(&self.session_id)
                                    .map(|g| g.len())
                                    .unwrap_or(0);
                            self.push_line(TranscriptLine::status(t!(
                                "tui.goal.queued",
                                goal.objective,
                                count
                            )));
                        }
                        Err(e) => self.push_line(TranscriptLine::error(
                            format!("goal queue: {e}"),
                        )),
                    }
                }
            }
        }
        _ => {
            // A bare objective creates a goal (TS parity).
            let snapshot = session.create_goal(rest).await?;
            self.push_line(TranscriptLine::status(t!(
                "tui.goal.created",
                snapshot["objective"]
            )));
        }
    }
            }
            "/goal-cancel" => {
    self.session
        .as_mut()
        .expect("session")
        .cancel_goal()
        .await?;
    self.push_line(TranscriptLine::status(t("tui.goal.cancelled")));
            }
            "/goal-pause" => {
    self.session
        .as_mut()
        .expect("session")
        .pause_goal(Some(rest))
        .await?;
    self.push_line(TranscriptLine::status(t("tui.goal.paused")));
            }
            "/goal-resume" => {
    self.session
        .as_mut()
        .expect("session")
        .resume_goal(Some(rest))
        .await?;
    self.push_line(TranscriptLine::status(t("tui.goal.resumed")));
            }
            "/goal-status" => {
    let goal = self.session.as_mut().expect("session").goal().await?;
    self.push_line(TranscriptLine::status(t!(
        "tui.goal.show",
        serde_json::to_string(&goal["goal"]).unwrap_or_default()
    )));
            }
            _ => {}
        }
        Ok(false)
    }
}

impl super::app::App {
    /// `session` command group (extracted from dispatch for readability).
    async fn cmd_session(
        &mut self,
        terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
        cmd: &str,
        rest: &str,
    ) -> anyhow::Result<bool> {
        match cmd {
            "/session" => {
    let parts: Vec<&str> = rest.split_whitespace().collect();
    match parts.first().copied() {
        Some("set") if parts.len() >= 2 => {
            let title = parts[1..].join(" ");
            match self.harness.rename_session(&self.session_id, &title).await {
                Ok(()) => self.push_line(TranscriptLine::status(t!(
                    "tui.status.sessionSet",
                    title
                ))),
                Err(e) => self.view.transcript.push_line(
                    TranscriptLine::error(t!("tui.err.renameFailed", e)),
                ),
            }
        }
        _ => {
            let msg = if parts.is_empty() {
                t!("tui.status.sessionId", self.session_id)
            } else {
                t("tui.usage.session").to_string()
            };
            self.push_line(TranscriptLine::status(msg));
        }
    }
            }
            "/new" => {
    let fresh = format!("session-{}", fresh_session_id());
    self.switch_to_session(&fresh).await?;
            }
            "/init" => {
    self.session.as_mut().expect("session").init().await?;
    self.view
        .transcript
        .push_line(TranscriptLine::status(t("tui.session.initialized")));
            }
            "/title" => {
    if rest.is_empty() {
        self.view
            .transcript
            .push_line(TranscriptLine::status(t("tui.title.usage")));
    } else {
        self.session.as_mut().expect("session").rename(rest).await?;
        self.view
            .transcript
            .push_line(TranscriptLine::status(t!("tui.title.set", rest)));
    }
            }
            "/resume" => {
    if rest.is_empty() {
        self.push_line(TranscriptLine::status(t("tui.resume.usage")));
    } else {
        let mut new_session = self.harness.create_session(rest).await?;
        // Restore the persisted state of the resumed session.
        let _ = new_session.load().await;
        self.session = Some(new_session);
        self.session_id = rest.to_string();
        self.push_line(TranscriptLine::status(t!("tui.resume.switched", rest)));
    }
            }
            "/clear" => {
    self.session
        .as_mut()
        .expect("session")
        .clear_context()
        .await?;
    self.push_line(TranscriptLine::status(t("tui.clear.ok")));
            }
            "/fork" => {
    if rest.is_empty() {
        self.push_line(TranscriptLine::status(t("tui.fork.usage")));
    } else {
        self.session
            .as_mut()
            .expect("session")
            .fork(rest, None, None)
            .await?;
        self.push_line(TranscriptLine::status(t!("tui.fork.done", rest)));
    }
            }
            "/import" => {
    if rest.is_empty() {
        self.push_line(TranscriptLine::status(t("tui.import.usage")));
    } else {
        self.session
            .as_mut()
            .expect("session")
            .import_context(rest, "tui")
            .await?;
        self.view.transcript.push_line(TranscriptLine::status(t!(
            "tui.import.done",
            rest.chars().count()
        )));
    }
            }
            "/sessions" => {
    let sessions = self.harness.list_sessions(50).await?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let items: Vec<crate::picker::PickerItem> = sessions
        .iter()
        .filter_map(|s| {
            let id = s["id"].as_str()?.to_string();
            let title = s["title"].as_str().unwrap_or("(untitled)").to_string();
            let mut item = crate::picker::PickerItem::new(id, title);
            if let Some(updated) = s["updated_at"].as_str() {
                let relative = format_relative_time(updated, now_ms);
                if !relative.is_empty() {
                    item = item.with_description(relative);
                }
            }
            Some(item)
        })
        .collect();
    if items.is_empty() {
        self.push_line(TranscriptLine::status(t("tui.sessions.none")));
    } else {
        let opts = crate::picker::PickerOptions::new(t(
            "tui.picker.selectSession",
        ))
        .filterable()
        .paged(10);
        match crate::picker::select_picker(
            terminal,
            self.view.theme,
            &opts,
            &items,
        )? {
            Some(id) => self.switch_to_session(&id).await?,
            None => self
                .view
                .transcript
                .push_line(TranscriptLine::status(t("tui.sessions.cancelled"))),
        }
    }
            }
            "/export" => {
                match self.harness.export_session(&self.session_id).await {
    Ok(zip) => {
        let path = format!("{}.zip", self.session_id);
        match std::fs::write(&path, &zip) {
            Ok(()) => self.push_line(TranscriptLine::status(t!(
                "tui.export.done",
                path,
                zip.len()
            ))),
            Err(e) => self
                .push_line(TranscriptLine::error(t!("tui.err.exportWrite", e))),
        }
    }
    Err(e) => {
        self.push_line(TranscriptLine::error(t!("tui.err.exportFailed", e)))
    }
                }
            }
            "/archive" => {
    let Some(session) = self.session.as_mut() else {
        self.push_line(TranscriptLine::error(t("tui.err.archiveNoSession")));
        return Ok(false);
    };
    match session.archive().await {
        Ok(true) => self
            .view
            .transcript
            .push_line(TranscriptLine::status(t("tui.archive.ok"))),
        Ok(false) => self
            .view
            .transcript
            .push_line(TranscriptLine::error(t("tui.err.archiveNotFound"))),
        Err(e) => self
            .view
            .transcript
            .push_line(TranscriptLine::error(t!("tui.err.archiveFailed", e))),
    }
            }
            "/btw" => {
    // TS parity: spawn a side-question agent and route the
    // prompt to it; the answer streams into the transcript
    // (`[btw]`-prefixed user line). While the agent is
    // active, every prompt routes to it until `/endbtw`.
    let question = rest.trim();
    if question.is_empty() {
        self.push_line(TranscriptLine::status(t("tui.btw.usage")));
    } else if self.btw_agent.is_some() {
        self.push_line(TranscriptLine::status(t("tui.btw.alreadyActive")));
    } else {
        match self.session.as_mut().expect("session").start_btw().await {
            Ok(id) => {
                self.btw_agent = Some(id.clone());
                self.push_line(TranscriptLine::status(t!("tui.btw.started", id)));
                return self.run_turn(question).await.map(|_| false);
            }
            Err(e) => {
                self.push_line(TranscriptLine::error(t!("tui.err.generic", e)));
            }
        }
    }
            }
            "/endbtw" => {
    match self.session.as_mut().expect("session").end_btw().await {
        Ok(()) => {
            self.btw_agent = None;
            self.push_line(TranscriptLine::status(t("tui.btw.ended")));
        }
        Err(e) => {
            self.push_line(TranscriptLine::error(t!("tui.err.generic", e)));
        }
    }
            }
            "/copy" => {
    // Copy the last assistant reply to the clipboard (TS
    // `handleCopyCommand` parity — sourced from the rendered
    // transcript so it survives compaction).
    match find_last_assistant_text(&self.view.transcript) {
        Some(text) => match copy_to_clipboard(&text) {
            Ok(()) => self.push_line(TranscriptLine::status(t!(
                "tui.copy.ok",
                text.chars().count()
            ))),
            Err(e) => self
                .push_line(TranscriptLine::error(t!("tui.err.copyFailed", e))),
        },
        None => self.push_line(TranscriptLine::status(t("tui.copy.none"))),
    }
            }
            "/export-md" => {
    // Export the visible transcript as a Markdown file (TS
    // `/export-md` parity, simplified).
    let path = format!("{}.md", self.session_id);
    let markdown = transcript_to_markdown(&self.view.transcript);
    match std::fs::write(&path, markdown) {
        Ok(()) => self
            .push_line(TranscriptLine::status(t!("tui.exportMd.done", path))),
        Err(e) => self
            .push_line(TranscriptLine::error(t!("tui.err.exportMdFailed", e))),
    }
            }
            _ => {}
        }
        Ok(false)
    }
}
