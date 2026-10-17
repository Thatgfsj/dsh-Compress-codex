# 真实运行时验证记录（M4-12 / #12）

> **结论先行**：装配层（行替换是否生效 + 真实启动里是否真的挂上）**已验证**；
> 会话层（真实会话触发一次压缩并观察 `compaction/start → compaction/summary →
> user/message → compaction/end`）**未验证**，它要等 M2（#4/#5/#6）落地 + 一个可用的
> 模型凭据。本文件逐条区分二者，不做任何"应该没问题"的推断。
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

## 3. 已验证（本轮实测输出）

`scripts/smoke-runtime.mjs` 实跑结果（2026-10-17，dsh 0.2.1-rc.2）：

```
SMOKE     : dsh = 0.2.1-rc.2
SMOKE OK  : A1 dsh plugin add accepted this package
SMOKE OK  : A2 compaction-basic disabled by this bundle
SMOKE OK  : A3 compaction-codex mounted from this package
SMOKE OK  : A4 no unresolved patch target ("patch: entry ... not found")
SMOKE OK  : A5 negative control: compaction-basic stays live without this bundle
SMOKE OK  : A6 real boot: real base resolved, CodexCompactionEngine mounted, no load failure
SMOKE SKIP: A7 session-level compaction needs the M2 policy (#4/#5/#6)...
SMOKE SUMMARY: 6 ok, 0 failed, 1 skipped
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

## 4. 未验证（待 M2 完成，脚本已预留）

`A7` 是会话级断言，判据为：会话持久化文件里出现**有序子序列**
`compaction/start → compaction/summary → user/message → compaction/end`。

当前状态：**SKIPPED**，原因有两层，缺一不可：

1. **M2 未落地**：`lib/engine.js` 仍是 #2 的骨架（决策钩子全部"delegate"，
   `REFUSE` 拒绝手动范围选择与自定义摘要），`#4/#5/#6` 合并前不会走 Codex 策略；
2. **无模型凭据**：本机 `dsh --profile hl "..."` 以
   `dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"`
   立即失败。

M2 合并 + 拿到凭据后，用一条命令回填：

```sh
SMOKE_SESSION=1 DEEPSEEK_API_KEY=... node scripts/smoke-runtime.mjs
```

脚本会自动：跑一次真实 headless 会话 → 在 `$DSH_HOME/sessions/**` 找最新的
`session.v4.jsonl.zstd` → 用 `node:zlib.zstdDecompressSync` 解压 → 校验事件顺序。
**未跑通前，任何"压缩端到端可用"的结论都不成立。**

> 注意：事件匹配用的是字面子串顺序，属于"最小可回填实现"；M2 落地时应把匹配器
> 收紧到具体事件类型字段，并额外断言 `shadowedRange` 非空。

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
node scripts/smoke-runtime.mjs                 # A1-A6；A7 在 M2 前 SKIP
SMOKE_KEEP=1 node scripts/smoke-runtime.mjs    # 保留临时 DSH_HOME 以便排障
```

环境变量：`DSH_BIN`（默认 `dsh`）、`SMOKE_PROFILE`（默认 `codexrtsmoke`）、
`SMOKE_KEEP=1`、`SMOKE_SESSION=1`。

退出码：任一断言 FAIL → `1`；缺少 `dsh`/`pnpm` → 打印
`SMOKE RESULT: SKIPPED` 并退出 `0`（**skip 不是 pass**，必须按未验证上报）。

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
