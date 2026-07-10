# 自研 Timeline Diff 基础设施对 AI 能力的提升

状态：已落地。2026-07-11。

---

## 1. 起源

### 1.1 问题触发

压缩背包时，AI 改过的代码正文会被方案三机械筛剥离——只保留操作痕迹（"edit_file foo.js ✓ 3处"），丢弃完整代码。这在绝大多数情况下安全——AI 每次都 re-read 磁盘拿最新代码，不依赖背包里的旧快照。但存在一个真实缺口：

> AI 要参考一段已经被后续改动覆盖掉的旧实现。

例如：第 8 层把 `foo.js` 登录超时从 30s 改成 60s。到了第 15 层，需要理解"当时为什吗那样改"，但磁盘上已是新代码，背包里只剩压缩饼干——旧代码正文丢失了。

Git blame 可以查到那一行是谁改的、什吗时候改的，但查不到改动前的精确代码正文。而 qqqide 有一个更好的东西：**Timeline**。

### 1.2 已有的基础设施：钩子 Q + Timeline 双轨

这是理解整个设计的关键——钩子 Q 不是为 AI 打造的，它先于 AI 而存在。

#### 钩子 Q（§37，panel-a4.js）

钩子 Q 是 qqqide 的核心拦截器，作用面极广：

```
executeTool(name, args)
    │
    ▼
_a4WrappedExecuteTool   ← 钩子 Q 拦截一切 AI 写工具
    │
    ├─ 1. 捕获 BEFORE（读磁盘 → 算 SHA256 → 确保入 timeline）
    ├─ 2. 执行原工具（edit_file / write_file / create_file / delete_file）
    ├─ 3. 捕获 AFTER（读磁盘或拿 args.content）
    ├─ 4. _a4RecordSnapshot → 写入 agent._a4Snapshots（per-floor 内存）
    │       └─ _a4PersistToTimeline → bridge.timeline.record → 主进程
    │            └─ SHA256(gzip(行尾归一化(content))) → qqq/timeline/blobs/{sha256[:2]}/{sha256}.gz
    └─ 5. 返回原始 result
```

钩子 Q 的拦截是透明的——AI 不知道它的存在，工具调用和返回值都和没有钩子一样。

#### Timeline 存储（timeline-store.ts）

```
qqq/timeline/
  blobs/{sha256[:2]}/{sha256}.gz    ← 内容不可变，SHA256 寻址，永不删除
  timeline.db                         ← SQLite 索引（每 100 条压缩一次）
  timeline.wal                        ← NDJSON 增量日志（≤99 行）
  timeline.db.bak                     ← 备份（损坏自动恢复）
```

SHA256 行尾归一化（CRLF/LF/CR → \n 统一）保证同一内容在不同平台产生相同 hash。blob 只存一份——写永远追加，读永远 hit。

#### 双轨用途

| 轨 | 使用者 | 作用 |
|----|--------|------|
| A4 面板 | 人 | 实时瀑布文件列表 → 点击 → openDiffWindow → Monaco side-by-side |
| Timeline 存储 | 人+系统 | 跨窗口脏文件追踪、外部修改静默捕获、版本恢复 |

**在此之前，AI 不在任何一轨上。** Timeline 是一个人用的系统，AI 看不到它。

### 1.3 为什么不能教 AI 用 git

AI 理论上可以跑 `git diff HEAD~5 -- foo.js` 或 `git show abc123:foo.js`。但：

- git 不是 qqqide 的领域——项目可能没 git init、可能 detached HEAD、可能 submodule
- AI 不知道 commit hash，需要额外推理
- run_command 走 qz spawn 管线，比 IPC 慢 10 倍，且可能被 security guard 拦截

**更根本的反对**：让 AI 在背包鼓胀时额外 spawn 子进程翻 git 历史 = 增加摩擦。§54 说：IDE 的唯一职责是消除摩擦。

---

## 2. 设计

### 2.1 核心洞察

钩子 Q 已经做了四件事：读 before → 执行工具 → 读 after → 持久化到 timeline。在这条管线里，`blob_hash` 是天然存在的——它是持久化的副产物，零额外成本产生。

**只需要做一件事：把已经存在的 blob_hash 写进工具返回值。** AI 在自然使用中自己发现这个能力。

### 2.2 链路

```
① AI 调用 edit_file / write_file / create_file
② 钩子 Q 拦截 → 正常执行 → timeline.record → 拿到 blob_hash
③ 返回值从 "✓ 3处" 变成 "✓ 3处 [sha256: abc123def456...]"
④ AI 自然注意到返回值里的 sha256 字符串（和它见过的任何 hash 一样）
⑤ read_file 工具描述里写了一句 "Pass sha256 to read a historical version from timeline"
⑥ 5 层楼之后，AI 想回看 → read_file(path, sha256="abc123...")
⑦ 主进程：sha256 → 向上找项目根(含 qqq/timeline/blobs/) → 读 blob → gunzip → 返回
```

### 2.3 改了什么（4 处，~45 行）

| 文件 | 改动 | 量 |
|------|------|-----|
| `tools-defs.js` | `read_file` parameters 加 `sha256: {type:'string', description:'...'}`，描述加 15 字 | +4 |
| `shell/ipc-fs.ts` | `read_file` handler：sha256 路径 → 文件路径找项目根 → blob→gunzip→paginate | +20 |
| `shell/preload.ts` | `read_file` 的 TS 类型加 `sha256?: string` | +1 |
| `panel-a4.js` | `_a4WrappedExecuteTool` 返回前，追加 `[sha256: xxx]` | +6 |

**提示词增量**：15 个中文字符。

### 2.4 坚决不做

- ❌ 不创建 `list_versions` / `query_timeline` / `open_diff` 工具
- ❌ 不在 system prompt 里提 timeline
- ❌ 不在工具描述里写使用场景
- ❌ 不让 AI 直接读 `timeline.wal` / `timeline.db`

---

## 3. 与当今最能打的方案比较

### 3.1 对比对象

| | qqqide Timeline + 钩子 Q | Cursor / Windsurf | VS Code Copilot | JetBrains AI | Git-based（通用） |
|---|---|---|---|---|---|
| **AI 能读历史版本吗** | ✅ `read_file(sha256=...)` 直接拿到 | ❌ 没有此能力 | ❌ 没有此能力 | ❌ 没有此能力 | ⚠️ AI 可以 `git show` 但需要知道 commit hash |
| **版本粒度** | 每次 AI 工具调用自动捕获 | — | — | — | 每次 commit（粒度太大，一个 commit 可能含 20 次编辑） |
| **历史版本寻址方式** | 工具返回值自带 sha256（零推理） | — | — | — | AI 需推理 commit/ref（有歧义） |
| **存储成本** | SHA256 去重，相同内容只存一份 | — | — | — | git object 全量存 |
| **对提示词的影响** | +15 个中文字符 | — | — | — | 需在 tools 描述里解释 git ref 语法 |
| **是否要求项目有 git** | ❌ 不要求。qqqide 自带 | 依赖 git 或没有 | 依赖 git 或没有 | 依赖 git 或没有 | ✅ 必须 git init |
| **外部修改可见** | ✅ 静默捕获，零弹窗 | ❌ | 弹窗二选一 | 底部通知 | ❌ 文件不改就不进 git |
| **人也能看** | ✅ A4 面板 + Diff 窗口 | ❌ | ❌ | ❌ | ✅ git log -p |

### 3.2 关键优势：sha256 作为能力涌现的载体

Cursor/Copilot 的 AI 想回看旧版本 → 唯一办法是 `run_command("git show HEAD~3:foo.js")`。这需要 AI 知道：
- 改动的 commit 是哪个（不知道——AI 不负责 commit）
- `HEAD~3` 对不对（不知道——中间可能有其他 commit）
- `foo.js` 的路径是否正确（可能被 rename 过）

**qqqide 的 AI 不需要任何推理。** sha256 就在返回值里——它改文件时拿到的那个字符串。它不是 commit hash，它是那个精确时刻、精确内容的指纹。零歧义。

### 3.3 为什么别人做不了

钩子 Q + Timeline 的组合是 qqqide 独有的架构资产：

- **钩子 Q 的透明拦截**：其他 IDE 的工具执行是库调用/HTTP 请求，没有统一的拦截点。AI 每次调用都是一个独立事件，没有"写工具 → 自动捕获版本"的管线。
- **内容寻址 blob 存储**：大多数 IDE 的本地历史是时序存储（按时间戳），不是内容寻址（按 SHA256）。时序存储会重复存相同内容，且无法作为能力载体传递——"第 3 次保存"不是可验证的引用，sha256 是。
- **客户端渲染管线**：qqqide 的工具返回是纯字符串，追加 `[sha256: ...]` 不影响任何现有逻辑。其他 IDE 的工具返回是结构化对象，加字段是 breaking change。

**这不是"我们做了比别人更多的工作"。这是我们已有的架构恰好使这件事极其便宜——便宜到 15 个字、45 行代码、零新工具。**

---

## 4. AI 能力提升（可验证场景）

### 4.1 回看被覆盖的旧实现

AI 在第 8 层改了 `foo.js`，第 15 层需要理解那个改动的上下文。磁盘已更新。AI 从第 8 层的 edit_file 返回值里取出 sha256 → `read_file("foo.js", sha256="abc...")` → 拿到精确的历史内容。

### 4.2 跨文件追溯改动链

AI 改 A.js 时引用了 B.js 的一个函数签名。3 层楼之后 B.js 被重构了，签名变了，A.js 崩了。AI 记得改 A.js 时 B.js 的 sha256 → read_file 拿到 B.js 改之前的版本 → 理解原来的签名 → 修 A.js。

### 4.3 与压缩饼干协同

压缩饼干说 "F8: edit_file foo.js ✓ 3处 [sha256: abc]"。AI 不需要读 3 处改动的细节——它知道 sha256，随时可以回看 foo.js 在 F8 之后的样子。

---

## 5. 总结

不需要知识库、不需要向量检索、不需要"请 AI 总结代码变更"、不需要 git。

**钩子 Q 已经做了捕获 + 持久化。我们只是把已经存在的 sha256 从内存搬到返回值里，然后把 read_file 的参数表加了一行。** 15 字提示词增量，45 行代码，零新工具，零新 IPC 通道。

AI 自己连接返回值里的 sha256 和 read_file 的 sha256 参数——和它学会用其他工具的方式完全一样。锦上添花，不教做事。
