Search file contents using regular expressions (powered by ripgrep).

Use Grep to find unknown content or file locations; use Read directly when inspecting a known file's contents. Do not run `grep` or `rg` via shell: they bypass workspace policy, output limits, and sensitive-file filtering.

Write patterns in ripgrep regex syntax, which differs from POSIX `grep` syntax. For example, braces are special, so escape them as `\{` to match a literal `{`.

Hidden files are searched by default.
