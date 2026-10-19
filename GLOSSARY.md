# 用词表

这个项目里的概念，以及它们**不是**什么。输出（issue 标题、测试名、文档、代码注释）里点到这些概念时用这里的说法。

## 时间线（timeline）

页面渲染的模型：`{ items, meta }`。**不是**后端的会话历史——历史行只是它的一种来源（`projectHistory`），另一种是实时事件（`reduceEvent`）。两者投影到同一个形状，所以刷新后的会话和正在跑的回合走同一套渲染。

## 气泡（bubble）

一条消息块。用户的和助手的都叫气泡，`kind` 区分。**不是** UI 库里的组件名，是数据模型里的 `UserItem` / `AssistantItem`。

## 思考块（thinking block）

一段推理（`ReasoningItem`），时间线上的独立条目。**不是**气泡：没有卡片底色、没有圆角、没有复制/重生成那一行，只有一条细轨和一行小字。一轮里可以有多段（想 → 调工具 → 再想），每段落在自己发生的位置。

## 工具行（tool row）

一次工具调用的展示块（`ToolItem`）。**不是**「工具」本身——一次调用对应一行，同一轮里同一个工具被调两次就是两行，靠 `toolId` 区分。**也不是**卡片：折叠态是一行 11px 的细轨文本，展开才出现参数与输出。

## 时间线条目（item）

`items` 数组里的一个元素，六种之一：`user` / `assistant` / `reasoning` / `tool` / `subagents` / `notice`。**不是**「消息」——思考块、工具行、子代理批次卡和提示行都不是消息。

## 服务端请求（server request）

后端发给客户端的、要客户端回答的 JSON-RPC 帧。**不是**客户端发的请求。判别依据：帧的 `id` 是字符串（客户端发的请求用数字 id）。

## 事件（event）

后端单向推送的通知帧（`method: "event"`）。**不是**服务端请求——事件不需要回答，服务端请求需要。

## runtime id / stored id

`session.create` 返回两个 id。**runtime id** 标识当前活着的会话，事件里的 `session_id` 是它；**stored id** 是 SQLite 里的持久化键。`session.history` 两个都收，事件只带 runtime id。混用会得到「查不到会话」。

## 归约（reduce）

把一个事件应用到一个时间线上，返回新时间线。**不是** Redux 意义上的 reducer 集合——这里是一个 `switch` 里的一串分支，每个分支处理一个事件类型。

## 去重闸门（dedupe gate）

跨 socket 的重复投递过滤器。**不是**幂等性保证——它只挡同一个 `(epoch, session, seq)` 在短窗口内的重复，不处理语义上的重复内容。

## 控制器（controller）

`ChatController`：持有 socket、时间线和会话状态，供 React 通过 `useSyncExternalStore` 消费。**不是** React 组件，也不 import React。

## 契约（contract）

`docs/01-protocol-contract.md` 描述的后端协议。**不是** 这个仓库定义的 API——它记录的是 Hermes 内部实现，升级会漂移，所以带核对基线。

## 工作区（workspace）

一个宿主机上的绝对路径，作为**下一个新对话**的起始目录，存在 `MultiState.workspace` 里，按 profile 记在 localStorage。**不是** 打开中会话的属性：会话的工作目录在 `session.create` 那一刻由后端钉在会话行上（`SessionMeta.cwd`），之后改不了。面板里同时出现两者时，那个只读的「本对话所在目录」说的是后者。

## 项目视图（project view）

历史面板的另一段（「最近 / 项目」页签的后者），按后端 `projects.tree` 分组，只做两层：项目 → 会话。**不是**桌面端侧栏的完整树——分支 / worktree / kanban 泳道在这里被拍平成一个列表，因为这个插件不驱动 worktree。没有工作区的会话进 `__no_project__` 桶，界面叫「未归类」（后端那个节点的 label 是英文 "Home"，由客户端按 locale 覆盖）。

## 上下文块（context block）

把一个**别的会话**的记录压成一段给模型的普通文本（`core/context.ts`）。**不是**附件：附件走 `file.attach` 之类的 RPC，有自己的卡片和 id；上下文块只是输入框里的文字，用户能看到、能改、能删，发送时和普通提问没有区别。**也不是**分支（`session.branch`）：分支会真的造出一个带有父会话历史的新会话，上下文块不改变任何会话的存在。
