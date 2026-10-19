# 社区视角：没有 inherit，如何可持续接管 preset 隔离服务

> 调研日 2026-10-19；外链均为资料。结论标记 [证据] / [推断] / [未找到]。

## 1 官方设计：覆盖 = 整块替换，无继承

- [证据] 官方流程：改 shipped preset 就按 Loader row id 覆盖声明，且「override replaces the complete config, so restate id, plugins and every other field」——[editing-cordis-compositions](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md)。
- [证据] 设计文档写死：「用户覆盖会替换整个子插件列表，不会合并后续内置变更」——[declarative-agent-presets](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-18-declarative-agent-presets.zh.md)。声明字段仅 id/name/description/order/plugins；子行 id 可省略、由 Loader 分配——[agent-preset README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset/README.md)。
- [未找到] 官方 issue/discussion/roadmap 的 preset 扩展点或 inherit（GitHub issues 搜索 total_count=0；registry README 的 Known Limitations 无此项）。[推断] 副本漂移是官方明确的取舍，不是可绕过的 bug。

## 2 社区如何侵入隔离上下文

- 运行时装饰（无副本）：[SunlitCrack/dsh-compaction-threshold](https://github.com/SunlitCrack/dsh-compaction-threshold) 用 ctx.get('agentPresets').serviceFor(agent,'compaction') 取得会话所在 preset 隔离 realm 的引擎，再整体替换 engine.config（对象 frozen，原位赋值会静默失败）。[证据] registry README 称 agentPresets.serviceFor() 是「显式检查保留组合」的公开面——[registry README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset-registry/README.md)。
- 换引擎行 / shim：[windwhiterain/dsh-compaction-threshold](https://github.com/windwhiterain/dsh-compaction-threshold) 在 preset 的 compaction group 内把 compaction-basic 换成自研 engine 子类，导入官方引擎并复制触发策略，自陈与上游耦合。
- 重建而非定向覆盖：[CK-Rebi/dsh-preset-reload](https://github.com/CK-Rebi/dsh-preset-reload) 用注册表 recompose + disable→enable 强制新 revision 并重绑活会话；[dsh-minimal-mode-compaction](https://github.com/wicm84266964/dsh-minimal-mode-compaction)、[dsh-compact-standard](https://github.com/pythonshiyi/dsh-compact-standard) 都是新建 preset / 复制 roster。
- [证据] 已有人补上缺失扩展点：dsh-TUI [PR #1552](https://github.com/ccch1mneyyy/dsh-TUI/pull/1552) 新增「seam VII preset 内的行」，插一行 preset-patch，config 为 {preset: standard, config: {compaction-basic: {...}}}，按行 id 整块替换、含嵌套 group、未知 id 告警。原文：「Agent preset 里的行……运行在 preset 自己的 realm 里，按 id 的 patch 够不到。」[推断] 该模块属 dsh-TUI fork，本机 DSH 0.2.1-rc.2 无。

## 3 寻址语义与失败根因

- [证据] [loader README](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/loader/README.md)：resolve(id) 支持嵌套 a:b；[@deepseek-ai/cordis-plugin-group](https://www.npmjs.com/package/@deepseek-ai/cordis-plugin-group) 写「Nested entry ids use : separators, for example tools:logger」——这是 Loader 运行时 API。
- [证据] DSH include 的 applyEntryPatches（[vendor/include/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/include/src/index.ts)）自建扁平 id map，仅递归 entry.group && Array.isArray(entry.config)；insert 也要求目标 group:true。非 group 的 config（即 preset 声明的 plugins）不入选，故 - id: compaction 报 not found。
- [证据] preset 子行挂在 registry 拥有的 in-memory Loader tree / 各代际 scope，不在 profile include 树内；patch 按层（各 bundle→用户→--patch）也只作用于 include 树。嵌套路径即便存在也跨不过去。

## 4 通用不漂移模式

[推断] 由优到劣：①运行时装饰 / 服务句柄；②shim 子类（接受耦合）；③安装期从上游文件生成覆盖 + anchor 校验（漂移即失败）；④推动上游扩展点。逐字副本是唯一会静默漂移的选项。

## 5 对本项目的建议

若只需改隔离 compaction 的行为/参数、不换实现：首选运行时装饰——host 插件用 serviceFor(agent,'compaction') 整体替换 config，删掉 preset-codex 副本；社区已验证可热更新且不碰会话日志。

若必须替换引擎模块或 wiring：不要手抄 22 项；改为构建/安装期从 dsh-web-app/presets/standard.patch.yml 生成 preset-codex（单一来源），并 assert 上游 roster 的 anchor/校验和，升级时告警失败；再用 dsh-preset-reload 重绑旧会话。[证据] 官方承认覆盖不合并，[推断] 生成+校验比手抄更贴合官方契约。

同时向上游提 feature request（可援引 dsh-TUI seam VII 的 config 形状），落地前不要依赖。
