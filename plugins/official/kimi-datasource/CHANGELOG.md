# Changelog

## 3.3.0 - 2026-07-22

- Add five data sources: `wind` (万得), `imf` (IMF macro datasets), `gildata` (恒生聚源 smart screening), `sec_edgar` (US SEC filings), and `sp_data` (S&P Capital IQ, paid scope).
- Strengthen source routing: require one specialized source per simple lookup, stop after the first sufficient result, and keep FX requests on IMF instead of querying Yahoo Finance in parallel or as a fallback.
- Retry once with a credential refreshed by the Kimi Code host when the backend rejects the previous access token during rotation.

## 3.2.0 - 2026-06-10

- Add the `yuandian_law` data source (元典法律数据库) for Chinese laws/regulations and judicial case search.
- Append a trace line (`request-id` / `tool-call-id`) to every tool result so failures can be correlated with backend logs.

## 3.1.2 - 2026-06-09

- Use OAuth credentials and datasource endpoints that match the active Kimi Code environment.

## 3.1.1 - 2026-06-02

- Refine skill activation wording and answer-language guidance.

## 3.1.0 - 2026-05-29

- Align the MCP server with the Python plugin's generic two-tool workflow.
- Remove the `query_stock` shortcut; use `get_data_source_desc` before `call_data_source_tool`.
