Fetch content from a URL. For an HTML page the main article text is extracted; for a plain-text or markdown response the full body is returned verbatim. The result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.

Only fully-formed public `http`/`https` URLs are supported; other schemes and private or loopback addresses are not fetched. Very large pages may be truncated or refused.
