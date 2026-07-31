//! Native Bash background task — spawns a bash process directly in Rust.
//!
//! This implements the `BackgroundTask` trait for native bash command
//! execution, capturing output to the ring buffer and supporting
//! cancellation, timeout, and detach semantics.
//!
//! Mirrors the TS background bash task in
//! `packages/agent-core/src/tools/builtin/shell/bash.ts`.

use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::watch;

use crate::background::types::*;
use crate::tools::bash::BashRunner;

/// A native bash background task.
pub struct NativeBashTask {
    runner: BashRunner,
    command: String,
    cwd: String,
    description: String,
}

impl NativeBashTask {
    /// Create a new native bash background task.
    pub fn new(runner: BashRunner, command: String, cwd: String, description: String) -> Self {
        Self {
            runner,
            command,
            cwd,
            description,
        }
    }
}

impl BackgroundTask for NativeBashTask {
    fn kind(&self) -> BackgroundTaskKind {
        BackgroundTaskKind::Process
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn start(
        self: Box<Self>,
        sink: Box<dyn BackgroundTaskSink + Send>,
        mut signal: watch::Receiver<bool>,
    ) -> Box<dyn std::future::Future<Output = ()> + Send> {
        let runner = self.runner;
        let command = self.command;
        let _cwd = self.cwd;
        let sink = Arc::new(tokio::sync::Mutex::new(sink));
        Box::new(async move {
            let full_cmd = command.clone();

            let mut cmd = Command::new(&runner.shell_path());
            cmd.arg("-c");
            cmd.arg(&full_cmd);
            cmd.current_dir(&_cwd);
            cmd.kill_on_drop(false);

            // Pipe stdout and stderr separately
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            cmd.stdin(std::process::Stdio::null());

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    let mut sink = sink.lock().await;
                    sink.append_output(&format!("Failed to spawn: {e}"));
                    sink.settle(BackgroundTaskSettlement {
                        status: BackgroundTaskSettlementStatus::Failed,
                        stop_reason: Some(format!("spawn error: {e}")),
                    });
                    return;
                }
            };

            let stdout = child.stdout.take();
            let stderr = child.stderr.take();

            // Monitor both stdout, stderr, and cancellation
            let sink_stdout = sink.clone();
            let stdout_reader = async move {
                let mut buf = [0u8; 4096];
                let mut reader = match stdout {
                    Some(r) => r,
                    None => return,
                };
                loop {
                    match reader.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            sink_stdout.lock().await.append_output(&String::from_utf8_lossy(&buf[..n]));
                        }
                        Err(_) => break,
                    }
                }
            };

            let sink_stderr = sink.clone();
            let stderr_reader = async move {
                let mut buf = [0u8; 4096];
                let mut reader = match stderr {
                    Some(r) => r,
                    None => return,
                };
                loop {
                    match reader.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            sink_stderr.lock().await.append_output(&String::from_utf8_lossy(&buf[..n]));
                        }
                        Err(_) => break,
                    }
                }
            };

            // Drain stdout and stderr concurrently. `join!` (not `select!`):
            // the streams close at independent times, and dropping the
            // slower reader would lose whatever that stream still buffers.
            let drain_output = async move {
                tokio::join!(stdout_reader, stderr_reader);
            };

            // Wait for both readers, racing against cancellation.
            tokio::select! {
                _ = drain_output => {},
                _ = signal.changed() => {
                    // Cancellation requested
                    let _ = child.start_kill();
                    sink.lock().await.settle(BackgroundTaskSettlement {
                        status: BackgroundTaskSettlementStatus::Killed,
                        stop_reason: Some("cancelled by user".into()),
                    });
                    return;
                }
            }

            // Wait for process exit — still cancellable: both streams can hit
            // EOF while the process keeps running, and `wait()` alone would
            // block forever with no way to kill it.
            let output = tokio::select! {
                output = child.wait() => output,
                _ = signal.changed() => {
                    let _ = child.start_kill();
                    sink.lock().await.settle(BackgroundTaskSettlement {
                        status: BackgroundTaskSettlementStatus::Killed,
                        stop_reason: Some("cancelled by user".into()),
                    });
                    return;
                }
            };
            match output {
                Ok(status) => {
                    let exit_code = status.code().unwrap_or(-1);
                    if exit_code == 0 {
                        sink.lock().await.settle(BackgroundTaskSettlement {
                            status: BackgroundTaskSettlementStatus::Completed,
                            stop_reason: None,
                        });
                    } else {
                        sink.lock().await.settle(BackgroundTaskSettlement {
                            status: BackgroundTaskSettlementStatus::Failed,
                            stop_reason: Some(format!("exit code: {exit_code}")),
                        });
                    }
                }
                Err(e) => {
                    sink.lock().await.settle(BackgroundTaskSettlement {
                        status: BackgroundTaskSettlementStatus::Failed,
                        stop_reason: Some(format!("wait error: {e}")),
                    });
                }
            }
        })
    }

    fn force_stop(
        self: Box<Self>,
    ) -> Box<dyn std::future::Future<Output = ()> + Send> {
        Box::new(async move {
            // Force stop is handled by the cancellation signal in `start()`
        })
    }
}