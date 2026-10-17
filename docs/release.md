# 发布流程与产物校验（M5-15 / #15）

> 目标：让每个版本**可发布、可校验、可回滚**，并且**无法静默丢失展示元数据**。
> 相关：[README](../README.md) · [安装与回滚](../README.md#7-回滚) · [运行时验证](runtime-verification.md)

## 1. 为什么校验必须"有判别力"

dsh 的展示元数据（标题/描述/图标）是**静默失效**的：`exports` 里漏掉
`./package.json` 或 `./locale/*.json`、图标不在包内或超过 256 KiB——**不报错、不打日志**，
表现只是"插件装了没反应"。

所以 `scripts/verify-pack.mjs` 不是打印 OK 的脚本，它检查**真实 `npm pack` 产物**
（不是工作树），并且 `--selftest` 会逐个注入已知故障、断言自己**必须报错**：

```sh
node scripts/verify-pack.mjs            # 校验本仓库
node scripts/verify-pack.mjs --selftest # 再证明这些检查不是摆设
```

### 1.1 它检查什么

| # | 检查 | 抓的是哪类事故 |
|---|---|---|
| 1 | tarball 里每个文件都被 `files[]` 覆盖 | 意外把临时文件/凭证打进包 |
| 2 | `files[]` 声明的每个路径都真的进了包 | 声明了却没打包（如漏了 `assets`）|
| 3 | `exports` 每个子路径都能在包内解析；含 `*` 的 key 至少匹配 1 个文件 | 子路径指向不存在的文件 |
| 4 | 有 `exports` 时必须导出 `./package.json` 与 `./locale/*.json` | **元数据静默丢失** |
| 5 | 图标存在、realpath 后仍在包内、≤256 KiB、SVG/PNG/JPEG/WebP、且真的被打包 | **图标静默丢失** |
| 6 | 每个 `locale/*.json` 的 `meta.title`/`meta.description` 非空 | 界面显示空标题 |
| 7 | `dsh.bundle.patch` 已声明且在包里 | 装上了但不是 profile 层 |

### 1.2 判别力由故障注入证明

`--selftest` 依次注入并在临时副本上重跑校验，要求**每一个都必须被抓住**，否则整体退出非 0：

```
exports: 删掉 ./locale/*.json          exports: 删掉 ./package.json
icon: 删掉 icon 字段                   icon: 指向包外路径
icon: 指向不存在的文件                 files: 去掉 assets/（图标不再入包）
icon: 超过 256 KiB                     locale: meta.description 置空
bundle: 删掉 dsh.bundle.patch           exports: "." 指向不存在的文件
```

## 2. 版本号规则

| 变更 | 版本 | 说明 |
|---|---|---|
| 首次可用发布 | `0.1.0` | 当前 `package.json` 的 `0.0.0` 是占位，发布前必须改 |
| 不兼容的策略/配置变更 | minor（`0.x` 阶段） | 例如移除或改名一个配置键；`normalizePolicy()` 对未知键**快速失败**，因此改名就是破坏性变更 |
| 修 bug / 文档 | patch | —— |
| 预发布 | `0.1.0-rc.1` → `0.1.0-rc.2` → `0.1.0` | 与 dsh 自身的 `rc` 节奏一致 |

**`engines` 的坑（必须记住）**：本包目前只声明 `engines.node`，**没有** `engines.dsh`。
一旦声明了 `engines.dsh`，它**单独**决定兼容性并让 peer 检查失效——写错区间等于把自己锁在
某个 dsh 版本外。要声明就必须覆盖真正支持的所有 dsh 版本（当前验证基线：`0.2.1-rc.2`）。

## 3. 发布步骤

```sh
# 1) 本地先跑一遍完整校验（与 CI 同一条命令）
node scripts/verify-pack.mjs --selftest

# 2) 确认版本号与变更一致
node -e "console.log(require('./package.json').version)"

# 3) 打 tag（只允许标签触发发布）
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

`.github/workflows/release.yml` 在 tag 上依次跑三个作业：

| 作业 | 做什么 |
|---|---|
| `release / verify` | `verify-pack --selftest`；`npm pack`；把 tarball 作为 artifact 上传。**不需要装任何依赖**，registry 挂了也能校验 |
| `release / install-check` | 装 `@deepseek-ai/dsh@next` + pnpm，把**tarball 本身**（不是 checkout）装进临时 profile，断言 `compaction-basic` 被禁用且归因、`compaction-codex` 已挂载 |
| `release / publish` | 仅 tag（或手动勾选 `publish`）时执行；`npm publish <tarball> --provenance`。缺少 `secrets.NPM_TOKEN` 时**拒绝发布**并报错 |

> 手动 `workflow_dispatch` 默认**不发布**，只做校验与产物上传——用来在打 tag 前预演。

## 4. 安装验证（产物层面）

拿到 tarball 后，在**干净**环境验证（不要用已有 profile）：

```sh
export DSH_HOME="${TMPDIR:-/tmp}/dsh-release-check"     # 绝不用真实 ~/.dsh
node scripts/assert-isolated-home.mjs                    # 守卫必须先通过
dsh plugin --profile relcheck add ./dsh-compress-codex-<version>.tgz
dsh --profile relcheck --dump-config | grep -B1 -A3 -E 'id: compaction-(basic|codex)'
```

期望输出与 README §3 相同：`compaction-basic` 为 `disabled: true` 且带
`patched by dsh-compress-codex`，`compaction-codex` 解析到本包。
更强的一层：`node scripts/smoke-runtime.mjs`（A1–A6，见 [运行时验证](runtime-verification.md)）。

**展示元数据**：本仓库用**断言**证明（`verify-pack.mjs` 检查 4/5/6 覆盖 `exports`、
图标、locale 字段），**没有**做 Web UI 截图。因此"界面里真的显示了标题/图标"
属于**未验证**——需要一次真实页面确认。

## 5. 回滚

三层，从最轻到最重：

```sh
# (a) 让坏版本不再被安装（推荐先做这个，立刻生效）
npm deprecate dsh-compress-codex@<bad-version> "broken; use <good-version>"

# (b) 用户侧回退到上一个版本
dsh plugin --profile <p> add dsh-compress-codex@<good-version>
dsh --profile <p> --dump-config | grep -B1 -A3 'id: compaction-basic'

# (c) 彻底移除本 bundle（官方压缩立即恢复）
dsh plugin --profile <p> remove dsh-compress-codex
```

`npm unpublish` 只在发布后 72 小时内、且无下游依赖时可用；**优先用 deprecate**。
回滚后必须复查：`compaction-basic` 恢复**启用**且**不再**带 `patched by dsh-compress-codex`。

## 6. 排障：装上了但"没反应"

| 症状 | 最可能的原因 | 怎么确认 |
|---|---|---|
| 界面里没有标题/图标 | `exports` 漏 `./package.json` 或 `./locale/*.json`；或图标没进包 | `node scripts/verify-pack.mjs`（检查 3/4/5/6）|
| 图标不显示 | 图标在包外（realpath 后逃逸）或 >256 KiB | 同上（检查 5 会给出具体原因）|
| 干涉了压缩策略却没生效 | `compaction-basic` 没被禁用 → 组合期 fatal | `--dump-config` 看该行；见 [运行时验证 §5.2](runtime-verification.md) |
| 覆盖不生效 | `config` 是整体替换；或上游删了该行 | `--dump-config` 里的 `patch: entry "..." not found` |

## 7. 本文件所述的验证状态

- `verify-pack.mjs` 的**判别力**：由 `--selftest` 当场证明（见 §1.2），不是声明。
- **发布流程本机可复现一次**：见 §4 的命令序列。
- **未验证**：Web UI 里的实际展示效果（无截图）；`npm publish` 本身（需要 `NPM_TOKEN`，本仓库尚无该 secret）。
