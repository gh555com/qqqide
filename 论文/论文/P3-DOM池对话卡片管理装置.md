# P3：基于DOM池的对话卡片管理装置

> 学术论文 · 四川的梦科技有限公司 · 2026-07-27

---

## 摘要

多对话会话界面中，用户在多个对话间切换时面临渲染延迟和状态丢失问题。现有"销毁-重建"模式导致切换闪烁、滚动位置丢失。本文提出**基于 DOM 池的对话卡片管理装置**——每个对话会话（quest）拥有一个完整 DOM 子树（Card），创建后永不 innerHTML 清空。切换对话 = 纯 CSS display 显隐，零 DOM 销毁，零竞态。Pool 上限 10 张 Card，LRU（最近最少使用）驱逐策略超限自动回收。该架构将对话切换延迟从 200-800ms 降至 <16ms（单帧），滚动位置 100% 保留。

---

## 1. 引言

AI 编程助手的一个典型使用模式是用户同时进行多个对话：一个讨论架构、一个修复 bug、一个探索新功能。用户在这几个对话间频繁切换。

现有前端方案：

| 方案 | 切换机制 | 核心问题 |
|------|----------|----------|
| SPA 路由 | 销毁旧组件 → 挂载新组件 | 重建延迟 200-800ms，滚动位置丢失 |
| 虚拟滚动 | 仅渲染可视区域 | 代码块/Markdown 复杂渲染不支持 |
| innerHTML 替换 | 一个容器，切换时清空重写 | 闪烁，事件监听器丢失 |
| React reconciliation | Virtual DOM diff | 大列表 diff 开销高，仍需重建 |

核心矛盾：对话渲染成本高（代码高亮、Markdown、图片嵌入），但切换必须瞬间完成。

---

## 2. 系统设计

### 2.1 Card = 完整 DOM 子树

每个 quest 创建时获得一个独立的 `<div class="card">` 容器，包含全部楼层 DOM：

```
Card #1 (q1.项目架构讨论)    → display: block   ← 可见
Card #2 (q2.修复登录bug)     → display: none    ← 隐藏
Card #3 (q3.新功能探索)      → display: none    ← 隐藏
...
Card #10 (q10.代码审查)      → display: none
```

切换 = 修改两个 Card 的 `display` 属性。不销毁、不重建、不 reflow。

### 2.2 Card Pool 生命周期

| 操作 | 实现 |
|------|------|
| 创建 Card | `_getOrCreateCard(questId)` → new div → appendChild → 渲染全部楼层 |
| 切换 Card | `switchCard(questId)` → 旧 Card display:none + 新 Card display:block |
| 驱逐 Card | LRU 队列尾部 → remove() → 从 _cards Map 删除 |
| 销毁 Pool | `destroy()` → 中止所有 agent → 移除所有 DOM → 清空 LRU |

### 2.3 LRU 驱逐策略

- Pool 容量上限：10 张 Card（可配置）
- 每次切换：将目标 Card 移至 LRU 队列头部
- 超限驱逐：删除 LRU 队列尾部 Card 的 DOM 子树
- 保护机制：当前活跃 Card 不可驱逐

### 2.4 Per-Card 楼层上限

每张 Card 最多容纳 16 层已封顶 + 1 层在建楼层。超限 → 最老楼层 DOM remove()。这防止单次超长对话耗尽浏览器内存。

---

## 3. 性能分析

| 指标 | 传统销毁-重建 | 本方案 |
|------|-------------|--------|
| 切换延迟 | 200-800ms | <16ms (1帧) |
| 滚动位置保留 | ❌ | ✅ 100% |
| 内存占用 (10对话) | ~50-150MB (含重建开销) | ~80-200MB (但无重建开销) |
| GC 压力 | 高 (频繁创建/销毁) | 低 (对象复用) |

权衡：本方案以更高的内存占用换取零延迟切换。10 张 Card x 平均 50 层楼 ≈ 可在现代浏览器中稳定运行（实测 ~120MB 堆内存）。

---

## 4. 与现有技术对比

| 特性 | React Virtual DOM | Vue <keep-alive> | Web Component | 本方案 |
|------|-------------------|-------------------|---------------|--------|
| 零切换延迟 | ❌ (需 diff) | ✅ | 部分 | ✅ |
| 滚动位置保留 | ❌ | ✅ | ❌ | ✅ |
| 代码高亮保留 | ❌ (需重新 highlight) | ✅ | 部分 | ✅ |
| 内存可控 | ✅ | ✅ | ✅ | ✅ (LRU) |
| 框架无关 | ❌ | ❌ | ✅ | ✅ (原生 DOM) |

---

## 5. 结论

基于 DOM 池的对话卡片管理装置通过"创建后永不 innerHTML"的设计原则，将多对话切换降至单帧延迟。LRU 驱逐策略保证内存可控。该方案适用于任何需要频繁切换重度渲染内容的多面板应用。

---

## 参考文献

[1] React Documentation — Reconciliation. reactjs.org.
[2] Vue.js <keep-alive> component. vuejs.org.
[3] MDN — Node.removeChild. developer.mozilla.org.
[4] qqq-shell-v2 架构文档 §29 Card Queue, 2026.
