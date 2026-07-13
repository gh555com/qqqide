# qqqide 上下文压缩 — V11 重构

状态：V11 实施中。每层楼自动重组背包，零网络，零费用。

---

## §1 铁律

```
┌──────────────────────────────────────────────────────────────┐
│  🔴 零网络调用。一切在客户端完成。                           │
│  🔴 楼层完结 → 即刻重组背包。建楼中不触发压缩。              │
│  🔴 背包顺序固定: Z → 饼干(前缀) → DE → 饼干(末层) → 当前消息│
│  🔴 压缩饼干 = 逐层 Q&A + 工具痕迹（无代码正文）。           │
│  🔴 DE = 不可恢复工具输出(K) + AI产出代码(C)，混合时序排列。  │
│  🔴 DE 单条 ≤6K chars(超→首尾各3K)，总计 ≤20K chars，FIFO。  │
│  🔴 失败原子回滚。                                           │
└──────────────────────────────────────────────────────────────┘
```

---

## §2 基础定义

### 背包
AI 对话的完整上下文。`agent.conversation[]` 数组。物理顺序：

```
[0] Z (sg0, 规则/铁律, _persistent)
[1] 压缩饼干前缀 (所有已完结楼层除最后一层, _biscuitPrefix)
[2] DE (K+C 时间线, _deBlock)
[3] 压缩饼干末层 (最近完结楼层, _biscuitLatest)
[4] 当前楼层原始消息 (user + assistant + tool)
```

### Z（注入物）
msg[0] 的规则/铁律/vision context。永不压缩，永不变化。缓存 100% 命中。

### 压缩饼干
已完结楼层经机械筛产出的纯文本。逐层 `=== FN ===` + Q/A/工具行。不含代码正文。不含 CURRENT TIME。

**分裂为两条消息**：前缀（F1 到 F(N-1)）和末层（FN）。前缀追加式增长，旧行不变→前缀缓存命中。末层每层楼换一次。

### DE（K+C 格子）
不可恢复工具输出(K) + AI 产出代码(C)，按时序混排。每条目 ≤6K chars。总计 ≤20K chars。FIFO 轮转。

条目格式：
```
[ts:1750221492 F3] [run_command] git log
  │ abc1234 Fix login timeout
  │ def5678 Add search

[ts:1750221680 F5] [code:edit_file] foo.js
  function login() { ... }
```

### K 集合
结果不能从磁盘 re-read 的 7 个工具：run_command / fetch_webpage / search_web / analyze_image / get_vision_context / generate_image / remove_background。

### C 集合
AI 产出的代码块。从 edit_file / write_file / create_file 的 tool_call arguments 提取。

---

## §3 触发机制

### 自动重组（唯一触发方式）
每层楼完结（onDone）→ `_rebuildBackpack()`：
1. 取当前楼层消息 → 机械筛 → 饼干行
2. 提取 K/C → 追加 DE（超 20K 则 FIFO 驱逐老条目）
3. 合并饼干前缀 + 旧末层 → 新前缀
4. 新楼层饼干 → 新末层
5. Splice conversation：移除原始消息，注入新饼干+DE

### 建楼中
**不触发压缩。** 旧 `_compressContext` 的阈值检查已移除。

### 手动压缩
已移除。保留旧代码路径（`_compressContext` 函数体注释保留），将来用于 AI 驱动的 facts 格子。

---

## §4 机械筛（同 V10）

### 转换规则

| 原始消息 | 格式 |
|---------|------|
| user | `Q: [全量内容]`（剥离 [File:] 注入块和 CURRENT TIME） |
| assistant 纯文本 | `A: [全量内容]` |
| assistant 含 tool_calls | 先 `A:` 行，再 `[A → xxx] file1, file2` |
| tool 返回（可恢复） | 摘要追加到上一工具行 |
| tool 返回（不可恢复） | 摘要 + 完整输出另起缩进块 |
| system | `[S] [全量内容]` |

### 工具分类（不变）

| 可恢复（仅摘要） | 不可恢复（摘要+完整输出→DE） |
|---|---|
| read_file / edit_file / write_file | **run_command** |
| create_file / delete_file | **fetch_webpage** |
| search_text / search_content | **search_web** |
| list_files / find_files | **analyze_image** |
| get_diagnostics | **get_vision_context** |
| | **generate_image** |
| | **remove_background** |

---

## §5 DE 详细规则

### 条目来源
- **K 条目**：不可恢复工具的完整输出（已由饼干保留缩进块，DE 中二次保留完整版）
- **C 条目**：edit_file / write_file / create_file 的 tool_call arguments 中提取代码正文

### 容量规则
- 单条 ≤ 6,000 chars。超→取首 3,000 + 尾 3,000，中间标 `…[截断 N chars]…`
- 总计 ≤ 20,000 chars。插入前检查：当前总量 + 新条目 > 20K → FIFO 驱逐最老条目直到有空间
- 如果单条 > 20K（理论上 6K 帽已防），整条跳过不存

### 时间格式
Unix timestamp（秒，10 位整数，如 `1750221492`）。8 字节整数，紧凑精确。

### 序列化格式
```
═══ DE (K+C, 20K cap) ═══

[ts:1750221492 F3] [run_command] git log --oneline
  │ abc1234 Fix login timeout
  │ def5678 Add search feature

[ts:1750221680 F5] [code:edit_file] foo.js
  function login() {
    const timeout = 5000;
    ...
  }
```

---

## §6 缓存命中分析

```
发送楼层 N+1 时的背包:
  [0] Z                     ← 100% 命中（永不变化）
  [1] biscuit F1..F(N-2)    ← 前缀命中（仅 F(N-1) 行是新的）
  [2] DE                    ← 前缀命中（仅刚追加的条目新；轮转时部分断）
  [3] biscuit F(N-1)        ← 100% 命中（与楼层 N 完结时相同）
  [4] user_msg FN           ← 新内容（唯一新 token 大头）

每层实际计费: ~2-4K tokens（仅最后一两条消息新）
vs 旧架构: ~38K tokens（饼干全量重生成→全断）
vs 无压缩: ~5K tokens 但背包无限膨胀→必死
```

---

## §7 与 V10 的本质区别

```
V10: 阈值触发 + W6 保留 + 压缩饼干全量重生成 → 缓存全断
V11: 每层完结自动重组 + 饼干追加式 + DE 替换 W6 → 前缀缓存极高
```

---

## §8 恢复路径

重启/切 quest 时：conversation 中已有的 biscuit/de 消息直接可用，无需重建。`_buildDynamicContext` 返回空字符串（动态上下文已在 conversation 中）。

---

## §9 未解决问题

1. **DE 代码提取启发式** — 当前从 tool_call arguments 提取，可能漏掉 AI 纯文本中讨论的代码
2. **多轮叠加** — >200 层时饼干自身需要二次压缩（罕见）
3. **恢复路径验证** — _restoreAgentFromStore 需要适配新 biscuit/de 结构
