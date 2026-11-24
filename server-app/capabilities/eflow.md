<!--@cap
probe: eflow/eflow-core.js
-->
E-Flow v2（**可选**的项目文档地基 · 每轮被注入的那份东西）：一律用 `eflow` 工具，禁手工数数、禁手改生成区。

· 入口（只有两处，全部用户主动；禁 AI 自己推销）：① `~New quest~` 卡片「AI 读懂我的项目」= 把文档地基**全局**交给 qd 管（点一下 = 发一句话；已开时这张卡自己不出现）② 用户在对话里明确说「要接入 / 文档怎么管」→ 项目级 `eflow upgrade`。没有第三个入口。
· ★ 全局接管（`eflow op=global action=on|off|status`）：只在用户显式要求时才开。开着时**机器自己**会把白纸项目接进来（铺骨架 + 写一行 rule，幂等），AI 不用重复做；已经有自己规则库的项目一个字都不动，只把每轮字数报给用户。开关真值 = 用户级目录下的一份小 JSON；**永禁往用户的全局规则文件（global.txt）写产品文案**（用户一删就静默失能）。要关：`action=off`（已接入的项目保持现状，拆单个项目用 `op=detach`）。

· ★ 白纸原则：项目默认什么都不接。**禁在用户没开口时跑 init/upgrade**（那会往人仓里写文件、改 project.txt）。用户问「文档怎么管 / 上下文塞满」→ 先 op=status 拿数字，再问他要不要接 E-Flow；他说接才动手。反悔用 op=detach（只拆 EF2 自己那一行 rule，文件不删；purge=true 才把骨架目录改名归档）。
· 用户已经有自己的规则库（project.txt 里有自己的 rule"…"）→ 完全合法，体检只量成本不拦人；禁把他的 rule 行删掉或「归一」。只有误指到别的项目 EF2 L0 的残行会被 BLOCK。

· 任何「文档太重 / 上下文塞满 / 不知道读哪份 / 规则散落」的诉求 → 先 `eflow` op=status：它会给出每轮固定注入多少字、各层有几份文档、经验几条。先拿数字，再说结论。
· 收尾前 op=check 必须 PASS（十道闸：注入面 / 体积 / 死链死路由 / 经验 schema / 索引同步 / 腐烂 / 密钥 / 放宽可见 / 生成区同步 / 成本）。BLOCK 逐条改到消失；WARN 允许存在，但必须在回复里如实说出来。
· L0（`_qqq/alphal/expert/index.md`，≤2500 字）里的 `EF2:BEGIN … EF2:END` 那段是生成区：它由各文档头部的 `# WHEN：…` / `# MUST：…` 编译而来。要改路由表或加铁律 → 改文档头，再 op=index。禁直接改生成区（体检会 BLOCK）。
· 新项目：op=init（幂等，绝不覆盖已有文件）。老项目把一份大文档当注入源：op=upgrade 只做机械迁移（停注入、改写 project.txt、建骨架、备份），铁律归位与细则拆分是 AI 的活，做完 op=check 必须 PASS。
· 写经验（L3）：一次具体、有代价、会复现的坑 → `_qqq/alphal/expert/exp/exp-YYYYMMDD-NNNN.md`，front matter 必填 id/date/domain/state/triggers（triggers 写「用户会怎么问」的词），正文四段：现象/根因/定式/证据。单条 ≤2000 字。期满 op=rotate --apply 归档并重建 INDEX.tsv。
· 预算要放宽：写 `_qqq/alphal/expert/budget.json`（带 _reason），禁改内核里的默认值；体检会把放宽项打印出来。
