/// Check if a WebP byte stream is animated (contains the "ANMF" marker).
///
/// Corresponds to `packages/agent-core-v2/src/agent/media/webp-animated.ts`.

/// Returns true if the byte data contains the animated WebP marker "ANMF" (0x41 0x4e 0x4d 0x46).
pub fn is_animated_webp(data: &[u8]) -> bool {
    if data.len() < 50 {
        return false;
    }
    let limit = std::cmp::min(data.len() - 4, 4096);
    for i in 0..limit {
        if data[i] == 0x41 && data[i + 1] == 0x4e && data[i + 2] == 0x4d && data[i + 3] == 0x46 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_too_short() {
        assert!(!is_animated_webp(&[0; 10]));
    }

    #[test]
    fn test_not_animated() {
        let data = vec![0u8; 100];
        assert!(!is_animated_webp(&data));
    }

    #[test]
    fn test_animated() {
        let mut data = vec![0u8; 100];
        data[30] = 0x41;
        data[31] = 0x4e;
        data[32] = 0x4d;
        data[33] = 0x46;
        assert!(is_animated_webp(&data));
    }

    #[test]
    fn test_animated_at_boundary() {
        let mut data = vec![0u8; 54];
        // Place marker at position 0 (within loop range 0..50)
        data[0] = 0x41; data[1] = 0x4e; data[2] = 0x4d; data[3] = 0x46;
        assert!(is_animated_webp(&data));
    }
}