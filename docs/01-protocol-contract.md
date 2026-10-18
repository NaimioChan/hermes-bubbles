# 01 · 协议契约（tui_gateway JSON-RPC over `/api/ws`）

本文件是插件与 Hermes 后端之间的唯一契约来源。改代码前先改这里。

**核对基线**：hermes-agent `0.22.2`（本机 `%LOCALAPPDATA%\hermes\hermes-agent`，commit `d923a5eb487`）。
核对方式：读 `tui_gateway/contracts/*.py`（后端自己声明的契约表）+ `tui_gateway/ws.py`（传输）+ `apps/shared/src/gateway-contract.generated.ts`（自动生成的 TS 镜像）。

> 这套协议**没有 OpenAPI 描述**，是内部实现。`hermes update` 之后可能漂移。核对基线版本号变了就要重跑一遍本文档的核对清单（见文末）。

## 1. 端点与鉴权

| 项 | 值 |
|---|---|
| URL | `GET /api/ws`（WebSocket 升级） |
| 鉴权（loopback 模式） | query `?token=<session token>`，token 由页面注入到 `window.__HERMES_SESSION_TOKEN__` |
| 鉴权（gated / OAuth 模式） | query `?ticket=<一次性票据>`，或子协议 `hermes-gateway-v1, hermes-gateway-ticket.<ticket>` |
| 取 URL 的方式 | **必须**用 `SDK.buildWsUrl("/api/ws")`，它按当前模式选 token / ticket |

服务端在 accept 前的门（`hermes_cli/web_routers/chat_ws.py::_close_unless_sidecar_allowed`）：

- `4403` — 嵌入式 chat 被禁用，或 Host/Origin/客户端 IP 不在仪表盘边界内
- `4401` — 凭据无效

连接建立后服务端**先**发 `gateway.ready`，客户端收到后应发一次 `client.capabilities`。

## 2. 帧格式

三条线路都是 JSON-RPC 2.0，一行一个 JSON 对象（`json.dumps(..., ensure_ascii=False)`，无尾随换行要求，服务端按行读）。

### 2.1 客户端 → 服务端：请求

```json
{"jsonrpc":"2.0","id":1,"method":"session.create","params":{"source":"desktop"}}
```

`id` 是数字。服务端回：

```json
{"jsonrpc":"2.0","id":1,"result":{...}}
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"..."}}
```

### 2.2 服务端 → 客户端：事件

```json
{"jsonrpc":"2.0","method":"event","params":{
  "type":"message.delta","session_id":"<runtime id>","seq":42,
  "payload":{"text":"你好"}
}}
```

- `session_id` — **runtime id**，不是 stored id。会话级事件带；全局广播（`sessions.changed`、`pet.changed` 等）不带。
- `seq` — 每会话单调计数，由 `tui_gateway/event_replay.py::_stamp_event` 打。**同一条事件会投递给该会话的每一个已连接 socket**（`session_transports.py` 的 fan-out），所以一个客户端持两条 socket 时会收到两份。去重键是 `(replay_epoch, session_id, seq)`。
- `replay_epoch` — 后端进程启动时生成的 uuid4，在 `gateway.ready` 里给客户端。后端重启后 seq 从 1 重新计数，靠 epoch 变化识别。

### 2.3 服务端 → 客户端：请求（要你回答）

```json
{"jsonrpc":"2.0","id":"req-abc","method":"approval","params":{...}}
```

**注意 `id` 是字符串**——这是与客户端请求（数字 id）的判别依据。客户端必须回：

```json
{"jsonrpc":"2.0","id":"req-abc","result":{"choice":"once"}}
```

不回 = 后端当这个客户端是旧版本，直接 fail 掉该请求（审批会被拒、clarify 会被跳过），agent 卡住。

## 3. 握手

### 3.1 `gateway.ready`（服务端主动推，第一帧）

```json
{"type":"gateway.ready","payload":{
  "skin":{...}, "change_events":true, "heartbeat":true, "replay_epoch":"<uuid4>"
}}
```

- `heartbeat: true` → 客户端可以发 `gateway.ping`（服务端在 `tui_gateway/ws.py` 的读循环里直接回 `{"ok":true}`，不走 dispatch）。
- `replay_epoch` → 存下来，参与去重键。
- `skin` → 后端的 CLI skin（终端配色）。**仪表盘 Web UI 不用它**，Web UI 的配色来自 dashboard theme。

### 3.2 `client.capabilities`（客户端发）

```json
{"method":"client.capabilities","params":{"server_requests":true}}
```

回 `{"server_requests":[...],"declines_not_shown":bool}`。**必须发**，否则后端不认为你支持服务端请求。

### 3.3 `gateway.ping`

```json
{"jsonrpc":"2.0","id":"heartbeat-1","method":"gateway.ping","params":{}}
```

回 `{"jsonrpc":"2.0","result":{"ok":true},"id":"heartbeat-1"}`。心跳失效判定用「上一次 ping 发出后是否收到过任何入站帧」，不是单纯超时。

## 4. 本插件用到的 RPC

### `session.create`

```json
{"source":"desktop","cwd":"<可选>","cwd_explicit":"<可选>","model":"<可选>","provider":"<可选>"}
```

返回 `SessionCreateResult`：`session_id`（runtime）、`stored_session_id`、`message_count`、`messages`（`TranscriptMessage[]`）、`info`（`SessionLiveInfo`）。

`source` 只影响会话列表的来源标记。用 `"desktop"` 让它在 `/sessions` 里按正常人类会话显示（`_LISTING_DENY_SOURCES` 会隐藏 subagent / kanban 来源）。

**`cwd` 与 `cwd_explicit`（工作区，0.22.2 / `d923a5eb487` 核对）。** 后端在 `tui_gateway/session_workdir.py::_resolve_create_cwd` 决定新会话的工作目录：

- `cwd` 能 `isdir` 通过 → 直接采用，会话行写上这个路径；
- `cwd` 通不过本机探测（dashboard 连的是远程 / 容器化后端，路径在网关那台机器上不存在）→ 只有 `cwd_explicit: true` 且 `source == "desktop"` 才采用原样路径。客户端说「这是用户亲手选的」，比网关的 `isdir` 更权威；
- 两个都不给 → 落到 `terminal.cwd` / 网关启动目录，且**不写会话行的 cwd**（「没有工作区」是一个真实状态，不是空字符串）。

所以插件选了工作区时固定发 `{cwd, cwd_explicit: true}`；没选时两个字段都不发，而不是发空串。

`info.cwd` 在 create / resume 的返回里回显会话自己的工作目录（没有则为空），插件把它放进 `SessionMeta.cwd` 只用于展示——已存在的会话不能被改目录，改的只是「下一个新对话」。

### `GET /api/chat/workspaces`（REST，非 RPC）

```json
{"projects":[{"id","name","archived","primary_path","folders":[{"path","label","is_primary"}]}],
 "repos":[{"root","label","last_active"}],"default_cwd":"…","home":"…","scan_enabled":true}
```

`?scan=1` 先让宿主重扫 `desktop.repo_scan_roots` 再返回（`hermes_cli/web_routers/chat_workspaces.py`）。这就是仪表盘自带 `/chat` 工作区选择器用的同一个端点，所以两边列出的项目/仓库完全一致。需要 dashboard 的会话 token —— 走 `SDK.fetchJSON`，不能用裸 `fetch`。`projects.db` 是 per-profile 的，profile 由服务端按请求作用域解析。

### `session.list`

参数 `{limit, include_hidden, title}` → `{sessions: SessionListRow[]}`。

`SessionListRow`: `id`（stored id）、`resolved_id`、`title`、`preview`、`started_at`（unix 秒）、`message_count`、`source`。

### `projects.tree`

参数 `{preview_limit, session_limit}`（`ProfileParams` 另加 `profile`）→ `{projects: ProjectTreeNode[], active_id, scoped_session_ids}`。

这是桌面端侧栏那棵树：`projects` 里每个节点是显式项目、自动发现的 git 仓库，或 `__no_project__`（`isNoProject: true`，label 由后端写成 `"Home"`——**界面上的「未归类」由客户端按 locale 覆盖**）。节点字段：

- `{id, label, path, color, icon, isAuto, isNoProject, sessionCount, lastActive, totalTokens, totalCostUsd}`
- `repos: [{id, label, path, sessionCount, groups: [{id, label, path, isMain, isKanban, isGit, sessions}]}]` —— `hydrate=false` 时 `sessions` 为空数组
- `previewSessions: ProjectTreeSession[]` —— 就是 `_project_tree_row` 的字段（`id` / `title` / `preview` / `started_at` / `last_active` / `message_count` / `cwd` / `git_branch` / `git_repo_root` / `model` / 用量）+ `profile`
- `sessionIds: string[]`

`preview_limit` 默认 3、`session_limit` 默认 2000。这个调用在后端要**对每个不同的会话 cwd 做一次 git probe**（Windows 上首次可能是秒级），所以插件只在打开「项目」页签时拉一次，且 `preview_limit: 2`；`hydrate` 在 `projects.tree` 里恒为 `false`。

### `projects.project_sessions`

参数 `{project_id, session_limit}` → `{project: ProjectTreeNode | null}`，同上的树但**只含一个项目且 hydration 打开**（该项目的每条 lane 都带 `sessions`）。`session_limit` 默认 5000，插件用 300。`project_id` 为空回 `5063`；找不到该 id 时 `project` 是 `null`。

分组的客户端口径（`core/projects.ts`）：只做两层，把 lane 拍平后按 `id` 去重、按 `last_active` 倒序；Home 桶永远排最后；「在此新建对话」用的路径是 `project.path` → 第一个 `repos[].path` → 空（Home 桶没有路径，按钮不出）。

### `session.history`

参数 `{session_id}`（stored id 或 runtime id）→ `{count, messages: TranscriptMessage[]}`。

### `session.resume`

参数 `{session_id, omit_messages?, inline_images?}` → `LiveSessionSnapshot`（含 `messages`、`info`、`running`、`pending_approval`、`open_requests`、`todo_state`）。

`todo_state` = `{todos:[…], revision}`，与 `todo.updated` 同形，只在后端有持久化快照时出现
（`tool_progress._attach_todo_state`）。没这个键**不代表**清单为空，插件不能拿它清空面板。

### `prompt.submit`

参数 `{session_id, text, display_kind?, queued?}` → `PromptSubmitResult`：`{status: "streaming"|"queued"|"steered"|"redirected", user_row_id?}`。

**这是 fire-and-forget**：`status` 只表示后端已受理，回答内容靠事件流。超时不要设短（桌面端用 1800s）。

### `session.interrupt`

参数 `{session_id}` → `{status:"interrupted"|"not_interrupted"}`。停止按钮用。

### `approval.respond`（服务端请求的 RPC 版，备用）

参数 `{session_id, choice:"once"|"session"|"always"|"deny", request_id?, all?}` → `{resolved:int}`。

正常路径是回答服务端请求帧（§2.3），这条 RPC 只在丢帧后的补救路径上用。

### 斜杠命令

#### `complete.slash` — 补全

参数 `{text, session_id?, profile?}` → `{items: CompletionItem[], replace_from?: number}`。

`CompletionItem`: `{text, display, meta, kind?}`。`kind` 只在斜杠补全上出现，取值 `command` / `skill`。`replace_from` 是接受该项后从第几列开始替换。

`text` 传光标前的整段文本（含 `/`）。带 `session_id` 时技能补全绑定该会话的 profile 与工作区（项目级技能）。

#### `commands.catalog` — 全量目录

参数 `{}` → `CommandsCatalogResult`：

| 字段 | 说明 |
|---|---|
| `pairs` | `[name, description]` 列表 |
| `sub` | 子命令表 `{父命令: [子命令...]}` |
| `canon` | 别名 → 规范名 |
| `commands` | `{name: {argument_mode, desktop, desktop_subcommands}}` |
| `categories` | `[{name, pairs}]`，带分类的展示用 |
| `skills` | `{name: {usage, origin}}` |
| `skill_count` | 技能数量 |
| `warning` | 目录不可用时的说明 |

首屏渲染命令菜单用 `catalog`（一次拿全，本地过滤，输入 `/` 零延迟）；敲字后的精细排序用 `complete.slash`。

#### `command.dispatch` — 执行

参数 `{name, arg?, session_id?, profile?}` → `CommandDispatchResult`，`type` 决定客户端怎么处理：

| `type` | 带什么 | 客户端行为 |
|---|---|---|
| `exec` / `plugin` | `output` | 把 `output` 当系统提示显示 |
| `alias` | `target` | 用 `target` 当新命令再 dispatch 一次 |
| `send` | `message` / `display` / `notice` | 把 `message` 作为普通用户消息提交（渲染 `display`，不要渲染 `message`） |
| `prefill` | `message` / `notice` | 只填进输入框，不提交 |
| `skill` | `name` / `message` / `display` | 技能调用，同 `send` 但带技能名 |

### 模型与推理强度

#### `model.options` — 可选模型清单

参数 `{session_id?, explicit_only?, include_unconfigured?, refresh?}` → `{providers: ModelOptionProvider[], model, provider}`。

`ModelOptionProvider`: `{slug, name, models: string[], is_current, authenticated, key_env, warning, capabilities, pricing, ...}`。

#### `config.set` — 切换

**模型**：

```json
{"session_id":"<runtime id>","key":"model","value":"<model> --provider <provider>"}
```

- 加 ` --session` 后缀只影响本会话；不加则同时写 profile 默认。
- 返回 `confirm_required: true` 时表示这是个贵模型，要带 `confirm_expensive_model: true` 重发。
- 返回 `deferred: true` 表示切换被排队到下一轮开始；**不要**立刻重查模型名（会读回旧值盖掉用户的选择），等 `session.info` 事件来同步。

**推理强度**：

```json
{"session_id":"<runtime id>","key":"reasoning","value":"<level>","scope":"session"}
```

`level` 取值（`hermes_constants.py::VALID_REASONING_EFFORTS`）：
`minimal` `low` `medium` `high` `xhigh` `max` `ultra`。`none` 不是档位而是「关闭」的哨兵值。

### 附件

| RPC | 参数 | 用途 |
|---|---|---|
| `file.attach` | `{session_id, path?}` 或 `{session_id, data_url?, name?}` | 把非图片文件放进会话工作区，返回 `@file:` 引用 |
| `image.attach` | `{session_id, path}` | 主机上可见的图片路径 |
| `image.attach_bytes` | `{session_id, content_base64?/data?, filename?, ext?}` | base64 上传（浏览器只能走这条，拿不到主机路径） |
| `pdf.attach` | `{session_id, path?/content_base64?, first_page?, last_page?}` | PDF 逐页渲染成 PNG 排队 |
| `clipboard.paste` | `{session_id}` | 取主机剪贴板里的图片 |
| `image.detach` | `{session_id, path}` | 撤销一张排队中的图片 |
| `complete.path` | `{word?, cwd?, session_id?}` | 路径 / `@` 引用补全 |

`FileAttachResult`: `{attached, name, path, ref_path, ref_text, uploaded}` —— `ref_text` 是插进输入框的那段 `@file:` 文本。

**浏览器侧的重要限制**：`file.attach` 的 `path` 形式要求文件在网关可见的主机上。网页只能读用户通过 `<input type=file>` / 拖放给的文件内容，所以必须走 `data_url` / `content_base64` 那条。`file.attach` 走的是 JSON-RPC，桌面端按 384 MiB 上限放行单帧，网页侧要自己设更小的上限。

### 多会话

- `session.list` → `{sessions: SessionListRow[]}`，`SessionListRow` 见 §4。
- `session.resume {session_id}` / `session.activate {session_id}` → `LiveSessionSnapshot`。

`resume` 是「切过去」（重建或复用），`activate` 是「挂上但别关掉之前聚焦的那个」——多开会话用后者。

**一条 socket 上开多个会话是安全的**：后端把发过言的每个 socket 都加进对应会话的 fan-out（§2.2），事件带 `session_id`，按它分流即可。这也是去重闸门必须按会话分桶的原因。

### 用量与实时指标

`session.usage` → `Usage`（§7 同名字段）。桌面端状态栏读的就是这几个：

| 字段 | 展示 | 说明 |
|---|---|---|
| `context_used` / `context_max` | `12.3k/200k` | 上下文占用；`context_estimated` 为真时前面加 `~` |
| `context_percent` | `[▓▓░░] 6%` | 后端已 clamp 并取整 |
| `cache_hit_pct` | `87%` | 缓存命中率；没有缓存读取时后端不给这个字段 |
| `avg_tps` | `42 t/s` | 滚动输出速度；第一次调用完成前没有 |
| `total` / `input` / `output` | token 计数 | |
| `cost_usd` | 花费 | |

两个来源：`session.usage` 事件（`{usage}`，回合中途也会推）与 `message.complete` 的 `usage` 字段（权威终值）。另外 `session.info` 的 `info.usage` 在 resume 时带回。

**注意**：`session.usage` 是 `Usage` 的扩展（多一个 `credits_lines`），字段与事件里的一致。

## 5. 本插件用到的事件

事件名与 payload 见 `tui_gateway/contracts/events.py`。下表是插件实际消费的子集。

### 会话流

| 事件 | payload | 插件行为 |
|---|---|---|
| `message.start` | 无 | 开一个新助手气泡（streaming）。若上一轮还在 streaming，先封口 |
| `message.delta` | `{text, rendered?, verbose?}` | `text` 追加到当前 streaming 气泡；没有则惰性创建 |
| `message.interim` | `{text, already_streamed}` | 封口当前气泡（它已经通过 delta 可见了）。之后的新 delta 开新气泡 |
| `message.complete` | `{text, usage?, status?, error?, partial?, reasoning?, billing?, failure_reason?}` | 收尾：`status:"error"` 时标错误；`text` 只在**本轮**气泡没有正文时兜底（本轮气泡被尾部思考块封口了也算本轮，界碑是最后一条 user 行；不许越过它去并进上一轮的回答）；`streaming=false`；记 usage |
| `reasoning.delta` | `{text, verbose?}` | 追加到当前**思考块**（`ReasoningItem`，时间线尾部独立的 reasoning 条目；回复已开始时先封口那条回复） |
| `reasoning.available` | `{text, verbose?}` | 整块推理（非流式 provider），落在同一个思考块上。**0.22.2 实测有例外**：一轮结束时后端也把**最终回复原文**塞进这一帧（`_relay_thinking` 走的是 `reasoning.available`），紧跟其后的 `message.complete` 带同样的 `text`。所以文本与已上屏的回复相同时整帧忽略——否则回答会先变成一块「思考」，再被 `message.complete` 追加成第二个气泡 |
| `thinking.delta` | `{text}` | **不进时间线**。绝大多数是 spinner 重绘 |
| `session.usage` | `{usage}` | 更新上下文占用条 |
| `session.title` | `{session_id, title}` | 自动标题，更新会话列表 |
| `error` | `{message}` | 一条系统提示 |

### 工具

| 事件 | payload | 插件行为 |
|---|---|---|
| `tool.start` | `{tool_id, name, context?, args?, args_text?, preview?, labels?}` | 封口当前气泡与思考块，推一条 running 工具行 |
| `tool.complete` | `{tool_id, name, args?, duration_s?, result?, summary?, result_text?, inline_diff?, todos?, labels?}` | 按 `tool_id` 找到工具行，填结果，标 ok/error（`result.error` 只在其值为真时算失败） |
| `tool.generating` | `{name}` | 忽略（只是模型在吐参数） |
| `tool.output_risk` | `{tool_id, name, risk, findings, redacted}` | 在工具行下加一条风险提示 |
| `todo.updated` | `{todos:[{id, content, status, parent?}], revision}` | **整体替换**任务清单（`meta.todo`）。`revision` 单调，旧值丢弃 |

### 子代理（`delegate_task` 的每个子任务）

六个事件共用一套 payload（`tui_gateway/contracts/events.py:SubagentEventPayload`，生产者在
`tools/delegate_tool_progress.py::_ChildProgressRelay`）。**同一次 `delegate_task` 的所有子代理是一张卡**，
并发子代理只是这张卡上的多行。

| 事件 | 何时来 | 插件行为 |
|---|---|---|
| `subagent.spawn_requested` | `delegate_task` 接受了子目标，子代理还没启动 | 建卡片行，状态 `queued` |
| `subagent.start` | 子代理开始跑 | 该行 → `running` |
| `subagent.progress` | 子代理的工具名批处理（每 5 个一批） | 追加一行进度（保留最近 6 行） |
| `subagent.thinking` | 子代理的推理片段（隐藏推理时后端不给 `text`） | 只留尾部 240 字，一行预览 |
| `subagent.tool` | 子代理调了一个工具 | 更新 `lastTool`、`tool_count`，追加预览 |
| `subagent.complete` | 子代理结束（终态含 `completed/failed/error/timeout/interrupted`） | 该行 → 终态，填 `summary`、`duration_seconds`、`input/output_tokens`、`output_tail` |

公共字段：`goal` `task_count` `task_index`，以及可选的身份字段 `subagent_id` `parent_id`
`child_session_id` `delegation_id` `depth` `model` `toolsets`。

**聚合规则**（`src/core/reduce.ts::upsertSubagent`）：先按 `subagent_id` 找已有的行（每一帧都带它，
所以晚到的帧一定回到自己的行），再按 `delegation_id` 找同批次的卡，两者都没有的旧 emitter
则并进「最后一个还没收满、还没结束」的卡。全部子代理进入终态时把卡标为 `finishedAt`，
之后的新一批不会再并进去。

### 生命周期

| 事件 | payload | 插件行为 |
|---|---|---|
| `status.update` | `{kind, text}` | 底部状态行。`kind` 取值含 `status` / `lifecycle` / `compacting` / `goal` / `loop` / `heartbeat` / `process` |
| `notice` | `{...}` | 系统提示 |
| `session.info` | `SessionLiveInfo` | 刷新模型/运行状态 |
| `approval.cancelled` | `{...}` | 关掉审批卡 |
| `sessions.changed` | 无 session_id | 刷新会话列表（防抖） |

### 客户端本地（非后端）

这些是客户端自己造的，用来统一走同一条 handler 流：`gateway.reconnecting`、`gateway.protocol_error`、`gateway.closed`。

桌面通知不是协议的一部分：controller 把「回合结束」与「有审批/提问待回答」包成 `TurnNotice`
交给页面（`setNoticeSink`），页面按 `document.visibilityState` / `hasFocus` 与浏览器通知权限决定
是否调 `new Notification(...)`（`src/core/notify.ts` 定策略，`src/ui/notifier.ts` 碰 DOM）。
窗口在前台时不弹，这是唯一的行为约定。

## 6. 服务端请求（要插件回答）

| 方法 | params | 插件回答 |
|---|---|---|
| `approval` | `{session_id, request_id, command, description, choices:["once","session","always","deny"], allow_permanent?, allow_session?, smart_denied?, tool_name?}` | `{"choice":"once"}`，拒绝 `{"choice":"deny"}` |
| `clarify` | `{session_id, questions:[{qid,question,choices?,multi_select?}]}` | `{"answers":{"<qid>":"<choice>"}}`；取消 `{}` |
| 其他 | — | 回 `-32601`，让后端 fail fast 而不是等满超时 |

## 7. `TranscriptMessage` 投影

`session.history` / `session.create` / `session.resume` 返回的 `messages` 是后端 `_history_to_messages` 的显示投影：

| 字段 | 说明 |
|---|---|
| `role` | `user` / `assistant` / `tool` / `system` |
| `text` | 显示文本（tool 行没有） |
| `content` | tool 行的原始结果，**只有 `write_file` / `patch` / `skill_manage` 三个工具带** |
| `tool_call_id` | tool 行对应哪次调用 |
| `name` | tool 行的工具名 |
| `context` | tool 行的一行摘要（80 字符预览） |
| `args` | tool 行的完整参数 |
| `labels` | 桥接调用的结构化标签 |
| `row_id` | 持久化行号，rewind / 表情回应按它寻址 |
| `timestamp` | unix 秒 |
| `display_kind` | `hidden` 的要跳过；`skill_invocation` / `steer` 等有专门渲染 |
| `reasoning` | 助手行的推理侧车（`_HISTORY_ASSISTANT_DETAIL_KEYS`） |

`display_kind === "hidden"` 的行是面向模型的脚手架，**必须跳过**。

## 8. 已知陷阱

1. **重复投递**：见 §2.2。`message.delta` 重复会让气泡里出现两份字。
2. **`id` 类型判别**：数字 = 我们的请求的回应；字符串 = 服务端在问我们。
3. **runtime id ≠ stored id**。`session.create` 返回两个；`session.history` 两者都收；事件里带的是 runtime id。
4. **事件流是全局的**。一条 socket 收所有会话的事件，必须按 `session_id` 过滤。
5. **`message.complete` 的 `text` 可能为空**（已经流式发过了），不要用它覆盖已累积的文本，只做兜底。
6. **`message.interim` 之后还会有 delta**（模型在工具调用之间说话）。封口，不是结束。
7. **`status:"error"` 的 `message.complete`** 里 `partial:true` 表示 `text` 是要保留的已流式输出，错误在 `error` 字段。
8. **断线重连**：`gateway.ready` 的 `replay_epoch` 变了说明后端重启，本地缓存的 seq 水位必须清空，否则 `session.events.since` 会永远返回空。

## 核对清单（升级 hermes 后重跑）

```bash
cd "$LOCALAPPDATA/hermes/hermes-agent"
git log --oneline -1
# 1. 事件名还在不在
grep -oE '^event\("[a-z_.]+"' tui_gateway/contracts/events.py | sed 's/event("//;s/"//' | sort > /tmp/events-now.txt
# 2. 方法名还在不在
grep -oE 'method\("[a-z_.]+"' tui_gateway/contracts/*.py | sed 's/.*method("//;s/"//' | sort > /tmp/methods-now.txt
# 3. 服务端请求名
grep -oE 'server_request\("[a-z_.]+"' tui_gateway/contracts/*.py
# 4. 关键 payload 字段
grep -n "class StreamDeltaPayload" -A 8 tui_gateway/contracts/events.py
grep -n "class MessageCompletePayload" -A 22 tui_gateway/contracts/events.py
grep -n "class ToolStartPayload" -A 12 tui_gateway/contracts/events.py
grep -n "class ToolCompletePayload" -A 14 tui_gateway/contracts/events.py
grep -n "class TodoUpdatedPayload" -A 6 tui_gateway/contracts/events.py
grep -n "class SubagentEventPayload" -A 30 tui_gateway/contracts/events.py
grep -n "todo_state" tui_gateway/contracts/sessions.py
```

把结果与本文档 §4–§7 对照；有出入就改文档，再改代码。
