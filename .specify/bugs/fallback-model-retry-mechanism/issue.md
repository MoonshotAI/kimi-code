# Bug Issue: No fallback model mechanism on request failures

- **Slug**: fallback-model-retry-mechanism
- **Reported**: 2025-08-26T08:00:02.053Z
- **Issue**: 16
- **URL**: https://github.com/arrrrny/kimi-code-sync/issues/16
- **Severity**: high

Filed GitHub issue for the missing fallback model mechanism — when requests fail (rate limit, quota), there's no automatic switch to a fallback model after N retries.