# 让本插件在 agent preset（web 默认配置）里生效

## 结论先行

在 web profile 里，本插件**不会自动生效**。这不是安装问题，是架构边界：

- web 的默认 agent preset 是 `standard`（`agent-preset-registry.config.default: standard`）；
- 每个 preset **自带一个隔离的 compaction 组**：

  ```yaml
  - id: compaction
    name: cordis:group
    group: true
    isolate:
      compaction: true
      toolResultPruner: true
    config:
      - id: compaction-basic
        name: "@deepseek-ai/dsh-compaction-basic"
  ```

- 我们的行在**顶层**，而 preset 的 agent 运行在隔离上下文里，各用各的 `ctx.compaction`。

## 为什么不能直接 patch 那一行

loader patch 只能寻址**顶层 entry id**。实测：

```
$ dsh --profile web --patch probe.yml --dump-config    # probe.yml: - id: compaction
dsh: [probe.yml] patch: entry "compaction" not found
```

那一行嵌在 `preset-standard.config.plugins` 里，而 patch 的 `config` 是**整体替换**、不是深合并；
`dsh-agent-preset-registry` 也**没有** extends/inheritance，所以无法只覆盖其中一条。

## 可行方案：preset-codex（生成，不是手抄）

默认配置下，**原生压缩在 web 端是正常工作的**（preset 内的 `compaction-basic` 是启用态，
顶层那份才被 `dsh-web-app` 禁用）。所以「要不要换」是选择，不是故障。

要换成 Codex 风格，就必须 restate 这份 roster 并把隔离组指向本插件。本仓库用生成器从
**上游权威文件**生成，而不是从 `--dump-config` 组合树里切片：

```sh
node scripts/sync-preset-codex.mjs --out preset-codex.patch.yml
```

- 单一来源：`<dsh>/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`
  （128 行、`- insert:` 形态的**完整 patch**）。因此生成不受你自己的 profile patch 影响，
  也不需要从组合后的缩进里反推结构，更不会把上游的字符串重新折行；
- 生成结果是一个**新增** preset（id `codex`，order 0），**默认 preset 仍是 standard** ——
  可先安全试用：在 Web UI 的 preset 选择器里选 `codex` 即可，不必改默认。

### 装进 profile（注意 `[]` 占位符）

新 profile 的 `~/.dsh/profiles/<p>/cordis.patch.yml` 默认内容是**空数组占位符 `[]`**。
此时用 `cat >>` 追加会得到非法 YAML：

```
Error: dsh: failed to parse overlay .../cordis.patch.yml: YAMLException:
  end of the stream or a document separator is expected
```

正确做法二选一：

```sh
# A. 文件里只有占位符 [] 时：整文件替换
cp preset-codex.patch.yml ~/.dsh/profiles/web/cordis.patch.yml

# B. 文件里已经有别的 patch 条目时：追加
cat preset-codex.patch.yml >> ~/.dsh/profiles/web/cordis.patch.yml
```

验证：

```sh
dsh --profile web --dump-config | grep -A3 "preset-codex"
```

## 漂移：从静默到可检测

preset-codex 终究是上游 preset 的**副本**：上游新增工具 / 改 system prompt / 加插件后，
副本不会自动跟随。生成器把这件事从「静默」变成「显式失败」：

- 每次生成前校验上游文件的 **SHA256 anchor**（记录在 `scripts/preset-anchors.json`）；
- anchor 不匹配 → 生成中断，并打印期望/实际摘要与「重新同步并 review diff」的指引；
- 只有显式 `--update-anchor` 才允许写入新值（即：承认上游变更是一次**需要 review** 的事件）。

```
$ node scripts/sync-preset-codex.mjs --check
sync-preset-codex: FAIL: the upstream preset changed (anchor mismatch)
  expected: 0d398d2a…
  actual  : 9f1c…
```

### 升级 dsh 后怎么同步

```sh
node scripts/sync-preset-codex.mjs --out /tmp/preset-codex.new.yml   # 先校验 anchor
diff /tmp/preset-codex.new.yml <你的 preset-codex.patch.yml>          # review 上游改了什么
node scripts/sync-preset-codex.mjs --update-anchor                    # 接受新基线
node scripts/sync-preset-codex.mjs --out preset-codex.patch.yml      # 重新生成
```

### CI：漂移门禁（非必需）

`ci / preset-drift`（**非 required**，因为它需要真实 dsh 安装）做两件事：

1. 在 ubuntu 上安装 `scripts/preset-anchors.json` 里记录的 **baseline** dsh 版本，跑 `--check`；
2. 跑 `--selftest` 的**反向证明**：篡改 anchor、模拟上游改动、删掉重定向行都必须失败，
   源文件不可达必须报告 INCOMPLETE。

拿不到 dsh / 源文件时，作业报告 `PRESET-DRIFT: INCOMPLETE — SKIPPED`（带 `::warning::` 注解），
**不会说 PASS**：本项目的规矩是 skip 不等于 pass。`ci / compat-next`（同样非门禁）另外对
`dsh@next` 跑一次同样的校验，作为上游漂移的早期信号。

## 为什么「复制」不可避免，以及最小副本面

- [证据] 官方流程：改 shipped preset 就按 row id 覆盖声明，且「override replaces the complete
  config, so restate id, plugins and every other field」——覆盖**不合并**后续内置变更。
- [证据] `dsh-agent-preset-registry` 没有 extends/inheritance；子行 patch（`- id: compaction`）
  只在 profile include 树上寻址，够不到 preset realm 里的行（实测 `entry "compaction" not found`）。
- [证据] 运行时装饰（`ctx.get('agentPresets').serviceFor(agent, 'compaction')` 后整体替换
  `engine.config`）在社区被用于**改参数**；但本项目必须**换引擎模块**（换成
  `dsh-compress-codex` 的 `CodexCompactionEngine`），该路径不适用。
  （社区方案与出处见 [`docs/community-maintenance-notes.md`](community-maintenance-notes.md)。）

**最小副本面评估**：由于覆盖语义是「整份 restate」，我们无法只抄 `compaction` 那一组——
其余 21 项必须原样保留，否则 preset 会丢掉工具与 system prompt。所以真正可控的不是「少抄几行」，
而是让复制成为**生成产物 + anchor 校验**：上游一变就显式失败，并给出可 review 的 diff。

## 已验证 / 未验证

- 已验证：
  - 生成器从上游 `standard.patch.yml` 生成，anchor 校验通过（`--check` 退出 0）；
  - **组合级语义等价**：把新旧两种生成结果分别装进临时 web profile 后 dump，
    `preset-codex` 子树的 33 个 plugin id、name 序列、isolate/order 与 plan-mode 文本完全一致；
  - 反向证明（`--selftest`）：篡改 anchor、模拟上游改动、删掉重定向行 → 必须失败（退出 1）；
    源文件不可达 → INCOMPLETE（退出 2），不伪装 PASS；
  - 隔离组指向 `dsh-compress-codex`，`command-compact` 与 `tool-result-pruner` 保留；
    独立实例 `dsh --profile web --port 0 --no-open` 启动无插件加载错误。
- 未验证：**用 codex preset 真实跑一轮并触发压缩**（需要在 UI 里选该 preset 并发起会话）。
  在完成这一步之前，不要对外声称「web 端已切到 Codex 压缩」。
