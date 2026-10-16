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
{"source":"desktop","cwd":"<可选>","model":"<可选>","provider":"<可选>"}
```

返回 `SessionCreateResult`：`session_id`（runtime）、`stored_session_id`、`message_count`、`messages`（`TranscriptMessage[]`）、`info`（`SessionLiveInfo`）。

`source` 只影响会话列表的来源标记。用 `"desktop"` 让它在 `/sessions` 里按正常人类会话显示（`_LISTING_DENY_SOURCES` 会隐藏 subagent / kanban 来源）。

### `session.list`

参数 `{limit, include_hidden, title}` → `{sessions: SessionListRow[]}`。

`SessionListRow`: `id`（stored id）、`resolved_id`、`title`、`preview`、`started_at`（unix 秒）、`message_count`、`source`。

### `session.history`

参数 `{session_id}`（stored id 或 runtime id）→ `{count, messages: TranscriptMessage[]}`。

### `session.resume`

参数 `{session_id, omit_messages?, inline_images?}` → `LiveSessionSnapshot`（含 `messages`、`info`、`running`、`pending_approval`、`open_requests`）。

### `prompt.submit`

参数 `{session_id, text, display_kind?, queued?}` → `PromptSubmitResult`：`{status: "streaming"|"queued"|"steered"|"redirected", user_row_id?}`。

**这是 fire-and-forget**：`status` 只表示后端已受理，回答内容靠事件流。超时不要设短（桌面端用 1800s）。

### `session.interrupt`

参数 `{session_id}` → `{status:"interrupted"|"not_interrupted"}`。停止按钮用。

### `approval.respond`（服务端请求的 RPC 版，备用）

参数 `{session_id, choice:"once"|"session"|"always"|"deny", request_id?, all?}` → `{resolved:int}`。

正常路径是回答服务端请求帧（§2.3），这条 RPC 只在丢帧后的补救路径上用。

## 5. 本插件用到的事件

事件名与 payload 见 `tui_gateway/contracts/events.py`。下表是插件实际消费的子集。

### 会话流

| 事件 | payload | 插件行为 |
|---|---|---|
| `message.start` | 无 | 开一个新助手气泡（streaming）。若上一轮还在 streaming，先封口 |
| `message.delta` | `{text, rendered?, verbose?}` | `text` 追加到当前 streaming 气泡；没有则惰性创建 |
| `message.interim` | `{text, already_streamed}` | 封口当前气泡（它已经通过 delta 可见了）。之后的新 delta 开新气泡 |
| `message.complete` | `{text, usage?, status?, error?, partial?, reasoning?, billing?, failure_reason?}` | 收尾：`status:"error"` 时标错误；`text` 非空且当前气泡为空时用它兜底；`streaming=false`；记 usage |
| `reasoning.delta` | `{text, verbose?}` | 追加到当前气泡的推理折叠区 |
| `reasoning.available` | `{text, verbose?}` | 整块推理（非流式 provider） |
| `thinking.delta` | `{text}` | **不进时间线**。绝大多数是 spinner 重绘 |
| `session.usage` | `{usage}` | 更新上下文占用条 |
| `session.title` | `{session_id, title}` | 自动标题，更新会话列表 |
| `error` | `{message}` | 一条系统提示 |

### 工具

| 事件 | payload | 插件行为 |
|---|---|---|
| `tool.start` | `{tool_id, name, context?, args?, args_text?, preview?, labels?}` | 推一张 running 工具卡 |
| `tool.complete` | `{tool_id, name, args?, duration_s?, result?, summary?, result_text?, inline_diff?, todos?, labels?}` | 按 `tool_id` 找到卡片，填结果，标 ok/error |
| `tool.generating` | `{name}` | 忽略（只是模型在吐参数） |
| `tool.output_risk` | `{tool_id, name, risk, findings, redacted}` | 在工具卡上加一条风险提示 |
| `todo.updated` | `{...}` | 忽略（v0.1 不做 todo 面板） |

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
```

把结果与本文档 §4–§7 对照；有出入就改文档，再改代码。
