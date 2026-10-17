# 真实运行时验证记录（M4-12 / #12）

> **结论先行**：装配层（行替换是否生效 + 真实启动里是否真的挂上）**已验证**；
> **会话层也已在真实模型上验证**（2026-10-18）：一次真实两轮会话触发了完整事务
> `compaction/start → compaction/summary → user/message → compaction/end`，摘要由
> `deepseek-official/deepseek-flash` 真实产生。**仍未验证**的是展示元数据在 Web UI 里的
> 渲染（只有断言，无截图，见 §9）与 `npm publish` 本身。
> 本文件逐条区分，不做任何"应该没问题"的推断。
>
> 脚本：`scripts/smoke-runtime.mjs`（`node scripts/smoke-runtime.mjs`）
> CI：`.github/workflows/compat.yml` 的 `ci / compat-next`（**非门禁**，`continue-on-error: true`）

## 1. 为什么必须用 `dsh plugin add`，不能用 web 模板

infra 在 #2 已发现：**`web` 模板本身就禁用了 `compaction-basic`**（该行归属
`@deepseek-ai/dsh-web-app`）。用 web 模板做冒烟，`--dump-config` 里
`compaction-basic` 也是 `disabled: true`，于是"本 bundle 生效了"这个断言**恒真**——
典型的假绿。因此本冒烟的两个 profile 都来自：

- 主 profile：`dsh plugin add <repo>`（极小栈：`dsh-base` + 本 bundle）
- 负控 profile：`--from-default-profile headless`（不含本 bundle）

并且断言 `A2` 额外要求 dump 把该行标注为 **`patched by dsh-compress-codex`**，
即"禁用"必须归因到本 bundle，而不是恰好本来就禁用。

## 2. 验证环境

| 项 | 值 |
|---|---|
| dsh | `0.2.1-rc.2`（`dsh --version`） |
| Node | `v24.21.0` |
| OS | linux（脚本用 Node 编写，兼容 win/mac；`dsh`/`pnpm` 走 `shell: true`） |
| pnpm | `12.11.2`（`dsh plugin add` 依赖） |
| DSH_HOME | `os.tmpdir()/dsh-compress-codex-runtime-<pid>`，由 `scripts/assert-isolated-home.mjs` 守卫 |
| 真实模型（仅 A7） | `deepseek-official/deepseek-flash`（一次性凭据豁免，见 §4.2） |

## 3. 已验证（本轮实测输出）

`scripts/smoke-runtime.mjs` 实跑结果（2026-10-18，dsh 0.2.1-rc.2；`SMOKE_SESSION=1` 下 A7 也参与）：

```
SMOKE     : dsh = 0.2.1-rc.2
SMOKE OK  : A1 dsh plugin add accepted this package
SMOKE OK  : A2 compaction-basic disabled by this bundle
SMOKE OK  : A3 compaction-codex mounted from this package
SMOKE OK  : A4 no unresolved patch target ("patch: entry ... not found")
SMOKE OK  : A5 negative control: compaction-basic stays live without this bundle
SMOKE OK  : A6 real boot: real base resolved, CodexCompactionEngine mounted, no load failure
SMOKE OK  : A7 real session emitted compaction/start(21) -> compaction/summary(23) -> user/message(24) -> compaction/end(25)
SMOKE     : A7 provider=deepseek-official model=deepseek-flash summaryChars=1749 shadowedRange={"start":8,"end":8}
SMOKE SUMMARY: 7 ok, 0 failed, 0 skipped
SMOKE RESULT: PASS
```

| 断言 | 它证明了什么 | 它**不**证明什么 |
|---|---|---|
| A1 | 本包能被 `dsh plugin add` 接进一个全新 profile | 插件会正确挂载（见 A6） |
| A2 | `compaction-basic` 的禁用**归因于本 bundle** | 运行时真的只挂了一个实现 |
| A3 | `compaction-codex` 行存在且解析到本包 | `apply()` 真的执行成功 |
| A4 | 没有 `patch: entry ... not found`（陈旧覆盖的第一信号） | —— |
| A5 | 没有本 bundle 时该行仍是启用态 ⇒ A2 非空转 | —— |
| A6 | **在一个真实启动的 dsh 进程内**，本包的 `mountEngine()` 解析出真实的 `@deepseek-ai/dsh-compaction-basic`，并构造出 `CodexCompactionEngine` | 压缩真的被触发（见 §4） |

**断言非空转的对照实验**（把 `cordis.patch.yml` 的 `disabled: true` 改成 `false`
后跑同一脚本）：

```
SMOKE FAIL: A2 compaction-basic is not disabled after our layer:
SMOKE FAIL: A6 the probe ran but the boot did not reach the app stage:
dsh: fatal load failure: Error: service "compaction" has been registered at <BasicCompactionEngine>
    at new CodexCompactionEngine (lib/engine.js:65:10)
SMOKE SUMMARY: 4 ok, 2 failed, 1 skipped
SMOKE RESULT: FAIL
```

即：断言确实会红，且**disable 行是承重的**（见 §5.2）。

## 4. 会话级压缩（A7）：**已在真实模型上验证**

判据：会话持久化日志里出现**同一次压缩事务**的完整序列
`compaction/start → compaction/summary → user/message → compaction/end`，且
`compaction/summary` 的 `provider`/`model` 非空（证明摘要来自真实模型调用，不是空壳）。

实测（2026-10-18，`dsh 0.2.1-rc.2`，真实 provider）：

```
SMOKE OK  : A7 real session emitted compaction/start(21) -> compaction/summary(23) -> user/message(24) -> compaction/end(25)
SMOKE     : A7 provider=deepseek-official model=deepseek-flash summaryChars=1749 shadowedRange={"start":8,"end":8}
SMOKE SUMMARY: 7 ok, 0 failed, 0 skipped
SMOKE RESULT: PASS
```

> `summaryChars` 随模型输出而变（同一脚本复跑会得到不同长度，例如 1749 / 403），
> 但**事件序列与各字段恒同**——断言用的是结构与字段，不是长度或文本内容。

从会话日志解出的原始事件（`seq` 连续、同一 `compactionId`）：

| seq | 事件 | 关键字段 |
|---|---|---|
| 21 | `compaction/start` | `compactionId=6dd547d0-…`、`turn=2` |
| 23 | `compaction/summary` | `summary=[{type:"text",…}]`、`provider="deepseek-official"`、`model="deepseek-flash"`、`maxTokens=65536`、`shadowedRange={start:8,end:8}`、`shadowedTokenCount=3529`、`usage.cacheReadTokens=8064` |
| 24 | `user/message` | `source={kind:"compact-checkpoint",compactionId:…}`，内容含 `<compacted-summary>` |
| 25 | `compaction/end` | 同一 `compactionId` |

这一次运行同时印证了四条契约：C3（事务相邻性：`user/message` 紧邻
`compaction/summary`）、C4（`cacheReadTokens=8064` 说明前缀缓存确实被复用）、
C5（`summary` 是纯文本块）、D4/D5（摘要正文以 Codex 的 SUMMARY_PREFIX 开头，替换消息由
基类框架包裹并携带检查点 source）。

### 4.1 让 A7 "能通过"的两个设计要点（改之前它**永远**不可能通过）

1. **必须强制压低阈值。** 默认触发是 `min(0.9 × W, triggerLimitTokens)`，而本机路由模型的
   `W` 是百万级：一个 `say ok` 会话产生的几千 token 永远越不过阈值，A7 只会得到
   "会话里没有 compression 事件"而 FAIL——**这不是凭据问题，是测试输入不足以触发被测行为**。
   A7 的 overlay 因此设 `triggerLimitTokens: 2000`（绝对上限优先，正整数，满足 #3 的 schema）。
2. **必须跑两轮，且只保留一个近期单元。** D2/D3 的保留单元是"以 `user/message` 起始的
   C1 平衡单元"（`lib/core/select.js`），且**最新单元永远逐字保留**；单轮会话只有 1 个单元，
   选择器会合法地返回 `null`（"nothing to shadow"）。所以 overlay 同时设
   `retainRecentUnits: 1`，并在**同一个 session 上跑第二轮**（`--session-id <id>`）——
   第二轮的前置检查（`agent/pre-step`）才是越过阈值并真正触发压缩的地方。

> 环境事实（踩过的坑）：`headless` 模板**禁用了 `credentials` 行**
> （`# == @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-headless`、`disabled: true`）。
> 只把 `.credentials.yaml` 放进临时 home **不够**——`ctx.get("credentials")` 仍是 `undefined`，
> 适配器于是只回退到进程环境变量并直接 `MISSING_CREDENTIAL`。A7 的 overlay 因此显式加
> `- id: credentials / disabled: false`。

### 4.2 凭据处理与一次性豁免记录（如实记录）

- 用户**一次性授权** A7 使用真实凭据。方案取"**真实凭据 + 临时 DSH_HOME**"而非直接用真实
  home：把 `~/.dsh/.credentials.yaml` **复制**进临时 home（`chmod 600`——该 provider 会拒绝
  权限过宽的文档），对真实 home 全程只读。
- **安全核验（跑完后实测）**：
  - 真实 `~/.dsh/sessions/` 下**没有**任何以测试 cwd 为 slug 的会话目录（`--tmp-dsh-wt-a7--`）
    ⇒ A7 没有把 session 写进真实 home；
  - `~/.dsh/.credentials.yaml` 的 mtime 仍是 `2026-10-16`（未被改写）；
  - 未创建或修改任何真实 profile 的既有内容。
  - **一处如实记录的例外**：调研阶段我跑 `dsh --profile headless --help` 时**忘了设 `DSH_HOME`**，
    加载器因此把真实 `~/.dsh/profiles/headless/cordis.yml` 重写为它标准的空根配置（内容 `[]`，
    该目录 22:57 已存在）。无 session、无凭据、无用户 profile 内容受影响；此后所有命令都在
    临时 `DSH_HOME` 下运行。
- 复现：

```sh
SMOKE_SESSION=1 node scripts/smoke-runtime.mjs
```

  （若 `~/.dsh/.credentials.yaml` 不存在，也可用 `SMOKE_SESSION=1 DEEPSEEK_API_KEY=...`；
  两者都没有时 A7 打印 `SKIPPED` 并说明缺什么，脚本以 **退出码 2（INCOMPLETE）** 结束——
  **skip 不是 pass**，见 §6 的退出码契约。）

### 4.3 A7 **不**证明什么

- **长会话质量**：只观测到一次压缩；多次压缩叠加与摘要漂移仍是 #9 的专项。
- **默认阈值下的行为**：A7 是人为压低阈值强制触发，**默认 `0.9 × W` 下何时触发未被真实长会话验证**。
- **跨工具调用的切割**：本次被遮蔽范围是单个 `user/message`（`shadowedRange={start:8,end:8}`），
  没有覆盖"跨越 tool-call 的切割"；C1 配对的覆盖在 #11 的属性测试里，不在这里。

## 5. 四条实测出来的约束（写测试的人必须知道）

### 5.1 安装域解析只在 dsh 启动内存在——裸 node 解析会**假阴性**

同一个包、同一个目录，两种解析结果：

```sh
# 在 profile 目录里用裸 node 解析 → 失败
cd "$DSH_HOME/profiles/hl" && node --input-type=module -e "await import('@deepseek-ai/dsh-compaction-basic')"
# → ERR_MODULE_NOT_FOUND
```
```
# 在 dsh 启动进程内（探针插件，文件位于 profile 目录）→ 成功
[probe-mount] probe-location base import: OK function
```

原因：profile 的 `node_modules` 里只有 link 进来的本包（`ls profiles/<p>/node_modules` 仅
`dsh-compress-codex`、无 `@deepseek-ai/`），宿主包由 dsh 的启动期运行时解析
（`dsh-app-boot` 的 `createRuntimeResolution` / 安装域链接）提供。

**结论**：不要写"从 profile 目录用 node 解析宿主包"的断言——它会红，但那是测试的
伪影，不是缺陷。正确做法就是 A6：在真实启动里探测。

### 5.2 `disabled: true` 是承重的

若不禁用官方行而直接插入本引擎，两个引擎都会 `provide('compaction')`，cordis 组合期
直接 fatal：

```
Error: service "compaction" has been registered at <BasicCompactionEngine>
  at new CodexCompactionEngine (.../lib/engine.js:65:10)
```

这为 `docs/PLAN.md` §2.1 的"必须 disable 原生行"提供了运行时证据（此前只有配置层证据）。

### 5.3 不要用 `--help` 当冒烟入口

实测 `dsh --profile <plugin-add-profile> --help` **不退出**（两次 60s/120s 超时；只打出
一行 `all_proxy` 警告后挂住）。本脚本改用**无提示词的离线启动**：

```sh
dsh --profile <p> --patch <overlay.yml> </dev/null
```

它 ~2s 退出（`dsh: a task is required, for example: dsh --profile headless "run the tests"`），
组合与 `apply()` 都已执行——既确定性、又不联网、也不需要凭据，适合 CI。

### 5.4 `--dump-config-schema` 同步读 `Config`，且必须是原生 Schemastery schema

本行的 schema 只有同时满足这两个条件才会进入 dump，否则该 entry 状态直接是 `unsupported`：

- **同步**：dump 走 `Reflect.get(plugin, "Config")` 后立刻 `isNativeConfigSchema()` 判定
  （`@deepseek-ai/dsh-app-boot/lib/index.js` L3402），既不 await，也不调用 lazy builder；
- **原生**：需要 `Symbol.for("schemastery") === true` + `type: string` + `meta` 对象。

这对本仓库的**零依赖门禁**是一个真实约束：schema 不能来自
`await import("@deepseek-ai/schemastery")`（同步阶段拿不到值），也不能来自静态 import
（`lib/index.js` 必须能在无 `node_modules` 时被 `node --test` import，否则整个门禁变红）。

解法（#3 / PR #32）：用 `process.getBuiltinModule("node:module")` 取 `createRequire` 做
**守卫式 require**，挂在默认导出的 `get Config()` 上。宿主包不存在时返回 `undefined`（不抛），
真实运行时返回原生 schema。刻意用 `process.getBuiltinModule` 而不是 `import "node:module"`
（后者会多一条静态 import），是为了让 `test/layering.test.mjs` 的"静态 import 全部 first-party"
断言继续成立。

实测（dsh 0.2.1-rc.2）：

```
entry: schema   configRef: #/$defs/config66   complete: true
schema 属性集 12/12 === POLICY_KEYS
```

**结论**：给本插件加配置键时，只要走 `lib/core/config.js` 的 `CONFIG_FIELDS`，schema 会自动
跟上；任何绕过 `CONFIG_FIELDS` 手写 schema 的做法都会让 dump 与实现分叉。

复现：

```sh
export DSH_HOME=$(mktemp -d)
dsh plugin --profile schemacheck add .
dsh --profile schemacheck --dump-config-schema > /tmp/schema.json
node -e 'const s=JSON.parse(require("node:fs").readFileSync("/tmp/schema.json","utf8"));
  console.log(s["x-cordis"].entries.find(e=>e.name==="dsh-compress-codex"))'
```

## 6. 复现命令

```sh
git clone https://github.com/Thatgfsj/dsh-Compress-codex.git
cd dsh-Compress-codex
node scripts/smoke-runtime.mjs                 # A1-A6；A7 未要求 → 退出码 2（INCOMPLETE）
SMOKE_SESSION=1 node scripts/smoke-runtime.mjs # 加上 A7：真实两轮会话 + 真实模型（需凭据）→ 退出码 0
SMOKE_KEEP=1 node scripts/smoke-runtime.mjs    # 保留临时 DSH_HOME 以便排障
```

环境变量：`DSH_BIN`（默认 `dsh`）、`SMOKE_PROFILE`（默认 `codexrtsmoke`）、
`SMOKE_KEEP=1`、`SMOKE_SESSION=1`、`SMOKE_ALLOW_SKIP=1`。

**退出码契约**（"skip 不是 pass"必须对机器也成立，不只是写在注释里）：

| 退出码 | 含义 |
|---|---|
| `0` | 所有断言都跑了且都通过——**完整**运行，才能声称已验证 |
| `1` | 至少一条断言**失败** |
| `2` | 跑过的都通过，但有断言被 SKIP，或前置条件缺失（无 `dsh`/`pnpm`）⇒ **不完整** |

结论行同时用文字说明，**裸 `PASS` 只出现在完整运行里**：

```
SMOKE RESULT: PASS (complete — no failing, no skipped assertions)        # exit 0
SMOKE RESULT: INCOMPLETE — PASS WITH 1 SKIPPED, NOT fully verified (A7)  # exit 2
SMOKE RESULT: FAIL (1 failing assertion(s))                              # exit 1
```

调用方若**有意**不要求某个 opt-in 断言，用 `SMOKE_ALLOW_SKIP=1` 声明该范围：结论行照旧，
退出码映射为 `0`。`ci / compat-next` 没有模型凭据、永远跑不了 A7，因此**必须**带这个变量
（否则该非门禁作业会以 2 结束，这正是新语义在起作用而不是故障）。

## 7. 版本区间与门禁关系

- 本机已验证：`dsh 0.2.1-rc.2` + `node v24.21.0`。
- `package.json` 声明的 `engines.node` = `^22.19.0 || >=24.0.0`；CI 的 `ci / node22`
  覆盖下界。
- `dsh 0.2.0-rc.2`：**未验证**（`engines.dsh` 语义、`dsh plugin --profile` 参数位置、
  子路径展示元数据在 0.2.1 都有破坏性变更；见 `dsh-plugin-construction` 技能）。
- `dsh@next`：由 `ci / compat-next` 每日 + 手工 + 相关路径变更时运行，**非门禁**
  （`continue-on-error: true`），失败不阻塞 main，只作为漂移信号。
- 必需门禁仍是 `ci / linux`、`ci / windows`、`ci / macos`、`ci / node22`。

## 8. 不碰真实环境

脚本在启动 `dsh` 之前先把 `DSH_HOME` 指向 `os.tmpdir()` 下的唯一目录，并运行
`scripts/assert-isolated-home.mjs`；守卫不通过就 `SKIPPED` 退出，绝不落盘到
真实 `~/.dsh`。临时目录在结束时删除（`SMOKE_KEEP=1` 除外）。

A7（仅 `SMOKE_SESSION=1`）会**读取**真实 `~/.dsh/.credentials.yaml` 并复制进临时 home 后
`chmod 600`；对真实 home 全程只读，凭据不会进入进程环境变量（除非你显式用
`DEEPSEEK_API_KEY`）。核验方法与那一次例外见 §4.2。

## 9. 展示元数据：断言已验证，界面未验证

- **已验证（断言层）**：`scripts/verify-pack.mjs` 在**真实 `npm pack` 产物**上检查
  `exports` 必须导出 `./package.json` 与 `./locale/*.json`、图标存在且在包内（realpath 后）
  且 ≤256 KiB、`locale/*.json` 的 `meta.title`/`meta.description` 非空；并用 `--selftest`
  注入 10 类故障证明这些检查**真的会红**（见 [发布文档](release.md) §1）。
- **未验证（界面层）**：**没有**做过 Web UI 页面确认，也没有截图。因此"界面上真的显示了
  标题与图标"仍属**未验证**。口径与 §3 的 `skip 不是 pass` 一致：断言能证明元数据
  **可解析且完整**，不能证明**渲染正确**。
