//! Hook combinators and constructors for the turn loop.
//!
//! The core hook types (`LoopHooks`, `BeforeStepResult`, `AfterStepResult`,
//! `StepContext`, `AfterStepContext`) live in `turn_loop::types` and are
//! already wired into `run_turn`. This module provides:
//!
//! - `noop()`: a `LoopHooks` whose every hook is `None` (the explicit form
//!   of `input.hooks = None`, useful when callers want a uniform shape).
//! - `Chain`: runs two hook sets in sequence, left-to-right. The first
//!   `StopTurn` wins; otherwise the second hook's result is used.
//! - `before_step_fn` / `after_step_fn`: ergonomic constructors so callers
//!   can build a `LoopHooks` from a single closure without spelling out
//!   the full struct.
//!
//! These keep `run_turn` polymorphic over hook composition: goal-aware
//! steering, telemetry, logging, and any future hook can be layered without
//! touching the loop itself.

use crate::turn_loop::types::{
    AfterStepContext, AfterStepResult, BeforeStepResult, LoopHooks, StepContext,
};

/// Build a `LoopHooks` whose every hook is `None`.
///
/// Equivalent to passing `hooks: None` into `RunTurnInput`, but useful when
/// a caller wants a uniform shape (for example, to swap a single hook in
/// later without restructuring the call site).
pub fn noop() -> LoopHooks {
    LoopHooks::default()
}

/// Build a `LoopHooks` from a single `before_step` closure.
pub fn before_step_fn<F>(f: F) -> LoopHooks
where
    F: Fn(&StepContext) -> Result<Option<BeforeStepResult>, Box<dyn std::error::Error>>
        + Send
        + Sync
        + 'static,
{
    LoopHooks {
        before_step: Some(Box::new(f)),
        after_step: None,
    }
}

/// Build a `LoopHooks` from a single `after_step` closure.
pub fn after_step_fn<F>(f: F) -> LoopHooks
where
    F: Fn(&AfterStepContext) -> Result<Option<AfterStepResult>, Box<dyn std::error::Error>>
        + Send
        + Sync
        + 'static,
{
    LoopHooks {
        before_step: None,
        after_step: Some(Box::new(f)),
    }
}

/// Chain two hook sets. `left` runs first; if it returns `StopTurn`, the
/// right side is skipped. Otherwise the right side runs and its result
/// (if any) wins. Errors from either side short-circuit.
pub fn chain(left: LoopHooks, right: LoopHooks) -> LoopHooks {
    LoopHooks {
        before_step: match (left.before_step, right.before_step) {
            (None, None) => None,
            (Some(l), None) => Some(l),
            (None, Some(r)) => Some(r),
            (Some(l), Some(r)) => {
                Some(Box::new(move |ctx: &StepContext| {
                    match l(ctx)? {
                        Some(BeforeStepResult::StopTurn(reason)) => {
                            Ok(Some(BeforeStepResult::StopTurn(reason)))
                        }
                        Some(BeforeStepResult::Continue) | None => r(ctx),
                    }
                }))
            }
        },
        after_step: match (left.after_step, right.after_step) {
            (None, None) => None,
            (Some(l), None) => Some(l),
            (None, Some(r)) => Some(r),
            (Some(l), Some(r)) => {
                Some(Box::new(move |ctx: &AfterStepContext| {
                    match l(ctx)? {
                        Some(AfterStepResult::StopTurn(reason)) => {
                            Ok(Some(AfterStepResult::StopTurn(reason)))
                        }
                        Some(AfterStepResult::Continue) | None => r(ctx),
                    }
                }))
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn noop_is_all_none() {
        let h = noop();
        assert!(h.before_step.is_none());
        assert!(h.after_step.is_none());
    }

    #[test]
    fn before_step_fn_attaches_closure() {
        let called = Arc::new(Mutex::new(false));
        let called_clone = called.clone();
        let h = before_step_fn(move |_ctx| {
            *called_clone.lock().unwrap() = true;
            Ok(None)
        });
        assert!(h.before_step.is_some());
        assert!(h.after_step.is_none());

        let ctx = StepContext {
            turn_id: "t".into(),
            step: 0,
        };
        h.before_step.unwrap()(&ctx).unwrap();
        assert!(*called.lock().unwrap());
    }

    #[test]
    fn chain_left_stop_turn_wins() {
        let left = before_step_fn(|_ctx| {
            Ok(Some(BeforeStepResult::StopTurn(
                crate::turn_loop::types::LoopTurnStopReason::Aborted,
            )))
        });
        let right_called = Arc::new(Mutex::new(false));
        let right_called_clone = right_called.clone();
        let right = before_step_fn(move |_ctx| {
            *right_called_clone.lock().unwrap() = true;
            Ok(None)
        });

        let chained = chain(left, right);
        let ctx = StepContext {
            turn_id: "t".into(),
            step: 0,
        };
        let result = chained.before_step.unwrap()(&ctx).unwrap();
        assert!(matches!(
            result,
            Some(BeforeStepResult::StopTurn(
                crate::turn_loop::types::LoopTurnStopReason::Aborted
            ))
        ));
        // Right side must not have been called.
        assert!(!*right_called.lock().unwrap());
    }

    #[test]
    fn chain_left_continue_falls_through_to_right() {
        let left = before_step_fn(|_ctx| Ok(Some(BeforeStepResult::Continue)));
        let right_returned = Arc::new(Mutex::new(false));
        let right_returned_clone = right_returned.clone();
        let right = before_step_fn(move |_ctx| {
            *right_returned_clone.lock().unwrap() = true;
            Ok(None)
        });

        let chained = chain(left, right);
        let ctx = StepContext {
            turn_id: "t".into(),
            step: 0,
        };
        let result = chained.before_step.unwrap()(&ctx).unwrap();
        assert!(result.is_none());
        assert!(*right_returned.lock().unwrap());
    }

    #[test]
    fn chain_left_none_falls_through_to_right() {
        let left = noop();
        let right_called = Arc::new(Mutex::new(false));
        let right_called_clone = right_called.clone();
        let right = before_step_fn(move |_ctx| {
            *right_called_clone.lock().unwrap() = true;
            Ok(None)
        });

        let chained = chain(left, right);
        assert!(chained.before_step.is_some());
        let ctx = StepContext {
            turn_id: "t".into(),
            step: 0,
        };
        chained.before_step.unwrap()(&ctx).unwrap();
        assert!(*right_called.lock().unwrap());
    }

    #[test]
    fn chain_after_step_left_stop_wins() {
        let left = after_step_fn(|_ctx| {
            Ok(Some(AfterStepResult::StopTurn(
                crate::turn_loop::types::LoopTurnStopReason::EndTurn,
            )))
        });
        let right = after_step_fn(|_ctx| {
            Ok(Some(AfterStepResult::StopTurn(
                crate::turn_loop::types::LoopTurnStopReason::Aborted,
            )))
        });

        let chained = chain(left, right);
        let ctx = AfterStepContext {
            turn_id: "t".into(),
            step: 0,
            tool_results: vec![],
        };
        let result = chained.after_step.unwrap()(&ctx).unwrap();
        assert!(matches!(
            result,
            Some(AfterStepResult::StopTurn(
                crate::turn_loop::types::LoopTurnStopReason::EndTurn
            ))
        ));
    }

    #[test]
    fn chain_propagates_errors_from_left() {
        let left = before_step_fn(|_ctx| Err("boom".into()));
        let right = before_step_fn(|_ctx| Ok(None));

        let chained = chain(left, right);
        let ctx = StepContext {
            turn_id: "t".into(),
            step: 0,
        };
        let result = chained.before_step.unwrap()(&ctx);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().to_string(), "boom");
    }
}
