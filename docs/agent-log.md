# Agent 交接日志

Hermes 与 OpenCode 共用。开工先读最近 5 条，收工在「当前占用」下方追加一条。

## 当前占用

（空）

---

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
