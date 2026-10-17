# 独立终验复核（task-16）

> **复核人**：selector-dev（本议题为独立验证角色）。
> **基线**：`origin/main = a6ca05b`（含 #38；复核期间 main 从 f11ac6c 前进到 a6ca05b，本文件所有结论均在新基线上重跑过）。
> **方法**：干净 worktree + 临时 `DSH_HOME` 独立复跑；26 处变异测试（故意破坏 → 看测试是否红）；文档证据抽查；GitHub issue 状态与验收原文逐条核对。
> **纪律**：发现的问题**不随手修**，全部列在 §3 交 Lead 派单；每条结论都给出可复核命令或 `文件:行`。
> **自证声明**：本人是 #5（D2/D3）与 #11（测试矩阵）的实现者。对这两项的复核属于"自审"，因此对它们下了最重的证伪手（§4 的 3 条存活变异中有 2 条正好落在 #5/#11 的代码与测试上）。其余 13 个议题由他人实现，本人独立复核。

---

## 0. 结论摘要

| 状态 | 议题 | 数量 |
|---|---|---|
| **满足** | #1 #3 #4 #5 #6 #7 #9 #10 #15 | 9 |
| **部分满足** | #2 #11 #12 #14 | 4 |
| **未达成** | #8（D5 注入形态，issue OPEN） · #13（可观测性用户可见层，issue OPEN） | 2 |
| 附带缺陷 | #22（隔离守卫 macOS realpath） | 满足 |

- **整体判断：项目主体完成度高，纪律性强**（文档普遍如实标注"已验证/未验证"，甚至主动标注自己的未验证面）。**但有 7 处假绿/缺口**（§3），其中 2 处（F1 屏障常数、F6 文档状态表反向失真）建议优先处理。
- **最值钱的两个证伪结论**：
  - **F1**：`SYSTEM_BARRIER_MIN_SHADOW_RATIO = 0.5` 及其判据**不被任何测试约束**——把 `releasesEnough` 改成恒 `true`，248 个测试全绿，而实际释放量从 5 个单元掉到 1 个单元。
  - **F3**：插件导出面 `get Config()`（`--dump-config-schema` 唯一的入口）**无门禁断言**——把它改名后 248 个测试全绿，而运行时 schema 会静默消失。

---

## 1. 独立复跑（原始输出，未引用他人结论）

环境：`git worktree add /tmp/dsh-wt-finalver -b docs/final-verification origin/main`，`DSH_HOME=$(mktemp -d)`。

```console
$ node --test "test/**/*.test.mjs"
ℹ tests 248
ℹ pass 248
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0

$ node scripts/assert-isolated-home.mjs
guard      : DSH_HOME=/tmp/tmp.HIvIRbYtvO
guard      : temp root=/tmp
guard      : ok

$ npm pack --dry-run
npm notice name: dsh-compress-codex
npm notice version: 0.1.0
npm notice package size: 52.1 kB
npm notice total files: 20

$ node scripts/smoke-runtime.mjs          # 真实运行时（本机 dsh 0.2.1-rc.2 / pnpm 已装）
SMOKE OK  : A1 dsh plugin add accepted this package
SMOKE OK  : A2 compaction-basic disabled by this bundle
SMOKE OK  : A3 compaction-codex mounted from this package
SMOKE OK  : A4 no unresolved patch target ("patch: entry ... not found")
SMOKE OK  : A5 negative control: compaction-basic stays live without this bundle
SMOKE OK  : A6 real boot: real base resolved, CodexCompactionEngine mounted, no load failure
SMOKE SKIP: A7 session-level compaction ... (见 F4)
SMOKE SUMMARY: 6 ok, 0 failed, 1 skipped
SMOKE RESULT: PASS
```

- **#22 的 TMPDIR 假红**：本次在 `/tmp/dsh-wt-finalver`（仓库自身位于 tmp 根下）**未复现假红**；`test/isolated-home-guard.test.mjs` 第 5 个用例（对称 realpath）在 Linux 实测通过。
- **分支保护**（`gh api repos/Thatgfsj/dsh-Compress-codex/branches/main/protection`）：
  `"strict":true`，`contexts:["ci / linux","ci / windows","ci / macos"]`，`enforce_admins.enabled:true` → #1 的第 4 条验收**满足**（但 `ci / node22` 不在 required 列表里，见 §3 F5 备注）。
- **CI 记录**：`gh run list` 显示 main 上最近 3 次 `ci` 与 `compat` 均 `success`。

---

## 2. 逐议题验收表（对照 issue 原文）

| 议题 | 验收条款（摘要） | 状态 | 证据（文件:行 / 命令） |
|---|---|---|---|
| **#1** 骨架 + CI | 三平台 `node --test` 绿；守卫在非临时 DSH_HOME **必须失败**；`npm pack --dry-run` 通过；分支保护 required checks | **满足** | §1 原始输出；`test/isolated-home-guard.test.mjs:21,27,33,41`（4 态 + 对称用例）；保护 JSON 见 §1 |
| **#2** 引擎骨架 + 行替换 | `--dump-config` 中 compaction 行唯一且为本插件；`--help` 冒烟不抛错；`/compact` 仍在 | **部分** | A2/A3/A6 实测（§1）**通过**，但唯一自动化载体是**非门禁** compat job；`scripts/smoke-dumpconfig.sh` 无任何 workflow 接线（F5）。`--help` 冒烟已废弃改写为离线启动（`runtime-verification.md` §5.3） |
| **#3** 配置 schema | 每个非法配置有唯一可读报错 + 断言；合法配置最小/最大形态有测试 | **满足** | `test/config.test.mjs`（47 条，含"每个键都有描述符、无孤儿描述符"）；`test/engine.test.mjs` 挂载期校验 |
| **#4** D1 三段式 | 边界（=阈值/±1）；溢出在阈值下仍触发；**明确记录** listener 是否随 disabled 丢失 | **满足** | `test/trigger.test.mjs`（32 条）；`docs/PLAN.md:116-117` 给出 listener 动态分派证据；#33 后 `test/errors.test.mjs` 补上溢出回退 LOCK |
| **#5** D2/D3 | 属性测试：任意会话下两侧配对平衡；整段不可分 → null 且零写；节点 0（含历史 system）不遮蔽 | **满足（有假绿，见 F1/F2）** | `test/select.test.mjs`（22 条）+ `test/invariants.test.mjs`（11 条）；变异测试：C2、起点吸附、软上限、注入校验、manual 全部被抓 |
| **#6** D4 模板/投影 | 固定输入快照；脏输出剥离；字段缺失不产空壳 | **满足** | `test/prompt.test.mjs`（11 条）；变异"投影保留非文本块"被 `C5` 用例抓住 |
| **#7** D4 调用 | 回放首项是 system 且含被遮蔽区间；取消保留原因；无路由给可操作错误 | **满足** | `test/summarize.test.mjs`（14 条） |
| **#8** D5 注入形态 | `isCompactCheckpointSource` 可识别；无持久身份泄漏；与 summary 事件邻接有断言 | **未达成** | issue **OPEN**。部分语义已落地并被他处断言：`test/transaction-sequence.test.mjs`（相邻性、`source.kind === 'compact-checkpoint'`）；"不给模型漏内部 id"**无任何断言** |
| **#9** 幂等与防漂移 | 连续 3 次压缩关键字段仍在；重复同范围不产生重复事件/摘要 | **满足** | `test/idempotence.test.mjs`（22 条）+ `lib/engine.js:249,383,495`（ledger/admit/antiDrift 已接入）；变异 6 条全部被抓 |
| **#10** 失败分级 | 每类失败码有测试；失败后锁释放；失败在日志可见 | **满足** | `test/errors.test.mjs`（14 条）+ `test/transaction-sequence.test.mjs`（10 条，含 diag payload 断言） |
| **#11** 测试矩阵 | 三平台 CI 绿；关键不变量有反向测试 | **部分** | 矩阵与反向用例齐备（`test/README.md`），但**两条变异存活**（F1/F2）证明"单元结构/屏障判据"这两类断言判别力不足 |
| **#12** 运行时冒烟 | 真实会话压缩后可继续 + 检查点可识别；本地与 CI 同一脚本；记录版本区间 | **部分** | 装配层 A1–A6 本人独立复现通过（§1）；**A7 会话级明确未验证**（`runtime-verification.md:74-98`），而 issue 已 CLOSED → 关闭理由建议复核 |
| **#13** 可观测性 | 未触发有可读原因；`/compact` busy/完成两态一致的用户可见结果 | **未达成** | issue **OPEN**；`lib/core/telemetry.js`（13 条测试）为**模块层**，`grep` 显示 `lib/` 中除自身无调用方（#37 PR 标题亦自述"模块层，Refs #13"） |
| **#14** 文档 | 每条 dsh 行为断言有文件+函数级证据；安装步骤干净环境可复现 | **部分** | 证据链总体可核（`architecture.md`/`runtime-verification.md` 均带文件行号）；**但状态表反向失真**（F6）；安装步骤由 `smoke-runtime.mjs` 覆盖 A1（本人复现通过） |
| **#15** 发布 | tarball 可 `dsh plugin add` 并在 dump 中出现；元数据在 Web UI 可见（截图或断言脚本） | **满足** | A1/A3（§1）复现通过；`scripts/verify-pack.mjs`（含 `--selftest` 故障注入）覆盖 exports/图标/locale；Web UI **外观未验证**但文档如实标注（`docs/release.md:96-98,132`） |
| **#22** 守卫 realpath | macOS 已存在临时目录必须通过；四态保持全绿；真实 `~/.dsh` 仍拒 | **满足** | `test/isolated-home-guard.test.mjs:47-76`（对称 realpath 用例，Linux 实测通过；Windows 跳过见 F7） |

---

## 3. 假绿 / 缺口清单（按严重度）

### F1【高·假绿】屏障判据与常数 `0.5` 不被任何测试约束
- **现象**：`lib/core/select.js:355` 的 `releasesEnough` 改成恒 `true` 后，**248 个测试全绿**。
- **影响不是理论上的**。用同一构造会话实测（命令见下），释放量差 5 倍：

  ```
  [原始] barrier=crossed pref=declined units=6 shadowedUnits=5 retainedUnits=1
  [变异] barrier=kept    pref=applied  units=6 shadowedUnits=1 retainedUnits=5
  ```
- **构造**：① `system,user,call1,result,user,system,call1,result` 起头，② 再追加 4 组 `user,call1,result`（共 6 个单元，首个历史内 system 落在单元 2），③ `retainRecentUnits=1`、`trigger='pressure'`、`capacity=null`。
- **根因**：现有两个屏障用例只覆盖 `applied`（`select.test.mjs:17` BARRIER_NEAR）与"被 `barrierCut > startIndex` 守卫否决"（`select.test.mjs:18` BARRIER_EARLY）——**比例判据本身从未决定过一次结果**。
- **建议**：把上面的构造会话加成回归用例，断言 `systemBarrierPreference === 'declined'` 且 `shadowedUnitCount === 5`；再补一条"比例刚好通过"的边界（`barrierShadowed*2 === shadowed`）。

### F2【中·假绿】单元结构断言自证（用被测函数复算）
- **现象**：`lib/core/select.js:146` 删掉 `cutBalanced[index] !== true`（单元可以从不平衡切点开始）后，**248 个测试全绿**。
- **为什么 C1 属性抓不到**：注入/后备的 `edgeChecks.after` 检查会否决该候选并"多保留一个单元"，最终返回的区间仍然平衡（我用 300 例语料核实：**0 条不平衡边**）。所以这不是 C1 漏洞，而是 **D3 保留模型回归**。
- **为什么单元属性也抓不到**：`test/select.test.mjs:322` 用**被测函数** `splitSurfaceUnits` 复算单元，再断言 plan 与复算一致——这是自证，只有函数自相矛盾时才会红。
- **建议**：加独立断言（不调用 `splitSurfaceUnits`）：保留尾巴的第一个节点必须是 `user/message`（或在测试自己的参考实现里是平衡切点）。

### F3【中·假绿】插件导出面 `get Config()` 无门禁断言
- **现象**：把 `lib/index.js:257` 的 `get Config()` 改名为 `get ConfigDisabled()` 后，**248 个测试全绿**。
- **影响**：`--dump-config-schema` 走"同步读模块导出 `Config`"（`docs/runtime-verification.md` §5.4），改名即静默失去 schema 与展示元数据——正是 #2/#3/#15 验收依赖的运行时路径。
- **根因**：`test/config.test.mjs:215-225` 明确容忍 `plugin.Config === undefined`（零安装门禁里宿主缺失时必须降级），于是"导出面存在"这件事无人断言。
- **建议**（门禁内可做）：断言访问器存在——
  `assert.equal(typeof Object.getOwnPropertyDescriptor(plugin, 'Config')?.get, 'function')`；
  另可在 `scripts/smoke-runtime.mjs` 的 A 系列里加一条 dump-schema 断言（非门禁但更真）。

### F4【中·"skip 当 pass"】冒烟脚本在 A7 跳过时仍判 PASS 且 exit 0
- **现象**（本人复现，§1）：`SMOKE SUMMARY: 6 ok, 0 failed, 1 skipped` + `SMOKE RESULT: PASS` + `exit=0`（`scripts/smoke-runtime.mjs:243-246`）。
- **矛盾点**：脚本自己的注释写着 "a skip is NOT a pass"（:29），文档也要求按未验证上报（`runtime-verification.md:196-198`），但判词与退出码都没有区分。
- **附带**：A7 的跳过原因文本**已过期**：`scripts/smoke-runtime.mjs:194` 仍说 "needs the M2 policy (#4/#5/#6) ... once M2 is merged"，而 #4/#5/#6 早已合并；真正缺的只是模型凭据。
- **建议**：有 skip 时输出 `SMOKE RESULT: PARTIAL (1 skipped)` 并让调用方显式选择是否算通过；同时更新过期文案。

### F5【低·覆盖缺口】`smoke-dumpconfig.sh` 无 workflow 接线
- **证据**：`grep -rn "smoke-dumpconfig" .` 只命中自身与 `cordis.patch.yml:20` 注释，无 `.github/workflows/*` 引用。
- **影响**：#2 的 `--dump-config` 验收只在 compat（`continue-on-error: true`、非 required）里间接覆盖；`ci / node22` 也不在 required contexts 里（保护 JSON 只列三个 OS 作业）。
- **建议**：把 dump 冒烟接进 `ci.yml`（或把 `ci / node22` 提为 required）。

### F6【高·文档反向失真】状态表停在 #5/#6/#7 合并之前
- **证据**（当前 main = a6ca05b）：
  - `README.md:176-178`：D2 "**in progress** (#5) — selector still returns `null`"、D3 "in progress (#5)"、D4 "…the cache-reusing call is #7 (not started)"。
  - `README.zh.md:163-165`：同义。
  - `docs/architecture.md:22`（架构图 "select.js(D2/D3,#5 骨架)"）、`:96,:97`（"进行中 #5"）。
  - 事实：`lib/core/select.js` 已是完整结构化选择器（`select.test.mjs` 22 条 + 变异 6/8 被抓）、#6 模板与 #7 调用均已合并（`prompt.test.mjs` 11 条、`summarize.test.mjs` 14 条）。
- **影响**：这是**反向**失真——文档低估实现，读者会据此判断"插件还什么都没做"。比夸大更容易被忽略，但同样违反 #14 的证据纪律。
- **另**：`docs/PLAN.md:204-212` 的风险表仍列"溢出恢复 listener 随 disabled 丢失"为开放风险，而 §2.3（`:116-117`）已给出结论。
- **建议**：更新状态表与架构图；把已完成项标为 implemented，并把 #8/#13 与 A7 的未验证面留在状态表里（那部分现在是准的）。

### F7【低·平台覆盖】守卫对称性用例在 Windows 跳过
- 证据：`test/isolated-home-guard.test.mjs:47-49`：`{ skip: process.platform === 'win32' ? 'symlinks need elevation…' : false }`（理由合理）。
- 影响：Windows 腿不验证该缺陷形态；#22 的 macOS 结论不受影响。
- 建议：无强制动作，建议在 `test/README.md` 的矩阵里显式标注"Windows 跳过"。

---

## 4. 变异测试全表（26 处，24 caught / 3 survived，1 处锚点说明）

方法：在 `/tmp/dsh-wt-mutation`（detached at origin/main）逐条替换源码 → 跑 `node --test "test/**/*.test.mjs"` → 记录 → `git checkout` 还原并校验 sha256 一致（脚本见 `/tmp/mutate*.mjs`，运行后 `git status` 干净）。

| # | 变异 | 判定 | 首个变红用例 |
|---|---|---|---|
| 1 | select: 允许遮蔽节点 0（C2） | caught | C1+C2 | consistency |
| 2 | select: 去掉起点平衡吸附（C1） | caught | the compactable start snaps forward… |
| 3 | select: 忽略 retainTokens 软上限 | caught | retainTokens is a soft bound… |
| 4 | select: 忽略注入的 before 判定 | caught | a disagreeing injection is never silently replaced… |
| 5 | select: 忽略注入的 after 判定 | caught | 同上 |
| 6 | **select: 屏障比例恒通过** | **SURVIVED** | —（F1） |
| 7 | select: manual 返回区间 | caught | manual compaction leaves /compact to the official engine |
| 8 | **select: 单元可从平衡切点外开始** | **SURVIVED** | —（F2） |
| 9 | trigger: limit 用 `>` 而非 `>=` | caught | scope = limit exactly |
| 10 | trigger: 溢出旁路改 skip | caught | context-overflow bypasses every threshold… |
| 11 | errors: summary 失败永远 propagate | caught | a summary failure is retried once, then degrades… |
| 12 | errors: 非 summary 也 degrade | caught | busy, changed, commit and persistence propagate… |
| 13 | engine: skip 委托基类 | caught | skip on the pressure path is a zero-write decision |
| 14 | engine: 溢出 null 区间被吞 | caught | LOCK: a null range on the overflow path… |
| 15 | config: 未知键被接受 | caught | rejects an unknown key |
| 16 | prompt: 投影保留非文本块（C5） | caught | C5: reasoning, tool calls… |
| 17 | keys: POLICY_KEYS 去掉 retainTokens | caught | every policy key has a descriptor… |
| 18 | config: CONFIG_FIELDS 去掉一项 | caught | every policy key has a descriptor… |
| 19 | engine: policy 用 base config 切片 | caught | consistency | the success path… |
| 20 | **index: `get Config()` 改名** | **SURVIVED** | —（F3） |
| 21 | idem: 关闭 R1 no-op 规则 | caught | R1: a region holding only a checkpoint is a no-op… |
| 22 | idem: 关闭 R3 fresh 规则 | caught | compact with a range commits through… |
| 23 | idem: 重复检测恒 false | caught | engine idempotence: the same range… |
| 24 | idem: 关闭防漂移断言 | caught | assertAntiDrift fails loud… |
| 25 | telemetry: 全部 outcome 降为 info | caught | the outcome union, its levels… |
| 26 | telemetry: 未计价测量退化为部分和 | caught | a missing or mismatched measurement reads as unmeasured… |

---

## 5. 尝试证伪但未能证伪的部分（守住了）

以下都是"我按最能造成真实伤害的方式破坏它、它仍然红了"的断言，可以认为有判别力：

1. **C1/C2 与零写入**：#5/#11 的 C1+C2 属性用**宿主语义等价物**（`test/support/host-tool-pairing.mjs`，逐行对照 `tool-pairing.js`）而不是被测实现自证；变异 1/2/4/5/7/8（间接）全部被抓，且我在 300 例语料上独立复算"不平衡边 = 0"。
2. **失败分级**（#10/#33）：retry→degrade 与 propagate 的身份保持、取消优先，两个方向的变异都被抓（11/12），`caught === thrown` 与"零诊断日志"确实有判别力。
3. **幂等与防漂移**（#9）：4 条变异（21-24）全被抓，说明 R1/R3 规则、重复检测与字段继承断言都绑在真实行为上。
4. **可观测性模块**（#13 模块层）：3 条变异（25-26）被抓，"未计价 = null 而不是 0"这类易混断言写得准。
5. **配置面**（#3）：键表/字段表任何一侧漂移都会红（17/18）。
6. **引擎装配与溢出自愈**（#2/#10）：skip 零写入、溢出 null 回退两条 LOCK 都拦得住（13/14）。
7. **真实装配层**（#2/#12）：A1–A6 我在本机独立复现（§1），包括"负控 profile 里 compaction-basic 仍是启用态"这条反空转对照。

---

## 6. 文档"已验证"表述核查

抽查 `README.md` / `README.zh.md` / `docs/architecture.md` / `docs/runtime-verification.md` / `docs/release.md` / `docs/PLAN.md`：

- **总体结论：诚实度高于常见水平。** 三处最容易夸大的地方都主动标注了未验证：会话级 A7（`runtime-verification.md:74-98`）、Web UI 展示（`release.md:96-98,132`）、`npm publish`（`release.md:132`）。A7 的"未跑通前任何端到端结论都不成立"写在文档里，我复核后确认这不是文字游戏而是真的 SKIP。
- **唯一反向失真**：F6 的状态表（低估实现）。
- **一处过期文案**：F4 的 A7 跳过原因仍称 M2 未合并。
- 其余"已验证"均有可复核命令或文件行号，未发现无证据的强断言。

---

## 7. 未达成 / 未验证清单（如实）

| 项 | 状态 | 依据 |
|---|---|---|
| #8 D5 注入形态 | **未达成** | issue OPEN；"注入体不含持久身份泄漏"无断言；外层框架受基类约束（`architecture.md:99`） |
| #13 可观测性（用户可见层） | **未达成** | issue OPEN；telemetry 模块无运行时调用方（`grep` 证据见 §2） |
| 会话级端到端压缩（A7） | **未验证** | `smoke-runtime.mjs` SKIP；缺模型凭据；`errors.js` 头注释亦声明未验证 |
| Web UI 展示外观 | **未验证** | 无截图；仅有 exports/locale 断言（`release.md:96-98`） |
| `npm publish` 本体 | **未验证** | 无 `NPM_TOKEN`（`release.md:132`） |
| dsh 0.2.0-rc.2 兼容 | **未验证** | `runtime-verification.md:205` |
| `ci / compat-next` | **非门禁** | `continue-on-error: true`，红不阻塞 |
| `ci / node22` | **非 required** | 保护 JSON 的 contexts 只有三个 OS 作业 |

---

## 8. 复核局限

1. 本机只有 Linux：Windows/macOS 结论引用 CI 记录（§1），未在本地独立复跑。
2. A7 无法在本机执行：真实凭据位于 `~/.dsh` 凭据库，与"不碰真实 DSH_HOME"红线冲突；本人**没有**为了验证而绕过隔离。
3. 变异测试是**抽样**（26 处，集中在决策层与新增模块），不是全量变异覆盖；`lib/index.js` 的挂载路径只做了 1 处（第 20 条）。
4. §3 的问题均**未修改**：本 PR 只新增 `docs/final-verification.md`。
