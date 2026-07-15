# 自研 Timeline Diff 基础设施对 AI 能力的提升

状态：已落地。2026-07-15 更新（五工具闭环）。

---

## 0. 五工具闭环（总览）

Timeline 从"为人设计的版本历史"升级为"AI 原生可编程版本系统"。五工具形成完整闭环：

```
timeline_versions   →  列出文件所有版本（可按楼层过滤 + 查看 trace 归因）
       ↓
diff_versions       →  计算任意两个版本间的 unified diff（或 vs 当前磁盘）
       ↓
read_file(sha256)   →  读任意历史版本的完整内容
       ↓
revert_file         →  一键回退到任意版本
```

加上 `panel-a4.js` 钩子 Q 在每个写工具返回值追加 `[sha256: xxx]`，AI 在自然使用中自己发现这个能力。

| 工具 | 类别 | 作用 | 代价 |
|------|------|------|------|
| `timeline_versions` | READ | 列版本 + 按楼层过滤 + trace 归因 | 0 ge（本地） |
| `diff_versions` | READ | 计算两个版本 unified diff | 0 ge（本地） |
| `read_file(sha256)` | READ | 读历史版本完整内容 | 0 ge（本地） |
| `revert_file` | WRITE | 回退到指定版本 | 触发 A4 钩子，等同于一次 write_file |
| 钩子 Q 返回值 | 自动 | 每次 write 后追加 `[sha256: xxx]` | 0 成本（管线副产物） |

---

## 1. 起源

### 1.1 问题触发

压缩背包时，AI 改过的代码正文会被方案三机械筛剥离——只保留操作痕迹（"edit_file foo.js ✓ 3处"），丢弃完整代码。这在绝大多数情况下安全——AI 每次都 re-read 磁盘拿最新代码，不依赖背包里的旧快照。但存在一个真实缺口：

> AI 要参考一段已经被后续改动覆盖掉的旧实现。

例如：第 8 层把 `foo.js` 登录超时从 30s 改成 60s。到了第 15 层，需要理解"当时为什吗那样改"，但磁盘上已是新代码，背包里只剩压缩饼干——旧代码正文丢失了。

Git blame 可以查到那一行是谁改的、什吗时候改的，但查不到改动前的精确代码正文。而 qqqide 有一个更好的东西：**Timeline**。

### 1.2 已有的基础设施：钩子 Q + Timeline 双轨

钩子 Q 是 qqqide 的核心拦截器，在每次 AI 写工具（edit/write/create/delete）执行前后捕获文件内容，计算 SHA256，写入 timeline 存储。这条管线天然产生 blob_hash —— 它是持久化的副产物，零额外成本。

Timeline 存储使用 SHA256 内容寻址 + gzip 压缩 + SQLite 索引 + WAL 增量日志 + .bak 备份，保证跨十年可靠性。

**在此之前，AI 不在任何一轨上。** Timeline 是一个人用的系统（A4 面板 + Diff 窗口），AI 看不到它。

---

## 2. 设计

### 2.1 核心理念：不教 AI，让 AI 自己发现

不做以下事情：
- ❌ 不在 system prompt 里提 timeline
- ❌ 不在工具描述里写使用场景
- ❌ 不让 AI 直接读 timeline.wal / timeline.db
- ❌ 不创建"请 AI 总结代码变更"之类的提示词

只做一件事：把已经存在的 blob_hash 从内存搬到返回值里。AI 自己连接返回值里的 sha256 和 read_file 的 sha256 参数。

### 2.2 五工具实现

#### 工具 1：钩子 Q 返回值注入（panel-a4.js）

```
edit_file/write_file/create_file 返回值
  从: "✓ 3处"
  到: "✓ 3处 [sha256: abc123def456...]"
```

#### 工具 2：read_file(sha256)（ipc-fs.ts + tools-defs.js）

主进程 handler 已支持 sha256 参数：从文件路径向上找项目根（有 qqq/timeline/blobs/ 的目录）→ 读 blob → gunzip → 返回。支持行范围分页。

#### 工具 3：timeline_versions（tools-exec.js + ipc-timeline.ts）

列出文件所有版本，可选按 floor_num 过滤。输出包含 file_seq、时间、±行数、source、trace（quest/floor/house/room 归属）、sha256 前缀。

#### 工具 4：diff_versions（tools-exec.js，2026-07-15 新增）

计算任意两个版本间的 unified diff。完整 LCS DP 算法，大文件（>5000 行）自动降级为近似 diff。to_seq 可选——默认比较 from_seq 与当前磁盘内容。零网络，零费用。

#### 工具 5：revert_file（tools-exec.js + ipc-timeline.ts）

一键回退：查 file_seq → 读 blob → 写回磁盘 → A4 钩子自动记录新版本。原子操作。

### 2.3 改动量

| 文件 | 改动 | 量 |
|------|------|-----|
| `tools-defs.js` | read_file 加 sha256 + timeline_versions + revert_file + diff_versions 定义 | ~50 行 |
| `tools-exec.js` | executeTimelineVersions + executeRevertFile + executeDiffVersions + LCS diff | ~240 行 |
| `panel-a4.js` | 返回值追加 [sha256: xxx] | +6 |
| `shell/ipc-fs.ts` | read_file handler：sha256 → blob → gunzip | +20 |
| `shell/ipc-timeline.ts` | versions/content/record IPC handlers | 已有 |
| `shell/preload.ts` | read_file TS 类型加 sha256 | +1 |

**提示词增量**：~80 个中文字符（四个工具的 description）。

---

## 3. 与当今最能打的方案比较

| | qqqide Timeline 五工具 | Cursor / Windsurf | VS Code Copilot | JetBrains AI | Git-based（通用） |
|---|---|---|---|---|---|
| **AI 能读历史版本吗** | ✅ read_file(sha256) | ❌ | ❌ | ❌ | ⚠️ git show 需知 hash |
| **AI 能 diff 历史版本吗** | ✅ diff_versions | ❌ | ❌ | ❌ | ⚠️ git diff 需知两个 ref |
| **AI 能列出所有版本吗** | ✅ timeline_versions | ❌ | ❌ | ❌ | ⚠️ git log 粒度过粗 |
| **AI 能按楼层过滤吗** | ✅ floor_num 参数 | ❌ | ❌ | ❌ | ❌ |
| **AI 能追溯改动归属吗** | ✅ trace 字段（quest/floor/house/room） | ❌ | ❌ | ❌ | ⚠️ git blame 仅到 commit |
| **AI 能回退文件吗** | ✅ revert_file 一键 | ❌ | ❌ | ❌ | ⚠️ git checkout 需知 ref |
| **版本粒度** | 每次 AI 工具调用自动捕获 | — | — | — | 每次 commit（太粗） |
| **历史版本寻址** | 工具返回值自带 sha256（零推理） | — | — | — | AI 需推理 commit/ref |
| **是否要求 git** | ❌ 不要求 | 依赖 git 或无 | 依赖 git 或无 | 依赖 git 或无 | ✅ 必须 |
| **人也能看** | ✅ A4 面板 + Diff 窗口 | ❌ | ❌ | ❌ | ✅ git log -p |

**核心优势**：sha256 作为能力涌现的载体。AI 不需要推理 commit hash——sha256 就在返回值里，是那个精确时刻、精确内容的指纹。零歧义。

---

## 4. AI 能力提升（可验证的五场景闭环）

### 4.1 回看被覆盖的旧实现（read_file + sha256）

AI 在第 8 层改了 `foo.js`，第 15 层需要理解那个改动的上下文。磁盘已更新。AI 从第 8 层的 edit_file 返回值里取出 sha256 → `read_file("foo.js", sha256="abc...")` → 拿到精确的历史内容。

### 4.2 审查自己上一层的改动（diff_versions + timeline_versions）

AI 刚完成第 8 层的编辑 → 调 `timeline_versions("foo.js")` 看到 #12 和 #13 是刚才改的 → `diff_versions("foo.js", from_seq=12, to_seq=13)` → 拿到精确 diff → 自我审查是否有遗漏或错误。

### 4.3 二分定位 bug 引入点（timeline_versions + diff_versions + revert_file）

AI 发现 `foo.js` 的登录逻辑有 bug → `timeline_versions("foo.js")` → 看到 15 个版本 → 二分法：`diff_versions("foo.js", 8, 15)` → 发现 bug 在 #12 引入 → `revert_file("foo.js", file_seq=11)` → 回退到正常版本。

### 4.4 跨文件追溯改动链 + 归因（timeline_versions + trace）

AI 改 A.js 时引用了 B.js 的一个函数签名。3 层楼后 B.js 被重构。AI → `timeline_versions("B.js")` → 看 trace 字段知道哪层楼改了什么 → 理解签名演变 → 修 A.js。

### 4.5 按楼层审计（timeline_versions + floor_num）

"第 8 层改了哪些文件的哪些版本？" → 对每个文件调 `timeline_versions(path, floor_num=8)` → 完整审计该楼层的影响面。

---

## 5. 总结

不需要知识库、不需要向量检索、不需要 git、不需要教 AI 做事。

**钩子 Q 已经做了捕获 + 持久化。我们只是把已经存在的 sha256 从内存搬到返回值里，然后加了三个纯本地、零费用的工具（timeline_versions / diff_versions / revert_file），让 AI 可以自己探索 timeline。**

五工具形成完整闭环：列版本 → 看差异 → 读内容 → 回退。AI 自己发现、自己使用、零额外教学成本。
