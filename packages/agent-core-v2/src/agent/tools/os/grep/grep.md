Search file contents using regular expressions (powered by ripgrep). Use it instead of shell `grep` or `rg`, which bypass the workspace's path policy, output limits, and secret-file filtering.

Patterns use ripgrep regex syntax, which differs from POSIX `grep`: for example, braces are special, so escape them as `\{` to match a literal `{`. Hidden files are searched by default.
