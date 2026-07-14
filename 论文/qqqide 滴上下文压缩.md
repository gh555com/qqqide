# qqqide 上下文压缩 — V12 架构

状态：V12 已落地。原地追加，零 splice，跨楼层前缀缓存命中。零网络，零费用。

---

## §1 铁律

```
┌──────────────────────────────────────────────────────────────┐
│  🔴 零网络调用。一切在客户端完成。                           │
│  🔴 楼层完结 → 即刻重组背包。建楼中不触发压缩。  │  🔴 背包顺序固定: Z → 饼干(1条msg,原地追加) → DE(1条msg,原地更│  🔴 压缩饼干 = 逐层 Q&A + 工具痕迹 + [ERR]错误标记（无代码正文）。│ 工具痕迹（无代码正文）。           │
│  🔴 DE = 不可恢复工具输出(K) + AI产出代码(C)，混合时序排列。  │
│  🔴 DE 单条 ≤6K chars(超→首尾各3│  🔴 biscuit/DE 消息对象永不变，仅 content 尾部增长。         │
│  🔴 失败原子回滚（conversation + _ctx 全部字段）。            │                         │
└──────────────────────────────────────────────────────────────┘
```

---

## §2 基础定义

### 背包
AI 对话的完整上下文。`agent.conversation[]` 数组。V12 物理顺序：

```
[0] Z (sg0, 规则/铁律, _persistent) — 永不变，100% 缓存命中
[1] 压缩饼干 (1条 _biscuit msg, content 尾部追加) — 前缀缓存命中
[2] DE (1条 _deBlock msg, content 原地更新) — 大部缓存命中
[3] 当前楼层原始消息 (user + assistant + tool) — 新建楼层时变化
```

**关键**：V12 biscuit/DE 消息对象永不变。仅 content 尾部增长。
跨楼层前缀缓存 ~90% 命中。每层实际计费 ~2-4K tokens。

V11 旧结构（已废弃）：
```
[0] Z → [1] biscuitPrefix → [2] DE → [3] biscuitLatest → [4] 当前
       ↑ splice 注入新对象 → 缓存从 biscuit 处全断（V11 根因漏洞）
```

### Z（注入物）
msg[0] 的规则/铁律/vision context。永不压缩，永不变化。缓存 100% 命中。

### 压缩饼干（V12：单条消息，原地追加）
已完结楼层经机械筛产出的纯文本。逐层 `=== FN ===` + Q/A/工具行。不含代码正文。不含 CURRENT TIME。

**V12 单条消息**：biscuit 消息对象永不替换，仅 content 尾部追加新楼层行。旧行不变→前缀缓存命中。

错误标记：fatal 楼层（含已恢复）输出 `[ERR] [HH:MM] 错误文本`。重启扫描 biscuit 重建错误日志。

V11 旧设计（已废弃）：biscuit 分裂为 prefix+latest 两条消息，每层 splice 替换→缓存全断。

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

### 自动重组（V12 唯一触发方式）
每层楼完结（onDone）→ `_rebuildBackpack()`：
1. 取当前楼层消息 → 机械筛 → 饼干行
2. 提取 K/C → 追加 DE 条目（超 20K 则 FIFO 驱逐）
3. 找已有 biscuit msg → content += 新饼干行（原地追加，零 splice）
4. 找已有 DE msg → content = 全新序列化（原地更新）
5. Splice-remove 原始楼层消息（仅删原始消息，biscuit/DE 不动）

### 建楼中
**不触发压缩。** 旧 `_compressContext` 的阈值检查已移除。

### 手动压缩
已移除。保留旧代码路径（`_compressContext` 函数体注释保留）。
将来用于 AI 驱动的 facts 格子（用户手动发起 → AI 语义提取 facts）。

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

## §6 缓存命中分析（V12）

```
发送楼层 N+1 时的背包:
  [0] Z                     ← 100% 命中（永不变化）
  [1] biscuit msg           ← 前缀命中（对象不变，仅最后一行新）
  [2] DE msg                ← 前缀命中（对象不变，仅最后条目新）
  [3] user_msg F(N+1)       ← 新内容（唯一新 token 大头）

每层实际计费: ~2-4K tokens（仅 biscuit 末行 + DE 末条目 + 用户消息新）
V11 架构: ~15-40K tokens（splice 创建新消息对象 → 缓存从 biscuit 处全断）
V10 架构: ~38K tokens（饼干全量重生成 → 全断）
无压缩: ~5K tokens 但背包无限膨胀 → 必死
```

---

## §7 V10→V11→V12 演进

```
V10: 阈值触发 + W6 保留 + AI 语义压缩（三专家并行）→ 缓存全断 + 质量不稳定
V11: 每层完结自动重组 + 本地机械筛 + 追加式饼干 → splice 新对象 → 缓存全断（根因漏洞）
V12: V11 的缓存修复版。核心改动：biscuit/DE 消息对象永不变，仅 content 原地追加/更新。
     零 splice → 前缀缓存跨楼层命中 ~90%。
```

---

## §8 红字框与压缩联动（V12b）

### 错误保留规则
- **未恢复 fatal 楼层**：不进饼干，原始消息保留在 conversation。AI 直接看到 `_error` 消息。
- **已恢复 fatal 楼层**：进饼干，`[ERR] [HH:MM] 错误文本` 格式。重启扫描 biscuit 重建错误日志。
- **时间戳**：`_errorTime` 字段持久化到 conversation 消息，重启后精确恢复。

### 恢复路径
重启/切 quest 时：conversation 中已有的 biscuit/de 消息直接可用。
`_restoreAgentFromStore` 扫描 `_error` 消息 + biscuit `[ERR]` 行，重建 `_questErrorLogByFloor`。
`_buildDynamicContext` 返回空字符串（动态上下文已在 conversation 中）。

---

## §9 未解决问题

1. **DE 代码提取启发式** — 从 tool_call args 提取，可能漏 AI 纯文本中的代码
2. **>200 层** — 饼干自身需二次压缩（罕见）
3. **DE 轮转时缓存断** — FIFO 驱逐条目时 DE content 变化→缓存从 DE 处断（低频）
