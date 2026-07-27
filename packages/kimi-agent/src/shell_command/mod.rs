/// ShellCommandService — run user `!` shell commands.
///
/// The delegate returns a `ShellExecutionOutput` with all events,
/// avoiding Rust borrow-checker conflicts with callbacks.
///
/// Corresponds to `packages/agent-core-v2/src/agent/shellCommand/`.
use std::collections::HashMap;

use crate::context::context_memory::ContextMemory;
use crate::context::types::{ContentPart, MessageOrigin};

const SHELL_FOREGROUND_TIMEOUT_S: u64 = 120;
const MAX_SHELL_COMMAND_SIZE: usize = 8_000;

#[derive(Debug, Clone)]
pub struct RunShellCommandInput {
    pub command: String,
    pub command_id: Option<String>,
    pub turn_id: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct RunShellCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub is_error: bool,
    pub backgrounded: bool,
}

#[derive(Debug, Clone)]
pub enum ShellOutputKind {
    Stdout(String),
    Stderr(String),
}

#[derive(Debug, Clone)]
pub enum ShellEvent {
    Output {
        command_id: String,
        kind: ShellOutputKind,
        task_id: Option<String>,
    },
    Started {
        command_id: String,
        task_id: String,
    },
    Completed {
        command_id: String,
        is_error: bool,
        task_id: Option<String>,
    },
}

#[derive(Clone)]
pub struct ShellExecutionOutput {
    pub result: Result<RunShellCommandResult, String>,
    pub events: Vec<ShellEvent>,
    pub task_id: Option<String>,
}

pub trait ShellCommandDelegate: Send + Sync {
    fn run(&self, input: &RunShellCommandInput) -> ShellExecutionOutput;
    fn cancel(&self, command_id: &str);
}

pub trait ShellEventListener: Send + Sync {
    fn on_shell_event(&self, event: &ShellEvent);
}

pub struct ShellCommandService {
    delegate: Box<dyn ShellCommandDelegate>,
    listeners: Vec<Box<dyn ShellEventListener>>,
    task_ids: HashMap<String, String>,
}

impl ShellCommandService {
    pub fn new(delegate: Box<dyn ShellCommandDelegate>) -> Self {
        Self {
            delegate,
            listeners: Vec::new(),
            task_ids: HashMap::new(),
        }
    }

    pub fn add_listener(&mut self, listener: Box<dyn ShellEventListener>) {
        self.listeners.push(listener);
    }

    pub fn run(
        &mut self,
        input: &RunShellCommandInput,
        context: &mut ContextMemory,
    ) -> Result<RunShellCommandResult, String> {
        self.append_shell_input(input, context);
        let output = self.delegate.run(input);

        if let (Some(cid), Some(tid)) = (input.command_id.as_deref(), output.task_id.as_deref()) {
            self.task_ids.insert(cid.to_string(), tid.to_string());
        }

        let task_id_for_events: Option<String> = input
            .command_id
            .as_ref()
            .and_then(|cid| self.task_ids.get(cid.as_str()).cloned());

        let mut events = output.events;
        for event in &mut events {
            match event {
                ShellEvent::Output { task_id: tid, .. } => {
                    *tid = task_id_for_events.clone();
                }
                _ => {}
            }
        }
        for event in &events {
            self.publish(event);
        }

        let result = output.result;
        let tid = task_id_for_events;
        let cid = input.command_id.clone();

        // Clean up task_id mapping after processing (matches TS `finally` cleanup).
        if let Some(ref c) = cid {
            self.task_ids.remove(c.as_str());
        }

        match result {
            Ok(res) => {
                if res.backgrounded {
                    let msg = format!("task_id: background_{}", input.command.len());
                    self.append_shell_output(context, "", "", false);
                    self.notify_backgrounded(context, &msg);
                    return Ok(RunShellCommandResult {
                        stdout: msg,
                        stderr: String::new(),
                        is_error: false,
                        backgrounded: true,
                    });
                }
                if res.is_error && res.stdout.is_empty() && res.stderr.is_empty() {
                    if let Some(ref c) = cid {
                        self.publish(&ShellEvent::Output {
                            command_id: c.clone(),
                            kind: ShellOutputKind::Stderr("Command failed.".into()),
                            task_id: tid.clone(),
                        });
                    }
                }
                if let Some(ref c) = cid {
                    self.publish(&ShellEvent::Completed {
                        command_id: c.clone(),
                        is_error: res.is_error,
                        task_id: tid,
                    });
                }
                self.append_shell_output(context, &res.stdout, &res.stderr, res.is_error);
                Ok(res)
            }
            Err(e) => {
                if let Some(ref c) = cid {
                    if !e.is_empty() {
                        self.publish(&ShellEvent::Output {
                            command_id: c.clone(),
                            kind: ShellOutputKind::Stderr(e.clone()),
                            task_id: tid.clone(),
                        });
                    }
                    self.publish(&ShellEvent::Completed {
                        command_id: c.clone(),
                        is_error: true,
                        task_id: tid,
                    });
                }
                self.append_shell_output(context, "", &e, true);
                Ok(RunShellCommandResult {
                    stdout: String::new(),
                    stderr: e,
                    is_error: true,
                    backgrounded: false,
                })
            }
        }
    }

    pub fn cancel(&self, command_id: &str) {
        self.delegate.cancel(command_id);
    }
    pub fn timeout_seconds(&self) -> u64 {
        SHELL_FOREGROUND_TIMEOUT_S
    }

    fn append_shell_input(&self, input: &RunShellCommandInput, context: &mut ContextMemory) {
        let truncated = if input.command.len() > MAX_SHELL_COMMAND_SIZE {
            format!(
                "{}... (truncated, {} chars)",
                &input.command[..MAX_SHELL_COMMAND_SIZE],
                input.command.len()
            )
        } else {
            input.command.clone()
        };
        let xml = format!("<bash-input>\n{}\n</bash-input>", escape_xml(&truncated));
        context.append_user_message(
            &[ContentPart::Text { text: xml }],
            MessageOrigin::ShellCommand {
                phase: "input".into(),
                is_error: None,
            },
        );
    }

    fn append_shell_output(
        &self,
        context: &mut ContextMemory,
        stdout: &str,
        stderr: &str,
        is_error: bool,
    ) {
        let text = format!(
            "<bash-stdout>{}</bash-stdout><bash-stderr>{}</bash-stderr>",
            escape_xml(stdout),
            escape_xml(stderr)
        );
        context.append_user_message(
            &[ContentPart::Text { text }],
            MessageOrigin::ShellCommand {
                phase: "output".into(),
                is_error: Some(is_error),
            },
        );
    }

    fn notify_backgrounded(&self, context: &mut ContextMemory, output: &str) {
        context.append_system_reminder(
            output,
            MessageOrigin::Injection {
                variant: "shell_command_backgrounded".into(),
            },
        );
    }

    fn publish(&self, event: &ShellEvent) {
        for listener in &self.listeners {
            listener.on_shell_event(event);
        }
    }
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub struct SimpleShellDelegate {
    run_fn: Box<dyn Fn(&RunShellCommandInput) -> ShellExecutionOutput + Send + Sync>,
    cancel_fn: Option<Box<dyn Fn(&str) + Send + Sync>>,
}
impl SimpleShellDelegate {
    pub fn new(
        f: impl Fn(&RunShellCommandInput) -> ShellExecutionOutput + Send + Sync + 'static,
    ) -> Self {
        Self {
            run_fn: Box::new(f),
            cancel_fn: None,
        }
    }
    pub fn with_cancel(mut self, f: impl Fn(&str) + Send + Sync + 'static) -> Self {
        self.cancel_fn = Some(Box::new(f));
        self
    }
}
impl ShellCommandDelegate for SimpleShellDelegate {
    fn run(&self, input: &RunShellCommandInput) -> ShellExecutionOutput {
        (self.run_fn)(input)
    }
    fn cancel(&self, command_id: &str) {
        if let Some(ref f) = self.cancel_fn {
            f(command_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ctx() -> ContextMemory {
        ContextMemory::new()
    }

    #[test]
    fn test_echo() {
        let d = SimpleShellDelegate::new(|i| ShellExecutionOutput {
            result: Ok(RunShellCommandResult {
                stdout: format!("ok:{}", i.command),
                stderr: String::new(),
                is_error: false,
                backgrounded: false,
            }),
            events: vec![ShellEvent::Completed {
                command_id: "c1".into(),
                is_error: false,
                task_id: None,
            }],
            task_id: None,
        });
        let mut svc = ShellCommandService::new(Box::new(d));
        let mut c = ctx();
        let r = svc
            .run(
                &RunShellCommandInput {
                    command: "echo hi".into(),
                    command_id: Some("c1".into()),
                    turn_id: None,
                },
                &mut c,
            )
            .unwrap();
        assert_eq!(r.stdout, "ok:echo hi");
        assert!(c.len() >= 2);
    }

    #[test]
    fn test_failure() {
        let d = SimpleShellDelegate::new(|_| ShellExecutionOutput {
            result: Err("crash".into()),
            events: vec![],
            task_id: None,
        });
        let mut svc = ShellCommandService::new(Box::new(d));
        let mut c = ctx();
        let r = svc
            .run(
                &RunShellCommandInput {
                    command: "bad".into(),
                    command_id: None,
                    turn_id: None,
                },
                &mut c,
            )
            .unwrap();
        assert!(r.is_error);
        assert!(r.stderr.contains("crash"));
    }

    #[test]
    fn test_backgrounded() {
        let d = SimpleShellDelegate::new(|_| ShellExecutionOutput {
            result: Ok(RunShellCommandResult {
                stdout: String::new(),
                stderr: String::new(),
                is_error: false,
                backgrounded: true,
            }),
            events: vec![],
            task_id: None,
        });
        let mut svc = ShellCommandService::new(Box::new(d));
        let mut c = ctx();
        let r = svc
            .run(
                &RunShellCommandInput {
                    command: "sleep".into(),
                    command_id: None,
                    turn_id: None,
                },
                &mut c,
            )
            .unwrap();
        assert!(r.backgrounded);
    }

    #[test]
    fn test_xml_escape() {
        assert_eq!(escape_xml("a & b"), "a &amp; b");
        assert_eq!(escape_xml("<t>"), "&lt;t&gt;");
    }

    #[test]
    fn test_timeout() {
        let d = SimpleShellDelegate::new(|_| ShellExecutionOutput {
            result: Ok(RunShellCommandResult {
                stdout: String::new(),
                stderr: String::new(),
                is_error: false,
                backgrounded: false,
            }),
            events: vec![],
            task_id: None,
        });
        assert_eq!(ShellCommandService::new(Box::new(d)).timeout_seconds(), 120);
    }

    #[test]
    fn test_task_ids_cleanup() {
        let d = SimpleShellDelegate::new(|_| ShellExecutionOutput {
            result: Ok(RunShellCommandResult {
                stdout: "ok".into(),
                stderr: String::new(),
                is_error: false,
                backgrounded: false,
            }),
            events: vec![],
            task_id: Some("task-1".into()),
        });
        let mut svc = ShellCommandService::new(Box::new(d));
        let mut c = ctx();
        let _ = svc
            .run(
                &RunShellCommandInput {
                    command: "echo".into(),
                    command_id: Some("c1".into()),
                    turn_id: None,
                },
                &mut c,
            )
            .unwrap();
        // After run completes, task_ids should be cleaned up (matching TS `finally`).
        assert!(svc.task_ids.is_empty());
    }

    #[test]
    fn test_task_ids_cleanup_on_error() {
        let d = SimpleShellDelegate::new(|_| ShellExecutionOutput {
            result: Err("boom".into()),
            events: vec![],
            task_id: Some("task-2".into()),
        });
        let mut svc = ShellCommandService::new(Box::new(d));
        let mut c = ctx();
        let _ = svc
            .run(
                &RunShellCommandInput {
                    command: "fail".into(),
                    command_id: Some("c2".into()),
                    turn_id: None,
                },
                &mut c,
            )
            .unwrap();
        assert!(svc.task_ids.is_empty());
    }
}
