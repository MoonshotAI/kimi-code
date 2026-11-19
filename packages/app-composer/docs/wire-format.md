---
日期: 2026-08-14
状态: 草案（待审阅）
实现：`packages/app-composer/src/model/`（纯文本编解码）、`packages/app-composer/src/features/attachment/inventory.ts`（可撤销附件清单）与 `packages/app-client/src/lib/composerAttachmentStore.ts`（会话级附件资源，§6）。
测试: packages/app-composer/test/（序列化语料 + 穷尽矩阵，§4/§5 的判据）
---

# Composer 编辑器文档的纯文本表示 Spec

## 1. 定位

composer 的编辑器文档（ProseMirror document）是**投影**，它的**纯文本表示**才是 anchor：daemon transcript、草稿、队列、TUI、发送给模型的 payload，一律使用本文定义的「编辑器文档的纯文本表示」。客户端在「读入」时把文本解析成 doc，在「写出」时把 doc 序列化成文本。

设计约束：

- **模型可读**：文本直接进 prompt，mention 的路径必须原样可见。
- **客户端无关**：TUI 没有 ProseMirror，手敲的 mention 链接形态必须在 app 里同样生效。
- **逐字节保真**：除 mention 链接外，用户输入的任何字符（包括其他 Markdown 语法）都是字面文本，解析和序列化都不得改写它。

## 2. 文档模型

doc 是**平坦的段落列表**，段落内的 inline 内容只有文本和三类 atom：

```
doc        := paragraph ( "\n" paragraph )*
paragraph  := ( text | mention | attachment | quote )*
mention    := 一个 atom 节点 { kind, name, path }   // file | folder | skill | session
attachment := 一个 atom 节点 { attId, name, kind }  // file | folder | image | video
quote      := 一个 atom 节点 { text }
```

三类 atom 对应三种用户可见的「pill」：

- **mention**：@ 引用——工作区里的文件 / 文件夹、一个技能，或另一个会话（§3）。
- **attachment**：附件引用——正文中对文件 / 文件夹 / 图片 / 视频的 inline 引用。附件是否随请求发送由 inventory 决定，doc 中可以没有引用，也可以多次引用同一 attId；路径、大小与上传状态存放在会话级 AttachmentStore（§6）。
- **quote**：划词引用——在消息记录里选中一段文本后挂到 composer 上的引用，提交时展开为 `> ` 引用块（§6.6）。

没有其他 block 类型，没有 mark（粗体/斜体/行内码等都不存在）。两个段落之间的 `\n` 在偏移计算中计 1 个字符（见 §7）。

## 3. Mention 的文本形态

mention 序列化为一个 Markdown 内联链接，四种 kind：

| kind | 形态 | 例 |
|---|---|---|
| file | `[name](path)` | `[README.md](docs/README.md)` |
| folder | `[name](path/)` — 以尾部 `/` 标识 | `[apps](apps/)` |
| skill | `[name](kimi-code://skill/<name>)` — 伪 scheme，服务端从不解析，是写给模型的自描述标记 | `[deploy](kimi-code://skill/deploy)` |
| session | `[title](kimi-code://session/<workspaceId>/<sessionId>)` — 同为伪 scheme；尾部两段即该会话在 Kimi Code home 下 `sessions/` 目录内的相对位置 | `[修复登录跳转](kimi-code://session/wd_app_0123456789ab/session_1)` |

`name` 的语义：file/folder 是 basename，skill 是技能名，session 是会话标题。

## 4. 序列化规则（doc → 文本）

逐段落用 `\n` 连接；文本节点原样输出；mention 节点按 §3 输出、attachment 节点按 §6.1 输出，转义如下（MUST）：

### 4.1 label（`[...]` 部分）

label 的编码是**两组规则按序叠加**（MUST，顺序不可换——`%` 必须最先，否则后面的编码层会被误解码）：

1. 先做私有 percent 层：`%` → `%25`（必须最先——否则后续层产生的 `%XX` 会和字面 `%` 构成的合法三元组混叠）、`&` → `%26`（真渲染器会把字符引用解码，`a&amp;b.md` 这类字面文本会被打开成 `a&b.md`）、`<` → `%3C`、`>` → `%3E`（inline-HTML 元字符）。
2. 再做 CommonMark 结构层：`\` `[` `]` 各加一个反斜杠前缀。
3. CR/LF → `%0A` / `%0D`（POSIX 允许 basename 含换行，字面换行会把纯文本拆成段落，label 也不例外）。

解码（MUST，与编码严格逆序）：反斜杠转义（`\\` `\[` `\]` 还原）、`%0A`/`%0D` 还原换行、`%26`→`&`、`%3C`→`<`、`%3E`→`>`，最后 `%25`→`%`（编码形式如 `%2526`/`%250A` 不会与内层混叠）。**注意**：这条完整逆序只用于 composer 解析路径（从原文切取的 label）；真 Markdown 渲染器已经消费了结构层，渲染面只能还原私有 percent 层（见 §8 不变式 3 的 `unescapeRenderedLinkText`）。

### 4.2 dest（`(...)` 部分）

**一条规则**：按 `/` 切段，每段做 canonical 编码——**ASCII 范围内**不属于 RFC 3986 unreserved 字符集（`A-Za-z0-9-._~`）的字符一律 percent 编码为 `%XX`；**非 ASCII 字符保持字面**（`docs/稿件.md` 不变成百分号串：CommonMark 的 bare destination 允许非 ASCII，§5.3 的守卫全是 ASCII 模式，真渲染器会把它们 percent-encode 而消息侧单层解码正好还原，即 §8 不变式 3 的机制）。唯一的例外：dest 以 `//` 开头（POSIX `//mount/x` 或正斜杠 UNC）→ 第二个 `/` 编码为 `%2F`（否则 §5.3 会判成 protocol-relative URL）——这是分隔符自身制造的唯一位置情形。

这一规则替代旧的 7 条位置阶梯（angle 形式、scheme/盘符守卫、选择性字符编码），推论如下：

- **对 CommonMark 惰性**：无 ASCII 空白、无括号、无 `<`/`>`、无反斜杠——bare destination 恒可 tokenize，不需要 angle 形式，不需要反斜杠转义。
- **对 §5.3 分类惰性**：没有开头的 `#`/`?`（锚点/query）、没有 scheme 形态（首个 `:` 也被编码）、没有 `//`——任何文件名在任何位置都构造性地通过全部守卫。
- **对渲染器无歧义**：编码过的 ASCII 已是合法三元组（渲染器原样保留），非 ASCII 由渲染器编码、消息侧单层解码还原——两条路都精确还原路径，`%5C` 这类渲染器差异无从产生。
- **解码**：任何消费面都是单层 `decodeURIComponent` 一次到位（try/catch 回退原文，malformed 手敲形态保持字面）。
- 孤立代理项（POSIX 文件名里的非法 UTF-8 字节）无法编码，原样保留：不含 `%` 的文本在解码侧是恒等的，round-trip 仍然成立。

历史文本形态（angle、反斜杠转义、选择性编码）继续按 §5 可读（§10 不改写存量文本）；新产生的序列化一律为本节的 canonical 形态。

### 4.3 按 kind 的补充

- folder：序列化前保证 path 以 `/` 结尾（没有则补上）。
- skill：dest 为 `kimi-code://skill/` + 按 §4.2 规则编码为**单段**的 name（括号亦被编码——CommonMark bare destination 不允许不平衡括号，而 canonical 字符集根本不含括号）；label 仍是技能名本身（经 §4.1 转义）。解析侧经 `decodeURIComponent` 还原，两种历史形态均可读。
- session：attrs 的 path 为 `<workspaceId>/<sessionId>`；dest 为 `kimi-code://session/` + 两段各自按 §4.2 编码后以 `/` 连接；label 是会话标题（经 §4.1 转义）。纯文本只携带会话身份：发送时 app-client 在提交副本末尾追加 `<referenced_sessions>` 块，每个被引用的会话一行，写明会话 id、标题与主 agent 事件日志的绝对路径 `<home_dir>/sessions/<workspaceId>/<sessionId>/agents/main/wire.jsonl`（`home_dir` 取自服务端 `GET /meta`，目录布局见 Kimi Code 文档「数据路径」），由模型自行读取；服务端未返回 `home_dir` 时不追加该块。composer doc、草稿与 transcript 中的用户消息展示不含该块。

## 5. 解析规则（文本 → doc）

解析器不是手写扫描器：候选链接由 **micromark 事件流**识别（construct 级 `disable` 配置，只让 link 相关的 construct 参与解析），再经下列 reject 管道过滤；**任何一步不满足，该候选整体按字面文本处理**。

解析以**行**为单位：输入先按 `\n` 切行、逐行识别候选、offset 再映射回原文。这是纯文本表示的结构属性——一行 = 一个段落（§2），mention atom 不跨段落，因此 mention 链接绝不跨行。micromark 本来接受跨单个换行的 label，但 textToDoc 先拆段落、不解析任何跨行链接，消息表面（气泡 pillify）必须与之一致，否则会显示出从未作为 mention 提交过的 pill。

### 5.1 候选识别（micromark，disable 配置）

micromark 以 CommonMark 规则 tokenize 全文，但按 construct 名单关闭与 link 无关的语法：`attention`、`autolink`、`blockQuote`、`characterReference`、`codeFenced`、`codeIndented`、`codeText`、`definition`、`hardBreakEscape`、`headingAtx`、`htmlFlow`、`htmlText`、`list`、`setextUnderline`、`thematicBreak`——这些语法的字符在纯文本表示里都是字面文本，不允许被 Markdown 语义消耗。刻意保留：

- `labelStartLink` / `labelEnd`（及 resource 机制）：inline link 本身。
- `labelStartImage`：`![alt](src)` 因此整体成为 image token，被整体 reject；若关掉，`[alt](src)` 部分会被误认为 link（图片语法被解析成 mention 是旧扫描器的 bug）。
- `characterEscape`：纯文本表示自身的反斜杠语义（`\[` 不开 label、`\(` 不闭合 dest）。
- `lineEnding` / `content`：tokenizer 运行的结构必需。

code 三个 construct（`codeText` / `codeFenced` / `codeIndented`）在关闭名单里：反引号 / 围栏 / 缩进对纯文本表示都是字面文本，且编辑器可以在 code 定界符内插入**真实的** mention atom——那是合法文档产物，其链接形态在草稿恢复 / 历史召回 / 气泡 pillify 时必须解析回 pill（round-trip 不变式），所以解析器在任何上下文都识别 mention 链接，code 不再屏蔽。注意这只影响 composer 的纯文本解析与气泡 pillify；assistant 消息走真 Markdown 渲染器，code 语义不受此影响。

token 的 offset 是原字符串的 UTF-16 下标（含 emoji/CJK/CRLF 已验证），label / dest 直接按 offset 从**原文**切取，再走 §4 的逆规则解码（dest：反斜杠转义（历史形态）+ 单层 `decodeURIComponent`（canonical 与手敲 percent 形态同一层覆盖）——micromark 自身的解码被刻意绕过：`characterReference` 已关闭（`a&amp;b.md` 是合法文件名，必须保持字面），percent 序列 micromark 本就不动。

### 5.2 reject 管道

对 micromark 给出的每个 label+resource 候选：

1. image token 内的 label 整体排除（图片不是 mention）。
2. reference 形态（`[a][b]` / `[a][]` / `[a]`）：`definition` 已关闭，永远无法 resolve，天然保持字面。
3. autolink（`<https://x.com>`）：`autolink` 已关闭，天然字面。
4. 带 title 的（`[a](b "t")`，resource 内含 resourceTitle）→ reject。
5. 空 label / 空 dest（`[](x)`、`[a]()`）→ reject。
6. dest 经解码后按 §5.3 分类，判为「非 mention」→ reject。（attachment 候选在分类前已按 §6.2 分流，不走本条。）

label / dest 的合法性判定遵循 CommonMark（由 micromark 负责）：label 可含平衡括号（跨行 label 因 §5 的逐行解析天然不出现）；bare dest 括号须平衡（或转义）且不含空白，angle dest 不含换行与未转义 `<`。旧手写扫描器在畸形手写输入上的判定与此不同（如 `[a](b(c)d)`、`[a](b "t")`）——只影响畸形手写文本，合法序列化产物（§4）的判定两版一致。

### 5.3 分类（classify）

对**未解码的 raw dest** 按序判定（分类必须在解码前：`%23notes.md` 在 raw 形态不以 `#` 开头，判为 file，解码后还原成 `#notes.md`；若先解码，锚点守卫会误拒自家文本形态）：

1. 以 `kimi-code://skill/` 开头**且尾部非空**（必须带技能名；空尾部的 `[x](kimi-code://skill/)` 会解码出空名，是死 pill 且无法 round-trip）→ **skill**。
2. 以 `kimi-code://session/` 开头**且尾部恰为两段非空段**（各段解码后不含 `/`）→ **session**。其它尾部（缺段、多段、空段）不判为 session，继续走下面的 scheme 排除，按字面文本处理。
3. 以 `#` 开头（页内锚点）或以 `?` 开头（query-only 导航，如 `[下一页](?page=2)`）→ 非 mention。自家纯文本的 `#`/`?` 开头文件名已按 §4.2 编码为 `%23`/`%3F`，raw 形态不会命中这两条。
4. 以 `//` 开头（protocol-relative URL，`//host/path` 是网络目标）→ 非 mention。自家纯文本的 `//` 开头路径已按 §4.2 把第二个 `/` 编码为 `%2F`。
5. 匹配 URI scheme（`^[a-zA-Z][a-zA-Z0-9+.-]*:`）且**不是**单字母 Windows 盘符 → 非 mention。盘符形态：`C:\…` / `C:/…`，以及渲染器 URI 规范化后的 `C:%5C…`（真 Markdown 渲染器会把反斜杠 dest 编成 `%5C`，消息侧 href 以此形态到达，仍须判为 file）。
6. 否则：dest 以路径分隔符结尾（`/`、`\`、或渲染器编码后的 `%5C` 尾——Windows 目录的三种形态）→ **folder**，否则 → **file**。

判为「非 mention」的候选同样按字面文本处理。

### 5.4 attrs 生成

- file/folder：`name` = unescape 后的 label，`path` = unescape 后的 dest。
- skill：`name` = dest 尾部的 `decodeURIComponent`（malformed `%` 序列回退为原始尾部）；**label 被丢弃**——技能身份以链接目标为准，解析会把 pill 规范化为真实技能名。
- session：`name` = unescape 后的 label（会话标题），`path` = 两段分别 `decodeURIComponent` 后以 `/` 连接的 `<workspaceId>/<sessionId>`。

## 6. Attachment 链接（composer 私有）

attachment（文件/文件夹/图片/视频附件）是第二类 inline atom，attrs `{ attId, name, kind }`（file | folder | image | video）。EditorState 的 `attachmentInventory` 保存 active attId、稳定顺序和由 doc 派生的引用计数；会话级 `AttachmentStore` 保存 fileId、size、mediaType、path、uploading、error、Blob、previewUrl、视频 thumbnailUrl 与媒体的 `mediaOrdinal`。前者由可逆 Step 修改并进入编辑器 Undo/Redo，后者只接受受控异步更新且不进入 History。doc 中的 name/kind 是当前 locale 的显示快照，attId 才是关联资源的身份；媒体显示名由 `kind + mediaOrdinal + locale` 重新求值，不作为资源状态持久化。

### 6.1 文本形态

attachment 序列化为带 **composer 私有 scheme** 的 Markdown 内联链接：

| kind | 形态 | 例 |
|---|---|---|
| file | `[name](kimi-code-composer://attachments/<attId>)` | `[report.pdf](kimi-code-composer://attachments/9f3k2h1x)` |
| folder | `[name/](kimi-code-composer://attachments/<attId>)` — name 带尾 `/` | `[assets/](kimi-code-composer://attachments/ab12cd34)` |
| image | `[name](kimi-code-composer://attachments/<attId>)` — 与 file 同形 | `[shot.png](kimi-code-composer://attachments/zx21cd34)` |
| video | `[name](kimi-code-composer://attachments/<attId>)` — 与 file 同形 | `[demo.mp4](kimi-code-composer://attachments/qw90mn56)` |

- label = name，按 §4.1 转义；folder 的尾 `/` 保留在 name 里，兼任 kind 标记（POSIX 与 Windows 文件名都不含 `/`，解析时以 label 尾 `/` 判定 kind）。**file/image/video 三者同形，文本自身不带 kind 区分**——kind 一律从消费面的元数据恢复（composer 内是 AttachmentStore entry，消息面是 payload 部件，剪贴板是 flavor entries），见 §6.2。**唯一的例外是提交重写出的序号形态**：media 的提交序号带 `m` 前缀（`attachments/m<index>`，见 §6.4），消息面凭此自描述地区分两类序号，旧消息（只有 file 序号）的按位映射永不漂移。
- dest = `kimi-code-composer://attachments/` + **逐字** attId。attId 由 `newAttId()` 生成（8 位 base36），字符集天然 bare-destination-safe，因此**不需要** §4.2 的编码层——与 mention 路径不同，id 不含任何需要转义的字符。

### 6.2 解析与分类

解析复用 §5 的同一 micromark 管线（同一候选扫描、同一逐行边界）：候选先查 `kimi-code-composer://attachments/` 前缀（**尾部非空**——空 attId 的 `[x](kimi-code-composer://attachments/)` 保持字面文本）判为 attachment，否则才走 §5.3 的 mention 分类。attId 逐字取 dest 尾部（序列化器逐字写入，不解码），label 按 §4.1 逆规则解码出 name。kind 的判定分两层：label 尾 `/` → folder；否则**暂记 file 占位**——file/image/video 在文本上同形（§6.1），真正的 kind 由消费面的元数据给出：composer 内由 AttachmentStore 恢复，消息面由 payload 部件决定，剪贴板由 flavor entries 给出。Store 暂不可用时 name/kind 快照保证 pill 可降级显示，但发送门会拒绝 active 且无资源的 attId。

### 6.3 命名空间隔离（设计动机）

两个链接族**构造性不相交**：

- mention 分类器（§5.3）对任何带 scheme 的 dest 一律判「非 mention」（Windows 盘符豁免不影响本 scheme），因此 attachment 链接对每个 mention 消费面（`parseMentionLinks` / `splitMentionSegments` / 消息侧 href 分类）都是字面文本；反向地，attachment 判定只认私有前缀，普通文件/文件夹/skill 链接永远不会被读成 attachment。
- 为什么必须独占 scheme，而不是把 attId 塞进 mention 的路径形态：attachment 的 dest 没有路径可放（路径属于 AttachmentStore）；若编码成路径形态，手敲或模型输出的同名文件链接会被误读为「附件引用」而去关联不存在的上传。私有 scheme 下，伪造的 attachment 链接最多解析出一个**死 pill**——Store 无此 attId，composer 内划线可见，提交时不进 payload（§6.4），不会产生任何虚构的附件关联。
- 纯文本不暴露本地路径：transcript、草稿、模型 prompt 里的 attachment 链接只含 attId 与文件名。

### 6.4 提交时重写（`rewriteAttachmentLinksForSubmit`）

重写只作用于**发送出去的文本副本**；composer 内存中的 doc 与持久化草稿保持 attId 形态。规则：

1. active file attachment：attId 重写为该 attId 在 inventory 的 file 家族稳定顺序中的 **1-based index**，使文本里的 `attachments/1..N` 与同序组装的 file 部件按位对应。没有正文 pill 的 active file 仍进入 payload；folder 不进 payload。
2. active image/video attachment：attId 重写为 **`m` 前缀序号** `attachments/m<index>`——index 是该 attId 在 inventory 的 media 家族稳定顺序中的 1-based 序号。拖入或文件选择产生的媒体可以没有正文 pill，但仍按 inventory 顺序进入 payload；聚焦编辑器粘贴则在同一事务中同时激活 inventory 并插入 pill。`m` 前缀继续保证旧消息的 file 序号按位不漂移。
3. folder attachment：重写为普通 folder **mention** 链接 `[name](path/)`——label 去掉尾 `/`，path 取自 AttachmentStore（`resolveFolder`）；mention 以 dest 尾 `/` 标识 kind（§3）。`resolveFolder` 解析不到路径时退回第 1/4 条规则。根路径（`/`、盘符根 `C:/`）无 basename：label 保留根显示（`/` 或盘符字母），否则空 label 的 `[](…)` 不可解析，会在消息表面退化成 Markdown 字面量；pill 的 name 生成（`planFolderAttachment`）对根路径同样直接取根自身。
4. attId 不在 orderedAttIds 中（死 pill、上传失败/上传中被排除的 pill、历史召回残留的陈旧序号链接）：**降级为裸 name**（folder 的 name 带尾 `/`），链接语法整体去掉——保留原字节会把 composer 私有 scheme 泄露给模型、让陈旧的序号与重写出的序号撞号（模型会把 `attachments/2` 按位关联到它并不指代的 payload 项），并在消息表面解析成不对应任何 payload 的假 pill。payload 不含对应项。
5. mention 链接与一切非 attachment 链接的文本逐字节不动。

steer 合并（app-client `steerPromptNow`，Ctrl+S 把队列文本与当前草稿一并注入运行中的 turn）是序号形态的第二个消费面：每段文本在各自提交时已按本节规则编号，拼接后各段的序号会撞号——合并时按段序累计前序段的 **file 附件数**与 **media 附件数**分别对各段的数值序号与 `m` 序号做 `offsetAttachmentLinkIndices` 重定位；生成式媒体名称末尾与旧 `mN` 一致时同步偏移显示编号，使合并文本与合并 payload 仍按位对应。

### 6.5 剪贴板自定义 flavor

composer 内复制（选区覆盖 attachment pill 时）除 text/plain、text/html 外，额外写自定义 MIME `application/x-kimi-composer`。MIME 上只放进程内 vault 的引用信封 `{"v":2,"ref":"<16 位 base36 nonce>"}`：完整 flavor 含本地路径与 fileId，不能落在 OS 剪贴板上被任意剪贴板管理器读取——复制时 `stashComposerFlavor` 把 flavor 存进模块级 vault（LRU 上限 50）并返回引用信封；粘贴时 `resolveComposerClipboardMime` 把 ref 查回 flavor（**不消费**——系统剪贴板留着 nonce，一次复制可粘任意多次，与旧完整 flavor 语义一致；跨进程/已淘汰/重启后的 ref 查空 → 回退纯文本路径）。非 v2 信封的内容原样放行——v1 完整 flavor 仍可粘贴（入站校验不变，元数据只是不再写出）。vault 里的 flavor JSON 信封（`ComposerClipboardPayload`）：

```json
{
  "v": 1,
  "slice": { "content": [ "…Slice.toJSON() 产物…" ], "openStart": 0, "openEnd": 1 },
  "attachments": [
    {
      "attId": "9f3k2h1x",
      "key": "file:///abs/path/report.pdf",
      "kind": "file",
      "name": "report.pdf",
      "size": 1024,
      "path": "/abs/path/report.pdf",
      "refCount": 0,
      "uploading": false,
      "fileId": "…"
    }
  ]
}
```

- `slice` 是 PM `Slice.toJSON()` 的产物（open sides 包含在内）；`attachments` 是该 slice 的 pill 引用到的 AttachmentStore entries，按 slice 内首现序。从**气泡**复制时没有 Store 可查，entries 以 `blob:<attId>` key 尽力构造，且 attId 一律重新铸造。
- ref 解析出 flavor（或 v1 原样放行）后先校验：flavor JSON 超过 1MB 直接拒绝；信封（`v` 必须为 1）或 slice（必须能按 composer schema 反序列化）不合法 → 整体丢弃本 flavor，回退纯文本路径。entries 逐条校验——身份字段（attId/key/name/kind）必须齐全且 attId 匹配 `^[0-9a-z]{1,64}$`，可选字段按类型收窄，畸形 entry 单独跳过。随后 `mergePastedEntries` 裁决身份并重写 slice 内 attId；新增资源 upsert 到目标会话 AttachmentStore，引用插入与 inventory activate 处于同一个 editor transaction。跨会话的 session-media 不直接复用源 fileId：先取回源 Blob，再在目标会话重新上传；Undo 在下载或上传完成前发生时资源留作 tombstone，Redo 可继续恢复。
- text/plain 刻意降级：pill 只剩裸 name（folder 带尾 `/`）——attId 链接永不以明文离开 app，外部粘贴目标只能看到纯文件名。quote pill 同理降级为纯引用文本（§6.6）。

### 6.6 Quote 链接（划词引用，自包含）

quote（划词动作的引用 excerpt）是第三类 inline atom，attrs `{ text }`（完整引用文本，可跨行）。与 attachment 的根本区别：quote **自包含**——没有上传状态，全部元数据就是引用文本本身，直接编码进 dest，因此不需要 inventory / AttachmentStore / sidecar。

- 文本形态：`[excerpt](kimi-code-composer://quote/<encoded>)`。label 是首行截断的显示摘要（§4.1 转义；解析时不读回，重新序列化按 attrs 重算），dest 是完整引用文本按 §4.2 同一 canonical 字母表编码（`/` 也编为 `%2F`，换行为 `%0A`，非 ASCII 保持字面），一层 `decodeURIComponent` 还原。
- 分类：候选先查 attachments 前缀，再查 quote 前缀（**尾部非空**——空 quote 的 `[x](kimi-code-composer://quote/)` 保持字面文本），最后才走 §5.3 的 mention 分类；三族构造性不相交（§6.3 同理）。
- 提交时重写（app-client `rewriteQuoteLinks`）：只作用于**发送出去的文本副本**——每个 quote 链接重写为其 `> ` blockquote 块（每行加 `> ` 前缀，尾部空行），并吃掉紧随链接的一个空格（插入时的 caret 分隔符）；链接前不是空行 run 时补完整空行分隔（消息侧按空行 run 切块，块必须落在 chunk 首才折叠）；块后的原始文本一律垫到 ≥3 换行的分隔（评论配对边界恰好是一个空行——attr 评论骑在块内，手打/既有后缀文本永不被吸成评论）。输出与文本时代 `> 引用\n\n[评论]` 逐字节一致（app-client 的 quote-selection 测试逐条断言）；composer doc 与持久化草稿保持链接形态，composer 私有 scheme 永不进 transcript / 模型 prompt。
- 插入（`buildQuoteInsertion`）：在 caret 处**内联**落点（mention 同款）——pill + caret 空格替换当前选区，前面紧贴非空白字符时补前导空格；多个标注在同一行累积，不再各占段落；单事务、可撤销，caret 落在插入内容之后。
- 消息表面不消费 quote 链接：漏网的手敲链接在 `ComposerText` 里降级为纯引用文本，不渲染 scheme；text/plain 复制同样降级为纯引用文本（§6.5 末条）。

### 6.6.1 Pasted-text 链接（长文本粘贴，自包含）

粘贴的纯文本超过 `PASTED_TEXT_MIN_CHARS`（2,000 字符）或 `PASTED_TEXT_MIN_LINES`（40 行）时，`handlePaste` 不再展开成段落，而是插入一个 `pasted_text` inline atom，attrs `{ text }`（换行规范化为 `\n` 的完整原文）。与 quote 同为自包含：没有上传、没有 inventory。composer 自有 flavor 的粘贴（§6.5）不走这条路。

- 文本形态：`[excerpt](kimi-code-composer://pasted-text/<encoded>)`。label 是首个非空行截断到 24 个字素的摘要（只扫描该行开头的有限片段，超长首行不会整行切分；解析时不读回）；序列化结果按原文缓存最近 8 条，避免每次 doc 变化都重新编码大段原文，dest 按 §4.2 同一字母表编码完整原文。
- 分类：在 quote 前缀之前判定，尾部非空才成立；与其它族构造性不相交。
- 提交时重写（app-client `rewriteInlineLinksForSubmit` = `rewriteQuoteLinks` 之后再 `expandPastedTextLinks`）：链接原样替换为原文，不加分隔、不吃空格。`editText` / `restoreText` / 历史保留链接形态，召回时还原成 pill。
- 交互：悬停或聚焦显示 tooltip，只含摘要、行数与字符数（按码点计）和操作按钮（不渲染原文，避免超长文本拖垮 tooltip）；点击（transcript 内 Enter / Space 同效）固定 tooltip，直到点击外部、Esc 或失焦。操作：「查看文本」打开对话框展示原文并可复制；消息内只读，composer 内可编辑，内容改动后「关闭」变为「保存」，保存在单个可撤销事务里改写该 pill 的原文（清空则删除 pill），有未保存改动时关闭对话框需确认放弃。
- 消息表面：带 snapshot 的气泡渲染同款 pill（`data-pasted-text` 携带原文）；无 snapshot 时漏网链接降级为原文。text/plain 复制一律输出原文。

### 6.7 image / video inventory 与引用

图片/视频附件同时拥有两个视图：composer 顶部的常驻缩略图表示 active inventory，正文 pill 表示可选引用。两者共享 attId 与 AttachmentStore 资源。

- **预览生命周期**：本地 image/video 立即在 AttachmentStore 保存 Blob 与 object URL，顶部 rail 常驻显示；视频额外生成受大小限制的 JPEG thumbnailUrl，可进入草稿 sidecar 与内部剪贴板，以便恢复时不下载完整视频。pill 继续保持 kind 图标 + name，hover popover 提供更大预览和元数据。previewUrl、Blob 与上传任务不进 EditorState、纯文本、草稿 sidecar 或剪贴板。Undo 删除只使 inventory inactive 并取消上传；可由 fileId 重建的 inactive 资源立即释放本地载荷，不可重建的 inactive source 按数量和总字节预算保留。发送、清空草稿、EditorState cache 淘汰或会话资源释放时最终吊销。
- **上传进度**：`uploadProgress` 由 Store 受控更新；daemon client 的 `uploadFile` 在有 progress 消费方时走可 Abort 的 XHR。进度、成功、失败只通过 `resourceRevision` 刷新视图并显式 `addToHistory: false`，不会产生 Undo 项。
- **输入语义**：粘贴、拖入和文件选择 image/video 只激活 inventory，不主动插 pill；普通 file 仍在光标/投放位置插 attachment pill。删除 pill 只减少引用，删除 Media rail 缩略图在单事务中 deactivate 并删除全部 pill。
- **图片格式**：Composer 规范化 MIME 后只把 PNG、JPEG、GIF、WebP 分类为 image；其他 `image/*` 走普通 file 路径，不进入 Media rail。服务端仍保留格式校验与文件降级，处理其他客户端或既有记录。
- **再次提及**：`@` 菜单把当前 active attachments 作为首个分组；空查询按 inventory 顺序显示，输入后同时匹配动态引用名与原文件名，无匹配时整个分组消失。选择结果用一个事务把完整 `@token` 替换为指向同一 attId 的 pill。桌面缩略图工具条的提及、移除标签统一使用动态引用名「图片/视频 N」，原文件名只用于预览元数据与菜单过滤；`@` 按钮在最近一次 editor selection 处插入同一引用，缩略图主体仍只负责预览。
- **显示命名**：image 与 video 共用 `mediaOrdinal`，active media 始终按 Media rail 顺序连续编号为 1…N；显示时按当前 locale 由 `kind + mediaOrdinal` 生成「图片 N / 视频 N」，语言切换用非历史 transaction 刷新 doc 显示快照。添加、删除与显式重排序都会收敛编号，Undo/Redo 恢复顺序与显示名。原文件名继续存于 entry.name，供上传、预览元数据与 `@` 过滤使用。跨 composer 粘贴按目标 rail 顺序分配新编号。
- **排序与消息展示**：Media rail 的 `orderedIds` 由可逆 reorder Step 修改；Composer 桌面端的 72px 缩略图按下并抬起时预览，指针位移超过 4px 后才进入拖拽。右下圆角编号块宽度随位数增长，并在 hover/focus 时沿右边缘向上展开；收起和展开状态的四个圆角都统一使用同心半径。垃圾桶、`@` 和编号从上到下纵向 `space-between`，工具条不启动排序；聚焦缩略图时支持 `Alt+←/→`。触屏横向滑动滚动 rail，长按缩略图进入排序，并隐藏 `@`、保留 44px 删除热区。sent/queued 消息始终在正文上方显示完整只读 Media rail，即使媒体已在正文 pill 中引用；远端视频进入视口附近后通过 AuthMedia 懒加载首帧，失败时保留静态占位。普通 file 继续按 inline/legacy 规则去重。
- **去重表态**：path-backed 媒体（desktop 拖入的真实文件）与 file 同规则——`file://<规范化路径>` key、同路径去重、size/mtime 版本检查（内容变了重传）；pathless（截图、web 粘贴）走 `blob:<attId>` key 且**不去重**——每次粘贴是独立 entry（与 chip 时代每次粘贴独立 chip 语义一致；字节级 dedup 不在本契约内）。
- **chip-era 降级**：正文无 media 链接的旧消息在编辑重发/队列回灌时，media 直接进入 inventory，file 仍按既有引用规则恢复；原 content-part 顺序成为 inventory 顺序。

序号形态速查（§6.4 详述）：提交重写后，file 链接变 `attachments/1..N`（只数 file，与 chip-era 一致），media 链接变 `attachments/m1..mM`（只数 media，`m` 前缀自描述——旧消息只有数值序号，按位映射永不漂移）。

## 7. 偏移映射（char offset ↔ PM position）

editor 的 @token 替换、caret 放置等需要在「序列化文本偏移」和「PM position」之间换算：

- 段落间的 `\n` 计 1 个字符；
- mention / attachment / quote 节点各计**其序列化链接形式的完整长度**；
- 其余文本节点计自身长度。

即：偏移语义 === 对序列化文本做字符串下标。

## 8. 不变式

1. **round-trip**：对合法 attrs，`parse(serialize(x)) ≡ x`。唯一例外是 skill：`name` 被规范化为 dest 尾部的解码值（label 不一致时以 dest 为准，这是刻意行为）。attachment 同规则成立：attId 逐字往返，kind 经 name 尾 `/` 还原（§6.1/§6.2）；quote 同规则成立：text 经 canonical 解码逐字往返（§6.6，label 只是显示摘要，解析时不读回）。
2. **字面保真**：不能解析为 mention 链接的文本（未闭合括号、其他 Markdown 语法、伪 scheme 链接等）在 parse→serialize 后逐字节不变。
3. **双 parser 存活**：同一文本既被 §5 的 mention 解析器解析，也要在真 Markdown 渲染器（markdown-it/markstream）里渲染成同义链接——§4.2 的 canonical 编码就是为渲染器侧准备的：产物是纯 ASCII 加合法三元组，渲染器的 URI 规范化对它是恒等变换，href 逐字节到达。assistant 消息不做子集解析，而是在渲染产物的 anchor href 上按 §5.3 分类、对 file/folder href 做单层 `decodeURIComponent` 还原路径。渲染产物的 **label** 只还原私有 percent 层（`unescapeRenderedLinkText`）：渲染器在生成文本时已消费 CommonMark 反斜杠层，文件名自带的字面反斜杠（`a\[b.md`）必须原样保留，不能再走 `unescapeLinkText` 的完整两层。
4. **性能**：parse 总耗时 O(n)。候选识别由 micromark 的线性 tokenizer 完成（construct disable 只裁剪语法、不改变复杂度），reject 管道对每个候选做 O(1) 判定；逐行切分只做一次线性扫描，行数不改变总量级。
5. **行边界**：mention / attachment 链接不跨 `\n`。纯文本的一行 = 一个段落，inline atom 不跨段落；解析逐行进行（§5），与 textToDoc 的段落边界严格一致——跨行 label 在编辑器与消息表面都不解析。

## 9. 消费矩阵

| 入口 | 方向 | 说明 |
|---|---|---|
| 发送消息 | doc → text | 整 doc 序列化；提交副本上的 attachment 链接按 §6.4 重写（1..N index / folder mention 化）后，进 daemon transcript 与模型 prompt |
| 草稿恢复 / 历史召回 / 队列重载 / 编辑重发 | text → doc | 解析，文本全部来自 daemon 的纯文本存储 |
| 粘贴 / 拖入文本 | text → slice | 同一解析器；复制的 pill 以链接形式粘回成 pill；composer 内部复制另走自定义 flavor（§6.5） |
| 用户/队列气泡渲染 | text → DOM（pillify） | 气泡是纯文本，原地解析出 pill（mention 与 attachment），不走 Markdown |
| assistant 消息渲染 | Markdown 渲染 + href 分类 | 真渲染器产出 anchor，再按 §5.3 装饰成 pill |
| TUI / 手敲 | 直接写文本 | 同一语法，app 端读取即生效 |

## 10. 演进规则

新增内容类型（后续 PR）时：

- **优先占用新的 dest 形态**：新的伪 scheme（`kimi-code://<type>/…`）或新的可判定路径约定，并在 §5.3 的分类链里加一条，位置要在「scheme 排除」之前。attachment（§6）是本条的首个实例：占用私有 scheme `kimi-code-composer://attachments/`，分类分流位于 mention 判定之前（§6.2）。
- **未知形态必须降级为字面文本**：旧客户端读到新形态时，按 §5 的自然拒绝路径保留原文，不得报错或吞字符。
- **不改写存量文本**：新版本的序列化输出变更只允许影响新产生的内容；历史 transcript 里的旧形态必须继续可解析。

## 11. 对照示例

| 纯文本 | doc 内容 | 说明 |
|---|---|---|
| `看 [README.md](docs/README.md) 这个` | text + file pill（path=`docs/README.md`） + text | 基本形态 |
| `[a b.ts](src/a%20b.ts)` | file pill（path=`src/a b.ts`） | 空白 → `%20`（canonical，§4.2） |
| `[a b.ts](<src/a b.ts>)` | file pill（path=`src/a b.ts`） | 历史 angle 形态，仍可读（§10） |
| `[a%2Fb.md](a%252Fb.md)` | file pill（path=`a%2Fb.md`） | 字面 `%` → `%25`，解码还原，不会变成路径分隔符 |
| `[apps](apps/)` | folder pill（path=`apps/`） | 尾 `/` 标识 folder |
| `[发布](kimi-code://skill/deploy)` | skill pill（name=`deploy`） | label 被规范化掉，身份取 dest |
| `[修复登录](kimi-code://session/wd_app_0123456789ab/session_1)` | session pill（name=`修复登录`，path=`wd_app_0123456789ab/session_1`） | 会话引用（§3），label 即标题 |
| `[x](kimi-code://session/session_1)` | 纯文本 | session 尾部缺少工作区段（§5.3） |
| `[report.pdf](kimi-code-composer://attachments/9f3k2h1x)` | attachment pill（file，attId=`9f3k2h1x`） | attachment 基本形态（§6.1） |
| `[assets/](kimi-code-composer://attachments/ab12cd34)` | attachment pill（folder） | name 尾 `/` 兼任 kind 标记（§6.1） |
| `[a.pdf](kimi-code-composer://attachments/2)` | attachment pill（file，attId=`2`） | §6.4 提交重写后的 index 形态，解析规则相同 |
| `[x](kimi-code-composer://attachments/)` | 纯文本 | 空 attId 不被解析（§6.2） |
| `[CDN 侧分两层](kimi-code-composer://quote/CDN%20侧分两层)` | quote pill（text=`CDN 侧分两层`） | quote 基本形态（§6.6）：dest 即完整引用，空格 → `%20`、非 ASCII 字面 |
| `[x](kimi-code-composer://quote/)` | 纯文本 | 空 quote 不被解析（§6.6） |
| `![img](a.png)` | 纯文本 | 图片语法不被解析 |
| `\[a](b)` | 纯文本 | 转义的 `[` 不是起点 |
| `prefix [unfinished [README](README.md)` | text `prefix [unfinished ` + file pill | 链接不能嵌套，内层链接优先（CommonMark） |
| `[server](ftp://host/path)` | 纯文本 | 未知 scheme 不是 workspace 文件 |
| `[a.ts](C%3A%5Cdocs%5Fa.ts)` | file pill（path=`C:\docs\a.ts`） | Windows 盘符的 canonical 形态（§4.2） |
| `[稿件.md](docs/稿件.md)` | file pill（path=`docs/稿件.md`） | 非 ASCII 保持字面（§4.2），不变成百分号串 |
| `[a](C:\x\y.ts)` | file pill | 手敲盘符形态：豁免 scheme 排除（§5.3） |
| `` `[a](b)` `` | text `` ` `` + file pill（path=`b`） + text `` ` `` | 反引号是字面文本，code 定界符内的链接照样被解析（round-trip 不变式，§5.1） |
| `[a](b "title")` | 纯文本 | 带 title 的链接不是 mention（§5.2） |
| `[x(1)](kimi-code://skill/x%281%29)` | skill pill（name=`x(1)`） | 技能名括号经百分号编码（§4.3），bare dest 保持平衡 |
