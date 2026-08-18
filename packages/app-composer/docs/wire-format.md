# Composer 富文本 wire 格式 Spec

- 日期:2026-08-14
- 状态:草案(待审阅)
- 实现:`packages/app-composer/src/composerTextDoc.ts`
- 测试:`packages/app-composer/test/`(序列化语料 + 穷尽矩阵,§4/§5 的判据)

## 1. 定位

composer 的富文本(ProseMirror document)是**投影**,纯文本才是 **anchor**:daemon transcript、草稿、队列、TUI、发送给模型的 payload,一律使用本文定义的纯文本格式。客户端在"读入"时把文本解析成 doc(revive),在"写出"时把 doc 序列化成文本。

设计约束:

- **模型可读**:文本直接进 prompt,mention 的路径必须原样可见。
- **客户端无关**:TUI 没有 ProseMirror,手敲的 mention 链接形态必须在 app 里同样生效。
- **逐字节保真**:除 mention 链接外,用户输入的任何字符(包括其他 Markdown 语法)都是字面文本,解析和序列化都不得改写它。

## 2. 文档模型

doc 是**平坦的段落列表**,段落内只有两类 inline 内容:

```
doc      := paragraph ( "\n" paragraph )*
paragraph := ( text | mention )*
mention  := 一个 atom 节点 { kind, name, path }   // file | folder | skill
```

没有其他 block 类型,没有 mark(粗体/斜体/行内码等都不存在)。两个段落之间的 `\n` 在偏移计算中计 1 个字符(见 §6)。

## 3. Mention 的文本形态

mention 序列化为一个 Markdown 内联链接,三种 kind:

| kind | 形态 | 例 |
|---|---|---|
| file | `[name](path)` | `[README.md](docs/README.md)` |
| folder | `[name](path/)` — 以尾部 `/` 标识 | `[apps](apps/)` |
| skill | `[name](kimi-code://skill/<name>)` — 伪 scheme,服务端从不解析,是写给模型的自描述标记 | `[deploy](kimi-code://skill/deploy)` |

`name` 的语义:file/folder 是 basename,skill 是技能名。

## 4. 序列化规则(doc → 文本)

逐段落用 `\n` 连接;文本节点原样输出;mention 节点按 §3 输出,转义如下(MUST):

### 4.1 label(`[...]` 部分)

label 的编码是**两组规则按序叠加**(MUST,顺序不可换——`%` 必须最先,否则后面的编码层会被误解码):

1. 先做私有 percent 层:`%` → `%25`(必须最先——否则后续层产生的 `%XX` 会和字面 `%` 构成的合法三元组混叠)、`&` → `%26`(真渲染器会把字符引用解码,`a&amp;b.md` 这类字面文本会被打开成 `a&b.md`)、`<` → `%3C`、`>` → `%3E`(inline-HTML 元字符)。
2. 再做 CommonMark 结构层:`\` `[` `]` 各加一个反斜杠前缀。
3. CR/LF → `%0A` / `%0D`(POSIX 允许 basename 含换行,字面换行会把 wire 文本拆成段落,label 也不例外)。

解码(MUST,与编码严格逆序):反斜杠转义(`\\` `\[` `\]` 还原)、`%0A`/`%0D` 还原换行、`%26`→`&`、`%3C`→`<`、`%3E`→`>`,最后 `%25`→`%`(编码形式如 `%2526`/`%250A` 不会与内层混叠)。**注意**:这条完整逆序只用于 composer revive 路径(从原文切取的 label);真 Markdown 渲染器已经消费了结构层,渲染面只能还原私有 percent 层(见 §7 不变式 3 的 `unescapeRenderedLinkText`)。

### 4.2 dest(`(...)` 部分)

**一条规则**:按 `/` 切段,每段做 canonical 编码——**ASCII 范围内**不属于 RFC 3986 unreserved 字符集(`A-Za-z0-9-._~`)的字符一律 percent 编码为 `%XX`;**非 ASCII 字符保持字面**(`docs/稿件.md` 不变成百分号串:CommonMark 的 bare destination 允许非 ASCII,§5.3 的守卫全是 ASCII 模式,真渲染器会把它们 percent-encode 而消息侧单层解码正好还原,即 §7 不变式 3 的机制)。唯一的例外:dest 以 `//` 开头(POSIX `//mount/x` 或正斜杠 UNC)→ 第二个 `/` 编码为 `%2F`(否则 §5.3 会判成 protocol-relative URL)——这是分隔符自身制造的唯一位置情形。

这一规则替代旧的 7 条位置阶梯(angle 形式、scheme/盘符守卫、选择性字符编码),推论如下:

- **对 CommonMark 惰性**:无 ASCII 空白、无括号、无 `<`/`>`、无反斜杠——bare destination 恒可 tokenize,不需要 angle 形式,不需要反斜杠转义。
- **对 §5.3 分类惰性**:没有开头的 `#`/`?`(锚点/query)、没有 scheme 形态(首个 `:` 也被编码)、没有 `//`——任何文件名在任何位置都构造性地通过全部守卫。
- **对渲染器无歧义**:编码过的 ASCII 已是合法三元组(渲染器原样保留),非 ASCII 由渲染器编码、消息侧单层解码还原——两条路都精确还原路径,`%5C` 这类渲染器差异无从产生。
- **解码**:任何消费面都是单层 `decodeURIComponent` 一次到位(try/catch 回退原文,malformed 手敲形态保持字面)。
- 孤立代理项(POSIX 文件名里的非法 UTF-8 字节)无法编码,原样保留:不含 `%` 的文本在解码侧是恒等的,round-trip 仍然成立。

历史 wire 形态(angle、反斜杠转义、选择性编码)继续按 §5 可读(§9 不改写存量文本);新产生的序列化一律为本节的 canonical 形态。

### 4.3 按 kind 的补充

- folder:序列化前保证 path 以 `/` 结尾(没有则补上)。
- skill:dest 为 `kimi-code://skill/` + 按 §4.2 规则编码为**单段**的 name(括号亦被编码——CommonMark bare destination 不允许不平衡括号,而 canonical 字符集根本不含括号);label 仍是技能名本身(经 §4.1 转义)。解析侧经 `decodeURIComponent` 还原,两种历史形态均可读。

## 5. 解析(revive)规则(文本 → doc)

解析器不是手写扫描器:候选链接由 **micromark 事件流**识别(construct 级 `disable` 配置,只让 link 相关的 construct 参与解析),再经下列 reject 管道过滤;**任何一步不满足,该候选整体按字面文本处理**。

解析以**行**为单位:输入先按 `\n` 切行、逐行识别候选、offset 再映射回原文。这是 wire 格式的结构属性——一行 = 一个段落(§2),mention atom 不跨段落,因此 mention 链接绝不跨行。micromark 本来接受跨单个换行的 label,但 textToDoc 先拆段落、不 revive 任何跨行链接,消息表面(气泡 pillify)必须与之一致,否则会显示出从未作为 mention 提交过的 pill。

### 5.1 候选识别(micromark,disable 配置)

micromark 以 CommonMark 规则 tokenize 全文,但按 construct 名单关闭与 link 无关的语法:`attention`、`autolink`、`blockQuote`、`characterReference`、`codeFenced`、`codeIndented`、`codeText`、`definition`、`hardBreakEscape`、`headingAtx`、`htmlFlow`、`htmlText`、`list`、`setextUnderline`、`thematicBreak`——这些语法的字符在 wire 格式里都是字面文本,不允许被 Markdown 语义消耗。刻意保留:

- `labelStartLink` / `labelEnd`(及 resource 机制):inline link 本身。
- `labelStartImage`:`![alt](src)` 因此整体成为 image token,被整体 reject;若关掉,`[alt](src)` 部分会被误认为 link(图片语法 revive 是旧扫描器的 bug)。
- `characterEscape`:wire 格式自身的反斜杠语义(`\[` 不开 label、`\(` 不闭合 dest)。
- `lineEnding` / `content`:tokenizer 运行的结构必需。

code 三个 construct(`codeText` / `codeFenced` / `codeIndented`)在关闭名单里:反引号 / 围栏 / 缩进对 wire 格式都是字面文本,且编辑器可以在 code 定界符内插入**真实的** mention atom——那是合法文档产物,其链接形态在草稿恢复 / 历史召回 / 气泡 pillify 时必须 revive(round-trip 不变式),所以 wire parser 在任何上下文都识别 mention 链接,code 不再屏蔽。注意这只影响 composer wire 解析与气泡 pillify;assistant 消息走真 Markdown 渲染器,code 语义不受此影响。

token 的 offset 是原字符串的 UTF-16 下标(含 emoji/CJK/CRLF 已验证),label / dest 直接按 offset 从**原文**切取,再走 §4 的逆规则解码(dest:反斜杠转义(历史形态)+ 单层 `decodeURIComponent`(canonical 与手敲 percent 形态同一层覆盖)——micromark 自身的解码被刻意绕过:`characterReference` 已关闭(`a&amp;b.md` 是合法文件名,必须保持字面),percent 序列 micromark 本就不动。

### 5.2 reject 管道

对 micromark 给出的每个 label+resource 候选:

1. image token 内的 label 整体排除(图片不是 mention)。
2. reference 形态(`[a][b]` / `[a][]` / `[a]`):`definition` 已关闭,永远无法 resolve,天然保持字面。
3. autolink(`<https://x.com>`):`autolink` 已关闭,天然字面。
4. 带 title 的(`[a](b "t")`,resource 内含 resourceTitle)→ reject。
5. 空 label / 空 dest(`[](x)`、`[a]()`)→ reject。
6. dest 经解码后按 §5.3 分类,判为"非 mention"→ reject。

label / dest 的合法性判定遵循 CommonMark(由 micromark 负责):label 可含平衡括号(跨行 label 因 §5 的逐行解析天然不出现);bare dest 括号须平衡(或转义)且不含空白,angle dest 不含换行与未转义 `<`。旧手写扫描器在畸形手写输入上的判定与此不同(如 `[a](b(c)d)`、`[a](b "t")`)——只影响畸形手写文本,合法序列化产物(§4)的判定两版一致。

### 5.3 分类(classify)

对**未解码的 raw dest** 按序判定(分类必须在解码前:`%23notes.md` 在 raw 形态不以 `#` 开头,判为 file,解码后还原成 `#notes.md`;若先解码,锚点守卫会误拒自家 wire 形态):

1. 以 `kimi-code://skill/` 开头**且尾部非空**(必须带技能名;空尾部的 `[x](kimi-code://skill/)` 会解码出空名,是死 pill 且无法 round-trip)→ **skill**。
2. 以 `#` 开头(页内锚点)或以 `?` 开头(query-only 导航,如 `[下一页](?page=2)`)→ 非 mention。自家 wire 的 `#`/`?` 开头文件名已按 §4.2 编码为 `%23`/`%3F`,raw 形态不会命中这两条。
3. 以 `//` 开头(protocol-relative URL,`//host/path` 是网络目标)→ 非 mention。自家 wire 的 `//` 开头路径已按 §4.2 把第二个 `/` 编码为 `%2F`。
4. 匹配 URI scheme(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)且**不是**单字母 Windows 盘符 → 非 mention。盘符形态:`C:\…` / `C:/…`,以及渲染器 URI 规范化后的 `C:%5C…`(真 Markdown 渲染器会把反斜杠 dest 编成 `%5C`,消息侧 href 以此形态到达,仍须判为 file)。
5. 否则:dest 以路径分隔符结尾(`/`、`\`、或渲染器编码后的 `%5C` 尾——Windows 目录的三种形态)→ **folder**,否则 → **file**。

判为"非 mention"的候选同样按字面文本处理。

### 5.4 attrs 生成

- file/folder:`name` = unescape 后的 label,`path` = unescape 后的 dest。
- skill:`name` = dest 尾部的 `decodeURIComponent`(malformed `%` 序列回退为原始尾部);**label 被丢弃**——技能身份以链接目标为准,revive 会把 pill 规范化为真实技能名。

## 6. 偏移映射(char offset ↔ PM position)

editor 的 @token 替换、caret 放置等需要在"序列化文本偏移"和"PM position"之间换算:

- 段落间的 `\n` 计 1 个字符;
- mention 节点计**其序列化链接形式的完整长度**;
- 其余文本节点计自身长度。

即:偏移语义 === 对序列化文本做字符串下标。

## 7. 不变式

1. **round-trip**:对合法 attrs,`parse(serialize(x)) ≡ x`。唯一例外是 skill:`name` 被规范化为 dest 尾部的解码值(label 不一致时以 dest 为准,这是刻意行为)。
2. **字面保真**:不能解析为 mention 链接的文本(未闭合括号、其他 Markdown 语法、伪 scheme 链接等)在 parse→serialize 后逐字节不变。
3. **双 parser 存活**:同一文本既被 §5 的 mention 解析器解析,也要在真 Markdown 渲染器(markdown-it/markstream)里渲染成同义链接——§4.2 的 canonical 编码就是为渲染器侧准备的:产物是纯 ASCII 加合法三元组,渲染器的 URI 规范化对它是恒等变换,href 逐字节到达。assistant 消息不做子集解析,而是在渲染产物的 anchor href 上按 §5.3 分类、对 file/folder href 做单层 `decodeURIComponent` 还原路径。渲染产物的 **label** 只还原私有 percent 层(`unescapeRenderedLinkText`):渲染器在生成文本时已消费 CommonMark 反斜杠层,文件名自带的字面反斜杠(`a\[b.md`)必须原样保留,不能再走 `unescapeLinkText` 的完整两层。
4. **性能**:parse 总耗时 O(n)。候选识别由 micromark 的线性 tokenizer 完成(construct disable 只裁剪语法、不改变复杂度),reject 管道对每个候选做 O(1) 判定;逐行切分只做一次线性扫描,行数不改变总量级。
5. **行边界**:mention 链接不跨 `\n`。wire 一行 = 一个段落,mention atom 不跨段落;解析逐行进行(§5),与 textToDoc 的段落边界严格一致——跨行 label 在编辑器与消息表面都不 revive。

## 8. 消费矩阵

| 入口 | 方向 | 说明 |
|---|---|---|
| 发送消息 | doc → text | 整 doc 序列化,进 daemon transcript 与模型 prompt |
| 草稿恢复 / 历史召回 / 队列重载 / 编辑重发 | text → doc | revive,文本全部来自 daemon 的纯文本存储 |
| 粘贴 / 拖入文本 | text → slice | 同一解析器;复制的 pill 以链接形式粘回成 pill |
| 用户/队列气泡渲染 | text → DOM(pillify) | 气泡是纯文本,原地 revive 出 pill,不走 Markdown |
| assistant 消息渲染 | Markdown 渲染 + href 分类 | 真渲染器产出 anchor,再按 §5.3 装饰成 pill |
| TUI / 手敲 | 直接写文本 | 同一语法,app 端读取即生效 |

## 9. 演进规则

新增内容类型(后续 PR)时:

- **优先占用新的 dest 形态**:新的伪 scheme(`kimi-code://<type>/…`)或新的可判定路径约定,并在 §5.3 的分类链里加一条,位置要在"scheme 排除"之前。
- **未知形态必须降级为字面文本**:旧客户端读到新形态时,按 §5 的自然拒绝路径保留原文,不得报错或吞字符。
- **不改写存量文本**:新版本的序列化输出变更只允许影响新产生的内容;历史 transcript 里的旧形态必须继续可解析。

## 10. 对照示例

| 文本(wire) | doc 内容 | 说明 |
|---|---|---|
| `看 [README.md](docs/README.md) 这个` | text + file pill(path=`docs/README.md`) + text | 基本形态 |
| `[a b.ts](src/a%20b.ts)` | file pill(path=`src/a b.ts`) | 空白 → `%20`(canonical,§4.2) |
| `[a b.ts](<src/a b.ts>)` | file pill(path=`src/a b.ts`) | 历史 angle 形态,仍可读(§9) |
| `[a%2Fb.md](a%252Fb.md)` | file pill(path=`a%2Fb.md`) | 字面 `%` → `%25`,解码还原,不会变成路径分隔符 |
| `[apps](apps/)` | folder pill(path=`apps/`) | 尾 `/` 标识 folder |
| `[发布](kimi-code://skill/deploy)` | skill pill(name=`deploy`) | label 被规范化掉,身份取 dest |
| `![img](a.png)` | 纯文本 | 图片语法不 revive |
| `\[a](b)` | 纯文本 | 转义的 `[` 不是起点 |
| `prefix [unfinished [README](README.md)` | text `prefix [unfinished ` + file pill | 链接不能嵌套,内层链接优先(CommonMark) |
| `[server](ftp://host/path)` | 纯文本 | 未知 scheme 不是 workspace 文件 |
| `[a.ts](C%3A%5Cdocs%5Fa.ts)` | file pill(path=`C:\docs\a.ts`) | Windows 盘符的 canonical 形态(§4.2) |
| `[稿件.md](docs/稿件.md)` | file pill(path=`docs/稿件.md`) | 非 ASCII 保持字面(§4.2),不变成百分号串 |
| `[a](C:\x\y.ts)` | file pill | 手敲盘符形态:豁免 scheme 排除(§5.3) |
| `` `[a](b)` `` | text `` ` `` + file pill(path=`b`) + text `` ` `` | 反引号是字面文本,code 定界符内的链接照样 revive(round-trip 不变式,§5.1) |
| `[a](b "title")` | 纯文本 | 带 title 的链接不是 mention(§5.2) |
| `[x(1)](kimi-code://skill/x%281%29)` | skill pill(name=`x(1)`) | 技能名括号经百分号编码(§4.3),bare dest 保持平衡 |
