---
name: sync-web-dist
description: 把 code-app 的 apps/web 构建产物同步到 kimi-code 仓（apps/kimi-code/dist-web）并提 dist PR 时使用。覆盖构建、同步、提交、PR 全流程，以及 changeset 衔接（哪些该带、哪些不带）的核对方法。
---

# 同步 web dist 到 kimi-code 并提 PR

kimi-code 仓不存放 web 源码，浏览器 Web UI 以预构建产物 `apps/kimi-code/dist-web` 的形式提交在 kimi-code 仓（gitignored，需 force-add）。本 skill 是把 code-app 最新 `apps/web` 发布到 kimi-code 的标准流程。参考实例：kimi-code PR #2697、#2840、#2853。

## 前置条件

- 一个 kimi-code 工作克隆（下称 `$KIMI_CODE_REPO`，如 `~/code/kimi-code-main`），remote 为 `MoonshotAI/kimi-code`，有推送权限，配好 `gh`。
- 本仓依赖已装（`pnpm install`）；若报缺 `@moonshot-ai/agent-core-v2` 等包，先 `pnpm run sync` 初始化 `kimi-code/` submodule。

## 流程

### 1. 钉住 kimi-code 基线

dist 最终提交到哪个 kimi-code 基线，构建就对着哪个基线——**先固定，之后全程不再 pull**：

```bash
cd $KIMI_CODE_REPO
git checkout main && git pull --ff-only origin main
# 本地 main 若含未推送提交，ff-pull 不会回退——钉之前校验没偏离远端，
# 否则会把意外提交带进 dist PR，且 bundle 按一个远端不存在的 CLI 版本构建
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" || { echo "本地 main 超前/偏离 origin/main，先处理"; exit 1; }
KIMI_SHA=$(git rev-parse HEAD)   # 本次构建对着的 CLI 版本与提交基线
```

### 2. 对齐 code-app，构建 web 产物

dist 内容、注入的 CLI 版本、后续 changeset 对账必须锚定**同一个 code-app main 提交**：

```bash
# 在 code-app 仓
git checkout main && git pull --ff-only origin main
# 工作树必须干净：未提交改动（尤其 apps/web / packages/ / kimi-code 指针）会被打进
# dist 却不属于 BUILD_SHA，trailer 与 changeset 对账都盖不住它们
git status --short
BUILD_SHA=$(git rev-parse HEAD)   # 记录下来：第 6 步提交信息和下次同步的水位线都要用

# 先把 submodule 同步到 BUILD_SHA 记录的指针：pull 可能带来新的 gitlink；
# 未初始化 / 空目录时 `git -C kimi-code` 会向上发现到父仓，后面的 ORIG_SUB 会记错
git submodule update --init --recursive kimi-code

# 先装依赖，再切 submodule：workspace 含 kimi-code/packages/*，在临时 SHA 上 install
# 可能按临时指针改写 pnpm-lock.yaml / node_modules（非 CI 不默认 frozen-lockfile），
# 即使之后复原 submodule 也会留下脏 lockfile
pnpm install

# web 构建会把 kimi-code/ submodule 里 apps/kimi-code/package.json 的版本注入产物
#（apps/web/vite.config.ts 的 readCliVersion → __KIMI_CLIENT_VERSION__），不对齐
# 会让同步后的 UI 显示/上报旧 CLI 版本（#2840 踩过）：
ORIG_SUB=$(git -C kimi-code rev-parse HEAD)   # 先记原指针，构建完要复原
git -C kimi-code fetch origin main && git -C kimi-code checkout $KIMI_SHA
# 只动工作树用于构建，不提交 submodule 指针

# 显式清掉会烘进产物的环境变量（Vite 构建期静态替换，残留值会进发布 bundle）：
# - KIMI_WEB_DESKTOP=1 会把浏览器 bundle 编成 desktop 环境（isDesktop 恒真、内部测试标记、desktop 归因）
# - VITE_KIMI_SERVER_HTTP_URL 会让发布的 Web UI 固定请求那台开发服务器（apps/web/src/api/config.ts
#   优先于同源默认值）；apps/web/.env.local 里若定义了它同样会进构建，先确认不存在或已清掉
env -u KIMI_WEB_DESKTOP -u VITE_KIMI_SERVER_HTTP_URL pnpm --filter kimi-code-web run build   # 产物在 apps/web/dist

git -C kimi-code checkout $ORIG_SUB   # 复原 submodule 工作树，避免后续无关提交误带 submodule bump
```

### 3. 从钉住的基线建分支

```bash
cd $KIMI_CODE_REPO
git checkout -b chore/sync-web-dist $KIMI_SHA   # 固定分支名；远端已存在同名分支时先确认旧 PR 已合并，再删旧分支重建
```

若此后 `origin/main` 又前进了，**不要直接 pull 叠加**——dist 是按 `$KIMI_SHA` 的 CLI 版本构建的，基线变了就回第 1 步重新钉基线、重建 dist。

### 4. 同步产物

```bash
# 回本仓根目录
KIMI_CODE_REPO=$KIMI_CODE_REPO pnpm run sync:web
```

脚本会整体替换 `$KIMI_CODE_REPO/apps/kimi-code/dist-web`。

### 5. 补 changesets（衔接规则见下节）

### 6. 提交

```bash
cd $KIMI_CODE_REPO
git add -f apps/kimi-code/dist-web       # dist-web 是 gitignored，必须 -f
git add .changeset/<逐个显式列文件名>      # 不用 git add -A
git commit -m "chore: sync web dist from code-app" -m "code-app: $BUILD_SHA"
```

提交信息必须带 `code-app: <sha>` trailer——这是下次同步的水位线锚点。

### 7. 推送并开 PR

```bash
git push -u origin chore/sync-web-dist
gh pr create --base main --head chore/sync-web-dist \
  --title "chore: sync web dist from code-app" --body "<模板见下>"
```

PR body 固定模板（对照 #2697/#2840）：

```markdown
## Related Issue

No related issue — routine web UI dist sync.

## Problem

The bundled web UI (`apps/kimi-code/dist-web`) needs to be refreshed with the latest `apps/web` build from the code-app repository.

## What changed

- Rebuilt `apps/web` in code-app at `<BUILD_SHA>` and synced the output into `apps/kimi-code/dist-web` via `scripts/sync-web-to-kimi-code.mjs`. No source changes in this repo — dist assets only.
- Added changesets (patch / minor) for each user-facing web UI change included in this sync, translated from the corresponding code-app changesets. Desktop-only changes are excluded.

## Checklist

- [x] I have read the [CONTRIBUTING](https://github.com/MoonshotAI/kimi-code/blob/main/CONTRIBUTING.md) document.
- [x] I have linked a related issue, or explained the problem above.
- [ ] I have added tests that prove my feature works. (N/A — generated dist assets and changesets only)
- [x] Ran `gen-changesets` skill, or this PR needs no changeset.
- [x] Ran `gen-docs` skill, or this PR needs no doc update. (No doc update needed)
```

## Changeset 衔接（核心，最容易错）

目标：本次 dist 里**所有用户可感知的 web 变化**，在 kimi-code 侧**恰好宣布一次**——不漏、不重、不夹带 desktop-only。

### 第 1 步：锚定上次同步点

**已同步水位线 = 上次 sync 提交信息里 `code-app: <sha>` trailer 记录的构建 SHA**。缺口候选：

```bash
# 在 code-app 仓：上次构建点之后、本次构建点之前合入 main 的提交
git log --first-parent --oneline <上次构建SHA>..$BUILD_SHA
```

**上界必须是 `$BUILD_SHA` 而不是浮动的 `main`**：BUILD_SHA 之后合入的 web 变化不在本次 dist 里，按 main 对账会把它们宣布进发布说明（宣布了 bundle 里不存在的东西）。

旧 sync 没记 SHA 时的兜底：**水位线必须不晚于真实构建点**——缺口窗口宁宽勿窄，多圈进来的会经第 2 步"已宣布集合"去重，圈漏的就真漏了。用上次 sync 携带的 changesets 在 code-app main 上的新增位置锚定（这些变化确定已进上次 dist）：

```bash
# 对上次 sync 携带的每个 changeset 文件名，找它在 code-app main 的新增提交；
# 水位线 = 其中最晚的那个提交
git log --first-parent --diff-filter=A --format=%H main -- .changeset/<文件名>
```

若最近一次无 trailer 的 sync 是纯重建、没带任何 changeset（如 #2853），它给不出锚点——**继续向前找最近一次能锚定的 sync**。窗口因此变宽没关系：第 2 步的"已宣布集合"会把重复项去掉。或者从上次构建的记录 / 产物里手工确认一个不晚于真实构建点的 code-app SHA。

PR 的创建时间只作旁证，不能单独当水位线——构建→建 PR 的窗口里可能又合入了 web 变化，createdAt 仍晚于真实构建点。查询时跨仓要指定仓库：

```bash
gh pr view <N> -R MoonshotAI/kimi-code --json createdAt   # 不带 -R 会按当前目录解析到错误的仓
```

两个禁区：

- **不要用 kimi-code 侧 sync 提交的合入时间**：dist PR 从推送到合入可能隔很久，这段窗口里合入 code-app 的 web 变化不在上次 dist 里，按合入时间会被误判为"已同步"而漏掉。
- **不要用 PR 号大小**：PR 号是创建顺序，合并顺序可以相反（本仓就有 #166 晚于 #191 合入的实例）——按编号会漏掉"低编号、晚合并"的 PR。合并顺序只认 main 的 first-parent 历史。

### 第 2 步：双轨对账确定缺口集合

**不要把 code-app 当前待发的 `.changeset/*.md` 直接当成缺口**——发版会消费（删除）changesets，被删条目可能从未同步过；漏写 changeset 的 web PR 更不会出现在任何 changeset 集合里。所以按两条轨道对账：

**PR 轨（抓漏写 changeset 的）**：对第 1 步缺口候选里的每个 first-parent 提交，`git show <commit> --stat` 看是否触碰 `apps/web` 或共享包路径；凡用户可见的 web 变化都应有对应 changeset——没有的按第 3 步规则补写一条。

**changeset 轨（抓已消费未同步的）**，按文件名做集合运算：

- **已宣布集合**：历次 sync PR 最终合入的 changesets 并集。`git log --oneline main -- apps/kimi-code/dist-web` 找到 sync 提交，从其主题提取 PR 号（`(#N)`），按 **PR 的最终 diff** 收集新增文件名：

  ```bash
  gh pr diff <N> -R MoonshotAI/kimi-code | grep '^+++ b/\.changeset/' | sed 's|^+++ b/||'
  ```

  必须按整个 PR 收集而不是只对 dist 提交 `git show`：多提交合并时 changeset 提交不碰 dist-web（#2697 在分支上就是 dist 与 changeset 分提交），只对 dist 提交收集会把已宣布条目漏回缺口集合造成重复宣布。按 PR 最终 diff 还有一个好处：PR 内加了又删的条目不会出现在 diff 里，正好排除。
- **曾存在集合**：本次缺口区间 `<上次构建SHA>..$BUILD_SHA` 内 code-app main 新增的 changesets。命令里保留新增每个文件的提交号，便于恢复正文：

  ```bash
  git log --first-parent --diff-filter=A --name-only --format='commit %H' <上次构建SHA>..$BUILD_SHA -- .changeset/
  ```

  区间必须卡下界：不设下界扫全历史，会把上古时期从未同步过的旧条目（早已包含在旧 dist 里）捞进缺口，造成重复宣布。

  已被 code-app 发版消费的条目在工作树里已删除，第 4 步翻译时用 `git show <commit>:<path>` 恢复原始中文正文——不要凭记忆重写。
- **待同步集合 = 曾存在 − 已宣布**。当前待发 `.changeset/` 只是它的日常快照：若 code-app 在上次 web 同步后发过版，待发集合会缺掉"已消费但未同步"的条目——只有对账能把它们抓出来；反过来待发集合里若有已宣布过的条目（理论上不该有，发版会清掉），剔除。

两轨结果合并去重，再经第 3 步筛选。

### 第 3 步：逐条筛选

对缺口集合里的每个 code-app PR / changeset：

- **不带**：纯重构（包迁移等无行为变化）、CI、文档、发版提交——遵循 kimi-code `gen-changesets` skill 的规则 6（用户感知不到的不写）。
- **不带**：desktop-only 变化（主进程、托盘、原生能力、`window.kimiDesktop` 桥接）。**改动路径只是初筛证据，不是充分条件**——desktop 原生功能 PR 也可能顺带同步 web 侧的通用 composable / 设计文档副本（见根 AGENTS.md 的分叉规则）。最终判据是**该用户可见行为在 web 运行时是否存在**：对照分叉清单 `apps/desktop/docs/native-todos.md`，并核对 changeset 描述的行为在 web 上能否触发。
- **带**：其余全部，与 code-app changeset **1:1 对应**；无 changeset 但用户可见的 web 变化（PR 轨抓到的）补写一条。

### 第 4 步：写法

- 在 `$KIMI_CODE_REPO/.changeset/` 新建文件，**文件名沿用 code-app 侧的文件名**（方便对照核对）。
- frontmatter 包名一律 `"@moonshot-ai/kimi-code"`（kimi-code 仓唯一用户可见发布包）。
- 正文：**一句英文，`web: ` 前缀**，把 code-app 的中文描述翻译过来，遵循 kimi-code `gen-changesets` 的措辞规则（简洁、面向用户）。
- 级别：修复 / 小改进 `patch`；实质性新能力（用户此前做不到的事）`minor`。先例：`sidebar-flat-sessions`（侧栏新视图）、`tool-media-lightbox`（全屏预览 + 缩放）为 minor，其余为 patch。拿不准就 patch，不要写 major。
- 写完后与**第 2 步对账出的完整待同步集合**（不是当前待发 `.changeset/`）做并排 diff，同名文件逐条对比，确认 1:1。

## 红旗

- 钉基线 / 记录 SHA 时状态不干净：kimi-code 本地 main 超前 `origin/main`、code-app 工作树有未提交改动（尤其 apps/web / packages/ / kimi-code 指针）——dist、trailer、对账三者立刻脱节。
- 构建前没钉住 kimi-code 基线（`KIMI_SHA`）、没把 code-app 切到最新 main 并记录 `BUILD_SHA`、没把 `kimi-code/` submodule 对齐 `$KIMI_SHA`（dist 与基线 / 对账不同源；`__KIMI_CLIENT_VERSION__` 烘焙过期版本——#2840 踩过，靠 #2853 返工）。
- 构建后没复原 submodule 工作树（后续无关提交容易误带 submodule bump）；`pnpm install` 跑在 submodule 切换之后（锁文件可能被临时 SHA 改写）；构建 shell / `apps/web/.env.local` 里残留会烘进产物的变量：`KIMI_WEB_DESKTOP=1`（编成 desktop 环境）、`VITE_KIMI_SERVER_HTTP_URL`（发布的 UI 固定请求开发服务器）。
- 建分支后又 `git pull` 前移 kimi-code 基线而不重建 dist。
- sync 提交没带 `code-app: <sha>` trailer（下次同步失去水位线锚点）。
- 用 PR 号大小、PR 创建时间或 kimi-code sync 提交的合入时间当水位线；或直接照抄 code-app 待发 `.changeset/` 而不做双轨对账（漏 / 重的根源）。
- "曾存在集合"扫全历史不卡缺口区间，把上古未同步条目捞回来重复宣布。
- 重建"已宣布集合"时只对 dist 提交 `git show`，不按整个 sync PR 的最终 diff 收集。
- 仅凭"碰过 apps/web / 共享包"就判定 web 适用，夹带 desktop-only 的 changeset。
- kimi-code changeset 出现 `kimi-code-app` 或 `@moonshot-ai/app-*` 包名；正文不是英文或缺 `web: ` 前缀。
- 提交 dist-web 时忘了 `git add -f`（gitignored，普通 add 加不进去，会造成"提交了 changesets 但 dist 是旧的"）。
- 用 `git add -A` / `git add .`（kimi-code 仓同样可能有不该提交的文件）。
- 从本仓的 `kimi-code/` submodule 提 PR——必须从独立工作克隆提。
