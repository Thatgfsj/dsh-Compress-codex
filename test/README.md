# 测试与可追溯矩阵（议题 #11）

本目录是**回归护栏**：任何一条不变量被改坏，CI 必须立刻变红。矩阵把每个议题的验收标准
映射到具体文件与用例名，评审可以直接按行复核。

## 运行

```sh
node --test "test/**/*.test.mjs"        # 门禁跑的就是这一条（linux/windows/macos/node22）
node scripts/assert-isolated-home.mjs   # 隔离守卫：DSH_HOME 必须在临时目录下
```

属性测试用固定种子，失败信息带种子，可直接复现：

```sh
DSH_INVARIANTS_SEED=0x11c0ffee node --test test/invariants.test.mjs   # 默认种子
DSH_INVARIANTS_SEED=12345 DSH_INVARIANTS_CASES=2000 node --test test/invariants.test.mjs
```

## 一、不变量 → 断言位置 → 反向用例

| 不变量 | 正向断言（现行） | 反向用例（故意破坏时必须红） |
|---|---|---|
| **C1** 切点两端 tool pairing 平衡 | `select.test.mjs`「property: every returned span is C1-balanced…」；`invariants.test.mjs`「C1+C2 (property)…」；`transaction-sequence.test.mjs`「the success path…」 | `invariants.test.mjs`「reverse: the C1 checker rejects a span that really splits a tool pair」（切在 `tool-call` 与 `tool/result` 之间）；`select.test.mjs`「reverse: a naive token-boundary cut splits a tool pair…」 |
| **C2** surface 节点 0 永不遮蔽 | `select.test.mjs`「surface node 0 stays verbatim, system head or not (C2)」；`invariants.test.mjs` C1+C2 属性 | `invariants.test.mjs`「reverse: a node-0 span passes balance but must still be rejected by C2」（该切点在 C1 上合法，只有 C2 能拦）；`select.test.mjs`「reverse: shadowing node 0 or an orphaned result…」 |
| **零写入**（无安全范围/跳过时） | `select.test.mjs`「retaining every unit means null, and the selector only reads surface/eventAt」（Proxy session）；`invariants.test.mjs`「zero-write (property): a refusal appends nothing」；`engine.test.mjs`「skip…zero-write decision」「a null range…zero-write decision」 | `invariants.test.mjs`「zero-write: an unreadable or empty surface refuses without touching the session」；`transaction-sequence.test.mjs`「reverse: …validates after the marker leaks the lock」 |
| **软上限** `retainTokens` 不切半对 | `select.test.mjs`「retainTokens is a soft bound: the newest unit is kept whole」「retainTokens narrows the retained tail…」；`core-decisions.test.mjs`「the retain budget is documented as a soft ceiling, not a hard cap」 | 上限越界仍整单元保留 → 上表首条用例的 `retainedTokens > retainTokens` 断言即判别 |
| **D1 三段式** 阈值/缓冲/轮末 | `trigger.test.mjs`（32 个用例，含 buffer 只加 limit 侧、prefix trap、比例整数运算） | `trigger.test.mjs`「a missing window delegates instead of reading as zero」；`invariants.test.mjs`「D1: an unknown window delegates instead of skipping」 |
| **D1 单调性** 用量上升不得 compact→skip | `invariants.test.mjs`「D1 monotonicity (property): growing usage never turns compact back into skip」 | `invariants.test.mjs`「reverse: a band-based decider violates the monotonicity checker」（带内触发/带外跳过的坏实现） |
| **D1 溢出旁路** 自愈不失效 | `trigger.test.mjs`「context-overflow bypasses every threshold and never measures」；`engine.test.mjs`「LOCK: a null range on the overflow path falls back to the base」 | 同上 LOCK 用例：把 overflow 的 null 当成「无事可做」就会红 |
| **DS 决策/选择一致** skip/delegate 不查选择器；compact 只提交选择器的 span | `invariants.test.mjs`「consistency: skip and delegate never call the selector」「consistency (property): the engine commits exactly the selector span, or nothing」 | 后者对每个提交的 span 都跑 C1/C2 检查；朴素实现（切在 call 上）会被 `assertTransactionSafe` 拦下 |
| **C3 事务序列** start → summary → 紧随替换 user/message → end | `transaction-sequence.test.mjs`「the success path is start -> summary -> replacement user/message -> end, in that order」（含 compactionId 关联、surfaceOp 边界、sourceEventSeqs 邻接） | 该文件「the transaction model rejects exactly the spans the selector refuses to emit」+ 上表 C1 反向用例 |
| **失败分级与降级**（#33 语义） | `errors.test.mjs`（14 条：分类表、retry/degrade/propagate、取消优先、身份保留）；`transaction-sequence.test.mjs`「a summary failure retries once then degrades…」「propagate-class failures keep the error identity…」「cancellation outranks a summary-shaped failure…」 | summary 失败必须恰好一次 retry 后 degrade（返回 null、一条 error 级诊断）；busy/changed/commit/persistence 必须原样抛出、不重试、不打日志 |
| **锁不泄漏** 每次尝试恰好一次 end（starts === ends） | `transaction-sequence.test.mjs` 的 `assertBalancedMarkers`（每个失败用例都过它）·「a stream of decisions never leaves two markers open」· `errors.test.mjs`「the lock assertion rejects a leaked and an orphaned marker」 | `transaction-sequence.test.mjs`「reverse: a transaction that validates after the marker leaks the lock, and the checker catches it」 |
| **C4/C5 摘要投影** | `prompt.test.mjs`（11 条：快照、脏输出剥离、空字段、版本号、前缀）· `summarize.test.mjs`（14 条：回放/路由/取消/失败分级） | `prompt.test.mjs`「C5: reasoning, tool calls, tool results and images never reach the checkpoint」· `summarize.test.mjs`「a projection that breaks C5 is refused, never persisted」 |
| **分层红线** lib/core 零宿主依赖 | `layering.test.mjs`「the decision layer imports nothing from the host」；`core-decisions.test.mjs` 全部零依赖运行 | 任何 `@deepseek-ai/*` import 进入 `lib/core` 即红 |

## 二、议题 → 验收标准 → 测试矩阵

| 议题 | 验收要点 | 落点（文件:用例） |
|---|---|---|
| #1 仓库骨架 + CI | 三平台门禁、隔离守卫、npm pack、patch 挂载 | `package-manifest.test.mjs`（7 条，含 `@deepseek-ai/*` 绝不进 dependencies、patch 为 insert）· `isolated-home-guard.test.mjs`（5 条）· `plugin-contract.test.mjs`（3 条） |
| #2 引擎骨架 + 行替换 | 决策层零依赖可测、假 base 可实例化、事件动态分派 | `layering.test.mjs`（3 条）· `mount.test.mjs`（5 条）· `engine.test.mjs`（19 条） |
| #3 配置 schema / 加载期校验 | 未知键、越界、互斥键、只给一半路由都要快速失败 | `config.test.mjs`（47 条，含 retainTokens 必须为正整数、retainTokens < triggerLimitTokens）· `core-decisions.test.mjs`「normalizePolicy rejects a config it cannot read, loudly」· `engine.test.mjs`「a row config is validated at mount time, not on the first turn」 |
| #4 D1 触发策略 | 三段式边界、buffer 位置、轮末、溢出旁路、W 不可得 | `trigger.test.mjs`（32 条）· `engine.test.mjs`「the resolved window is injected as capacity, and only for pressure」 |
| #5 D2/D3 切分与保留 | C1 平衡区间、C2 节点 0、零写入、软上限、manual 委托、诊断字段 | `select.test.mjs`（22 条）· `core-decisions.test.mjs`「D2/D3 answers null or a well-formed range…」· `invariants.test.mjs` C1+C2/零写入属性 |
| #6 D4 摘要模板与投影 | 提示词快照、脏输出剥离、空字段不产空壳、模板版本号 | `prompt.test.mjs`（11 条） |
| #7 D4 摘要调用 | 缓存友好回放、路由与上限解析、取消转发、C5 投影接线 | `summarize.test.mjs`（14 条，含摘要失败 waterfall 的 LOCK 用例） |
| #8 D5 注入与续跑提示 | 检查点形态与 `compactCheckpointSource` 契约 | 待实现；事务侧形态由 `transaction-sequence.test.mjs` 的 `source.kind === 'compact-checkpoint'` 断言守住 |
| #9 幂等与防漂移 | 多次压缩叠加、压缩的压缩 | `transaction-sequence.test.mjs`「a stream of decisions never leaves two markers open」（锁层）；语义漂移待 #9 |
| #10 失败与降级 | summary 失败 retry→degrade；busy/changed/commit/persistence/cancelled 原样传播；取消优先；锁不泄漏 | `errors.test.mjs`（14 条）· `transaction-sequence.test.mjs`（10 条，含每类反应的序列后果）· `engine.test.mjs` 手动路径拒绝用例 |
| #11 引擎级测试矩阵（本议题） | 跨模块不变量 + 反向用例 + 事务序列 + 本矩阵 | `invariants.test.mjs`（11 条，250 例属性）· `transaction-sequence.test.mjs`（10 条）· `README.md`（本文件） |
| #12 真实运行时冒烟 | 隔离 profile 内 disable/insert/负控、事件序列 | `scripts/smoke-runtime.mjs` + `.github/workflows/compat.yml` + `docs/runtime-verification.md`（非 `node --test`） |
| #13 可观测性 | 压缩前后 token 账目、诊断日志 | 待实现；数据源已就位：`plan.reason`/`numbers`/`systemBarrierSkippedNodes` |
| #14 文档 | README/架构/差异对照/安装回滚 | `README.md`、`docs/`（非 `node --test`） |
| #15 发布 | release.yml、npm pack 校验 | 待实现；`package-manifest.test.mjs` 先守住包面不变量 |

## 三、本目录的规矩

1. **不得弱化既有断言。** 发现假绿（断言在实现被破坏时仍然通过）→ 报告给 Lead，而不是删掉。
2. **反向用例必须真的非法。** 例如 C1 的反例要切在 `tool-call` 与 `tool/result` 之间；
   形如 `{start:1, end:4}` 这种「合法但不符合我们整单元保留策略」的切点只能用于策略断言，
   **不能**当作 C1 的反例（否则判别力是假的）。
3. **属性测试必须有固定种子**，失败信息里带种子与用例号（`DSH_INVARIANTS_SEED`）。
4. **C1 的判定权在宿主**：测试用 `test/support/host-tool-pairing.mjs`（逐行对照
   `dsh-compaction/lib/types/tool-pairing.js`）作为权威，不用被测实现自证。
5. `lib/core/**` 保持零宿主依赖；事务的真实实现在基类里，本目录用契约模型 + 注入的
   假 base 断言顺序契约，真实运行时证据在 #12。
6. **失败语义以 `lib/core/errors.js` 为准**：summary 失败 retry 一次后 degrade（返回 null、
   `ctx.logger.error` 诊断），busy/changed/commit/persistence/cancelled 一律原样传播。
   无论哪一类，`starts === ends` 必须成立——这是本目录最贵的不变量。
7. **策略口径与 schema 对齐**：`retainTokens` 在 `lib/core/select.js` 里也要求正整数
   （越界 fail closed 返回 null），与 #3 的 schema 同一域，见 `config.test.mjs`。
