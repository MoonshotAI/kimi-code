/// Loop error utilities.
///
/// Corresponds to `packages/agent-core/src/loop/errors.ts`.

use std::error::Error;
use std::fmt;

/// Error indicating the maximum number of steps was exceeded.
#[derive(Debug, Clone)]
pub struct MaxStepsExceededError {
    pub max_steps: u32,
}

impl fmt::Display for MaxStepsExceededError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Max steps ({}) exceeded", self.max_steps)
    }
}

impl Error for MaxStepsExceededError {}

/// Create a max-steps-exceeded error.
pub fn create_max_steps_exceeded_error(max_steps: u32) -> MaxStepsExceededError {
    MaxStepsExceededError { max_steps }
}

/// Check if an error is a max-steps-exceeded error.
pub fn is_max_steps_exceeded_error(err: &(dyn Error + 'static)) -> bool {
    err.downcast_ref::<MaxStepsExceededError>().is_some()
}

/// Check if an error is an abort error (cancelled signal).
pub fn is_abort_error(err: &dyn Error) -> bool {
    // Check if the error message contains "abort" or "cancel"
    let msg = err.to_string().to_lowercase();
    msg.contains("abort") || msg.contains("cancel") || msg.contains("task")
}

/// Extract a human-readable error message from any error.
pub fn error_message(err: &dyn Error) -> String {
    err.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_max_steps_exceeded_error() {
        let err = create_max_steps_exceeded_error(10);
        assert_eq!(err.max_steps, 10);
        assert!(err.to_string().contains("10"));
        assert!(is_max_steps_exceeded_error(&err));
    }

    #[test]
    fn test_is_abort_error() {
        let err = std::io::Error::new(std::io::ErrorKind::Other, "task cancelled");
        assert!(is_abort_error(&err));
    }

    #[test]
    fn test_error_message() {
        let err = create_max_steps_exceeded_error(5);
        let msg = error_message(&err);
        assert!(!msg.is_empty());
    }
}