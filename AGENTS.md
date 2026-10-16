# AGENTS.md — hermes-bubbles 项目铁律

Hermes 网页仪表盘（`hermes dashboard`）的气泡聊天页插件。改这个仓库之前先读完本文件。

## 这个仓库是什么

一个 **dashboard UI 插件**，把仪表盘内置的 `/chat`（xterm.js 接 `/api/pty`，跑真 TUI，所以是终端长相）替换成原生气泡消息流。

- **数据来源是 `/api/ws`**：仪表盘自带的 `tui_gateway` JSON-RPC WebSocket（桌面端走的就是这条）。不是 PTY，不是 `hermes chat -q` 子进程。
- **产物是 drop-in 插件目录**：`dist/index.js`（IIFE）+ `manifest.json` + 可选 `plugin_api.py`，装到 `%LOCALAPPDATA%\hermes\plugins\hermes-bubbles\dashboard\`。装完不用重启仪表盘，`/api/dashboard/plugins/rescan` 即可。
- **不 fork 仪表盘源码**。插件只通过 `window.__HERMES_PLUGIN_SDK__` 拿 React / UI 组件 / `fetchJSON` / `buildWsUrl`。

## 运行

| 想做什么 | 命令 |
|---|---|
| 装依赖 | `npm install --include=dev` |
| 单测（纯逻辑，不起浏览器） | `npm test` |
| 类型检查 | `npm run typecheck` |
| 构建 + 装进插件目录 | `npm run install-plugin` |
| 起仪表盘看效果 | `hermes dashboard --no-open` → http://127.0.0.1:9119/chat |

构建产物目录由 `scripts/install-plugin.mjs` 决定，`HERMES_HOME` 优先，其次 `%LOCALAPPDATA%\hermes`。

## 架构铁律

1. **协议层纯函数、无 DOM、可单测。** `src/core/` 里不许出现 `window`、`document`、`WebSocket`、`fetch`。它们只做：事件 → 时间线归约、历史 → 时间线投影、去重。所有 `src/core/` 的行为必须有一条 vitest 覆盖。
2. **`src/ui/` 不许直接 `new WebSocket`。** 一律经 `src/gateway/`。传输可替换（测试用假 transport），这是重连逻辑能被测的前提。
3. **不引 React 依赖。** `react` / `react-dom` 只在 devDependencies 里出类型，运行时一律取 `SDK.React`。打包产物里出现 react 的代码即视为构建配置出错。
4. **主题跟着仪表盘走。** 颜色一律用 `--color-*` / `--radius` / `--spacing-mul` 这些 CSS 变量，不许写死十六进制色值（`DESIGN.md` 里的语义色除外，且必须在 `DESIGN.md` 登记）。换主题必须整体跟着变。
5. **事件按 `session_id` 过滤。** 一个 socket 会收到所有会话的事件；只有当前会话的才进时间线。
6. **同一事件可能重复到达。** 后端把每个已连接的 socket 都加进会话的 fan-out，重连窗口内会重复投递。`message.delta` 重复会让气泡里出现两份同样的字。去重靠 `(replay_epoch, session_id, seq)`。
7. **服务端请求（approval / clarify）必须应答，答不了就立刻回 `-32601`。** 不回的后端会当这个客户端是旧版本，一直等到自己的超时（clarify 是 3600s），等于把 agent 卡死。快速失败比沉默好。
8. **发 RPC 前先 `await ensureOpen()`，不要 `connect()` 之后直接发。** `connect()` 是 fire-and-forget，URL provider 是异步的，紧跟其后的请求会在 socket 存在之前发出去并失败——而 socket 几毫秒后就绪。`Controller.start()` 已经这么做了。
9. **`gateway.ready` 必须走归约，不能提前 return。** 它是 `meta.connected` 变 true 的唯一来源，跳过它输入框会一直禁用。
10. **契约文档先行。** 用到哪个 RPC / 事件，先写进 `docs/01-protocol-contract.md` 再写代码。协议是 Hermes 的内部实现，升级会漂移——契约文档要写清「从哪个版本核对过」。

## 禁区

- 不许改 `%LOCALAPPDATA%\hermes\hermes-agent\` 下的任何文件。要提需求就去上游开 issue。
- 不许在 `dist/` 里手改代码；`dist/` 是构建产物，改源文件重跑构建。
- 不许把 `window.__HERMES_SESSION_TOKEN__` 读出来自己拼 URL。用 `SDK.buildWsUrl` / `SDK.fetchJSON`。
- `.bat` 必须纯 ASCII（cmd 按 GBK 解析，中文注释会破坏批处理）。

## 改完必须跑

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm run install-plugin
```

动了 UI 之后，还要在真实仪表盘里点一遍：发一条消息、看流式气泡、展开一个工具卡片、刷新页面看历史恢复。

`node scripts/verify.mjs` 把这套点检自动化了（15 项，跑真模型真往返），需要仪表盘在 9119 上跑着。

## Agent skills

### Issue tracker

GitHub Issues，仓库 `NaimioChan/hermes-bubbles`，走 `gh` CLI。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个规范状态角色各对应同名标签（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：根 `GLOSSARY.md` + `docs/adr/`。见 `docs/agents/domain.md`。
