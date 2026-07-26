/// `questionTools` — the AskUserQuestion tool's validation, normalisation, and
/// rendering.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/questionTools/tools/ask-user.ts` and
/// `question-background-task.ts`.
///
/// The actual UI interaction is the host's (the interaction kernel behind
/// `ISessionQuestionService`); what lives here is everything decidable without
/// a UI: input validation (question/option counts and uniqueness), result
/// normalisation across the two historical response shapes, the
/// dismissed/unsupported strings, the background-mode task registration and
/// its `task_id` output block, and the background task's settle rules.
use serde::{Deserialize, Serialize};

use crate::task::{
    AgentTask, QuestionTaskInfo, RegisterAgentTaskOptions, TaskInfoBase, TaskInfoByKind,
    TaskService, TaskSettlement, TaskSettlementStatus, TaskSink,
};

pub const ASK_USER_QUESTION_TOOL_NAME: &str = "AskUserQuestion";

pub const QUESTION_DISMISSED_MESSAGE: &str = "User dismissed the question without answering.";

pub const QUESTION_UNSUPPORTED_FAILURE_MESSAGE: &str =
    "The connected client does not support interactive questions. Do NOT call this tool again. \
     Ask the user directly in your text response instead.";

const QUESTION_UNIQUENESS_MESSAGE: &str = "Question texts must be unique across questions, and \
     option labels must be unique within each question.";

pub const MIN_QUESTIONS: usize = 1;
pub const MAX_QUESTIONS: usize = 4;
pub const MIN_OPTIONS: usize = 2;
pub const MAX_OPTIONS: usize = 4;

// ── Input ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionItem {
    pub question: String,
    #[serde(default)]
    pub header: String,
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AskUserQuestionInput {
    #[serde(default)]
    pub background: bool,
    pub questions: Vec<QuestionItem>,
}

/// Validate the input the way the zod schema + refine do.
///
/// Shape errors mirror the schema bounds (1-4 questions, 2-4 options, no empty
/// texts); uniqueness errors reproduce the TS strings verbatim, since the model
/// reads them to correct itself.
pub fn validate_input(input: &AskUserQuestionInput) -> Result<(), String> {
    if input.questions.len() < MIN_QUESTIONS || input.questions.len() > MAX_QUESTIONS {
        return Err(format!(
            "Invalid questions: expected {MIN_QUESTIONS}-{MAX_QUESTIONS} questions, got {}.",
            input.questions.len()
        ));
    }
    for item in &input.questions {
        if item.question.is_empty() {
            return Err("Invalid questions: question text must not be empty.".to_string());
        }
        if item.options.len() < MIN_OPTIONS || item.options.len() > MAX_OPTIONS {
            return Err(format!(
                "Invalid questions: expected {MIN_OPTIONS}-{MAX_OPTIONS} options in question {:?}, got {}.",
                item.question,
                item.options.len()
            ));
        }
        if item.options.iter().any(|option| option.label.is_empty()) {
            return Err(format!(
                "Invalid questions: option labels must not be empty in question {:?}.",
                item.question
            ));
        }
    }
    question_uniqueness_error(&input.questions).map_or(Ok(()), Err)
}

/// The uniqueness refine: duplicate question texts across the set, duplicate
/// option labels within a question.
pub fn question_uniqueness_error(questions: &[QuestionItem]) -> Option<String> {
    let mut texts = std::collections::HashSet::new();
    for item in questions {
        if !texts.insert(item.question.as_str()) {
            return Some(format!(
                "Invalid questions: duplicate question text {:?}. {QUESTION_UNIQUENESS_MESSAGE} \
                 Rephrase the duplicates and call the tool again.",
                item.question
            ));
        }
        let mut labels = std::collections::HashSet::new();
        for option in &item.options {
            if !labels.insert(option.label.as_str()) {
                return Some(format!(
                    "Invalid questions: duplicate option label {:?} in question {:?}. \
                     {QUESTION_UNIQUENESS_MESSAGE} Rephrase the duplicates and call the tool again.",
                    option.label, item.question
                ));
            }
        }
    }
    None
}

/// Human-readable description of a question batch (task descriptions, approval
/// prompts): first question's text, `(+N more)` past one.
pub fn question_description(questions: &[QuestionItem]) -> String {
    let first = questions.first().map(|q| q.question.trim()).unwrap_or("");
    let label = if first.is_empty() { "Ask user question" } else { first };
    if questions.len() <= 1 {
        return label.to_string();
    }
    format!("{label} (+{} more)", questions.len() - 1)
}

// ── Results ────────────────────────────────────────────────────────────────

/// How the user answered, when the client reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionAnswerMethod {
    Selected,
    Custom,
}

/// The normalised outcome of a question round.
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedQuestionResult {
    /// `question text -> answer`. TS models answers as a string map.
    pub answers: serde_json::Map<String, serde_json::Value>,
    pub method: Option<QuestionAnswerMethod>,
}

/// Normalise the host's raw result across its two historical shapes.
///
/// `null` → dismissed. `{ answers: {...}, method? }` → the modern response.
/// A bare object → the legacy answers map itself.
pub fn normalize_question_result(
    result: &serde_json::Value,
) -> Option<NormalizedQuestionResult> {
    if result.is_null() {
        return None;
    }
    let object = result.as_object()?;
    if let Some(answers) = object.get("answers").and_then(|a| a.as_object()) {
        let method = object
            .get("method")
            .and_then(|m| serde_json::from_value::<QuestionAnswerMethod>(m.clone()).ok());
        return Some(NormalizedQuestionResult { answers: answers.clone(), method });
    }
    Some(NormalizedQuestionResult { answers: object.clone(), method: None })
}

/// A tool result, mirroring `ExecutableToolResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionToolResult {
    pub output: String,
    pub is_error: bool,
}

/// The `{"answers": {}}` + note payload for a dismissed question.
pub fn dismissed_question_result() -> QuestionToolResult {
    QuestionToolResult {
        output: serde_json::json!({
            "answers": {},
            "note": QUESTION_DISMISSED_MESSAGE,
        })
        .to_string(),
        is_error: false,
    }
}

/// The result for an unsupported client (`NOT_IMPLEMENTED` from the kernel).
pub fn unsupported_question_result() -> QuestionToolResult {
    QuestionToolResult {
        output: QUESTION_UNSUPPORTED_FAILURE_MESSAGE.to_string(),
        is_error: true,
    }
}

/// Fold the host's raw answer into the tool result the model reads.
///
/// Empty or absent answers count as dismissal, matching TS's
/// `Object.keys(normalized.answers).length === 0` check.
pub fn render_question_result(raw: &serde_json::Value) -> QuestionToolResult {
    let Some(normalized) = normalize_question_result(raw) else {
        return dismissed_question_result();
    };
    if normalized.answers.is_empty() {
        return dismissed_question_result();
    }
    QuestionToolResult {
        output: serde_json::json!({ "answers": normalized.answers }).to_string(),
        is_error: false,
    }
}

// ── Background mode ────────────────────────────────────────────────────────

/// The task registered for `background: true`.
///
/// The run itself — parking the question with the interaction kernel and
/// waiting for the answer — is the host's closure; the settle rules
/// (completed / killed-on-abort / failed-with-reason) are this type's.
pub struct QuestionBackgroundTask {
    description: String,
    question_count: usize,
    tool_call_id: Option<String>,
    run: Box<dyn Fn(&TaskSink) -> Result<QuestionToolResult, QuestionTaskError> + Send + Sync>,
}

/// How a background question run can end abnormally.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuestionTaskError {
    /// The task was aborted (its signal fired).
    Aborted,
    Failed(String),
}

impl QuestionBackgroundTask {
    pub fn new(
        description: String,
        question_count: usize,
        tool_call_id: Option<String>,
        run: Box<dyn Fn(&TaskSink) -> Result<QuestionToolResult, QuestionTaskError> + Send + Sync>,
    ) -> Self {
        Self { description, question_count, tool_call_id, run }
    }

    pub fn question_count(&self) -> usize {
        self.question_count
    }

    pub fn tool_call_id(&self) -> Option<&str> {
        self.tool_call_id.as_deref()
    }
}

impl AgentTask for QuestionBackgroundTask {
    fn kind(&self) -> &str {
        "question"
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn id_prefix(&self) -> &str {
        "question"
    }
    fn start(&self, sink: &TaskSink) {
        match (self.run)(sink) {
            Ok(result) => {
                (sink.append_output)(&result.output);
                (sink.settle)(TaskSettlement {
                    status: TaskSettlementStatus::Completed,
                    stop_reason: None,
                });
            }
            Err(QuestionTaskError::Aborted) => {
                (sink.settle)(TaskSettlement {
                    status: TaskSettlementStatus::Killed,
                    stop_reason: None,
                });
            }
            Err(QuestionTaskError::Failed(reason)) => {
                (sink.settle)(TaskSettlement {
                    status: TaskSettlementStatus::Failed,
                    stop_reason: Some(reason),
                });
            }
        }
    }
    fn to_info(&self, base: &TaskInfoBase) -> TaskInfoByKind {
        TaskInfoByKind::Question(QuestionTaskInfo { base: base.clone() })
    }
}

/// Register a background question and render the immediate tool output.
pub fn execute_in_background(
    tasks: &mut TaskService,
    task: QuestionBackgroundTask,
) -> QuestionToolResult {
    let description = task.description.clone();
    let task_id = match tasks
        .register_task(&task, RegisterAgentTaskOptions { detached: true, ..Default::default() })
    {
        Ok(task_id) => task_id,
        Err(error) => return QuestionToolResult { output: error, is_error: true },
    };
    let status_label = tasks
        .get_task(&task_id)
        .map(|info| info.status.as_str())
        .unwrap_or("running");
    QuestionToolResult {
        output: render_background_question_output(&task_id, &description, status_label),
        is_error: false,
    }
}

/// The `task_id:` block returned by a background question registration.
pub fn render_background_question_output(
    task_id: &str,
    description: &str,
    status: &str,
) -> String {
    format!(
        "task_id: {task_id}\n\
         description: {description}\n\
         status: {status}\n\
         automatic_notification: true\n\
         next_step: Continue your current work; the answer will arrive automatically when the user responds.\n\
         next_step: Use TaskOutput with this task_id for a non-blocking status/answer snapshot.\n\
         next_step: Use TaskStop only if the question should be cancelled.\n\
         human_shell_hint: The pending question is also visible in /tasks."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::TaskServiceConfig;

    fn option(label: &str) -> QuestionOption {
        QuestionOption { label: label.to_string(), description: String::new() }
    }

    fn item(question: &str, labels: &[&str]) -> QuestionItem {
        QuestionItem {
            question: question.to_string(),
            header: String::new(),
            options: labels.iter().map(|l| option(l)).collect(),
            multi_select: false,
        }
    }

    fn input(questions: Vec<QuestionItem>) -> AskUserQuestionInput {
        AskUserQuestionInput { background: false, questions }
    }

    // ── validation ────────────────────────────────────────────────────────

    #[test]
    fn a_well_formed_input_validates() {
        let ok = input(vec![item("Which auth method?", &["OAuth", "API key"])]);
        assert!(validate_input(&ok).is_ok());
    }

    #[test]
    fn question_count_bounds_are_enforced() {
        assert!(validate_input(&input(vec![])).is_err());
        let five = input((0..5).map(|i| item(&format!("q{i}?"), &["a", "b"])).collect());
        assert!(validate_input(&five).is_err());
        let four = input((0..4).map(|i| item(&format!("q{i}?"), &["a", "b"])).collect());
        assert!(validate_input(&four).is_ok());
    }

    #[test]
    fn option_count_bounds_are_enforced() {
        assert!(validate_input(&input(vec![item("q?", &["only"])])).is_err());
        assert!(validate_input(&input(vec![item("q?", &["a", "b", "c", "d", "e"])])).is_err());
        assert!(validate_input(&input(vec![item("q?", &["a", "b", "c", "d"])])).is_ok());
    }

    #[test]
    fn empty_texts_are_rejected() {
        assert!(validate_input(&input(vec![item("", &["a", "b"])])).is_err());
        assert!(validate_input(&input(vec![item("q?", &["", "b"])])).is_err());
    }

    #[test]
    fn duplicate_question_texts_are_rejected_with_guidance() {
        let dup = input(vec![item("Same?", &["a", "b"]), item("Same?", &["c", "d"])]);
        let error = validate_input(&dup).unwrap_err();
        assert!(error.contains("duplicate question text \"Same?\""));
        assert!(error.contains("Rephrase the duplicates and call the tool again."));
    }

    #[test]
    fn duplicate_option_labels_within_a_question_are_rejected() {
        let dup = input(vec![item("Pick?", &["same", "same"])]);
        let error = validate_input(&dup).unwrap_err();
        assert!(error.contains("duplicate option label \"same\" in question \"Pick?\""));
    }

    #[test]
    fn the_same_option_label_in_different_questions_is_fine() {
        let ok = input(vec![item("First?", &["yes", "no"]), item("Second?", &["yes", "no"])]);
        assert!(validate_input(&ok).is_ok());
    }

    // ── description ───────────────────────────────────────────────────────

    #[test]
    fn the_description_is_the_first_question() {
        assert_eq!(question_description(&[item("Which one?", &["a", "b"])]), "Which one?");
    }

    #[test]
    fn extra_questions_are_counted() {
        let questions = vec![
            item("Which one?", &["a", "b"]),
            item("And this?", &["a", "b"]),
            item("Also?", &["a", "b"]),
        ];
        assert_eq!(question_description(&questions), "Which one? (+2 more)");
    }

    #[test]
    fn a_blank_first_question_falls_back() {
        assert_eq!(question_description(&[item("   ", &["a", "b"])]), "Ask user question");
        assert_eq!(question_description(&[]), "Ask user question");
    }

    // ── normalisation ─────────────────────────────────────────────────────

    #[test]
    fn null_normalises_to_dismissed() {
        assert_eq!(normalize_question_result(&serde_json::Value::Null), None);
    }

    #[test]
    fn the_modern_response_shape_carries_answers_and_method() {
        let raw = serde_json::json!({ "answers": { "Which?": "OAuth" }, "method": "selected" });
        let normalized = normalize_question_result(&raw).unwrap();
        assert_eq!(normalized.answers.get("Which?").unwrap(), "OAuth");
        assert_eq!(normalized.method, Some(QuestionAnswerMethod::Selected));
    }

    #[test]
    fn an_unknown_method_is_dropped_not_fatal() {
        let raw = serde_json::json!({ "answers": { "Which?": "OAuth" }, "method": "telepathy" });
        let normalized = normalize_question_result(&raw).unwrap();
        assert_eq!(normalized.method, None);
    }

    #[test]
    fn the_legacy_bare_map_shape_still_normalises() {
        let raw = serde_json::json!({ "Which?": "OAuth" });
        let normalized = normalize_question_result(&raw).unwrap();
        assert_eq!(normalized.answers.get("Which?").unwrap(), "OAuth");
        assert_eq!(normalized.method, None);
    }

    #[test]
    fn non_object_results_are_dismissed() {
        assert_eq!(normalize_question_result(&serde_json::json!("nope")), None);
        assert_eq!(normalize_question_result(&serde_json::json!([1, 2])), None);
    }

    // ── rendering ─────────────────────────────────────────────────────────

    #[test]
    fn answers_render_as_the_json_payload() {
        let raw = serde_json::json!({ "answers": { "Which?": "OAuth" } });
        let result = render_question_result(&raw);
        assert!(!result.is_error);
        let parsed: serde_json::Value = serde_json::from_str(&result.output).unwrap();
        assert_eq!(parsed["answers"]["Which?"], "OAuth");
        assert!(parsed.get("note").is_none());
    }

    #[test]
    fn empty_answers_render_as_dismissed() {
        let raw = serde_json::json!({ "answers": {} });
        let result = render_question_result(&raw);
        assert!(!result.is_error, "dismissal is not an error");
        let parsed: serde_json::Value = serde_json::from_str(&result.output).unwrap();
        assert_eq!(parsed["note"], QUESTION_DISMISSED_MESSAGE);
    }

    #[test]
    fn null_renders_as_dismissed() {
        let result = render_question_result(&serde_json::Value::Null);
        assert!(result.output.contains(QUESTION_DISMISSED_MESSAGE));
    }

    #[test]
    fn the_unsupported_result_is_an_error_with_do_not_retry() {
        let result = unsupported_question_result();
        assert!(result.is_error);
        assert!(result.output.contains("Do NOT call this tool again"));
    }

    // ── background mode ───────────────────────────────────────────────────

    fn noop_task(description: &str) -> QuestionBackgroundTask {
        QuestionBackgroundTask::new(
            description.to_string(),
            1,
            Some("call-1".to_string()),
            Box::new(|_sink| {
                Ok(QuestionToolResult {
                    output: serde_json::json!({ "answers": { "q": "a" } }).to_string(),
                    is_error: false,
                })
            }),
        )
    }

    #[test]
    fn background_registration_returns_the_task_block() {
        let mut tasks = TaskService::new(TaskServiceConfig::default());
        let result = execute_in_background(&mut tasks, noop_task("Which auth? (+1 more)"));
        assert!(!result.is_error);
        assert!(result.output.starts_with("task_id: question-"));
        assert!(result.output.contains("description: Which auth? (+1 more)"));
        assert!(result.output.contains("status: running"));
        assert!(result.output.contains("automatic_notification: true"));
        assert!(result
            .output
            .contains("human_shell_hint: The pending question is also visible in /tasks."));
    }

    #[test]
    fn background_registration_failure_is_an_error_result() {
        let mut tasks = TaskService::new(TaskServiceConfig {
            max_running_tasks: Some(0),
            ..Default::default()
        });
        let result = execute_in_background(&mut tasks, noop_task("q"));
        assert!(result.is_error);
        assert!(result.output.contains("Too many background tasks"));
    }

    #[test]
    fn the_background_task_registers_as_a_question_task() {
        let mut tasks = TaskService::new(TaskServiceConfig::default());
        let result = execute_in_background(&mut tasks, noop_task("Which?"));
        let task_id = result.output.lines().next().unwrap().strip_prefix("task_id: ").unwrap();
        let info = tasks.get_task(task_id).unwrap();
        assert_eq!(info.kind, "question");
        assert!(info.detached);
    }

    #[test]
    fn a_successful_run_settles_completed_with_the_answer_as_output() {
        let task = noop_task("q");
        let outputs = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let settled = std::sync::Arc::new(std::sync::Mutex::new(Vec::<TaskSettlement>::new()));
        let sink = TaskSink {
            append_output: {
                let outputs = outputs.clone();
                Box::new(move |chunk| outputs.lock().unwrap().push(chunk.to_string()))
            },
            settle: {
                let settled = settled.clone();
                Box::new(move |settlement| {
                    settled.lock().unwrap().push(settlement);
                    true
                })
            },
        };
        task.start(&sink);
        assert_eq!(outputs.lock().unwrap().len(), 1);
        let settled = settled.lock().unwrap();
        assert_eq!(settled.len(), 1);
        assert_eq!(settled[0].status, TaskSettlementStatus::Completed);
    }

    #[test]
    fn an_aborted_run_settles_killed_without_a_reason() {
        let task = QuestionBackgroundTask::new(
            "q".to_string(),
            1,
            None,
            Box::new(|_| Err(QuestionTaskError::Aborted)),
        );
        let settled = std::sync::Arc::new(std::sync::Mutex::new(Vec::<TaskSettlement>::new()));
        let sink = TaskSink {
            append_output: Box::new(|_| {}),
            settle: {
                let settled = settled.clone();
                Box::new(move |settlement| {
                    settled.lock().unwrap().push(settlement);
                    true
                })
            },
        };
        task.start(&sink);
        let settled = settled.lock().unwrap();
        assert_eq!(settled[0].status, TaskSettlementStatus::Killed);
        assert_eq!(settled[0].stop_reason, None);
    }

    #[test]
    fn a_failed_run_settles_failed_with_the_reason() {
        let task = QuestionBackgroundTask::new(
            "q".to_string(),
            1,
            None,
            Box::new(|_| Err(QuestionTaskError::Failed("kernel exploded".to_string()))),
        );
        let settled = std::sync::Arc::new(std::sync::Mutex::new(Vec::<TaskSettlement>::new()));
        let sink = TaskSink {
            append_output: Box::new(|_| {}),
            settle: {
                let settled = settled.clone();
                Box::new(move |settlement| {
                    settled.lock().unwrap().push(settlement);
                    true
                })
            },
        };
        task.start(&sink);
        let settled = settled.lock().unwrap();
        assert_eq!(settled[0].status, TaskSettlementStatus::Failed);
        assert_eq!(settled[0].stop_reason.as_deref(), Some("kernel exploded"));
    }
}
