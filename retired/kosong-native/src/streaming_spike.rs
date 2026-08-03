//! Phase 8 spike — prove the ThreadsafeFunction push pattern works.
//!
//! The current kosong-native providers (`anthropic_chat`, `openai_chat`,
//! `google_genai_chat`) all return a fully-collected `StreamedMessage`
//! after the HTTP body has been entirely drained. The TS-side wrapper
//! yields pre-collected parts as an async iterator, which is fine for
//! correctness but means the UI never sees a token until the entire
//! stream has been parsed and serialized across the napi boundary.
//!
//! The fix is to use napi-rs's `ThreadsafeFunction` to push each SSE
//! delta back to JS as soon as it arrives. The pattern is:
//!
//!   1. Rust provider returns immediately with a `StreamHandle { id }`.
//!   2. A spawned tokio task reads the SSE stream and calls
//!      `tsfn.call(json_payload)` for each delta.
//!   3. On stream completion, the task calls `tsfn.call(done_payload)`.
//!   4. On error, the task calls `tsfn.call(error_payload)`.
//!
//! ## Scope of THIS spike
//!
//! The discriminant-union approach (proper `#[napi(discriminant = "kind")]`
//! sealed class in TS) requires napi-rs `napi-derive` >= 2.x with stable
//! support for it. The current pin (2.16.17) doesn't surface a
//! user-facing enum that napi-rs can serialize cleanly as a
//! `ThreadsafeFunction<T>` argument.
//!
//! To keep the spike **minimal and verifiable**, this module uses plain
//! `String` payloads (JSON-encoded) for the ThreadsafeFunction argument.
//! The TS side parses the JSON and discriminates on a `kind` field.
//! This sacrifices TS type-safety at the FFI boundary but proves the
//! napi/JS plumbing end-to-end. Once verified, the next iteration can
//! switch to a sealed union.
//!
//! ## Payload shapes (JSON-encoded strings)
//!
//! Delta event:
//!   `{"kind":"delta","text":"hello"}`
//! Done event:
//!   `{"kind":"done","total_events":42}`
//! Error event:
//!   `{"kind":"error","message":"cancelled"}`

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use napi::JsFunction;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::oneshot;

/// Global monotonic handle counter. Mirrors the `StdioClient::NEXT_HANDLE`
/// pattern from kimi-native-tools.
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

/// Opaque handle returned to JS. JS calls `.cancel()` to abort the
/// associated stream task.
#[napi]
pub struct StreamHandle {
    pub id: u32,
    /// `None` after `cancel()` has been called.
    cancel_tx: Option<oneshot::Sender<()>>,
}

#[napi]
impl StreamHandle {
    /// Signal the background task to abort. Idempotent — calling twice
    /// is a no-op.
    #[napi]
    pub fn cancel(&mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
    }
}

fn delta_payload(text: &str) -> String {
    format!(
        r#"{{"kind":"delta","text":{}}}"#,
        serde_json::to_string(text).unwrap_or_default()
    )
}

fn done_payload(total: u32) -> String {
    format!(r#"{{"kind":"done","total_events":{total}}}"#)
}

fn error_payload(message: &str) -> String {
    format!(
        r#"{{"kind":"error","message":{}}}"#,
        serde_json::to_string(message).unwrap_or_default()
    )
}

/// Spawn a synthetic event stream that pushes `count` deltas to the
/// callback, then a `done` event.
///
/// Returns a `StreamHandle` immediately. The callback receives a JSON
/// string per event (see module docs for shapes).
///
/// `@param count`       number of delta events to emit (max 1000).
/// `@param intervalMs`  delay between deltas in milliseconds (default 50).
/// `@param callback`     ThreadsafeFunction that receives one JSON string
///                       per event. JS is expected to `JSON.parse` and
///                       discriminate on `kind`.
#[napi]
pub fn streaming_spike_start(
    count: u32,
    interval_ms: Option<u32>,
    callback: JsFunction,
) -> Result<StreamHandle> {
    let count = count.min(1000);
    let interval_ms = interval_ms.unwrap_or(50);

    // Build a ThreadsafeFunction<String>. The callback I pass to
    // `create_threadsafe_function` adapts the String payload (from Rust
    // producer) to the JS-side call arguments (a single string arg).
    // `String` implements `ToNapiValue`, so the identity closure below
    // is sufficient.
    let tsfn: ThreadsafeFunction<String, ErrorStrategy::Fatal> = callback
        .create_threadsafe_function(0, |ctx| {
            let s = ctx.value;
            Ok(vec![s])
        })?;

    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    let id = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed) as u32;

    tokio::spawn(async move {
        let mut total: u32 = 0;
        for i in 0..count {
            // Each iteration creates a fresh cancellation future that
            // borrows from `cancel_rx`. `oneshot::Receiver` is `Unpin`,
            // so `&mut cancel_rx` produces a future we can poll without
            // moving the receiver itself.
            tokio::select! {
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(interval_ms as u64)) => {
                    let payload = delta_payload(&format!("delta-{i}"));
                    let status = tsfn.call(payload, ThreadsafeFunctionCallMode::NonBlocking);
                    if status == Status::Ok {
                        total += 1;
                    } else {
                        break;
                    }
                }
                _ = &mut cancel_rx => {
                    let _ = tsfn.call(
                        error_payload("cancelled"),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                    return;
                }
            }
        }
        let _ = tsfn.call(
            done_payload(total),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    });

    Ok(StreamHandle {
        id,
        cancel_tx: Some(cancel_tx),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[test]
    fn delta_payload_is_well_formed_json() {
        let s = delta_payload("hello world");
        let parsed: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["kind"], "delta");
        assert_eq!(parsed["text"], "hello world");
    }

    #[test]
    fn delta_payload_escapes_special_chars() {
        let s = delta_payload("quote\"and\\backslash");
        let parsed: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["text"], "quote\"and\\backslash");
    }

    #[test]
    fn done_payload_carries_count() {
        let parsed: serde_json::Value = serde_json::from_str(&done_payload(42)).unwrap();
        assert_eq!(parsed["kind"], "done");
        assert_eq!(parsed["total_events"], 42);
    }

    #[test]
    fn error_payload_carries_message() {
        let parsed: serde_json::Value = serde_json::from_str(&error_payload("boom")).unwrap();
        assert_eq!(parsed["kind"], "error");
        assert_eq!(parsed["message"], "boom");
    }

    #[test]
    fn handle_counter_is_monotonic() {
        let a = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        let b = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
        assert!(b > a);
    }

    /// End-to-end test using an mpsc channel instead of a real
    /// ThreadsafeFunction. Validates the *control flow* of the spike
    /// (count emissions, cancel-in-the-middle) without needing a Node
    /// runtime.
    #[tokio::test]
    async fn synthetic_event_loop_emits_expected_count() {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let (_cancel_tx, mut cancel_rx) = oneshot::channel::<()>();

        let task = tokio::spawn(async move {
            for i in 0..5u32 {
                tokio::select! {
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(1)) => {
                        let _ = tx.send(delta_payload(&format!("delta-{i}")));
                    }
                    _ = &mut cancel_rx => {
                        let _ = tx.send(error_payload("cancelled"));
                        return;
                    }
                }
            }
            let _ = tx.send(done_payload(5));
        });

        let mut received: Vec<String> = Vec::new();
        while let Some(ev) = rx.recv().await {
            received.push(ev);
            let parsed: serde_json::Value = serde_json::from_str(received.last().unwrap()).unwrap();
            if parsed["kind"] == "done" || parsed["kind"] == "error" {
                break;
            }
        }
        task.await.unwrap();

        assert_eq!(received.len(), 6);
        let last: serde_json::Value = serde_json::from_str(received.last().unwrap()).unwrap();
        assert_eq!(last["kind"], "done");
        assert_eq!(last["total_events"], 5);
    }

    #[tokio::test]
    async fn cancel_during_emission_breaks_loop() {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();

        let task = tokio::spawn(async move {
            for i in 0..1000u32 {
                tokio::select! {
                    _ = tokio::time::sleep(tokio::time::Duration::from_millis(1)) => {
                        let _ = tx.send(delta_payload(&format!("delta-{i}")));
                    }
                    _ = &mut cancel_rx => {
                        let _ = tx.send(error_payload("cancelled"));
                        return;
                    }
                }
            }
            let _ = tx.send(done_payload(1000));
        });

        // Receive a couple of deltas, then cancel.
        let _ = rx.recv().await;
        let _ = rx.recv().await;
        let _ = cancel_tx.send(());

        let mut last: Option<String> = None;
        while let Some(ev) = rx.recv().await {
            last = Some(ev);
        }
        task.await.unwrap();

        let parsed: serde_json::Value = serde_json::from_str(last.as_deref().unwrap()).unwrap();
        assert_eq!(parsed["kind"], "error");
        assert_eq!(parsed["message"], "cancelled");
    }

    #[test]
    fn cancel_idempotent_after_drop() {
        // A handle with `cancel_tx: None` (after `take()`) must not panic.
        let mut h = StreamHandle {
            id: 1,
            cancel_tx: None,
        };
        h.cancel(); // should be a no-op
        // No assertion needed — just verifying no panic.
    }
}