# Changelog

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
