/// `faultInjection` — deterministic provider-failure simulation.
///
/// Faithful port of `packages/agent-core-v2/src/agent/faultInjection/`.
///
/// The turn-loop recovery resends (media-degraded after an HTTP 413 body-size
/// rejection, media-stripped after an image-format rejection) are
/// deterministic given a provider error, but a real provider cannot be asked
/// to produce one on demand. Arming a one-shot fault makes the next LLM
/// request attempt raise the chosen error BEFORE the provider is contacted,
/// so the recovery path — projection rebuild, per-turn stickiness, wire
/// records — runs end-to-end while the (successful) resend still goes to the
/// real provider.
///
/// `arm` is refused unless the `fault-injection` experimental flag is enabled;
/// `take` is the requester's consumption point and stays inert otherwise.
use serde::{Deserialize, Serialize};

pub const FAULT_INJECTION_FLAG_ID: &str = "fault-injection";
pub const FAULT_INJECTION_FLAG_ENV: &str = "KIMI_CODE_EXPERIMENTAL_FAULT_INJECTION";

pub const FAULT_INJECTION_DISABLED_MESSAGE: &str =
    "Fault injection is disabled; enable the fault-injection experimental flag \
     (KIMI_CODE_EXPERIMENTAL_FAULT_INJECTION=1, the master flag, or the \
     [experimental] config section).";

/// The two injectable provider failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FaultKind {
    /// HTTP 413 body-size rejection → the media-degraded resend path.
    #[serde(rename = "request-too-large")]
    RequestTooLarge,
    /// Image-format rejection → the media-stripped resend path.
    #[serde(rename = "image-format")]
    ImageFormat,
}

impl FaultKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FaultKind::RequestTooLarge => "request-too-large",
            FaultKind::ImageFormat => "image-format",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "request-too-large" => Some(FaultKind::RequestTooLarge),
            "image-format" => Some(FaultKind::ImageFormat),
            _ => None,
        }
    }
}

/// Snapshot of the latch (TS `FaultInjectionStatus`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaultInjectionStatus {
    pub armed: Option<FaultKind>,
    pub fired: Vec<FaultKind>,
}

/// Agent-scope one-shot latch: `arm` (flag-gated) stores the next fault,
/// `take` consumes and records it.
#[derive(Debug, Default)]
pub struct FaultInjectionService {
    armed: Option<FaultKind>,
    fired: Vec<FaultKind>,
}

impl FaultInjectionService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Arm the next fault. Refused (with the TS error string) unless the
    /// experimental flag is enabled — injection must never be reachable in a
    /// session that did not opt in.
    pub fn arm(&mut self, kind: FaultKind, flag_enabled: bool) -> Result<(), String> {
        if !flag_enabled {
            return Err(FAULT_INJECTION_DISABLED_MESSAGE.to_string());
        }
        self.armed = Some(kind);
        Ok(())
    }

    pub fn status(&self) -> FaultInjectionStatus {
        FaultInjectionStatus { armed: self.armed, fired: self.fired.clone() }
    }

    pub fn clear(&mut self) {
        self.armed = None;
        self.fired.clear();
    }

    /// The requester's per-attempt consumption point: consume the armed fault,
    /// record it as fired. Inert when nothing is armed.
    pub fn take(&mut self) -> Option<FaultKind> {
        let kind = self.armed.take()?;
        self.fired.push(kind);
        Some(kind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arming_requires_the_flag() {
        let mut service = FaultInjectionService::new();
        let error = service.arm(FaultKind::RequestTooLarge, false).unwrap_err();
        assert_eq!(error, FAULT_INJECTION_DISABLED_MESSAGE);
        assert_eq!(service.status().armed, None, "a refused arm stores nothing");
    }

    #[test]
    fn arming_with_the_flag_stores_the_fault() {
        let mut service = FaultInjectionService::new();
        service.arm(FaultKind::ImageFormat, true).unwrap();
        assert_eq!(service.status().armed, Some(FaultKind::ImageFormat));
        assert!(service.status().fired.is_empty());
    }

    #[test]
    fn re_arming_replaces_the_previous_fault() {
        let mut service = FaultInjectionService::new();
        service.arm(FaultKind::ImageFormat, true).unwrap();
        service.arm(FaultKind::RequestTooLarge, true).unwrap();
        assert_eq!(service.status().armed, Some(FaultKind::RequestTooLarge));
    }

    #[test]
    fn take_is_a_one_shot() {
        let mut service = FaultInjectionService::new();
        service.arm(FaultKind::RequestTooLarge, true).unwrap();
        assert_eq!(service.take(), Some(FaultKind::RequestTooLarge));
        assert_eq!(service.take(), None, "the latch is consumed");
        assert_eq!(service.status().armed, None);
        assert_eq!(service.status().fired, vec![FaultKind::RequestTooLarge]);
    }

    #[test]
    fn take_when_nothing_is_armed_is_inert() {
        let mut service = FaultInjectionService::new();
        assert_eq!(service.take(), None);
        assert!(service.status().fired.is_empty());
    }

    #[test]
    fn fired_faults_accumulate_across_rounds() {
        let mut service = FaultInjectionService::new();
        service.arm(FaultKind::RequestTooLarge, true).unwrap();
        service.take();
        service.arm(FaultKind::ImageFormat, true).unwrap();
        service.take();
        assert_eq!(
            service.status().fired,
            vec![FaultKind::RequestTooLarge, FaultKind::ImageFormat]
        );
    }

    #[test]
    fn clear_resets_both_the_latch_and_the_history() {
        let mut service = FaultInjectionService::new();
        service.arm(FaultKind::RequestTooLarge, true).unwrap();
        service.take();
        service.arm(FaultKind::ImageFormat, true).unwrap();
        service.clear();
        assert_eq!(service.status(), FaultInjectionStatus { armed: None, fired: vec![] });
    }

    #[test]
    fn kinds_serialise_to_the_wire_spelling() {
        assert_eq!(
            serde_json::to_string(&FaultKind::RequestTooLarge).unwrap(),
            "\"request-too-large\""
        );
        assert_eq!(serde_json::to_string(&FaultKind::ImageFormat).unwrap(), "\"image-format\"");
        assert_eq!(FaultKind::parse("request-too-large"), Some(FaultKind::RequestTooLarge));
        assert_eq!(FaultKind::parse("image-format"), Some(FaultKind::ImageFormat));
        assert_eq!(FaultKind::parse("other"), None);
    }
}
