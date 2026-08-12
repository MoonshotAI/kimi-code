---
"@moonshot-ai/kimi-code": patch
---

Fix glob character classes that start with `]`. A pattern such as `[]]*.ts` was cut short at the first `]`, so it silently matched the wrong files, and a class that is valid as a glob but not as a JavaScript regex (a reversed range like `[a--]`) threw `Range out of order in character class` out of `glob` instead of matching nothing as Python `fnmatch` does.
