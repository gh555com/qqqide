# qqqide 上下文压缩 — 概念定义与架构

状态：V10 已落地。本地机械筛，零网络，零费用。

---

## §1 铁律

```
┌──────────────────────────────────────────────────────────────┐
│  🔴 压缩 = 背包重构。成功前不写盘，失败原子回滚。            │
│  🔴 零网络调用。一切在客户端完成。                           │
│  🔴 仅保留当前在建楼层原始。楼层完结→即刻机械筛。           │
│  🔴 Q/A/S 全量保留，不截断。工具结果仅摘要。                 │
│  🔴 不可恢复工具（run_command/fetch_webpage/search_web/      │
│     analyze_image等）输出完整保留。                           │
│  🔴 [File: ...] 注入块剥离。CURRENT TIME 剥离。              │
│  🔴 压缩前后快照 + 恢复路径：重启不反弹。                    │
└──────────────────────────────────────────────────────────────┘
```

---

## §2 基础定义

### 背包
AI 对话的完整上下文。`agent.conversation[]` 数组。

### Z（注入物）
每次请求携带但非对话内容的消息：msg[0]（规则）、toolsdef、guard、CURRENT TIME、_system 恢复消息。

### 压缩原料 X
已完结楼层的原始消息，剥离 Z。

### 压缩饼干
X 经机械筛产出的纯文本。逐层 Q&A 缩略 + 工具调用行 + 摘要 + 不可恢复工具完整输出。作为 `{role:"system", _compressed:true}` 注入 conversation。

---

## §3 触发机制

### 自动压缩
每间 house 完成后检查 `_lastApiPromptTokens > COMPRESS_THRESHOLD`（默认 200k tokens，设置→高级可调 100k-1000k）。

触发后：原地执行 `_compressContext` → splice conversation → 移除非 W6 楼层消息 → 注入饼干。

### 手动压缩
左下角按钮。不检查阈值，强制压缩。`_compressContext({force:true})`。

### W6 保留
`_findBreakpoint` 保证断点后至少 4 层完整原始楼层（≥10% 总 token）。W6 永不压缩。

---

## §4 机械筛（方案三：楼层摘要式）

### 转换规则

| 原始消息 | 格式 |
|---------|------|
| user | `Q: [全量内容]`（剥离 [File:] 注入块和 CURRENT TIME） |
| assistant 纯文本 | `A: [全量内容]` |
| assistant 含 tool_calls | 先 `A:` 行，再 `[A → xxx] file1, file2` |
| tool 返回（可恢复） | 摘要追加到上一工具行 |
| **tool 返回（不可恢复）** | **摘要上追一行 + 完整输出另起缩进块** |
| system | `[S] [全量内容]` |

### 工具分类

| 可恢复（仅摘要） | 不可恢复（摘要+完整输出保留） |
|---|---|
| read_file / edit_file / write_file | **run_command** |
| create_file / delete_file | **fetch_webpage** |
| search_text / search_content | **search_web** |
| list_files / find_files | **analyze_image** |
| get_diagnostics | **get_vision_context** |
| | **generate_image** |
| | **remove_background** |

**不可恢复 = 结果在磁盘上找不到。** 例如 `psql` 查询、`curl` API 返回、网页抓取、图像分析——这些内容只在那个时刻存在。

### 视觉识别特殊说明
用户粘贴图片时，预分析结果（`VISION ANALYSIS RESULTS`）注入到 user 消息内容中。Q 行全量保留→预分析不丢失。

AI 主动调 `analyze_image` 的结果：属于不可恢复工具→完整输出另起缩进块保留。

---

## §5 恢复路径（防反弹）

```
压缩时：
  ① conversation splice → 饼干入内存
  ② ctx.narrative = 饼干全文 → 随 agent metadata 落盘 sq3
  ③ ctx.lastCompressedFloor = 被压最大楼层号

重启/切 quest 时（_restoreAgentFromStore）：
  ① 读 ctx.lastCompressedFloor + ctx.narrative
  ② 聚合楼层 conversation，跳过 _floor <= lastCompressedFloor 的原始消息
  ③ unshift 饼干到 conversation 头部
  ④ 用实际 conversation 索引覆盖 _floorMeta.floorStartIdx
  ⑤ 去重 _compressed 消息（各楼层快照中的饼干副本）
```

---

## §6 与之前版本的本质区别

```
V1-V6: 网络 AI 压缩（三专家并行→扣费→经常失败→回滚）
V7-V8: 本地机械筛（零网络→零费用→100%成功 但是 W6 过多）
V9:    +run_command 完整输出
V10:   +所有不可恢复工具完整输出 + 恢复路径（重启不反弹）
```

---

## §7 未解决问题

1. **极端大消息** — 用户粘贴 50K 纯文本日志→全量保留→饼干膨胀
2. **多轮叠加** — >200层对话时旧饼干需二次压缩
