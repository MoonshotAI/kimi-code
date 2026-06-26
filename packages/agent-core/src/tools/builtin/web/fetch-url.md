Fetch content from a URL. Returns the main text content extracted from the page, or a base64-encoded image if the URL points to an image file. Use this when you need to read a specific web page or view an image from a URL.

Only public `http`/`https` URLs are supported. Requests to private, loopback, or link-local addresses are refused, and responses larger than 10 MiB are rejected.
