# codex-ptc preset：安装与验证

`codex-ptc` = 上游 `ptc` preset 的完整副本，仅把隔离 compaction 组换成 `dsh-compress-codex`。
**PTC 工具呈现（`run_code` + 生成的 SDK）完整保留**，`preset-ptc` 不被覆盖。

## 生成

```sh
node scripts/sync-preset-codex.mjs \
  --base ptc \
  --preset-id preset-codex-ptc \
  --config-id codex-ptc \
  --order 5 \
  --name "Codex (PTC)" \
  --description "PTC 工具呈现保持不变，压缩改用 dsh-compress-codex。" \
  --out /tmp/codex-ptc.yml
```

## 安装

新 profile 的 `cordis.patch.yml` 可能是空数组占位符 `[]`，直接追加会产出非法 YAML（dsh 解析报错）。
只有占位符时整文件替换，已有条目才追加：

```sh
P=~/.dsh/profiles/web/cordis.patch.yml
if grep -qE '^\[\]$' "$P"; then
  cat /tmp/codex-ptc.yml > "$P"
else
  printf '\n' >> "$P"; cat /tmp/codex-ptc.yml >> "$P"
fi
dsh --profile web --dump-config >/dev/null && echo "PARSE OK"
```

## 验证

组合级语义等价：与上游 `ptc.patch.yml` 的 diff 只有 compaction 两行 + id/name/description/order。
其余 128 行逐字相同。

| 项 | 期望 |
|---|---|
| `mode: ptc` | 1 |
| `disabled: true` | 4 |
| `compaction-codex` | 1 |
| `compaction-basic` | 0 |

## 回滚

移除 profile patch 里该 insert 块，或从 `~/.dsh/.manual-backup-before-codex-ptc-*` 恢复。
