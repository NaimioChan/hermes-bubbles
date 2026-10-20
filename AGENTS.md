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
8. **所有 RPC 走 `Controller.rpc()`（内部 `await ensureOpen()`），不要直接 `client.request()`。** `connect()` 是 fire-and-forget，URL provider 是异步的，紧跟其后的请求会在 socket 存在之前发出去并失败——而 socket 几毫秒后就绪。这条踩过两次：一次是开会话，一次是拉命令目录。需要绕过 `rpc()` 的只有已经显式 `await ensureSession()` 的那几个。
9. **`gateway.ready` 必须走归约，不能提前 return。** 它是 `meta.connected` 变 true 的唯一来源，跳过它输入框会一直禁用。
10. **组件里的钩子不能出现在提前 `return` 之后。** 钩子数量在两次渲染间变化会抛 React #310，整页白屏，而逻辑单测和 `tsc` 都看不见。`tests/hook-order.test.ts` 会在源码层面拦住它。
11. **新样式写进 `src/ui/style.css`，别用宿主可能没有的 Tailwind 类。** 插件跑在仪表盘**预编译**的 CSS 上，那份产物只含它自己用过的类；我们造的类若不在其中，**静默失效**（不报错、不警告，属性就是不生效）。踩过三个：`resize-none`、`max-h-[70vh]`、`text-[0.625rem]`。改完跑 `node scripts/audit-classes.mjs`，`tests/layout-classes.test.ts` 会在 CI 层拦住。
    **二进制资源不要手写进 CSS。** 目前只有运行指示的鲸鱼尾巴（`src/ui/whale-tail.png`，28×28 / 60 帧 APNG）：在 `style.css` 里写占位符 `__WHALE_TAIL__`，`build.mjs` 构建时替换成 data URI，找不到占位符就构建失败。它当 alpha 遮罩盖在 `currentColor` 上，所以颜色跟着主题走；静态 SVG 兜底写在 `Bubble.ts` 里给不支持 mask 或开了「减少动态效果」的场合。
12. **运行中也要允许发消息。** Hermes 的行为是中途输入 = 打断修正，后端 `prompt.submit` 的 busy 路径会决定排队 / 插入 / 改向并在 `status` 里回报。别再把输入框禁用掉。
13. **`src/core/markdown.ts` 是回复渲染的唯一来源。** 助手气泡的文本先解析成节点树（`src/core/markdown.ts`），再由 `src/ui/Markdown.ts` 用 `React.createElement` 渲染。**不许出现 `innerHTML` / `dangerouslySetInnerHTML`**——节点树让 React 负责转义，等于从根上删掉注入这一类问题，而不是在周边做净化。`tests/architecture.test.ts` 会拦。链接仍要过 `safeHref()`（React 不会替你拦 `javascript:` 协议）。
14. **引 CSS 变量必须确认宿主真的定义了它，否则给 fallback。** 宿主从不定义 `--color-foreground` 与 `--color-background`（0.22.2 实测：23 个 `--color-*`，两个都不在其中）。`var(--undefined)` **不报错**，整条声明在计算值阶段被丢掉，元素静默继承或透出背景——`--color-background` 曾让代码块与审批卡变成全透明。`tests/theme-vars.test.ts` 对照真实编译产物查，离线时回退白名单。
15. **文案不进测试断言。** 每个可点/可测的元素带一个 `data-hb="…"` 钩子（`tab` / `tab-new` / `history-toggle` / `history-panel` / `primary-action` / `stop-action` / `reasoning-toggle` / `message-actions` / `request-card` / `clarity-submit` / `workspace-button` / `workspace-panel` / `workspace-option` / `workspace-custom-open` / `workspace-custom` / `workspace-apply` / `workspace-rescan` / `git-badge` / `session-to-context` / `model-picker-open` / `model-confirm` / `model-confirm-accept` / `model-confirm-cancel`），`scripts/verify.mjs` 只按钩子找元素。踩过一次：整套验收按中文文案选择器写，页面默认语言改成英语后 9 条断言集体失效——那是测试脆，不是功能坏。新增可交互元素时补一个钩子。**后端要求确认的操作必须给出可点的确认控件**：`config.set` 回 `confirm_required` 时什么都没写，只把 `confirm_message` 当提示打印等于让用户无路可走（长上下文换模型的那次报障就是这么来的），要弹带接受/取消的对话框并在接受后带 `confirm_expensive_model: true` 重发。
16. **默认语言是英语，并跟随仪表盘。** `display.language` 默认就是 `en`；插件从 `localStorage['hermes-locale']` 与 `<html lang>` 两个信号读当前语言（无 RPC 可问），并用 `storage` + `MutationObserver` 跟着切。文案集中在 `src/core/i18n.ts`，任何组件里不许再写裸字符串。
17. **`@` 不是补全入口。** 后端 `complete.path` 期望的 `word` **包含**开头的 `@`（`is_context = word.startswith("@")`），早期客户端发的是去掉 `@` 的查询，所以永远匹配不上。功能已按用户要求移除，`@` 当普通字符；文件用 `+` 按钮走 `file.attach`。别再加回来，除非同时把 `@` 带上。
18. **时间线的时间戳一律是毫秒。** `at` / `completedAt` 是 `Date.now()` 的量级，格式化函数**不做**任何缩放；后端给的是秒，只在数据进入模型的那一处（`core/history.ts::timestampOf`）乘一次 1000。这条踩过：三处各按自己的假设缩放，结果 02:46 的任务显示成 19:32。
19. **改存量会话走 REST，不走 `session.*` 的写接口。** 重命名用 `PATCH /api/sessions/{id}`、删除用 `DELETE /api/sessions/{id}`（桌面端同款）。`session.title` 只认**活跃**会话，为拿 runtime id 而 resume 会让该行变成活跃，之后 `session.delete` 以 4023 拒绝；而 REST DELETE 对活跃会话会**返回 `{ok:true}` 却删不掉**（行会被重新持久化），所以删完必须回查 `session.list` 确认，不能信返回值。REST 与 `session.list` 是**不同的库**，校验要用 `session.list`。
20. **列表型选项用 `flex-direction: column`，不用 `flex-wrap`。** `flex-wrap` 只在容器边缘换行，几个短选项就挤在同一行；每行一个是要么全换、要么不换的语义，用列。行内再配 `width:100%` 与左对齐，否则看起来像一堆药丸。
21. **空状态不是死状态。** 关掉所有页签时 `activeTimeline` 是空的占位，它的 `meta.connected` 恒为 false——直接拿它当输入框可用性会让整个输入区变灰。判断能否输入看**socket**（`getConnection().state`），`send()` 在没有活动页签时先 `newSession()`。
22. **聊天 controller 是文档级单例，卸载时只能 `release()`，不能 `dispose()`。** 仪表盘切页会卸载插件页；早期在 cleanup 里 dispose，等于每次切走就把 socket 和所有打开的会话一起关掉。生命周期规则在 `src/app/persistent.ts`，`tests/persistent.test.ts` 守着（含 StrictMode 双挂载只能建一个实例）。
23. **页面卸载期间到达的服务端请求要暂存，不能回 `-32601`。** 后端会一直等到超时（clarify 是 3600s）。controller 现在把这类请求放进 `pendingCards`，重新挂载时由页面取走渲染。给 channel 的 fail-fast 是针对「永远不会答的客户端」，不是针对「刚好在两次挂载之间」。
24. **写进注入脚本的正则用 `String.raw`。** `verify.mjs` 的表达式是模板字符串，`\/` 与 `\s` 会被当成转义消费掉，`/\/config/` 会变成 `//config/`（行注释），整段代码被注释掉后报 `Unexpected token`。这个坑排查了三轮才定位，代价很高。
25. **契约文档先行。** 用到哪个 RPC / 事件，先写进 `docs/01-protocol-contract.md` 再写代码。协议是 Hermes 的内部实现，升级会漂移——契约文档要写清「从哪个版本核对过」。
26. **工作区是偏好，不是会话属性。** 选中的目录只在 `session.create` 那一刻变成会话的 `cwd`；已存在的会话改不了目录（后端在会话行上钉死了）。所以状态放在 `MultiState.workspace`（下一个新对话用），不要塞进 `SessionTab`；`send()` 在没有页签时也会 `newSession()`，这条路必须拿到同一个答案。列表走 REST `/api/chat/workspaces`（与仪表盘自带选择器同源），写入用 `{cwd, cwd_explicit: true}`——少了 `cwd_explicit`，网关探不到路径时会静默丢掉工作区。**chip 显示的是当前会话的 `meta.cwd`（实时），只有没有实时目录时才显示偏好**；偏好是**一次性**的：`ensureSession()` 用它建完会话就清空（也清 localStorage），所以没人指方向的新对话落默认目录。选中时若活动页签还没被说过话（`items` 空且不在跑），`pickWorkspace()` 会把它关掉重开一个——页面加载时已经建过会话，而它的 cwd 改不了，不重建就等于把用户选的目录吞掉（这条踩过，用户报的「选了自定义目录还是落默认目录」）。
27. **历史面板分「最近 / 项目」两段，项目视图只做两层。** 后端 `projects.tree` 给的是 project → repo → lane（分支/worktree/kanban）→ session，插件把 lane 拍平（`core/projects.ts`），因为这里不驱动 worktree，多一层只多一级缩进。`projects.tree` 会在宿主上对每个不同的 cwd 做 git probe，所以**只在打开项目页签时拉一次**（`preview_limit: 2`），展开单个项目才 `projects.project_sessions`。Home 桶（`isNoProject`）显示成按 locale 的「未归类」，且不给「新建对话」按钮——它没有路径。改名/删除只留在最近页签，项目视图不做第二套内联编辑器。

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

`node scripts/verify.mjs` 把这套点检自动化了（90 项，跑真模型真往返），需要仪表盘在 9119 上跑着。

**它必须收拾现场。** 验收跑在真网关上，每次都会真的建会话、真的改标题：改名那条断言先记下编进输入框的原标题、断完用 REST PATCH 写回去（历史第一行就是最新那个会话，很可能是用户自己的对话）；跑完用 `session.close` + `DELETE /api/sessions/{id}` 删掉本次新建的会话，判据是「空会话，或首条消息是本套件的探针文案」，绝不能按「列表差分」——页面加载时先冒出来的那个会话正是差分看不见的那个。以前没做这两件事，跑十几次之后历史里堆了 137 个「回复收到」和 15 个被改成 `verify-renamed-…` 的真对话。

另有 `node scripts/verify-clarify.mjs`：审批/选择题卡片只在**模型主动调用 clarify** 时才出现，所以它单独放，不进主验收（依赖模型行为的断言会随机失败）。卡片逻辑的单测在 `tests/requests.test.ts`。

还有 `node scripts/verify-confirm.mjs`：模型切换被网关拦下时的确认对话框。大上下文守卫只在会话已测上下文 ≥ `model.switch_context_confirm_tokens` 时触发，测试机上达不到，所以默认不改配置、只报「守卫没触发」；要断言整条链路就加 `--edit-config`，它先把 `config.yaml` 备份、临时把阈值设成 1，`finally` 里逐字节还原。跑完照同样规则删掉自己建的会话。

三套「静默失效」守卫值得单独说，因为它们的失败方式都不报错：`scripts/audit-classes.mjs` 查「用了但宿主 CSS 里没有的类」，`tests/theme-vars.test.ts` 查「引了但宿主没定义的 CSS 变量」，`tests/layout-classes.test.ts` 查「hb- 类没在自己样式表里定义」。加新样式或新颜色时先跑它们。

还有一类更隐蔽的：宿主用**标签名**（不是类名）定的全局规则会钻进我们的组件。宿主的 `code { display: inline; color: var(--background) }` 就把每个 `<pre>` 里的 `<code>` 变成了内联的浅底黑字小块——代码块因此既不铺满气泡又看不清。`hb-md-pre code` / `hb-output code` 显式覆盖它。写新组件时，如果元素是 `code` / `pre` / `a` / `table` 这类会被全局选中的标签，先假设宿主会插手。

## Agent skills

### Issue tracker

GitHub Issues，仓库 `NaimioChan/hermes-bubbles`，走 `gh` CLI。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个规范状态角色各对应同名标签（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：根 `GLOSSARY.md` + `docs/adr/`。见 `docs/agents/domain.md`。
