/// Single step execution within a turn.

use super::retry::RetryConfig;
use super::retry::retry_delay;
use super::types::*;
use crate::rpc::types::BoxFuture;

/// Wrap a string error into a `Box<dyn Error + Send + Sync>` (`'static`).
fn boxed_err(s: String) -> Box<dyn std::error::Error + Send + Sync> {
    Box::new(std::io::Error::new(std::io::ErrorKind::Other, s))
}

/// Classify an LLM error: decide whether to return it or continue retrying.
///
/// Returns `Ok(())` if the error is retryable and attempts remain,
/// or `Err(boxed_error)` if the error should be propagated.
///
/// This is a standalone function (not an async block) so that the non-`Send`
/// `Box<dyn Error>` is consumed and dropped before any `.await` in the caller.
fn classify_llm_error(
    err: Box<dyn std::error::Error>,
    llm: &dyn LLM,
    attempt: u32,
    config: &RetryConfig,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let err_str = err.to_string();
    // `err` is dropped here (end of function scope for the parameter).
    if !llm.is_retryable_error(&err_str) {
        return Err(boxed_err(err_str));
    }
    if attempt >= config.max_attempts {
        return Err(boxed_err(format!(
            "LLM call failed after {attempt} attempts: {err_str}"
        )));
    }
    Ok(())
}

/// Execute a single LLM step with default retry configuration.
///
/// Convenience wrapper around `execute_loop_step_with_retry` that uses
/// `RetryConfig::default()`.
pub fn execute_loop_step<'a>(
    turn_id: &'a str,
    step: u32,
    llm: &'a dyn LLM,
    messages: Vec<LLMMessage>,
    tools: &'a [&'a dyn ExecutableTool],
    tool_defs: Vec<ToolInfo>,
) -> BoxFuture<'a, Result<StepResult, Box<dyn std::error::Error + Send + Sync>>> {
    execute_loop_step_with_retry(turn_id, step, llm, messages, tools, tool_defs, &RetryConfig::default())
}

/// Execute a single LLM step: call the LLM using the current messages,
/// return the response with any tool calls. Retries retryable errors
/// using exponential backoff with jitter (see `retry::retry_delay`).
///
/// Non-retryable errors fail immediately. Retryable errors are retried up
/// to `retry_config.max_attempts` times. Each attempt is 1-based: the
/// first call is attempt 1, the first retry is attempt 2, etc.
///
/// Takes owned `messages` and `tool_defs` so the future doesn't borrow
/// from the caller's local scope — this avoids lifetime propagation
/// issues when awaited inside an outer async block.
pub fn execute_loop_step_with_retry<'a>(
    _turn_id: &'a str,
    _step: u32,
    llm: &'a dyn LLM,
    messages: Vec<LLMMessage>,
    _tools: &'a [&'a dyn ExecutableTool],
    tool_defs: Vec<ToolInfo>,
    retry_config: &RetryConfig,
) -> BoxFuture<'a, Result<StepResult, Box<dyn std::error::Error + Send + Sync>>> {
    let retry_config = retry_config.clone();
    Box::pin(async move {
        let params = LLMChatParams {
            messages,
            tools: tool_defs,
        };

        let mut attempt: u32 = 0;
        let response = loop {
            attempt += 1;
            // Match the chat result and extract only Send-safe values, so the
            // non-Send `Box<dyn Error>` is fully consumed before the `.await`.
            let (break_resp, return_err, delay) = match llm.chat(params.clone()).await {
                Ok(resp) => (Some(resp), None, None),
                Err(err) => {
                    let err_str = err.to_string();
                    match classify_llm_error(err, llm, attempt, &retry_config) {
                        Ok(()) => {
                            // Layered backoff (TS retry.ts): the delay tier is
                            // chosen from the error class — 429 waits longest,
                            // 503 moderate, transient uses the default ramp.
                            let tier =
                                super::retry::retry_config_for(super::retry::classify_error(&err_str));
                            (None, None, Some(retry_delay(attempt, &tier)))
                        }
                        Err(e) => (None, Some(e), None),
                    }
                }
            };
            if let Some(resp) = break_resp {
                break resp;
            }
            if let Some(e) = return_err {
                return Err(e);
            }
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
        };

        let usage = response.usage.clone();
        if response.tool_calls.is_empty() {
            Ok(StepResult {
                usage,
                stop_reason: LoopStepStopReason::Complete,
                content: response.content,
            })
        } else {
            Ok(StepResult {
                usage,
                stop_reason: LoopStepStopReason::ToolCalls(response.tool_calls),
                content: response.content,
            })
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::types::TokenUsage;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A test LLM that fails N times then succeeds, with configurable retryability.
    struct FlakyLlm {
        system_prompt: String,
        model_name: String,
        fail_count: u32,
        calls: AtomicU32,
        retryable: bool,
    }

    impl FlakyLlm {
        fn new(fail_count: u32, retryable: bool) -> Self {
            Self {
                system_prompt: "test".into(),
                model_name: "flaky".into(),
                fail_count,
                calls: AtomicU32::new(0),
                retryable,
            }
        }
    }

    impl LLM for FlakyLlm {
        fn system_prompt(&self) -> &str { &self.system_prompt }
        fn model_name(&self) -> &str { &self.model_name }
        fn is_retryable_error(&self, _error: &str) -> bool { self.retryable }

        fn chat(&self, _params: LLMChatParams) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let fail_count = self.fail_count;
            Box::pin(async move {
                if call < fail_count {
                    return Err(format!("simulated failure {}", call + 1).into());
                }
                Ok(LLMChatResponse {
                    content: String::new(),
                    tool_calls: vec![],
                    finish_reason: Some("stop".into()),
                    usage: TokenUsage { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                })
            })
        }
    }

    #[tokio::test]
    async fn test_retry_succeeds_after_failures() {
        // Fails 2 times, succeeds on 3rd try. max_attempts=3 should succeed.
        let llm = FlakyLlm::new(2, true);
        let config = RetryConfig {
            max_attempts: 3,
            base_delay_ms: 1, // fast for tests
            max_delay_ms: 10,
        };
        let result = execute_loop_step_with_retry(
            "t1", 1, &llm, vec![], &[], vec![], &config,
        ).await;
        assert!(result.is_ok(), "should succeed after retries: {:?}", result.err());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn test_retry_exhausted() {
        // Always fails; with max_attempts=2, should give up after 2 tries.
        let llm = FlakyLlm::new(100, true);
        let config = RetryConfig {
            max_attempts: 2,
            base_delay_ms: 1,
            max_delay_ms: 10,
        };
        let result = execute_loop_step_with_retry(
            "t1", 1, &llm, vec![], &[], vec![], &config,
        ).await;
        assert!(result.is_err());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn test_non_retryable_fails_immediately() {
        // Non-retryable error should fail on first attempt, no retries.
        let llm = FlakyLlm::new(100, false);
        let config = RetryConfig {
            max_attempts: 5,
            base_delay_ms: 1,
            max_delay_ms: 10,
        };
        let result = execute_loop_step_with_retry(
            "t1", 1, &llm, vec![], &[], vec![], &config,
        ).await;
        assert!(result.is_err());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_no_retry_needed() {
        // Succeeds on first try.
        let llm = FlakyLlm::new(0, true);
        let config = RetryConfig::default();
        let result = execute_loop_step_with_retry(
            "t1", 1, &llm, vec![], &[], vec![], &config,
        ).await;
        assert!(result.is_ok());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_retry_tool_calls_in_response() {
        let calls = Arc::new(AtomicU32::new(0));
        struct ToolCallLlm {
            calls: Arc<AtomicU32>,
        }
        impl LLM for ToolCallLlm {
            fn system_prompt(&self) -> &str { "test" }
            fn model_name(&self) -> &str { "tool-llm" }
            fn is_retryable_error(&self, _: &str) -> bool { false }
            fn chat(&self, _: LLMChatParams) -> BoxFuture<'_, Result<LLMChatResponse, Box<dyn std::error::Error + Send + Sync>>> {
                let call = self.calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    Ok(LLMChatResponse {
                        content: String::new(),
                        tool_calls: if call == 0 {
                            vec![ToolCall { id: "c1".into(), name: "read".into(), arguments: serde_json::json!({}) }]
                        } else {
                            vec![]
                        },
                        finish_reason: Some("stop".into()),
                        usage: TokenUsage { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                    })
                })
            }
        }

        let llm = ToolCallLlm { calls: calls.clone() };
        let result = execute_loop_step_with_retry("t1", 1, &llm, vec![], &[], vec![], &RetryConfig::default()).await;
        assert!(result.is_ok());
        let step = result.unwrap();
        match step.stop_reason {
            LoopStepStopReason::ToolCalls(tcs) => assert_eq!(tcs.len(), 1),
            _ => panic!("expected ToolCalls stop reason"),
        }
    }

    #[tokio::test]
    async fn test_retry_max_attempts_one() {
        let llm = FlakyLlm::new(1, true);
        let config = RetryConfig { max_attempts: 1, base_delay_ms: 1, max_delay_ms: 10 };
        let result = execute_loop_step_with_retry("t1", 1, &llm, vec![], &[], vec![], &config).await;
        assert!(result.is_err());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_retry_succeeds_on_first_retry() {
        let llm = FlakyLlm::new(1, true);
        let config = RetryConfig { max_attempts: 2, base_delay_ms: 1, max_delay_ms: 10 };
        let result = execute_loop_step_with_retry("t1", 1, &llm, vec![], &[], vec![], &config).await;
        assert!(result.is_ok());
        assert_eq!(llm.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn test_execute_loop_step_no_retry_config() {
        let llm = FlakyLlm::new(0, true);
        let result = execute_loop_step("t1", 1, &llm, vec![], &[], vec![]).await;
        assert!(result.is_ok());
    }
}
