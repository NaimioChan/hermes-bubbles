# Agent 交接日志

Hermes 与 OpenCode 共用。开工先读最近 5 条，收工在「当前占用」下方追加一条。

## 当前占用

（空）

---

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
