/// `contextMemory` vacuous-content predicate.
///
/// Faithful port of
/// `packages/agent-core-v2/src/agent/contextMemory/vacuousContent.ts`.
///
/// Shared test for content parts that carry nothing the provider wire can
/// represent, used by the loop-event fold (settle-time drop of output-free
/// steps) and the context projector (wire-time drop of wholly-vacuous
/// messages). Vacuous means an empty or whitespace-only text block, or an
/// empty thinking block with no provider signature; a signed thinking block
/// (`encrypted`) is never vacuous — reasoning providers require it back
/// verbatim — and media parts always carry content.
use crate::context::types::ContentPart;

pub fn is_vacuous_content_part(part: &ContentPart) -> bool {
    match part {
        ContentPart::Text { text } => text.trim().is_empty(),
        // TS: `part.encrypted === undefined && part.think.trim().length === 0`.
        // This crate models `think` as optional; an absent think block is the
        // empty string for this predicate's purposes.
        ContentPart::Think { think, encrypted, .. } => {
            encrypted.is_none() && think.as_deref().unwrap_or("").trim().is_empty()
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::types::MediaContainer;

    #[test]
    fn empty_text_is_vacuous() {
        assert!(is_vacuous_content_part(&ContentPart::Text { text: String::new() }));
    }

    #[test]
    fn whitespace_text_is_vacuous() {
        assert!(is_vacuous_content_part(&ContentPart::Text { text: "  \n\t ".to_string() }));
    }

    #[test]
    fn non_empty_text_is_not_vacuous() {
        assert!(!is_vacuous_content_part(&ContentPart::Text { text: "hi".to_string() }));
    }

    #[test]
    fn empty_unsigned_think_is_vacuous() {
        assert!(is_vacuous_content_part(&ContentPart::Think {
            think: Some("   ".to_string()),
            encrypted: None,
            signature: None,
        }));
        assert!(is_vacuous_content_part(&ContentPart::Think {
            think: None,
            encrypted: None,
            signature: None,
        }));
    }

    #[test]
    fn signed_think_is_never_vacuous() {
        // Reasoning providers require the encrypted block back verbatim, so an
        // otherwise-empty signed think block must survive settle.
        assert!(!is_vacuous_content_part(&ContentPart::Think {
            think: Some(String::new()),
            encrypted: Some("opaque".to_string()),
            signature: None,
        }));
    }

    #[test]
    fn non_empty_think_is_not_vacuous() {
        assert!(!is_vacuous_content_part(&ContentPart::Think {
            think: Some("reasoning".to_string()),
            encrypted: None,
            signature: None,
        }));
    }

    #[test]
    fn media_parts_are_never_vacuous() {
        let part = ContentPart::ImageUrl {
            image_url: MediaContainer { url: String::new(), id: None },
        };
        assert!(!is_vacuous_content_part(&part));
    }
}
