# hermes-bubbles

Hermes 网页仪表盘（`hermes dashboard`）的气泡聊天页。

内置的 `/chat` 是一个 xterm.js 终端，接 `/api/pty` 跑真的 TUI，所以它天生是终端长相：字符流、等宽字体、没有消息边界。这个插件把 `/chat` 换成原生气泡消息流——助手回答、工具调用、审批卡片各自成块，流式输出直接长在当前气泡里。

数据不走 PTY，走仪表盘自带的 `tui_gateway` JSON-RPC WebSocket（`/api/ws`），也就是桌面端用的那条。所以拿到的是结构化事件：`message.delta` 是一个 token 块，`tool.start` / `tool.complete` 是一对可配对的调用，`approval` 是要用户回答的请求。

![气泡聊天页](docs/assets/chat-bubbles.png)

左侧是会话列表（打开中的 tab + 历史），右侧是转写区：用户气泡、工具卡片、可展开的思考过程，底部输入框带附件、模型、思考强度与实时指标。

![斜杠命令菜单](docs/assets/slash-menu.png)

## 快速开始

```bash
npm install --include=dev      # Windows 上 NODE_ENV=production 会静默跳过 devDependencies
npm test                       # 109 项，纯逻辑，不起浏览器
npm run install-plugin         # 构建 + 装进 $HERMES_HOME/plugins/hermes-bubbles/dashboard/
```

装完打开 `http://127.0.0.1:9119/chat`。仪表盘不用重启，但插件是**用户插件**，得先在 `config.yaml` 的 `plugins.enabled` 里登记：

```bash
hermes config set plugins.enabled '["homeassistant","hermes-bubbles"]'
curl -H "X-Hermes-Session-Token: <token>" http://127.0.0.1:9119/api/dashboard/plugins/rescan
```

（`<token>` 从仪表盘页面源码里的 `window.__HERMES_SESSION_TOKEN__` 取。）

## 能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 流式气泡 | 已交付 | `message.delta` 逐块追加到当前气泡，末尾带闪烁光标 |
| 工具卡片 | 已交付 | 按 `tool_id` 配对 start/complete，运行中展开、完成后折叠，左侧状态色条 |
| 历史恢复 | 已交付 | `session.history` 投影成同样的气泡结构，刷新后不丢 |
| 审批卡片 | 已交付 | `approval` 服务端请求渲染成允许/拒绝按钮，直接回帧 |
| clarify 卡片 | 已交付 | 同上，按 `qid` 回答案 |
| 多轮续聊 | 已交付 | 一个会话内连续发消息；`session.create` 一次，之后复用 runtime id |
| 停止 | 已交付 | `session.interrupt`，失败也会本地封口气泡 |
| 斜杠命令 | 已交付 | `/` 唤起菜单，目录一次拉全后本地过滤；`command.dispatch` 的六种指令都接了 |
| 会话列表与切换 | 已交付 | 侧栏两段：打开中的 tab 与历史会话，可新建、切换、关闭、重开 |
| 多开会话 | 已交付 | 一条 socket 承载多个会话，事件按 `session_id` 分流，每个 tab 独立时间线 |
| 附件 | 已交付 | `+` 按钮与拖放/粘贴；按类型走 `image.attach_bytes` / `pdf.attach` / `file.attach` |
| `@` 路径引用 | 已交付 | `complete.path` 补全 |
| 模型选择 | 已交付 | `model.options` 列表 + `config.set`；会话级切换，贵的模型会回报确认要求 |
| 思考强度 | 已交付 | 七档 `config.set key=reasoning scope=session` |
| 思考过程半显式 | 已交付 | 流式时显示最后一行 + 光标，结束后收成一行摘要，可展开全文 |
| 实时指标 | 已交付 | 上下文条 + 占用百分比、缓存命中率、输出速度、花费，随 `session.usage` 更新 |
| 中途 steer | 未开工 | `session.steer` 已有契约，未接 UI；running 时输入框仍禁用 |
| 会话删除 / 重命名 | 未开工 | `session.delete` / `session.title` 已有契约 |

## 架构

```
src/
├── core/          纯逻辑，无 DOM 无 socket，全部可单测
│   ├── types.ts       时间线模型（气泡 / 工具卡 / 提示 / 用量）
│   ├── reduce.ts      事件 → 时间线
│   ├── history.ts     历史行 → 时间线
│   ├── sessions.ts    多会话 store：tab、事件分流、历史替换
│   ├── slash.ts       斜杠 token / 补全 / dispatch 解析、推理档位
│   ├── attachments.ts 附件队列、@ token、体积与类型筛查
│   ├── metrics.ts     用量指标格式化与压力分级
│   └── dedupe.ts      跨 socket 重复投递闸门
├── gateway/       传输
│   ├── channel.ts     JSON-RPC 通道（请求 / 事件 / 服务端请求）
│   └── client.ts      socket 生命周期 + 重连退避 + ensureOpen
├── app/
│   └── controller.ts  会话控制：RPC 网关、路由、模型切换、附件、重同步
├── ui/            渲染
│   ├── ChatPage.ts    页面骨架与状态接线
│   ├── SessionSidebar.ts  会话列表（打开中 / 历史）
│   ├── Composer.ts    输入框、斜杠菜单、附件托盘、指标条
│   ├── ModelPicker.ts 模型与思考强度选择器
│   ├── Bubble.ts      消息块与可展开的思考过程
│   ├── format.ts      纯展示逻辑（工具名、截断、耗时）
│   └── style.css      变量驱动的少量样式
└── index.ts       注册入口
```

`core/` 和 `ui/format.ts` 里不许出现 `window` / `document` / `WebSocket`，这是能对着一堆边界情况写单测的前提。传输层通过构造参数注入 socket 工厂，测试用假 socket 驱动整条链路。

契约文档：`docs/01-protocol-contract.md`。协议是 Hermes 的内部实现，没有 OpenAPI 描述，所以那份文档记了核对基线（hermes-agent `0.22.2`，commit `d923a5eb487`）和一份升级后重跑的核对清单。

## 命令

| 想做什么 | 命令 |
|---|---|
| 单测 | `npm test` |
| 类型检查 | `npm run typecheck` |
| 构建 | `npm run build` |
| 构建 + 安装 | `npm run install-plugin` |
| 对着真仪表盘验收 | `node scripts/verify.mjs`（需要仪表盘在 9119 上跑着） |
| 看某次会话的 DOM | `node scripts/probe-turn.mjs` |

## 验证

- `npm test` — 254 项，覆盖归约、历史投影、多会话分流、斜杠解析与补全、附件队列、用量指标、去重闸门、JSON-RPC 通道（含心跳与服务端请求应答）、控制器（含多开、模型切换、附件、重连与重同步），以及一条**源码级守卫**（钩子不得出现在提前 return 之后——React #310 就是它漏掉的）。
- `node scripts/verify.mjs` — 24 项，对**真实仪表盘**跑：插件接管 `/chat`、内置 xterm 消失、主题变量生效、后端能力探针通过、无人工操作下输入框自行就绪、`/` 唤起并按字过滤命令、接受补全后 token 被替换、侧栏两段渲染、新建 tab、`+` 与文件输入、模型选择器列出真实 provider、思考强度档位、跑完一轮后指标条出现、控制台无报错。跑的是真模型真往返。

验收截图由该脚本产出，落在 `.cache/shots/`。

## 兼容性

| 项 | 实测值 |
|---|---|
| hermes-agent | 0.22.2（commit `d923a5eb487`） |
| 后端声明的方法 / 事件 | 257 / 77 |
| 插件 SDK 契约版本 | 1.1.0 |
| 需要的 RPC | `session.create` `session.resume` `session.list` `session.history` `prompt.submit` `session.interrupt` |
| 需要的事件 | `message.start` `message.delta` `message.interim` `message.complete` `reasoning.delta` `tool.start` `tool.complete` `status.update` `session.usage` `session.title` `session.info` `notice` `error` |
| 需要的服务端请求 | `approval` `clarify` |
| Node | 24.21.0 |
| 打包产物 | 112.5 KiB（不含 React） |

插件的后端路由 `/api/plugins/hermes-bubbles/capabilities` 会在页面渲染前问一次后端「这些方法/事件还在不在」，缺任何一条就报出缺的名字。协议漂移时它会先坏在明处，而不是渲染出一个空对话。

## 已知限制

- **用户插件要手动登记。** 仪表盘只加载 `plugins.enabled` 里的用户插件，装完不登记就只是被发现、不加载。内置插件没这个门槛。
- **服务端请求只接了 approval 和 clarify。** `vault.unlock_prompt`、`sudo`、`secret` 这些一律回 `-32601`，后端会快速失败而不是等满超时——这是有意的，但意味着这些流程在这个页面上走不通。
- **没有会话列表。** 打开页面就是新会话；历史恢复指的是同一会话刷新后不丢，不是能在会话之间切。
- **`useSyncExternalStore` 不在 SDK 的 hooks 白名单里**，得从 `SDK.React` 上取。SDK 的 `hooks` 是个精选子集，不是 React 全量。
- **协议无版本保证。** 这套 JSON-RPC 是内部实现，`hermes update` 后可能漂移；`capabilities` 路由是第一道闸，`docs/01-protocol-contract.md` 的核对清单是第二道。
- 工具结果里只有 `write_file` / `patch` / `skill_manage` 三个带原始 `content`（后端投影如此），其余工具的历史行只有一行摘要，展开也看不到完整输出。

## 许可

MIT
