/// Loop event types and dispatcher.
///
/// Corresponds to `packages/agent-core/src/loop/events.ts`.

use crate::rpc::types::TokenUsage;
use crate::turn_loop::types::{ExecutableToolResult, LoopStepStopReason, ToolCall};

/// Reasons a loop can be interrupted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopInterruptReason {
    Aborted,
    MaxSteps,
    Error,
}

/// Reasons a loop can be interrupted (telemetry-facing).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopInterruptCause {
    Aborted,
    MaxSteps,
    Error,
    UserCancelled,
}

/// Step begin event.
#[derive(Debug, Clone)]
pub struct LoopStepBeginEvent {
    pub uuid: String,
    pub turn_id: String,
    pub step: u32,
}

/// Step end event.
#[derive(Debug, Clone)]
pub struct LoopStepEndEvent {
    pub uuid: String,
    pub turn_id: String,
    pub step: u32,
    pub usage: Option<TokenUsage>,
    pub finish_reason: Option<LoopStepStopReason>,
    pub trace_id: Option<String>,
}

/// Step retrying event.
#[derive(Debug, Clone)]
pub struct LoopStepRetryingEvent {
    pub turn_id: String,
    pub step: u32,
    pub step_uuid: String,
    pub failed_attempt: u32,
    pub next_attempt: u32,
    pub max_attempts: u32,
    pub delay_ms: u64,
    pub error_name: String,
    pub error_message: String,
}

/// Content part event (text delta from streaming).
#[derive(Debug, Clone)]
pub struct LoopContentPartEvent {
    pub uuid: String,
    pub turn_id: String,
    pub step: u32,
    pub step_uuid: String,
    pub part: ContentPartPayload,
}

/// Text or thinking content part.
#[derive(Debug, Clone)]
pub enum ContentPartPayload {
    Text { text: String },
    Think { think: String },
}

/// Tool call event.
#[derive(Debug, Clone)]
pub struct LoopToolCallEvent {
    pub uuid: String,
    pub turn_id: String,
    pub step: u32,
    pub step_uuid: String,
    pub tool_call_id: String,
    pub name: String,
    pub args: serde_json::Value,
    pub trace_id: Option<String>,
}

/// Tool result event.
#[derive(Debug, Clone)]
pub struct LoopToolResultEvent {
    pub parent_uuid: String,
    pub tool_call_id: String,
    pub result: ExecutableToolResult,
    pub trace_id: Option<String>,
}

/// Tool progress event.
#[derive(Debug, Clone)]
pub struct LoopToolProgressEvent {
    pub tool_call_id: String,
    pub update: ToolUpdatePayload,
}

/// Tool update payload.
#[derive(Debug, Clone)]
pub struct ToolUpdatePayload {
    pub kind: String,
    pub text: Option<String>,
    pub percent: Option<f64>,
}

/// Turn interrupted event.
#[derive(Debug, Clone)]
pub struct LoopTurnInterruptedEvent {
    pub reason: LoopInterruptReason,
    pub attempted_steps: u32,
    pub active_step: Option<u32>,
    pub message: Option<String>,
    pub interrupt_reason: Option<LoopInterruptCause>,
    pub trace_id: Option<String>,
}

/// Text delta event (live streaming).
#[derive(Debug, Clone)]
pub struct LoopTextDeltaEvent {
    pub delta: String,
}

/// Thinking delta event (live streaming).
#[derive(Debug, Clone)]
pub struct LoopThinkingDeltaEvent {
    pub delta: String,
}

/// Tool call delta event (live streaming).
#[derive(Debug, Clone)]
pub struct LoopToolCallDeltaEvent {
    pub tool_call_id: String,
    pub name: Option<String>,
    pub arguments_part: Option<String>,
}

/// A recorded event (persisted to transcript).
#[derive(Debug, Clone)]
pub enum LoopRecordedEvent {
    StepBegin(LoopStepBeginEvent),
    StepEnd(LoopStepEndEvent),
    ContentPart(LoopContentPartEvent),
    ToolCall(LoopToolCallEvent),
    ToolResult(LoopToolResultEvent),
}

/// A live-only event (not persisted).
#[derive(Debug, Clone)]
pub enum LoopLiveOnlyEvent {
    TurnInterrupted(LoopTurnInterruptedEvent),
    StepRetrying(LoopStepRetryingEvent),
    TextDelta(LoopTextDeltaEvent),
    ThinkingDelta(LoopThinkingDeltaEvent),
    ToolCallDelta(LoopToolCallDeltaEvent),
    ToolProgress(LoopToolProgressEvent),
}

/// Any loop event.
#[derive(Debug, Clone)]
pub enum LoopEvent {
    Recorded(LoopRecordedEvent),
    LiveOnly(LoopLiveOnlyEvent),
}

/// Event dispatcher — routes recorded events to transcript and live events to UI.
pub struct LoopEventDispatcher {
    append_transcript: Box<dyn Fn(LoopRecordedEvent) -> Result<(), Box<dyn std::error::Error>> + Send + Sync>,
    emit_live: Option<Box<dyn Fn(LoopLiveOnlyEvent) + Send + Sync>>,
}

impl LoopEventDispatcher {
    pub fn new(
        append_transcript: Box<dyn Fn(LoopRecordedEvent) -> Result<(), Box<dyn std::error::Error>> + Send + Sync>,
        emit_live: Option<Box<dyn Fn(LoopLiveOnlyEvent) + Send + Sync>>,
    ) -> Self {
        Self { append_transcript, emit_live }
    }

    /// Dispatch a recorded event (persisted + optionally live).
    pub fn dispatch_recorded(&self, event: LoopRecordedEvent) -> Result<(), Box<dyn std::error::Error>> {
        (self.append_transcript)(event.clone())?;
        if let Some(ref emit) = self.emit_live {
            emit(LoopLiveOnlyEvent::from_recorded(&event));
        }
        Ok(())
    }

    /// Dispatch a live-only event (not persisted).
    pub fn dispatch_live(&self, event: LoopLiveOnlyEvent) {
        if let Some(ref emit) = self.emit_live {
            emit(event);
        }
    }
}

impl LoopLiveOnlyEvent {
    /// Convert a recorded event to a live-only event for UI emission.
    fn from_recorded(event: &LoopRecordedEvent) -> Self {
        match event {
            LoopRecordedEvent::StepBegin(e) => LoopLiveOnlyEvent::TextDelta(LoopTextDeltaEvent {
                delta: format!("[step {}]", e.step),
            }),
            _ => LoopLiveOnlyEvent::TextDelta(LoopTextDeltaEvent {
                delta: String::new(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_step_begin_event() {
        let event = LoopStepBeginEvent {
            uuid: "u1".into(),
            turn_id: "t1".into(),
            step: 1,
        };
        assert_eq!(event.uuid, "u1");
        assert_eq!(event.turn_id, "t1");
        assert_eq!(event.step, 1);
    }

    #[test]
    fn test_tool_call_event() {
        let event = LoopToolCallEvent {
            uuid: "u1".into(),
            turn_id: "t1".into(),
            step: 1,
            step_uuid: "su1".into(),
            tool_call_id: "tc1".into(),
            name: "read".into(),
            args: serde_json::json!({"path": "/a.txt"}),
            trace_id: Some("tr1".into()),
        };
        assert_eq!(event.name, "read");
        assert_eq!(event.tool_call_id, "tc1");
    }

    #[test]
    fn test_dispatcher_dispatch_recorded() {
        let recorded = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let r = recorded.clone();
        let dispatcher = LoopEventDispatcher::new(
            Box::new(move |event| {
                r.lock().unwrap().push(event);
                Ok(())
            }),
            None,
        );

        let event = LoopRecordedEvent::StepBegin(LoopStepBeginEvent {
            uuid: "u1".into(),
            turn_id: "t1".into(),
            step: 1,
        });
        dispatcher.dispatch_recorded(event).unwrap();
        assert_eq!(recorded.lock().unwrap().len(), 1);
    }

    #[test]
    fn test_turn_interrupted_event() {
        let event = LoopTurnInterruptedEvent {
            reason: LoopInterruptReason::Aborted,
            attempted_steps: 3,
            active_step: Some(2),
            message: Some("cancelled".into()),
            interrupt_reason: Some(LoopInterruptCause::UserCancelled),
            trace_id: None,
        };
        assert_eq!(event.attempted_steps, 3);
        assert!(matches!(event.reason, LoopInterruptReason::Aborted));
    }

    #[test]
    fn test_step_retrying_event() {
        let event = LoopStepRetryingEvent {
            turn_id: "t1".into(),
            step: 1,
            step_uuid: "su1".into(),
            failed_attempt: 1,
            next_attempt: 2,
            max_attempts: 3,
            delay_ms: 1000,
            error_name: "RateLimitError".into(),
            error_message: "Too many requests".into(),
        };
        assert_eq!(event.failed_attempt, 1);
        assert_eq!(event.next_attempt, 2);
    }
}