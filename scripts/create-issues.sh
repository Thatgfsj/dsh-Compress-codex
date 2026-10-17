#!/usr/bin/env bash
set -euo pipefail
cd /home/thatgfsj/AIagent/dsh-Compress-codex
REPO=Thatgfsj/dsh-Compress-codex

for l in m0-infra m1-integration m2-policy m3-stability m4-verification m5-delivery p0-first principles-blocked; do
  gh label create "$l" --repo "$REPO" --color 0e8a16 --description "auto" >/dev/null 2>&1 || true
done

mk() {
  local title="$1"; local labels="$2"; local body="$3"
  local url
  url=$(gh issue create --repo "$REPO" --title "$title" --label "$labels" --body "$body")
  echo "$url"
}

mk "M0-1 仓库骨架与 CI 流水线（优先合并）" "m0-infra,p0-first" "$(cat <<'BODY'
## 目标
建立可运行的仓库骨架与门禁流水线。**本议题必须先于其他一切合并**，因为后续每个 PR 都要在它之上跑绿。

## 交付物
- package.json：`dsh.bundle.patch`、`exports`(含 ./package.json 与 ./locale/*.json)、`engines.node`、peerDependencies 仅放 @deepseek-ai/*、scripts.test
- cordis.patch.yml：bundle 层骨架
- .github/workflows/ci.yml：ubuntu/windows/macos 矩阵 + node22 lts 作业
- test/ 框架 + 隔离守卫脚本（禁止触碰真实 ~/.dsh，一律临时 DSH_HOME）
- LICENSE / .gitignore / .gitattributes / .editorconfig

## 验收标准
- `node --test` 在三个平台绿
- 隔离守卫在 DSH_HOME 未指向临时目录时**必须失败**
- `npm pack --dry-run` 通过
- 分支保护已配置：ci / linux、ci / windows、ci / macos 为 required checks

## 写入范围
package.json, cordis.patch.yml, .github/**, test/**, scripts/**, LICENSE, .gitignore

## 依赖
无（根节点）

## 第一性原则
对应工程约束：门禁不可绕过。CI 先行是"合并前强制测试"这一规约的物理实现，否则规约只是一句话。
BODY
)"

mk "M1-2 引擎骨架与行替换接入" "m1-integration" "$(cat <<'BODY'
## 目标
让本插件真正**侵入**压缩层：禁用官方 `compaction-basic` 行并把 `ctx.compaction` 换成我们的实现（骨架即可，策略在 M2 落）。

## 交付物
- `lib/index.js`：`CodexCompactionEngine` 骨架 + 默认导出（与官方同构：Service 子类、static inject、static Config）
- cordis.patch.yml：`- id: compaction-basic / disabled: true` + `insert: compaction-codex`
- 冒烟脚本：`dsh --profile <tmp> --dump-config` 断言 ①basic 行已禁用 ②本插件行已挂载 ③无 "patch: entry not found"
- 假 session / 假 llm 测试装置（不触网、不触真实会话）

## 验收标准
- `--dump-config` 输出中 compaction 行唯一且为本插件
- `--help` 冒烟不抛错（证明 apply 真执行、effect 正确注册与释放）
- `/compact` 命令行仍在（backend-independent，不得被误删）

## 写入范围
lib/index.js, lib/config.js, cordis.patch.yml, test/**, scripts/smoke-*.sh

## 依赖
#1

## 第一性原则
接入层只做一件事：把服务实现换掉。此处的正确性判据是"可观测地替换成功"，而非"功能已完备"。
BODY
)"

mk "M1-3 类型契约与配置 schema" "m1-integration" "$(cat <<'BODY'
## 目标
把 D1-D5 五维策略的**配置面**固化为可校验契约，非法配置在加载期快速失败。

## 交付物
- `Config`（schemastery）覆盖：触发阈值、保留策略、摘要模板开关、路由覆盖（per provider/model）
- 加载期校验：未知键、非法值、互斥项、保留预算 >= 阈值 → 明确报错
- `lib/types/*.d.ts` 导出全部公开类型
- 表驱动校验测试

## 验收标准
- 每个非法配置有唯一、可读的报错信息，且有测试断言
- 合法配置的最小与最大形态都有测试

## 写入范围
lib/config.js, lib/types/**, test/config.test.mjs

## 依赖
#2

## 第一性原则
配置是策略的**声明式投影**：五维之外的键一律不应存在。拒绝未知键即守卫设计边界的完整性。
BODY
)"

mk "M2-4 D1 触发策略（Codex 风格）" "m2-policy" "$(cat <<'BODY'
## 目标
替换 D1：用 Codex 的触发语义决定何时压缩，并保证上下文溢出后可自愈。

## 交付物
- 触发算式实现（源码依据见 docs/codex-notes.md，不得凭印象）
- 溢出恢复路径：`CONTEXT_WINDOW_EXCEEDED` 时旁路常规阈值强制一次可用缩减
- 覆盖后的 auto listener 注册验证（确认动态分派到子类）

## 验收标准
- 边界用例：恰好在阈值、阈值-1、阈值+1 的触发行为有断言
- 溢出恢复在阈值之下的极长单轮场景仍能触发一次
- **明确记录**：决策 B 下原生溢出 listener 是否随 disabled 丢失；若丢失则本议题必须自建

## 写入范围
lib/core/trigger.js, test/trigger.test.mjs

## 依赖
#3

## 第一性原则
D1 是"信息增益/成本"的定价点：压缩越晚越贵，越早越损。阈值必须是可解释算式，而非魔数。
BODY
)"

mk "M2-5 D2/D3 切分与保留策略" "m2-policy" "$(cat <<'BODY'
## 目标
替换 D2/D3：按**对话结构**（而非纯 token 预算）决定压哪段、留哪段逐字。

## 交付物
- 结构化范围选择器：保留最近 N 个结构单元逐字（任务上下文优先），压缩更早的平衡范围
- 硬不变量：C1 工具配对平衡、C2 不遮蔽 surface 节点 0、无安全范围时**零写入**
- 与官方 `toolPairingBalancedBefore/After` 配套使用

## 验收标准
- 不变量以属性测试覆盖：任意构造的会话下，切分点两侧均配对平衡
- "整个会话就是一个不可分单元"时返回 null 且**不向会话日志写任何事件**
- 节点 0 为 system 时永不被遮蔽（含历史内追加的 system/message 用例）

## 写入范围
lib/core/select.js, test/select.test.mjs

## 依赖
#3

## 第一性原则
D2/D3 是"信息密度排序"问题：保留的是**未来仍需引用的状态**，不是最近出现的内容。C1/C2 是不可协商约束。
BODY
)"

mk "M2-6 D4 摘要模板与输出投影" "m2-policy" "$(cat <<'BODY'
## 目标
替换 D4 的"写法"：把自由文本摘要换成 Codex 风格结构化摘要。

## 交付物
- 摘要提示词构建器：字段为"续跑必需最小集"（进展 / 关键决策与理由 / 待办 / 触碰的文件与状态 / 已知坑）
- 输出投影：仅取返回文本，排除推理与 tool_call；产出稳定 ContentBlock[]
- 模板版本号（便于日后度量漂移）

## 验收标准
- 固定输入 → 固定提示词快照测试（防止无意改动）
- 含推理/工具调用的模型返回被正确剥离
- 字段缺失时不产生空壳字段（避免噪声）

## 写入范围
lib/core/prompt.js, test/prompt.test.mjs

## 依赖
#3

## 第一性原则
D4 是**有损编码的码本设计**：字段即"续跑时模型必须重建的状态变量"，多余字段既是 token 税也是噪声。
BODY
)"

mk "M2-7 D4 摘要调用（缓存友好回放）" "m2-policy" "$(cat <<'BODY'
## 目标
实现摘要的**调用**侧：复用会话前缀命中 provider KV cache，并正确处理路由与取消。

## 交付物
- `ctx.llm.stream()` 单轮调用：回放 system + 有效 tools + 被遮蔽区域消息 + 末位摘要指令
- `GenerateOptions.purpose = 'compaction'`
- 摘要路由解析（配置对 → 最新已路由请求目标 → AgentOptions）
- 输出上限 `maxTokens` 解析
- 取消信号全程转发

## 验收标准
- 用假 llm 断言：回放 message 序列的首项是 system，且包含被遮蔽区间
- 取消时调用被中止且错误原因原样保留
- 无可用路由时给出可操作的明确错误（而非静默失败）

## 写入范围
lib/core/summarize.js, test/summarize.test.mjs

## 依赖
#6

## 第一性原则
C4：摘要调用若不复用前缀，成本模型与缓存假设同时失效。此议题是成本约束的直接实现。
BODY
)"

mk "M2-8 D5 注入形态与续跑提示" "m2-policy" "$(cat <<'BODY'
## 目标
替换 D5：决定压缩结果以什么形态回到模型可见面。

## 交付物
- 替换 `user/message` 的注入实现，必须使用 `compactCheckpointSource(compactionId, sourceCommandId?)`
- 注入体形态（标记/标签与头部说明）按 Codex 风格，并保证模型知道"历史已被压缩、如何续跑"
- 保留原文到 `compaction/summary` 事件（纯文本块）

## 验收标准
- 纯消费端可用 `isCompactCheckpointSource` 识别检查点
- 注入体不含任何持久身份泄漏（不把内部 id 暴露给模型）
- 与 `compaction/summary` 事件的时序相邻性有测试断言

## 写入范围
lib/core/inject.js, test/inject.test.mjs

## 依赖
#6

## 第一性原则
D5 是"压缩后的自我描述"：模型必须能区分'我没见过这段'和'这段已被摘要'，否则会重复劳动或幻觉。
BODY
)"

mk "M3-9 幂等与防漂移" "m3-stability" "$(cat <<'BODY'
## 目标
保证多次压缩叠加时语义不退化（压缩的压缩）。

## 交付物
- 多次压缩叠加语义：已有检查点再次进入范围时的处理规则
- 防漂移：摘要的摘要策略（保留既有决策字段、禁止字段丢失）
- 稳定标记与 identity 复用规则

## 验收标准
- 连续 3 次压缩的模拟测试：关键决策字段在链式摘要后仍然存在
- 重复调用同一范围不产生重复事件或重复摘要

## 写入范围
lib/core/idempotence.js, test/idempotence.test.mjs

## 依赖
#5, #7

## 第一性原则
有损信道的级联会放大损失。防漂移 = 保证投影是幂等近似，而不是每次丢一点。
BODY
)"

mk "M3-10 失败与降级" "m3-stability" "$(cat <<'BODY'
## 目标
让压缩在失败时**可诊断、可恢复、不损坏会话**。

## 交付物
- 摘要失败恢复：`compaction/summary-error` waterfall 监听（可记录对输入的持久修正）
- 取消语义：中止时保留精确 abort reason
- 错误分级：与 `ManualCompactionError` 的 busy/cancelled/changed/summary/commit/persistence 对齐
- 后台失败不吞：日志可见

## 验收标准
- 每类失败码有对应测试
- 摘要失败后会话仍可继续、锁被释放（`compaction/end` 必达）
- 失败尝试在日志中可见

## 写入范围
lib/core/errors.js, test/errors.test.mjs

## 依赖
#2, #7

## 第一性原则
C3：事务必须要么完整要么可观测地失败。锁泄漏是比压缩失败严重得多的事故。
BODY
)"

mk "M4-11 引擎级测试矩阵" "m4-verification" "$(cat <<'BODY'
## 目标
把 D1-D5 的**不变量**固化为可重复的测试矩阵，作为回归护栏。

## 交付物
- 表驱动单测：触发边界、切分不变量（C1/C2）、零写入路径、事务事件序列
- 属性/模糊测试：随机会话 → 断言永不产出非法请求（配对平衡）
- 覆盖每个验收标准的可追溯映射表

## 验收标准
- 所有断言在 linux/windows/macos 三个平台 CI 绿
- 关键不变量有反向测试（故意破坏时测试必须失败）

## 写入范围
test/**

## 依赖
#4

## 第一性原则
测试是可执行的设计意图。反向测试证明断言真的有判别力，否则只是装饰。
BODY
)"

mk "M4-12 真实运行时冒烟与兼容性" "m4-verification" "$(cat <<'BODY'
## 目标
在**真实 dsh 运行时**证明替换生效，而不只是单测绿。

## 交付物
- 隔离 profile 安装脚本（临时 DSH_HOME，绝不碰真实环境）
- `--dump-config` 断言压缩层已被替换
- 真实会话触发一次压缩的端到端脚本，附 token 前后账目
- `ci / compat-next` 作业（非门禁，红不阻塞 main）

## 验收标准
- 真实运行时压缩后会话可继续，且检查点可被识别
- 冒烟脚本在本地与 CI 同一份文件运行（不允许两套）
- 明确记录 dsh 版本区间

## 写入范围
scripts/**, .github/workflows/compat.yml, docs/runtime-verification.md

## 依赖
#1

## 第一性原则
单元测试证明逻辑，真实运行时证明**接线**——而"装了没反应"正是本类插件的头号失效模式。
BODY
)"

mk "M4-13 可观测性" "m4-verification" "$(cat <<'BODY'
## 目标
让压缩行为对用户与维护者可解释。

## 交付物
- `/compact` 端到端（手动路径）验证与结果呈现
- 压缩前后 token 账目（释放量、影子价一致性）
- 诊断日志：为何触发、选了哪段、为什么没压

## 验收标准
- 未触发时有可读原因
- 手动 /compact 在 busy 与已完成两种状态下给出一致的用户可见结果

## 写入范围
lib/core/telemetry.js, test/telemetry.test.mjs, docs/observability.md

## 依赖
#8, #11

## 第一性原则
不可观测的自动行为不可信任。压缩必须能回答"为什么现在压了这一段"。
BODY
)"

mk "M5-14 文档" "m5-delivery" "$(cat <<'BODY'
## 目标
交付可自助安装、可自助排障的文档。

## 交付物
- README.md / README.zh.md
- docs/architecture.md：含**与原生 compaction-basic 的策略差异对照表**（D1-D5 逐维）
- docs/codex-notes.md：Codex 语义的源码证据（文件/函数级）
- 安装、验证三级阶梯、回滚指南
- docs/PLAN.md 更新为终态（本计划）

## 验收标准
- 文档中的每条 dsh 行为断言都有文件+函数级证据
- 安装步骤在干净环境可复现

## 写入范围
README*, docs/**, locale/**

## 依赖
#12, #13

## 第一性原则
证据纪律：文档里的每条硬结论都要能被下一个人复核，否则它就是负债。
BODY
)"

mk "M5-15 发布流程" "m5-delivery" "$(cat <<'BODY'
## 目标
让版本可发布、可校验、可回滚。

## 交付物
- `.github/workflows/release.yml`
- `npm pack` 内容校验（exports/files 与实际产物一致）
- 展示元数据校验：`icon` 或 `exports[\"./icon\"]`、`locale/*.json` 的 meta.title/description
- 安装验证指南与回滚步骤

## 验收标准
- 发布的 tarball 能被 `dsh plugin add` 成功安装并出现在 `--dump-config` 中
- 元数据在 Web UI 可见（有截图或断言脚本）

## 写入范围
.github/workflows/release.yml, package.json(version/metadata), scripts/verify-pack.mjs

## 依赖
#14

## 第一性原则
发布是唯一把"代码正确"变成"用户可用"的步骤；元数据静默失效会让插件"装了没反应"。
BODY
)"
