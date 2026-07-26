/// Shared prompt-template renderer — `${var}` substitution pass.
///
/// Corresponds to `packages/agent-core-v2/src/_base/utils/render-prompt.ts`.
use napi_derive::napi;
use regex::Regex;

/// Render a prompt template by substituting `${var}` placeholders.
/// `vars_json` is a JSON object mapping variable names to string/number values.
/// Unknown or non-string/number placeholders stay verbatim.
#[napi]
pub fn native_render_prompt(template: String, vars_json: String) -> String {
    let re = Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}").unwrap();
    let vars: std::collections::HashMap<String, serde_json::Value> =
        serde_json::from_str(&vars_json).unwrap_or_default();

    re.replace_all(&template, |caps: &regex::Captures| {
        let name = &caps[1];
        match vars.get(name) {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => caps[0].to_string(), // keep verbatim
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_substitution() {
        let result = native_render_prompt(
            "Hello ${name}!".to_string(),
            r#"{"name":"World"}"#.to_string(),
        );
        assert_eq!(result, "Hello World!");
    }

    #[test]
    fn test_number_substitution() {
        let result = native_render_prompt(
            "Count: ${count}".to_string(),
            r#"{"count":42}"#.to_string(),
        );
        assert_eq!(result, "Count: 42");
    }

    #[test]
    fn test_unknown_var_kept() {
        let result = native_render_prompt(
            "Hello ${unknown}!".to_string(),
            r#"{"name":"World"}"#.to_string(),
        );
        assert_eq!(result, "Hello ${unknown}!");
    }

    #[test]
    fn test_multiple_substitutions() {
        let result = native_render_prompt(
            "${greeting} ${name}!".to_string(),
            r#"{"greeting":"Hi","name":"Alice"}"#.to_string(),
        );
        assert_eq!(result, "Hi Alice!");
    }

    #[test]
    fn test_no_vars() {
        let result = native_render_prompt(
            "Plain text".to_string(),
            r#"{}"#.to_string(),
        );
        assert_eq!(result, "Plain text");
    }

    #[test]
    fn test_empty_template() {
        let result = native_render_prompt(
            "".to_string(),
            r#"{"a":"b"}"#.to_string(),
        );
        assert_eq!(result, "");
    }

    #[test]
    fn test_dollar_sign_not_special_alone() {
        let result = native_render_prompt(
            "Price: $5".to_string(),
            r#"{}"#.to_string(),
        );
        assert_eq!(result, "Price: $5");
    }

    #[test]
    fn test_special_regex_chars_in_template() {
        let result = native_render_prompt(
            "path: ${dir}/file.txt".to_string(),
            r#"{"dir":"/home/user"}"#.to_string(),
        );
        assert_eq!(result, "path: /home/user/file.txt");
    }
}