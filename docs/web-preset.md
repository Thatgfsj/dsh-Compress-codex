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

## 可行方案：preset-codex

默认配置下，**原生压缩在 web 端是正常工作的**（preset 内的 `compaction-basic` 是启用态，
顶层那份才被 `dsh-web-app` 禁用）。所以「要不要换」是选择，不是故障。

要换成 Codex 风格，就必须复制 preset 的 roster 并把隔离组指向本插件。
本仓库提供生成器：

```sh
node scripts/sync-preset-codex.mjs --profile web --base standard --out preset-codex.patch.yml
cat preset-codex.patch.yml >> ~/.dsh/profiles/web/cordis.patch.yml
dsh --profile web --dump-config | grep -A3 "preset-codex"
```

生成结果是一个**新增** preset（id `codex`，order 0），**默认 preset 仍是 standard** ——
所以可先安全试用：在 Web UI 的 preset 选择器里选 `codex` 即可，不必改默认。

## 漂移（必须知道）

这份副本是 `@deepseek-ai/dsh-web-app` 中 `preset-standard` 的**逐字复制**。
上游改动 preset（新增工具、改 system prompt、加插件）后，副本不会自动跟随。
升级 dsh 后请重跑生成器并 diff：

```sh
node scripts/sync-preset-codex.mjs --profile web --base standard --out /tmp/preset-codex.new.yml
diff /tmp/preset-codex.new.yml preset-codex.patch.yml
```

## 已验证 / 未验证

- 已验证：组合树正确（preset-codex 的隔离组指向 `dsh-compress-codex`，`command-compact` 与
  `tool-result-pruner` 保留）；独立实例 `dsh --profile web --port 0 --no-open` 启动无插件加载错误、
  无 `disabling profile plugin row "preset-codex"`。
- 未验证：**用 codex preset 真实跑一轮并触发压缩**（需要在 UI 里选该 preset 并发起会话）。
  在完成这一步之前，不要对外声称「web 端已切到 Codex 压缩」。
