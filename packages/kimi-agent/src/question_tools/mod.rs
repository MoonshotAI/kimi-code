/// QuestionTools — ask user question tool, delegating to HostCallbacks.
///
/// Corresponds to `packages/agent-core-v2/src/agent/questionTools/`.

use serde::{Deserialize, Serialize};

/// A question to ask the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<QuestionOption>>,
}

/// A single option in a question.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The user's answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Answer {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_label: Option<String>,
}

/// QuestionTools — delegates to the host via a callback.
pub struct QuestionTools {
    ask_fn: Option<Box<dyn Fn(&Question) -> Result<Answer, String> + Send + Sync>>,
}

impl QuestionTools {
    pub fn new() -> Self {
        Self { ask_fn: None }
    }

    pub fn set_ask_fn<F>(&mut self, f: F)
    where
        F: Fn(&Question) -> Result<Answer, String> + Send + Sync + 'static,
    {
        self.ask_fn = Some(Box::new(f));
    }

    pub fn ask(&self, question: &Question) -> Result<Answer, String> {
        match &self.ask_fn {
            Some(f) => f(question),
            None => Err("QuestionTools: no ask handler set".to_string()),
        }
    }
}

impl Default for QuestionTools { fn default() -> Self { Self::new() } }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_handler() {
        let qt = QuestionTools::new();
        let q = Question { text: "test?".into(), options: None };
        assert!(qt.ask(&q).is_err());
    }

    #[test]
    fn test_with_handler() {
        let mut qt = QuestionTools::new();
        qt.set_ask_fn(|q| Ok(Answer { text: format!("answered: {}", q.text), selected_label: None }));
        let q = Question { text: "hello?".into(), options: None };
        let a = qt.ask(&q).unwrap();
        assert_eq!(a.text, "answered: hello?");
    }
}