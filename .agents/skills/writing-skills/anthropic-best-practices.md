# 技能编写最佳实践

> 学习如何编写 Claude 能发现并成功使用的有效技能。

好的技能是简洁、结构良好、并经过真实使用测试的。本指南提供实用的编写决策，帮助你编写 Claude 能发现并有效使用的技能。

关于技能工作原理的概念背景，请参阅[技能概述](/en/docs/agents-and-tools/agent-skills/overview)。

## 核心原则

### 简洁是关键

[上下文窗口](https://platform.claude.com/docs/en/build-with-claude/context-windows)是公共资源。你的技能与 Claude 需要知道的所有其他内容共享上下文窗口，包括：

* 系统提示
* 对话历史
* 其他技能的元数据
* 你的实际请求

并非技能中的每个 token 都有即时成本。启动时，只有所有技能的元数据（name 和 description）被预加载。Claude 只在技能变得相关时才读取 SKILL.md，并且只在需要时才读取额外文件。然而，在 SKILL.md 中保持简洁仍然很重要：一旦 Claude 加载它，每个 token 都在与对话历史和其他上下文竞争。

**默认假设**：Claude 已经非常聪明

只添加 Claude 还不知道的上下文。对每条信息进行质疑：

* "Claude 真的需要这个解释吗？"
* "我能假设 Claude 知道这个吗？"
* "这段话值得它的 token 成本吗？"

**好的示例：简洁**（约 50 个 token）：

````markdown  theme={null}
## 提取 PDF 文本

使用 pdfplumber 进行文本提取：

```python
import pdfplumber

with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```
````

**差的示例：太冗长**（约 150 个 token）：

```markdown  theme={null}
## 提取 PDF 文本

PDF（便携式文档格式）文件是一种常见的文件格式，包含文本、图像和其他内容。
要从 PDF 中提取文本，你需要使用一个库。有很多 PDF 处理库可用，
但我们推荐 pdfplumber，因为它易于使用且处理大多数情况都很好。
首先，你需要使用 pip 安装它。然后你可以使用下面的代码……
```

简洁版本假设 Claude 知道什么是 PDF 以及库是如何工作的。

### 设置适当的自由度

将具体程度与任务的脆弱性和可变性相匹配。

**高自由度**（基于文本的指令）：

适用场景：

* 多种方案都有效
* 决策取决于上下文
* 启发式方法指导方案

示例：

```markdown  theme={null}
## 代码审查流程

1. 分析代码结构和组织
2. 检查潜在的 bug 或边界情况
3. 建议改善可读性和可维护性
4. 验证是否遵循项目约定
```

**中等自由度**（伪代码或带参数的脚本）：

适用场景：

* 存在首选模式
* 可以接受一些变化
* 配置影响行为

示例：

````markdown  theme={null}
## 生成报告

使用此模板并根据需要自定义：

```python
def generate_report(data, format="markdown", include_charts=True):
    # 处理数据
    # 按指定格式生成输出
    # 可选包含可视化
```
````

**低自由度**（具体脚本，很少或没有参数）：

适用场景：

* 操作脆弱且容易出错
* 一致性至关重要
* 必须遵循特定顺序

示例：

````markdown  theme={null}
## 数据库迁移

严格运行此脚本：

```bash
python scripts/migrate.py --verify --backup
```

不要修改命令或添加额外参数。
````

**类比**：把 Claude 想象成一个探索路径的机器人：

* **两侧是悬崖的窄桥**：只有一条安全的路。提供具体的护栏和精确的指令（低自由度）。例如：必须按确切顺序运行的数据库迁移。
* **没有障碍的开阔地**：很多路径都能成功。给出大方向，信任 Claude 找到最佳路线（高自由度）。例如：方案取决于上下文的代码审查。

### 用你计划使用的所有模型测试

技能作为模型的补充，因此效果取决于底层模型。用你计划使用的所有模型测试你的技能。

**按模型的测试考虑**：

* **Claude Haiku**（快速、经济）：技能是否提供了足够的指导？
* **Claude Sonnet**（平衡）：技能是否清晰高效？
* **Claude Opus**（强大推理）：技能是否避免了过度解释？

对 Opus 完美工作的内容可能对 Haiku 需要更多细节。如果你计划跨多个模型使用技能，瞄准对所有模型都适用的指令。

## 技能结构

<Note>
  **YAML Frontmatter**：SKILL.md 的 frontmatter 支持两个字段：

  * `name` - 技能的可读名称（最多 64 个字符）
  * `description` - 技能做什么以及何时使用的一行描述（最多 1024 个字符）

  完整的技能结构细节请参阅[技能概述](/en/docs/agents-and-tools/agent-skills/overview#skill-structure)。
</Note>

### 命名约定

使用一致的命名模式使技能更容易引用和讨论。我们推荐使用**动名词形式**（动词 + -ing）作为技能名称，因为这清楚地描述了技能提供的活动或能力。

**好的命名示例（动名词形式）**：

* "Processing PDFs"
* "Analyzing spreadsheets"
* "Managing databases"
* "Testing code"
* "Writing documentation"

**可接受的替代方案**：

* 名词短语："PDF Processing"、"Spreadsheet Analysis"
* 动作导向："Process PDFs"、"Analyze Spreadsheets"

**避免**：

* 模糊的名称："Helper"、"Utils"、"Tools"
* 过于通用："Documents"、"Data"、"Files"
* 技能集合中命名模式不一致

一致的命名便于：

* 在文档和对话中引用技能
* 一眼就能理解技能的作用
* 组织和搜索多个技能
* 维护专业、连贯的技能库

### 编写有效的描述

`description` 字段用于技能发现，应包含技能做什么以及何时使用。

<Warning>
  **始终用第三人称写**。描述被注入系统提示中，不一致的人称视角会导致发现问题。

  * **好的：** "Processes Excel files and generates reports"
  * **避免：** "I can help you process Excel files"
  * **避免：** "You can use this to process Excel files"
</Warning>

**具体且包含关键术语**。同时包含技能做什么和何时使用的具体触发条件/上下文。

每个技能只有一个描述字段。描述对技能选择至关重要：Claude 使用它从可能 100 多个可用技能中选择正确的技能。你的描述必须提供足够的细节让 Claude 知道何时选择此技能，而 SKILL.md 的其余部分提供实现细节。

有效的示例：

**PDF 处理技能：**

```yaml  theme={null}
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
```

**Excel 分析技能：**

```yaml  theme={null}
description: Analyze Excel spreadsheets, create pivot tables, generate charts. Use when analyzing Excel files, spreadsheets, tabular data, or .xlsx files.
```

**Git 提交助手技能：**

```yaml  theme={null}
description: Generate descriptive commit messages by analyzing git diffs. Use when the user asks for help writing commit messages or reviewing staged changes.
```

避免模糊的描述：

```yaml  theme={null}
description: Helps with documents
```

```yaml  theme={null}
description: Processes data
```

```yaml  theme={null}
description: Does stuff with files
```

### 渐进式披露模式

SKILL.md 作为概述，按需指向详细材料，就像入门指南中的目录。关于渐进式披露如何工作的解释，请参阅概述中的[技能工作原理](/en/docs/agents-and-tools/agent-skills/overview#how-skills-work)。

**实用指导：**

* SKILL.md 正文保持在 500 行以内以获得最佳性能
* 接近此限制时将内容拆分到独立文件
* 使用以下模式有效地组织指令、代码和资源

#### 可视化概览：从简单到复杂

基本技能只需一个包含元数据和指令的 SKILL.md 文件：

<img src="https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=87782ff239b297d9a9e8e1b72ed72db9" alt="简单的 SKILL.md 文件，展示 YAML frontmatter 和 markdown 正文" data-og-width="2048" width="2048" data-og-height="1153" height="1153" data-path="images/agent-skills-simple-file.png" data-optimize="true" data-opv="3" srcset="https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?w=280&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=c61cc33b6f5855809907f7fda94cd80e 280w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?w=560&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=90d2c0c1c76b36e8d485f49e0810dbfd 560w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?w=840&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=ad17d231ac7b0bea7e5b4d58fb4aeabb 840w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?w=1100&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=f5d0a7a3c668435bb0aee9a3a8f8c329 1100w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?w=1650&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=0e927c1af9de5799cfe557d12249f6e6 1650w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-simple-file.png?w=2500&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=46bbb1a51dd4c8202a470ac8c80a893d 2500w" />

随着技能增长，你可以捆绑额外的内容，Claude 只在需要时才加载：

<img src="https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=a5e0aa41e3d53985a7e3e43668a33ea3" alt="捆绑额外的参考文件如 reference.md 和 forms.md。" data-og-width="2048" width="2048" data-og-height="1327" height="1327" data-path="images/agent-skills-bundling-content.png" data-optimize="true" data-opv="3" srcset="https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?w=280&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=f8a0e73783e99b4a643d79eac86b70a2 280w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?w=560&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=dc510a2a9d3f14359416b706f067904a 560w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?w=840&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=82cd6286c966303f7dd914c28170e385 840w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?w=1100&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=56f3be36c77e4fe4b523df209a6824c6 1100w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?w=1650&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=d22b5161b2075656417d56f41a74f3dd 1650w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-bundling-content.png?w=2500&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=3dd4bdd6850ffcc96c6c45fcb0acd6eb 2500w" />

完整的技能目录结构可能如下：

```
pdf/
├── SKILL.md              # 主指令（触发时加载）
├── FORMS.md              # 表单填写指南（按需加载）
├── reference.md          # API 参考（按需加载）
├── examples.md           # 使用示例（按需加载）
└── scripts/
    ├── analyze_form.py   # 实用脚本（执行，不加载）
    ├── fill_form.py      # 表单填写脚本
    └── validate.py       # 验证脚本
```

#### 模式 1：高层指南加引用

````markdown  theme={null}
---
name: PDF Processing
description: Extracts text and tables from PDF files, fills forms, and merges documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
---

# PDF 处理

## 快速开始

用 pdfplumber 提取文本：
```python
import pdfplumber
with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```

## 高级功能

**表单填写**：参见 [FORMS.md](FORMS.md) 获取完整指南
**API 参考**：参见 [REFERENCE.md](REFERENCE.md) 获取所有方法
**示例**：参见 [EXAMPLES.md](EXAMPLES.md) 获取常见模式
````

Claude 只在需要时才加载 FORMS.md、REFERENCE.md 或 EXAMPLES.md。

#### 模式 2：领域特定组织

对于有多个领域的技能，按领域组织内容以避免加载不相关的上下文。当用户询问销售指标时，Claude 只需要读取销售相关的 schema，而非财务或营销数据。这保持了 token 使用低和上下文聚焦。

```
bigquery-skill/
├── SKILL.md（概述和导航）
└── reference/
    ├── finance.md（收入、账单指标）
    ├── sales.md（商机、管道）
    ├── product.md（API 使用、功能）
    └── marketing.md（营销活动、归因）
```

````markdown SKILL.md theme={null}
# BigQuery 数据分析

## 可用数据集

**财务**：收入、ARR、账单 → 参见 [reference/finance.md](reference/finance.md)
**销售**：商机、管道、客户 → 参见 [reference/sales.md](reference/sales.md)
**产品**：API 使用、功能、采用率 → 参见 [reference/product.md](reference/product.md)
**营销**：活动、归因、邮件 → 参见 [reference/marketing.md](reference/marketing.md)

## 快速搜索

使用 grep 查找特定指标：

```bash
grep -i "revenue" reference/finance.md
grep -i "pipeline" reference/sales.md
grep -i "api usage" reference/product.md
```
````

#### 模式 3：条件性细节

展示基本内容，链接到高级内容：

```markdown  theme={null}
# DOCX 处理

## 创建文档

使用 docx-js 创建新文档。参见 [DOCX-JS.md](DOCX-JS.md)。

## 编辑文档

简单编辑可直接修改 XML。

**修订追踪**：参见 [REDLINING.md](REDLINING.md)
**OOXML 细节**：参见 [OOXML.md](OOXML.md)
```

Claude 只在用户需要这些功能时才读取 REDLINING.md 或 OOXML.md。

### 避免深层嵌套引用

当引用来自其他被引用文件时，Claude 可能只部分读取文件。遇到嵌套引用时，Claude 可能使用 `head -100` 等命令预览内容而非读取完整文件，导致信息不完整。

**从 SKILL.md 到引用保持一层深度**。所有引用文件应直接从 SKILL.md 链接，以确保 Claude 在需要时读取完整文件。

**差的示例：太深**：

```markdown  theme={null}
# SKILL.md
参见 [advanced.md](advanced.md)...

# advanced.md
参见 [details.md](details.md)...

# details.md
这里是实际信息...
```

**好的示例：一层深度**：

```markdown  theme={null}
# SKILL.md

**基本用法**：[SKILL.md 中的指令]
**高级功能**：参见 [advanced.md](advanced.md)
**API 参考**：参见 [reference.md](reference.md)
**示例**：参见 [examples.md](examples.md)
```

### 为较长的参考文件添加目录

对于超过 100 行的参考文件，在顶部包含目录。这确保 Claude 即使在部分读取预览时也能看到可用信息的完整范围。

**示例**：

```markdown  theme={null}
# API 参考

## 目录
- 认证和设置
- 核心方法（创建、读取、更新、删除）
- 高级功能（批量操作、webhooks）
- 错误处理模式
- 代码示例

## 认证和设置
...

## 核心方法
...
```

Claude 可以读取完整文件或按需跳转到特定章节。

关于这种基于文件系统的架构如何实现渐进式披露的详细信息，请参阅下方高级部分的[运行时环境](#runtime-environment)章节。

## 工作流和反馈循环

### 对复杂任务使用工作流

将复杂操作分解为清晰的顺序步骤。对于特别复杂的工作流，提供一个 Claude 可以复制到响应中并在进展时逐项勾选的清单。

**示例 1：研究综合工作流**（无代码的技能）：

````markdown  theme={null}
## 研究综合工作流

复制此清单并跟踪你的进度：

```
研究进度：
- [ ] 步骤 1：阅读所有源文档
- [ ] 步骤 2：识别关键主题
- [ ] 步骤 3：交叉验证论点
- [ ] 步骤 4：创建结构化摘要
- [ ] 步骤 5：验证引用
```

**步骤 1：阅读所有源文档**

审查 `sources/` 目录中的每个文档。记录主要论点和支持证据。

**步骤 2：识别关键主题**

寻找跨源的模式。哪些主题反复出现？源之间在哪里一致或分歧？

**步骤 3：交叉验证论点**

对于每个主要论点，验证它出现在源材料中。记录哪个源支持每个要点。

**步骤 4：创建结构化摘要**

按主题组织发现。包含：
- 主要论点
- 来自源的支持证据
- 矛盾观点（如果有）

**步骤 5：验证引用**

检查每个论点是否引用了正确的源文档。如果引用不完整，返回步骤 3。
````

此示例展示了工作流如何应用于不需要代码的分析任务。清单模式适用于任何复杂的多步骤过程。

**示例 2：PDF 表单填写工作流**（有代码的技能）：

````markdown  theme={null}
## PDF 表单填写工作流

复制此清单并在完成时逐项勾选：

```
任务进度：
- [ ] 步骤 1：分析表单（运行 analyze_form.py）
- [ ] 步骤 2：创建字段映射（编辑 fields.json）
- [ ] 步骤 3：验证映射（运行 validate_fields.py）
- [ ] 步骤 4：填写表单（运行 fill_form.py）
- [ ] 步骤 5：验证输出（运行 verify_output.py）
```

**步骤 1：分析表单**

运行：`python scripts/analyze_form.py input.pdf`

这会提取表单字段及其位置，保存到 `fields.json`。

**步骤 2：创建字段映射**

编辑 `fields.json` 为每个字段添加值。

**步骤 3：验证映射**

运行：`python scripts/validate_fields.py fields.json`

在继续之前修复所有验证错误。

**步骤 4：填写表单**

运行：`python scripts/fill_form.py input.pdf fields.json output.pdf`

**步骤 5：验证输出**

运行：`python scripts/verify_output.py output.pdf`

如果验证失败，返回步骤 2。
````

清晰的步骤防止 Claude 跳过关键验证。清单帮助 Claude 和你跟踪多步骤工作流的进度。

### 实现反馈循环

**常见模式**：运行验证器 → 修复错误 → 重复

此模式大幅提高输出质量。

**示例 1：风格指南合规**（无代码的技能）：

```markdown  theme={null}
## 内容审查流程

1. 按照 STYLE_GUIDE.md 中的指南起草内容
2. 按清单审查：
   - 检查术语一致性
   - 验证示例遵循标准格式
   - 确认所有必需章节都存在
3. 如果发现问题：
   - 记录每个问题及具体章节引用
   - 修改内容
   - 再次审查清单
4. 只有所有要求满足后才继续
5. 最终定稿并保存文档
```

这展示了使用参考文档而非脚本的验证循环模式。"验证器"就是 STYLE_GUIDE.md，Claude 通过阅读和比较来执行检查。

**示例 2：文档编辑流程**（有代码的技能）：

```markdown  theme={null}
## 文档编辑流程

1. 对 `word/document.xml` 进行编辑
2. **立即验证**：`python ooxml/scripts/validate.py unpacked_dir/`
3. 如果验证失败：
   - 仔细审查错误信息
   - 修复 XML 中的问题
   - 再次运行验证
4. **只有验证通过后才继续**
5. 重新打包：`python ooxml/scripts/pack.py unpacked_dir/ output.docx`
6. 测试输出文档
```

验证循环能及早发现错误。

## 内容指南

### 避免时间敏感的信息

不要包含会过时的信息：

**差的示例：时间敏感**（会变得不正确）：

```markdown  theme={null}
如果你在 2025 年 8 月之前做这件事，使用旧 API。
2025 年 8 月之后，使用新 API。
```

**好的示例**（使用"旧模式"章节）：

```markdown  theme={null}
## 当前方法

使用 v2 API 端点：`api.example.com/v2/messages`

## 旧模式

<details>
<summary>旧版 v1 API（2025-08 弃用）</summary>

v1 API 使用：`api.example.com/v1/messages`

此端点不再支持。
</details>
```

旧模式章节提供历史上下文而不会干扰主要内容。

### 使用一致的术语

选择一个术语并在整个技能中统一使用：

**好的 - 一致**：

* 始终用"API endpoint"
* 始终用"field"
* 始终用"extract"

**差的 - 不一致**：

* 混用"API endpoint"、"URL"、"API route"、"path"
* 混用"field"、"box"、"element"、"control"
* 混用"extract"、"pull"、"get"、"retrieve"

一致性帮助 Claude 理解和遵循指令。

## 常见模式

### 模板模式

为输出格式提供模板。将严格程度与你的需求匹配。

**严格要求时**（如 API 响应或数据格式）：

````markdown  theme={null}
## 报告结构

始终使用这个精确的模板结构：

```markdown
# [分析标题]

## 摘要
[关键发现的一段概述]

## 关键发现
- 发现 1 及支持数据
- 发现 2 及支持数据
- 发现 3 及支持数据

## 建议
1. 具体可操作的建议
2. 具体可操作的建议
```
````

**灵活指导时**（当适应性有用时）：

````markdown  theme={null}
## 报告结构

这是一个合理的默认格式，但请根据分析情况自行判断：

```markdown
# [分析标题]

## 摘要
[概述]

## 关键发现
[根据你的发现调整章节]

## 建议
[根据具体上下文定制]
```

根据具体分析类型按需调整章节。
````

### 示例模式

对于输出质量取决于看到示例的技能，提供输入/输出对，就像常规提示一样：

````markdown  theme={null}
## 提交信息格式

按照这些示例生成提交信息：

**示例 1：**
输入：添加了使用 JWT token 的用户认证
输出：
```
feat(auth): implement JWT-based authentication

Add login endpoint and token validation middleware
```

**示例 2：**
输入：修复了报告中日期显示不正确的 bug
输出：
```
fix(reports): correct date formatting in timezone conversion

Use UTC timestamps consistently across report generation
```

**示例 3：**
输入：更新了依赖并重构了错误处理
输出：
```
chore: update dependencies and refactor error handling

- Upgrade lodash to 4.17.21
- Standardize error response format across endpoints
```

遵循此风格：type(scope): 简短描述，然后详细说明。
````

示例比纯描述更能帮助 Claude 理解期望的风格和详细程度。

### 条件工作流模式

引导 Claude 通过决策点：

```markdown  theme={null}
## 文档修改工作流

1. 确定修改类型：

   **创建新内容？** → 遵循下方"创建工作流"
   **编辑现有内容？** → 遵循下方"编辑工作流"

2. 创建工作流：
   - 使用 docx-js 库
   - 从头构建文档
   - 导出为 .docx 格式

3. 编辑工作流：
   - 解压现有文档
   - 直接修改 XML
   - 每次更改后验证
   - 完成后重新打包
```

<Tip>
  如果工作流变得大且复杂、有很多步骤，考虑将它们推到独立文件中，并告诉 Claude 根据手头的任务读取相应的文件。
</Tip>

## 评估和迭代

### 先建立评估

**在编写大量文档之前创建评估。** 这确保你的技能解决的是真实问题而非想象中的问题。

**评估驱动的开发：**

1. **识别差距**：在没有技能的情况下让 Claude 执行代表性任务。记录具体的失败或缺失的上下文
2. **创建评估**：构建三个测试这些差距的场景
3. **建立基线**：衡量 Claude 在没有技能时的表现
4. **编写最小指令**：只创建足够解决差距和通过评估的内容
5. **迭代**：执行评估，与基线对比，并优化

这种方法确保你解决的是实际问题而非可能永远不会出现的预期需求。

**评估结构**：

```json  theme={null}
{
  "skills": ["pdf-processing"],
  "query": "从这个 PDF 文件中提取所有文本并保存到 output.txt",
  "files": ["test-files/document.pdf"],
  "expected_behavior": [
    "使用适当的 PDF 处理库或命令行工具成功读取 PDF 文件",
    "从文档的所有页面提取文本内容，不遗漏任何页面",
    "将提取的文本以清晰、可读的格式保存到名为 output.txt 的文件中"
  ]
}
```

<Note>
  此示例演示了带有简单测试评分标准的数据驱动评估。我们目前不提供内置的评估运行方式。用户可以创建自己的评估系统。评估是你衡量技能有效性的真实来源。
</Note>

### 与 Claude 一起迭代开发技能

最有效的技能开发过程涉及 Claude 本身。与一个 Claude 实例（"Claude A"）一起创建技能，该技能将被其他实例（"Claude B"）使用。Claude A 帮助你设计和优化指令，而 Claude B 在真实任务中测试它们。这之所以有效，是因为 Claude 模型既理解如何编写有效的智能体指令，也理解智能体需要什么信息。

**创建新技能：**

1. **不用技能完成一个任务**：用正常提示与 Claude A 一起解决问题。工作过程中，你自然会提供上下文、解释偏好、分享流程知识。注意你反复提供了什么信息。

2. **识别可复用的模式**：完成任务后，识别你提供的哪些上下文对类似的未来任务有用。

   **示例**：如果你完成了一个 BigQuery 分析，你可能提供了表名、字段定义、过滤规则（如"始终排除测试账户"）和常见查询模式。

3. **让 Claude A 创建技能**："创建一个技能来捕获我们刚刚使用的 BigQuery 分析模式。包含表 schema、命名约定和关于过滤测试账户的规则。"

   <Tip>
     Claude 模型原生理解技能的格式和结构。你不需要特殊的系统提示或"编写技能"技能来让 Claude 帮助创建技能。只需让 Claude 创建技能，它就会生成结构正确的 SKILL.md 内容，包含适当的 frontmatter 和正文。
   </Tip>

4. **审查简洁性**：检查 Claude A 是否添加了不必要的解释。问："去掉关于什么是胜率的解释——Claude 已经知道了。"

5. **改善信息架构**：让 Claude A 更有效地组织内容。例如："组织一下，让表 schema 在一个独立的参考文件中。我们以后可能会添加更多表。"

6. **在类似任务上测试**：用 Claude B（加载了技能的全新实例）在相关用例上使用技能。观察 Claude B 是否找到了正确的信息、正确应用规则、成功处理了任务。

7. **基于观察迭代**：如果 Claude B 遇到困难或遗漏了什么，带着具体情况回到 Claude A："当 Claude 使用这个技能时，它忘了在 Q4 按日期过滤。我们应该添加一个关于日期过滤模式的章节吗？"

**迭代现有技能：**

改进技能时继续同样的层级模式。你在以下之间交替：

* **与 Claude A 合作**（帮助优化技能的专家）
* **用 Claude B 测试**（使用技能执行真实工作的智能体）
* **观察 Claude B 的行为**并将见解带回 Claude A

1. **在真实工作流中使用技能**：给 Claude B（加载了技能的）实际任务，而非测试场景

2. **观察 Claude B 的行为**：记录它在哪里遇到困难、成功或做出意外选择

   **观察示例**："当我让 Claude B 做区域销售报告时，它写了查询但忘了过滤测试账户，尽管技能提到了这条规则。"

3. **回到 Claude A 进行改进**：分享当前 SKILL.md 并描述你观察到的。问："我注意到 Claude B 在我要求区域报告时忘了过滤测试账户。技能提到了过滤，但也许不够突出？"

4. **审查 Claude A 的建议**：Claude A 可能建议重组以使规则更突出，使用更强的语言如"必须过滤"而非"始终过滤"，或重构工作流章节。

5. **应用并测试更改**：用 Claude A 的改进更新技能，然后在类似请求上再次用 Claude B 测试

6. **基于使用重复**：在遇到新场景时继续这个观察-优化-测试循环。每次迭代基于真实的智能体行为而非假设来改进技能。

**收集团队反馈：**

1. 与团队成员分享技能并观察他们的使用
2. 问：技能是否在预期时激活？指令清楚吗？缺少什么？
3. 整合反馈以解决你自己使用模式中的盲点

**为什么这种方法有效**：Claude A 理解智能体需求，你提供领域专业知识，Claude B 通过真实使用揭示差距，迭代优化基于观察到的行为而非假设来改进技能。

### 观察 Claude 如何导航技能

迭代技能时，注意 Claude 在实践中实际如何使用它们。留意：

* **意外的探索路径**：Claude 是否以你未预期的顺序读取文件？这可能表明你的结构不如你想的直观
* **遗漏的连接**：Claude 是否未能跟随到重要文件的引用？你的链接可能需要更明确或更突出
* **过度依赖某些章节**：如果 Claude 反复读取同一文件，考虑该内容是否应该放在主 SKILL.md 中
* **被忽略的内容**：如果 Claude 从不访问某个捆绑文件，它可能不必要或在主指令中信号不明确

基于这些观察而非假设来迭代。技能元数据中的"name"和"description"尤其关键。Claude 使用它们来决定是否为当前任务触发技能。确保它们清楚地描述技能做什么以及何时使用。

## 要避免的反模式

### 避免 Windows 风格的路径

始终在文件路径中使用正斜杠，即使在 Windows 上：

* ✓ **好的**：`scripts/helper.py`、`reference/guide.md`
* ✗ **避免**：`scripts\helper.py`、`reference\guide.md`

Unix 风格的路径在所有平台上都能工作，而 Windows 风格的路径在 Unix 系统上会出错。

### 避免提供太多选项

除非必要，不要展示多种方案：

````markdown  theme={null}
**差的示例：太多选择**（令人困惑）：
"你可以使用 pypdf，或 pdfplumber，或 PyMuPDF，或 pdf2image，或……"

**好的示例：提供默认方案**（有备用方案）：
"使用 pdfplumber 进行文本提取：
```python
import pdfplumber
```

对于需要 OCR 的扫描 PDF，改用 pdf2image 加 pytesseract。"
````

## 高级：带可执行代码的技能

以下章节聚焦于包含可执行脚本的技能。如果你的技能只使用 markdown 指令，跳到[有效技能清单](#checklist-for-effective-skills)。

### 解决问题，不要甩锅

编写技能的脚本时，处理错误条件而不是甩给 Claude。

**好的示例：明确处理错误**：

```python  theme={null}
def process_file(path):
    """处理文件，如果不存在则创建。"""
    try:
        with open(path) as f:
            return f.read()
    except FileNotFoundError:
        # 创建带默认内容的文件而非失败
        print(f"文件 {path} 未找到，正在创建默认文件")
        with open(path, 'w') as f:
            f.write('')
        return ''
    except PermissionError:
        # 提供替代方案而非失败
        print(f"无法访问 {path}，使用默认值")
        return ''
```

**差的示例：甩给 Claude**：

```python  theme={null}
def process_file(path):
    # 直接失败让 Claude 来处理
    return open(path).read()
```

配置参数也应该有理由和文档说明，以避免"巫术常量"（Ousterhout 定律）。如果你不知道正确的值，Claude 怎么确定？

**好的示例：自文档化**：

```python  theme={null}
# HTTP 请求通常在 30 秒内完成
# 更长的超时考虑了慢速连接
REQUEST_TIMEOUT = 30

# 三次重试平衡了可靠性和速度
# 大多数间歇性故障在第二次重试时就解决了
MAX_RETRIES = 3
```

**差的示例：魔法数字**：

```python  theme={null}
TIMEOUT = 47  # 为什么是 47？
RETRIES = 5   # 为什么是 5？
```

### 提供实用脚本

即使 Claude 可以编写脚本，预制脚本有其优势：

**实用脚本的好处**：

* 比生成的代码更可靠
* 节省 token（无需在上下文中包含代码）
* 节省时间（无需代码生成）
* 确保跨使用的一致性

<img src="https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=4bbc45f2c2e0bee9f2f0d5da669bad00" alt="将可执行脚本与指令文件捆绑在一起" data-og-width="2048" width="2048" data-og-height="1154" height="1154" data-path="images/agent-skills-executable-scripts.png" data-optimize="true" data-opv="3" srcset="https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?w=280&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=9a04e6535a8467bfeea492e517de389f 280w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?w=560&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=e49333ad90141af17c0d7651cca7216b 560w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?w=840&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=954265a5df52223d6572b6214168c428 840w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?w=1100&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=2ff7a2d8f2a83ee8af132b29f10150fd 1100w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?w=1650&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=48ab96245e04077f4d15e9170e081cfb 1650w, https://mintcdn.com/anthropic-claude-docs/4Bny2bjzuGBK7o00/images/agent-skills-executable-scripts.png?w=2500&fit=max&auto=format&n=4Bny2bjzuGBK7o00&q=85&s=0301a6c8b3ee879497cc5b5483177c90 2500w" />

上图展示了可执行脚本如何与指令文件协同工作。指令文件（forms.md）引用脚本，Claude 可以在不将其内容加载到上下文中的情况下执行它。

**重要区分**：在指令中明确说明 Claude 应该：

* **执行脚本**（最常见）："运行 `analyze_form.py` 提取字段"
* **作为参考阅读**（用于复杂逻辑）："参见 `analyze_form.py` 了解字段提取算法"

对于大多数实用脚本，执行是首选因为它更可靠和高效。参见下方[运行时环境](#runtime-environment)章节了解脚本执行的工作原理。

**示例**：

````markdown  theme={null}
## 实用脚本

**analyze_form.py**：从 PDF 中提取所有表单字段

```bash
python scripts/analyze_form.py input.pdf > fields.json
```

输出格式：
```json
{
  "field_name": {"type": "text", "x": 100, "y": 200},
  "signature": {"type": "sig", "x": 150, "y": 500}
}
```

**validate_boxes.py**：检查边界框是否重叠

```bash
python scripts/validate_boxes.py fields.json
# 返回："OK" 或列出冲突
```

**fill_form.py**：将字段值应用到 PDF

```bash
python scripts/fill_form.py input.pdf fields.json output.pdf
```
````

### 使用视觉分析

当输入可以渲染为图像时，让 Claude 分析它们：

````markdown  theme={null}
## 表单布局分析

1. 将 PDF 转换为图像：
   ```bash
   python scripts/pdf_to_images.py form.pdf
   ```

2. 分析每个页面图像以识别表单字段
3. Claude 可以直观地看到字段位置和类型
````

<Note>
  在此示例中，你需要编写 `pdf_to_images.py` 脚本。
</Note>

Claude 的视觉能力有助于理解布局和结构。

### 创建可验证的中间输出

当 Claude 执行复杂的开放性任务时，它可能会出错。"计划-验证-执行"模式通过让 Claude 首先创建结构化格式的计划，然后用脚本验证该计划再执行，来及早发现错误。

**示例**：想象让 Claude 根据电子表格更新 PDF 中的 50 个表单字段。没有验证的话，Claude 可能引用不存在的字段、创建冲突的值、遗漏必填字段或错误地应用更新。

**解决方案**：使用上面展示的工作流模式（PDF 表单填写），但添加一个中间 `changes.json` 文件在应用更改前进行验证。工作流变为：分析 → **创建计划文件** → **验证计划** → 执行 → 验证。

**为什么这个模式有效：**

* **及早发现错误**：验证在更改应用前发现问题
* **机器可验证**：脚本提供客观验证
* **可逆的规划**：Claude 可以在不触碰原件的情况下迭代计划
* **清晰的调试**：错误消息指向具体问题

**何时使用**：批量操作、破坏性更改、复杂验证规则、高风险操作。

**实现提示**：让验证脚本输出详细的具体错误消息，如"字段 'signature\_date' 未找到。可用字段：customer\_name、order\_total、signature\_date\_signed"，以帮助 Claude 修复问题。

### 打包依赖

技能在代码执行环境中运行，有平台特定的限制：

* **claude.ai**：可以从 npm 和 PyPI 安装包，可以从 GitHub 仓库拉取
* **Anthropic API**：没有网络访问，没有运行时包安装

在 SKILL.md 中列出所需的包，并在[代码执行工具文档](/en/docs/agents-and-tools/tool-use/code-execution-tool)中验证它们是否可用。

### 运行时环境

技能在具有文件系统访问、bash 命令和代码执行能力的代码执行环境中运行。关于此架构的概念解释，请参阅概述中的[技能架构](/en/docs/agents-and-tools/agent-skills/overview#the-skills-architecture)。

**这对你的编写有什么影响：**

**Claude 如何访问技能：**

1. **元数据预加载**：启动时，所有技能的 YAML frontmatter 中的 name 和 description 被加载到系统提示中
2. **文件按需读取**：Claude 在需要时使用 bash Read 工具从文件系统访问 SKILL.md 和其他文件
3. **脚本高效执行**：实用脚本可以通过 bash 执行而不将其完整内容加载到上下文中。只有脚本的输出消耗 token
4. **大文件无上下文惩罚**：参考文件、数据或文档在实际读取之前不消耗上下文 token

* **文件路径很重要**：Claude 像文件系统一样导航你的技能目录。使用正斜杠（`reference/guide.md`），而非反斜杠
* **描述性文件命名**：使用表明内容的名称：`form_validation_rules.md`，而非 `doc2.md`
* **为发现而组织**：按领域或功能组织目录结构
  * 好的：`reference/finance.md`、`reference/sales.md`
  * 差的：`docs/file1.md`、`docs/file2.md`
* **捆绑全面的资源**：包含完整的 API 文档、大量示例、大型数据集；在访问之前没有上下文惩罚
* **确定性操作优先使用脚本**：编写 `validate_form.py` 而非让 Claude 生成验证代码
* **明确执行意图**：
  * "运行 `analyze_form.py` 提取字段"（执行）
  * "参见 `analyze_form.py` 了解提取算法"（作为参考阅读）
* **测试文件访问模式**：通过真实请求测试验证 Claude 能够导航你的目录结构

**示例：**

```
bigquery-skill/
├── SKILL.md（概述，指向参考文件）
└── reference/
    ├── finance.md（收入指标）
    ├── sales.md（管道数据）
    └── product.md（使用分析）
```

当用户询问收入时，Claude 读取 SKILL.md，看到对 `reference/finance.md` 的引用，并调用 bash 只读取该文件。sales.md 和 product.md 文件留在文件系统上，在需要之前消耗零上下文 token。这种基于文件系统的模型是渐进式披露的基础。Claude 可以导航并选择性地加载每个任务所需的内容。

完整的技术架构细节请参阅技能概述中的[技能工作原理](/en/docs/agents-and-tools/agent-skills/overview#how-skills-work)。

### MCP 工具引用

如果你的技能使用 MCP（模型上下文协议）工具，始终使用完全限定的工具名称以避免"工具未找到"错误。

**格式**：`ServerName:tool_name`

**示例**：

```markdown  theme={null}
使用 BigQuery:bigquery_schema 工具检索表 schema。
使用 GitHub:create_issue 工具创建 issue。
```

其中：

* `BigQuery` 和 `GitHub` 是 MCP 服务器名称
* `bigquery_schema` 和 `create_issue` 是这些服务器中的工具名称

没有服务器前缀，Claude 可能无法定位工具，尤其是当有多个 MCP 服务器可用时。

### 避免假设工具已安装

不要假设包已可用：

````markdown  theme={null}
**差的示例：假设已安装**：
"使用 pdf 库处理文件。"

**好的示例：明确依赖**：
"安装所需包：`pip install pypdf`

然后使用它：
```python
from pypdf import PdfReader
reader = PdfReader("file.pdf")
```"
````

## 技术说明

### YAML frontmatter 要求

SKILL.md 的 frontmatter 只包含 `name`（最多 64 字符）和 `description`（最多 1024 字符）字段。完整的结构细节请参阅[技能概述](/en/docs/agents-and-tools/agent-skills/overview#skill-structure)。

### Token 预算

保持 SKILL.md 正文在 500 行以内以获得最佳性能。如果内容超过此限制，使用前面描述的渐进式披露模式将其拆分到独立文件。架构细节请参阅[技能概述](/en/docs/agents-and-tools/agent-skills/overview#how-skills-work)。

## 有效技能清单

分享技能前，验证：

### 核心质量

* [ ] 描述具体且包含关键术语
* [ ] 描述同时包含技能做什么和何时使用
* [ ] SKILL.md 正文在 500 行以内
* [ ] 额外细节在独立文件中（如果需要）
* [ ] 无时间敏感信息（或在"旧模式"章节中）
* [ ] 全文术语一致
* [ ] 示例具体，非抽象
* [ ] 文件引用一层深度
* [ ] 适当使用渐进式披露
* [ ] 工作流有清晰的步骤

### 代码和脚本

* [ ] 脚本解决问题而非甩给 Claude
* [ ] 错误处理明确且有帮助
* [ ] 无"巫术常量"（所有值有理由）
* [ ] 所需包在指令中列出且已验证可用
* [ ] 脚本有清晰的文档
* [ ] 无 Windows 风格路径（全部使用正斜杠）
* [ ] 关键操作有验证/确认步骤
* [ ] 质量关键任务包含反馈循环

### 测试

* [ ] 至少创建三个评估
* [ ] 用 Haiku、Sonnet 和 Opus 测试过
* [ ] 用真实使用场景测试过
* [ ] 整合了团队反馈（如适用）

## 后续步骤

<CardGroup cols={2}>
  <Card title="开始使用 Agent Skills" icon="rocket" href="/en/docs/agents-and-tools/agent-skills/quickstart">
    创建你的第一个技能
  </Card>

  <Card title="在 Claude Code 中使用技能" icon="terminal" href="/en/docs/claude-code/skills">
    在 Claude Code 中创建和管理技能
  </Card>

  <Card title="通过 API 使用技能" icon="code" href="/en/api/skills-guide">
    以编程方式上传和使用技能
  </Card>
</CardGroup>
