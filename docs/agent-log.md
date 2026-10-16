# Agent 交接日志

Hermes 与 OpenCode 共用。开工先读最近 5 条，收工在「当前占用」下方追加一条。

## 当前占用

（空）

---

## 2026-10-17 01:50 · hermes · 回复气泡支持 Markdown

- 改：新增 `src/core/markdown.ts`（解析器）、`src/ui/Markdown.ts`（渲染器）、`tests/markdown.test.ts`（48 条）、`tests/theme-vars.test.ts`、`tests/architecture.test.ts`；改 `src/ui/Bubble.ts`（助手气泡走 Markdown）、`src/ui/style.css`（`.hb-md-*`）；修正 6 个 UI 文件里的 `--color-foreground` / `--color-background`
- 验证：`npm test` 315 passed；`npx tsc --noEmit` 干净；`node scripts/verify.mjs` 40/40；`node scripts/audit-classes.mjs` 0 缺失
- 遗留：会话删除/重命名（issue #5）；其余服务端请求（issue #4）

### 为什么手写解析器

先确认过没有现成的可用：0.22.2 的 `SDK.components` 里没有任何 markdown / prose 组件，`window` 上也没有 `marked` / `markdown-it` / `DOMPurify`。项目铁律不引运行时依赖，所以要么手写一个子集，要么把解析器加净化器一起塞进 IIFE。选前者，规模也就 500 行。

### 两个设计决定

**不产出 HTML。** 解析器输出节点树，`src/ui/Markdown.ts` 用 `React.createElement` 渲染。文本由 React 转义，全流程没有 `innerHTML`，注入这一类问题是被删掉而不是被净化掉。`tests/architecture.test.ts` 会拦住 `innerHTML` / `dangerouslySetInnerHTML`。链接仍过 `safeHref()`——React 不会替你拦 `javascript:` 协议。

**必须能跑半句话。** 每个流式增量都重解整条消息，所以未闭合的围栏、单独的 `**`、还没等到分隔行的表格都是**正常输入**而不是错误。测试里专门有一条性质检查：对一条完整消息的每个前缀都跑一遍，不允许抛异常。

刻意不支持 setext 标题（`标题` 下面一行 `---`）：模型都写 `##`，把裸 `---` 当标题惹的麻烦比帮上的多，按分隔线处理，和 CommonMark 一致。

### 顺带查出两个一直存在的真 bug

写渲染器时要给代码块一个深色底，才发现 `--color-background` 在这个主题里解析成 **transparent**。查宿主编译产物：它**从不定义** `--color-foreground` 和 `--color-background`（23 个 `--color-*` 变量里没有这两个）。`var(--undefined)` 不报错，整条声明在计算值阶段被丢掉，元素静默继承或透出背景。也就是说：

- 工具卡片的 `<pre>` 和审批卡的代码块从 v0.1 起**一直没有可见底色**（用户没提，因为不影响功能）；
- 6 个 UI 文件里的 `color: var(--color-foreground)` 一直在做无用功（表现上恰好等于继承色，所以看不出来）。

改用真实存在的 token（`--color-card-foreground`）并给背景加 fallback。新增 `tests/theme-vars.test.ts`：逐个把 `var(--x)` 对照真实编译产物核对，没 fallback 又不存在就报错，离线回退白名单。守卫本身也验过——植入一行 `var(--color-background)` 确认两条断言都会失败。

### 又一次「守卫要验它真的会响」

`layout-classes.test.ts` 最初我写成「禁止任意值语法」，结果 8 个实际生效的类（`text-[0.6875rem]` 等）被误报。判据是**这个类在不在宿主产物里**，不是它长什么样，改成对照真实 CSS 逐个核对。这个教训值得记：守卫的判据要贴着根因，不能贴着表象。

## 2026-10-17 00:40 · hermes · v0.3 按七条反馈返工

- 改：新增 `src/ui/{TabStrip,HistoryPanel}.ts`、`tests/layout-classes.test.ts`、`scripts/audit-classes.mjs`；删 `src/ui/SessionSidebar.ts`；重写 `src/ui/{ChatPage,Composer,style.css}`；`src/app/controller.ts` 支持中途发送
- 验证：`npm test` 261 passed；`npx tsc --noEmit` 干净；`node scripts/verify.mjs` 35/35；`node scripts/audit-classes.mjs` 0 缺失
- 遗留：会话删除/重命名（issue #5）；vault/sudo 等其余服务端请求（issue #4）
- 下一步：issue #4

### 这轮最重要的一条：宿主 CSS 里没有的类会静默失效

插件跑在仪表盘**预编译**的 Tailwind 产物上，那份 CSS 只含仪表盘自己源码用过的类。我们新造的类如果不在其中，**不报错、不警告，属性完全不生效**。三个用户可见的 bug 全出自这里：

- `resize-none` 不在 → 输入框保留原生缩放手柄（用户第 6 条）
- `max-h-[70vh]` 不在 → 模型选择器没有高度上限
- `text-[0.625rem]` 不在 → 用量行按 15px 基准渲染（用户第 5 条）

注意**不能简单禁掉任意值语法**：实测 `text-[0.6875rem]`、`tracking-[0.06em]`、`w-[0.5em]`、`max-h-48` 都在宿主 CSS 里且生效，而 `mt-1.5`、`max-w-[16ch]`、`disabled:opacity-40`、`group-hover:opacity-100` 不在。判据是**这个类在不在**，不是它长什么样。于是：新增 `scripts/audit-classes.mjs`（对照真实编译产物逐个核对）与 `tests/layout-classes.test.ts`（守护，宿主缺失时回退到实测白名单）。

### 其余六条的落点

1. 命令目录原来被截到 12 条，且**过滤跑在截断后的列表上**——超过 12 的命令永远搜不到。改成渲染上限 200（列表可滚动），过滤针对全量。
2. 布局改成：会话页签在顶、历史在右侧可收起。新增 `TabStrip` / `HistoryPanel`，删掉原来的左侧 `SessionSidebar`。
3. `@` 补全原来要求 query 至少一个字符，而裸 `@` 恰恰是后端给出 `@diff` / `@file:` / `@folder:` / `@url:` 根的最有用情形。去掉长度限制。
4. 气泡去掉「你」「HERMES」标签，靠左右对齐与配色区分。
5. 用量行改用 `hb-text-tiny`（9.375px，比思考行 10.3125px 略小）；思考块的间距从失效的 `mt-1.5` 改成 `hb-stack-gap`（实测 7.5px）。
6. 输入框 `resize:none`，去掉那个反直觉的原生手柄。
7. 运行中允许发送：主按钮变「插入」，停止按钮降为次要；后端在 `prompt.submit` 的 `status` 里回报 queued / steered / redirected，页面把它显示成一行提示。

### 验收脚本里三个假断言

第 7 条（运行中允许输入）一开始只在**空闲态**断言输入框没被禁用——那什么都证明不了，需求说的就是运行中。改成先发一条 `sleep 12` 的慢任务，再在运行期间观察：拿到了 `{"hasInsertButton":true,"hasStopButton":true,"textareaDisabled":false}`，并确认输入的字真的能提交。顺带发现「插入」按钮在输入框为空时是禁用的（`insertDisabled:true`），这是对的，不要动。

「no console errors」查出两条 `Could not establish connection. Receiving end does not exist.`。原来是异常日志没记来源，补上 `d.url` 后立刻看清是 `chrome-extension://pdffkfellgipmhklpdmokmckkkfcopbh/...`——headless Edge 照旧加载自带扩展，是扩展自己跨源抛的，与插件无关。改为过滤 `*extension://` 来源。这类噪声不记来源就永远查不清，所以顺手把来源写进日志。

### 又两个假断言（验收脚本）

- 「无发言人标签」用全文正则匹配 `/^HERMES$/m`，命中的是**仪表盘自己的侧栏 logo**，不是气泡。改成只在转写区里找。
- 「用量行字号」的断言被放在新建 tab 之后，那时聚焦的 tab 已经空转写区，量到 null；移到跑完一轮之后测量，并顺手把「思考块有真实间距」也补成断言（7.5px）。

## 2026-10-16 23:40 · hermes · v0.2 装修：把它做成正常 aichat 的样子

- 改：新增 `src/core/{sessions,slash,attachments,metrics}.ts`、`src/ui/{Composer,SessionSidebar,ModelPicker}.ts`、`tests/{sessions,slash,attachments,metrics,hook-order}.test.ts`；重写 `src/app/controller.ts`（多会话）、`src/ui/{ChatPage,Bubble}.ts`；扩 `docs/01-protocol-contract.md`（slash/模型/附件/多会话/用量五节）
- 验证：`npm test` 254 passed；`npx tsc --noEmit` 干净；`node scripts/verify.mjs` 24/24 对真实仪表盘
- 遗留：中途 steer、会话删除/重命名（契约已有）
- 下一步：issue #3 steer

### 这轮抓到的三个真 bug（都写进测试了）

1. **React #310，整页白屏**：`Reasoning` 组件把 `useMemo` 写在 `if (!trimmed) return null` 之后。钩子数量在两次渲染间变化。逻辑单测看不见、`tsc` 也看不见——只有真跑起来、且某一轮有思考下一轮没有时才会炸。为此加了 `tests/hook-order.test.ts`：**源码级**扫描「钩子出现在提前 return 之后」，并带一条自检（植入一个违规样本，确认守卫真的会报）。写这个扫描器本身踩了两个坑：深度是**行后**语义（开括号行与函数体同深度），以及匹配 `return` 前必须先剥掉注释——文件自己的说明注释里就有「return」这个词，会被误判。
2. **又是一个连接竞态**：拉命令目录的 `commandsCatalog()` 没有 `ensureOpen()`，和 `start()` 抢跑，目录静默为空、`/` 菜单一条都不出。这已经是同一类 bug 的第二次，所以改成所有 RPC 统一走 `Controller.rpc()`。
3. **`bindSnapshot` 把新会话标成未连接**：草稿 tab 是连接建立前创建的，`connected` 一直带 false 进新时间线。改成由调用方按真实连接状态传入（`core/sessions.ts` 的 `options.connected`）。

### 验收脚本自身的两个假断言（记一下）

- 「新建会话」原本断言输入框为空——新输入框本来就是空的，等于没测。改成数侧栏的关闭按钮（tab 数）。
- 「接受补全」原本在**同一个** `evaluate` 里 click 完就读输入框，React 状态还没提交，读到的是点击前的值，断了个寂寞。改成 click 后另起一次读取，并把期望值收紧成 `=== "/help"`（原来只断言「以 / 开头」，而我输入的就是 `/hel`，永远为真）。

## 2026-10-16 22:15 · hermes · 修 gateway not connected + 补 AGENTS.md 索引

- 改：`src/gateway/client.ts`（新增 `ensureOpen`）、`src/app/controller.ts`（新增 `start`、`gateway.ready` 走归约）、`src/ui/ChatPage.ts`、`tests/controller.test.ts`（+5）、`scripts/verify.mjs`（+2）、`AGENTS.md`、`docs/agent-log.md`
- 验证：`npm test` 114 passed；`npx tsc --noEmit` 干净；`node scripts/verify.mjs` 15/15
- 遗留：无
- 下一步：issue #1 会话列表与切换

### 这次修的是什么

用户报「/chat 一进来就显示 gateway not connected，重启网关也没用」。两个缺陷叠加：

1. `ChatPage` 调 `connect()` 后**立刻** `openSession()`。`connect()` 是 fire-and-forget 且 URL provider 异步，`session.create` 在 socket 存在前发出，抛 `gateway not connected`——而 socket 几毫秒后就绪。修复：`GatewayClient.ensureOpen()` 把调用方挂起到可用（终态鉴权失败直接 reject 不挂死），`Controller.start()` 先 await 再开会话。
2. `controller.handleEvent` 对 `gateway.ready` 提前 return，没走归约，`meta.connected` 永远 false → 输入框一直禁用。修复：走归约。

### 为什么原有测试没抓到（重要）

109 项测试和 13 项端到端**全绿**，因为端到端脚本先发了消息——那次 `send()` 内部的 `openSession()` 重试把竞态掩盖了。教训：**验收脚本必须断言「无人工操作下的初始就绪态」，不能只断言「发一条消息后能工作」。** 现在 verify.mjs 有两条专门的检查（composer 自行就绪、页面上不出现该横幅）。

## 2026-10-16 21:35 · hermes · 气泡聊天页插件首个可用版本

- 改：全新仓库。`src/core/{types,reduce,history,dedupe}.ts`、`src/gateway/{channel,client}.ts`、`src/app/controller.ts`、`src/ui/{ChatPage,Bubble,format,sdk}.ts`、`src/index.ts`、`build.mjs`、`manifest.json`、`plugin_api.py`、`scripts/{install-plugin,verify,probe,probe-turn}.mjs`、`AGENTS.md`、`DESIGN.md`、`README.md`、`docs/01-protocol-contract.md`、`docs/agents/*`
- 验证：`npm test` 109 passed；`npx tsc --noEmit` 干净；`node scripts/verify.mjs` 13/13 对真实仪表盘通过（真模型真往返，含一次带工具调用的回合）
- 遗留：会话列表/切换、附件、steer 未做；服务端请求只接了 approval 与 clarify
- 下一步：见 README「已知限制」

### 本轮踩到的坑（写给接手的人）

1. **`SDK.hooks` 是精选子集，不是 React 全量**——`useSyncExternalStore` 不在里面。取不到就 `TypeError: useSyncExternalStore is not a function`，整个页面白屏、控制台一行异常。要用 `SDK.React` 上的完整实例。
2. **用户插件必须在 `plugins.enabled` 里登记**，否则 `/api/dashboard/plugins` 会把它过滤掉，但 rescan 的 count 里还算它——看起来「发现了但没加载」。内置插件没这个门槛。
3. **插件后端路由在启动时挂载，rescan 不会重挂**。新加 `plugin_api.py` 要重启仪表盘才生效；前端 bundle 不用重启。
4. **manifest 的 `entry` 相对 `dashboard/` 目录**，所以安装脚本必须保留 `dist/` 这一层，铺平会让所有声明路径 404。
5. **服务端请求的 `id` 是字符串，客户端请求的 `id` 是数字**——这是同一 socket 上区分「回应」与「提问」的唯一依据。
6. **重复投递是真事**：后端把每个发过言的 socket 都加进该会话的 fan-out，`message.delta` 会到两遍，气泡里就出现两份字。去重键 `(replay_epoch, session_id, seq)`，epoch 变了必须清空水位，否则后端重启后重放永远返回空。
7. **`message.complete` 的 `text` 常为空**（已经流式发过了），只能当兜底，不能用来覆盖已累积的文本。
