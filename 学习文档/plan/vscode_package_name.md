# 改名 apps/vscode 扩展标识符

> **补记（同日稍后）**：管理员注册的深链实为 `vscode://life-restver-rd.restver-code`（此前误记为 `…rd.code`），已二次改名：`name`: code → **restver-code**（publisher 不变），仓库 5 处引用、文档示例与 VSIX 已按新值重打。正文中出现的 `name: "code"` / `--filter restver-code` 等为当时对话实况，终态以文末成果清单为准。


改动内容（8 个文件）：

| 文件 | 改动 |
|---|---|
| `apps/vscode/package.json` | `publisher: "life-restver-rd"` + `name: "restver-code"` → 扩展 ID = `life-restver-rd.restver-code`，与管理员注册的深链 authority **逐字匹配** |
| 根 `package.json` | typecheck 脚本 `--filter restver-code` |
| `flake.nix` | workspaceNames `"restver-code"`（仓库硬规则，`check-nix-workspace.mjs` 验证 ✓：19/19） |
| `.changeset/okta-sso-login.md` | 包名键 `"restver-code": patch` |
| `.github/workflows/vscode-publish.yml` | filter / `vsce show` 扩展 ID / open-vsx 查询三处 |
| `pnpm-lock.yaml` | 重新生成（importer 名） |
| okta 测试 + 两份文档（`structured-okta.md` / `structured-okta-implemented-summary.md`） | 示例深链值统一为 `vscode://life-restver-rd.restver-code`；设计文档新增 **fork 定制点清单**（标识符 5 处同步 + node-sdk `setMemoryConfig`，上游合并时逐处核对） |

**刻意不动的**：VSIX 产物文件名（`kimi-code-<平台>.vsix`，`vsix-targets.mjs` 硬编码，与扩展 ID 解耦）；上游测试文件头注释（避免 17 个文件的注释 churn）；`vsix-verify.mjs` 的 `.kimi-code`（VSIX 禁入路径清单）。

okta.json 由此这样配：

```json
{
  "issuer": "https://你的okta域",
  "clientId": "…",
  "redirectUri": "vscode://life-restver-rd.restver-code"
}
```

（redirect_uri 里不用带路径——路由只看 authority；带了 `/callback` 也行，Okta 注册的是什么就填什么。）

两个部署提醒：
1. **重新打包 VSIX 后，已装旧构建的用户要卸载重装**——扩展 ID 变了，VS Code 视为两个不同扩展（globalStorage 目录也随之换新；内部新部署无历史数据，无碍）
2. 旧构建打开那个深链依然路由不到（它 ID 还是 `moonshot-ai.kimi-code`），确认全员换新包

---

### 改动的 2/3/5/6 点是什么意思

这四点都是**同一次改名的"下游影子"**——源头上 `apps/vscode/package.json` 的 `name` 从 `kimi-code` 改成了 `code`，仓库里有四个地方硬编码引用着旧包名/旧扩展 ID，不同步就会在不同环节报错：

**2. 根 `package.json` 的 typecheck 脚本**

仓库根 `package.json:20` 的 typecheck 脚本是按**包名**逐个调用各包的类型检查：

```text
pnpm --filter @moonshot-ai/kimi-code run typecheck && pnpm --filter kimi-code run typecheck && …
                                                              ↑ 这个 filter 按包名找 apps/vscode
```

包改名后 `--filter kimi-code` 找不到任何包，整个仓库的 typecheck 入口就断了。**影响你**：每次跑根 typecheck / CI 类型检查。

**3. `flake.nix` 的 `workspaceNames`**

这个仓库提供 Nix 打包（`nix build`），而 `flake.nix` 里**手工维护**了一份 workspace 包名清单（110 行附近那个字符串列表）。Nix 构建时按这份清单决定给哪些包拉取 pnpm 依赖（`pnpmConfigHook`）——清单里没有的名字，构建时依赖直接缺失。所以仓库规则（CLAUDE.md）明文要求：包名有任何增删改，必须手动同步这里。已把列表里的 `"kimi-code"` 换成 `"code"`。**影响你**：只有用 Nix 构建时才相关；不用 Nix 可以无视，但留着不同步会让 Nix 构建静默缺依赖。

**5. `.github/workflows/vscode-publish.yml`**

发布工作流里硬编码了三处旧标识，全都指向"不存在的包/扩展"了：

| 位置 | 作用 | 坏法 |
|---|---|---|
| `pnpm --filter kimi-code exec …` | 调用打包命令 | 找不到包，打包步骤失败 |
| `vsce show moonshot-ai.kimi-code` | 查 VS Code 市场是否已发布过此版本（防重复发布） | 查的是官方 ID，永远查不到你们的 |
| `open-vsx.org/api/moonshot-ai/kimi-code/…` | 查 open-vsx 是否已有此版本 | 同上 |

它只在手动触发发布时运行，平时无感——但既然 ID 变了就一起换掉，免得将来真要发布时全线报错。

**6. `pnpm-lock.yaml`**

锁文件里记录着每个 workspace 包（术语叫 importer）的**名字**和依赖解析结果。包改名后锁文件里还挂着旧名，谁下次跑 `pnpm install` 都会产生一笔无谓的 lock diff。所以主动跑了一次 `pnpm install` 把 importer 名刷新成 `code` 落盘——纯粹是"替所有人提前做了一次必然会发生的 lock 更新"，内容上没有任何依赖变化。

一句话总结：**只有第 2 点日常会碰到（typecheck 命令），第 3、5 点分别是 Nix 构建和发布工作流的引用，第 6 点是一次性的锁文件刷新**。VSIX 文件名没动是因为它在 `vsix-targets.mjs` 里硬编码生成、和包名解耦——打包产物还叫 `kimi-code-darwin-arm64.vsix`，装进去的扩展 ID 却是 `life-restver-rd.restver-code`，这两件事互不相干。

---

### 什么是 pnpm --filter？

**先搞懂 `pnpm --filter` 是什么**

这个仓库不是单项目，是一个 **pnpm workspace（多包仓库）**：根 `pnpm-workspace.yaml` 声明了 `packages/*`、`apps/*` 下的每个目录都是一个独立的包，各自有名字（各目录 `package.json` 里的 `name`）和自己的 scripts。

`pnpm --filter <选择器> run <脚本>` 的意思就是：**"不去那个包的目录，直接在仓库根按包名筛选，在选中的包里执行某个脚本"**。选择器可以是：

| 写法 | 匹配什么 | 例子 |
|---|---|---|
| 精确包名 | 一个包 | `pnpm --filter restver-code run typecheck` |
| 带 scope 的包名 | 一个包 | `pnpm --filter @moonshot-ai/kimi-code run typecheck` |
| glob 通配 | 一批包 | `pnpm -r --filter './packages/*' run typecheck` |

`-r`（recursive）= "把所有匹配到的包挨个跑一遍"。单个精确名字本来只匹配一个包，加不加 `-r` 效果一样；`'./packages/*'` 能匹配十几个包，就必须靠它逐个执行。

**整行拆解（5 段，`&&` 串联——前一段失败就停）**

```text
pnpm run build:packages
  && pnpm -r --filter './packages/*' run typecheck
  && pnpm --filter @moonshot-ai/kimi-code run typecheck
  && pnpm --filter restver-code run typecheck
  && pnpm --filter @moonshot-ai/vis-server run typecheck
  && pnpm --filter @moonshot-ai/vis-web run typecheck
```

| 段 | 干什么 |
|---|---|
| ① `run build:packages` | 先把 `packages/*` 全部构建一遍——apps 的类型检查要引用这些包的构建产物/类型 |
| ② `-r --filter './packages/*' run typecheck` | 对 `packages/` 下**所有**包（kosong、oauth、node-sdk、agent-core-v2…）逐个跑各自的 `typecheck`（就是各包里的 `tsc --noEmit`） |
| ③ `--filter @moonshot-ai/kimi-code` | CLI/TUI 应用（`apps/kimi-code`，带 `@moonshot-ai/` scope，是**另一个包**） |
| ④ `--filter restver-code` | **VS Code 插件**（`apps/vscode`）——改名前是 `--filter kimi-code`。包名改了，filter 按名字找包，不跟着改就找不到包、整条命令断在这里 |
| ⑤⑥ `--filter @moonshot-ai/vis-server / vis-web` | 另外两个带 typecheck 的应用 |

③④⑤⑥ 不用 glob 是因为 `apps/*` 里有些包没有 typecheck 脚本或不需在此入口跑，所以逐个点名。

**为什么 ④ 必须随包名改**：`--filter` 认的是 `package.json` 里的 `name` 字符串。改名后仓库里叫 `kimi-code` 的裸名包不存在了（只剩 CLI 的 `@moonshot-ai/kimi-code`），`--filter kimi-code` 会报 "no project matched the filter"，整个仓库 typecheck 就红了。

**日常可直接用的几个**：

```bash
pnpm --filter restver-code run typecheck   # 只查插件的类型
pnpm --filter restver-code test            # 只跑插件测试（371 个那些）
pnpm --filter restver-code run dev         # F5 前的 watch 开发模式
pnpm -r --filter './packages/*' run build   # 重新构建所有底层包
```

不用 `cd apps/vscode` 再敲命令——这就是 `--filter` 存在的意义：**在仓库根按名字指挥任意子包**。

---

### 如何打包？

打包链是现成的（`apps/vscode/scripts/vsix-package.mjs`：自动构建 → 逐平台 `vsce package` → 产物校验 `verifyVsix`）：

**打包步骤**

```bash
# 1. Node 24 环境（本机 nvm）
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"

# 2. 先构建底层包（打包链消费 packages 的 dist，这步不能省）
pnpm run build:packages

# 3. 打 VSIX（在仓库根执行；无参数 = 全部 6 个平台）
pnpm --filter restver-code run package:platform                    # darwin-x64/arm64 + linux-x64/arm64 + win32-x64/arm64
pnpm --filter restver-code run package:platform --target darwin-arm64   # 只打当前这台 Mac 的
```

**产物位置**：`apps/vscode/artifacts/vsix/kimi-code-<平台>.vsix`（文件名是 `vsix-targets.mjs` 硬编码的，仍是 `kimi-code-*`——与扩展 ID 解耦，**装进去的 ID 是 `life-restver-rd.restver-code`**）。每个产物打完会自动过一遍 verifyVsix 内容审计（检查清单、禁入路径）。

**安装**：`code --install-extension kimi-code-darwin-arm64.vsix`，或扩展面板 `…` → Install from VSIX…。装之前先卸载旧构建（ID 不同会并存，旧的那个收不到深链）。

**其他形态**：`--dry-run` 只打印不构建；`package:verify` 只审计已有产物；`publish:vsix` 发布市场用（内部分发用不上）。

两个容易踩的坑：

1. **忘跑 `pnpm run build:packages`** → 扩展 tsdown 打包引用的 `@moonshot-ai/*` workspace 包没有 dist 产物时报模块解析错误（开发态 F5 不需要 dist，打包链需要——两套解析机制）
2. **Node 版本** → 仓库要求 ≥24.15（`.npmrc` engine-strict），系统默认 22 直接被拒

---
