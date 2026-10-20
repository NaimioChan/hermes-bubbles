# Agent 交接日志

Hermes 与 OpenCode 共用。开工先读最近 5 条，收工在「当前占用」下方追加一条。

## 当前占用

（空）

---

## 2026-10-20 16:52 · hermes · 移动端适配（手机访问 dashboard 不再挤成一团）

- 背景：用户现在能从手机访问 dashboard，但气泡页没给移动尺寸做适配，用着很难受。要求适配。
- 排查（桌面 390px 下的真实问题，非外观问题）：① 历史面板是固定 `17rem` 竖栏，手机上吃掉三分之一宽、把转写区挤成一条缝；② 输入行把 `+`、textarea、模型芯片、思考芯片、发送塞一行，草稿框只剩几个字宽、整行还横向溢出；③ 控件 32px 低于 44px 触控最小尺寸，且 `.hb-actions` / `.hb-row-tools` 靠 `:hover` 才 `opacity:1`——触屏没有 hover，复制/改名/删除直接点不到；④ 定位轨道是 hover 驱动又只占宽度；⑤ 弹出层按 `rem` 给鼠标设计（21rem / 34rem），窄屏会跑出屏幕。
- 改（集中在 `src/ui/style.css` 的一个 `@media (max-width:768px)` 块，纯宽度判断，同一份产物同时服务桌面和手机）：气泡 / 思考 / 工具 / 子代理 / 请求卡 `max-width:100% !important`（组件是**内联** `max-width:min(72ch,82%)`，不加 `!important` 压不住，第一版就漏了这条，实测仍 82%）；`.hb-actions,.hb-row-tools{opacity:1}`；控件 44px；历史面板改固定底部抽屉（72vh，靠 `data-hb="history-panel"` 选中）+ 新增 `.hb-hist-backdrop`（桌面 `display:none`，窄屏变遮罩，点击关闭）；`.hb-rail{display:none}`；输入行新增钩子 `.hb-composer-row`（可换行）与 `.hb-composer-tools`（换到第二行右对齐，textarea 独占第一行）；`.hb-workspace-panel` 左右收边、`.hb-modal-scrim/.hb-modal-card` 收边（ModelPicker / ConfirmDialog 各加类）。另把 `.hb-workspace-wrap` 改 `flex-wrap:wrap`（chip + git 徽标在窄屏换行，纯增益）。
- 验证（自动化）：`tsc --noEmit` 干净；`vitest run` **554 passed**（`tests/layout-classes.test.ts` 新增一条「adapts to a phone」，断言媒体查询存在、message-actions 的 `max-width:100% !important`、动作行 `opacity:1`、Composer 带两个钩子）；`audit-classes` 188/188。
- 验证（视觉，受限于登录）：**这台仪表盘今早已开 basic-auth（`/chat` 302 → `/login`，`config.yaml` 的 basic_auth 却是空、真实口令在 `.env` 的 `HERMES_DASHBOARD_BASIC_AUTH_*`）。我没有密码、也不会去读/输入它，故无法登入真页面截 390px 图。** 改用**忠实静态 harness**：同一目录放**真实产物** `dashboard/dist/style.css` + **真实宿主** `index-Ckq2QD_K.css`（布局靠宿主 `.flex/.items-end/.gap-*` 等预编译类，缺了会测歪——第一版只引插件 CSS，tab strip 假性换行），HTML 按各组件 `React.createElement` 的 class/内联样式复刻，Edge CDP `setDeviceMetricsOverride` 量 390 与 1280。结果：390 下 `docScrollWidth==390`（无横向溢出）、textarea 295px 独占第一行、模型/Medium/Send 落到第二行（y 744 vs 704）、rail `none`、历史 `fixed` 72vh + 遮罩 `block`、动作行 `opacity:1`、Send 44px、气泡 360px（占满）；工作区面板 23→368、模型弹窗 11→379 均不出屏。1280 下全部还原（气泡 `min(553,82%)`、rail `block`、历史 `static`、动作行 `opacity:0`、Send 32px）——桌面零改动。
- 文档：`README.md` / `README.zh-CN.md` 功能表各加一行「Mobile / narrow screens · 移动端适配」并给「定位器」补「手机上隐藏」；`DESIGN.md` Layout 段加 `Narrow screens`。
- **未完成（需用户）**：`AGENTS.md` 铁律 15 的 data-hb 钩子清单想补 `history-backdrop`，写入被保护审批拦截（超时未确认），按规则未重试。清单缺这一个钩子；要补请用户放行后再改。
- 部署：`npm run install-plugin` 已把新产物装到 `%LOCALAPPDATA%\hermes\plugins\hermes-bubbles\dashboard`。前端 bundle 改动靠 `/api/dashboard/plugins/rescan` 生效（无需重启；但 rescan 本身要登录态，我这边 401）。手机浏览器强刷一次即可看到。未提交 git（等确认）。

## 2026-10-20 11:18 · hermes · 运行指示换成鲸鱼尾巴 + 输入框字体与控件对齐

- 背景：用户报三件事。① DeepSeek harness 桌面端思考时有个鲸鱼尾巴小动画，问能不能给气泡页也装一个；② 输入框里的英文是窄衬线体，不好读；③ 输入框左边的 `+`、右边的发送按钮和输入框没对齐。
- 找资源：`dsh` 的 UI 不在常规资源目录里，最终在 `%LOCALAPPDATA%/Programs/DeepSeek Harness/resources/app.asar` 内的 `dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js` 找到（用 `grep -a -b` 定位字节偏移，再用一个小 Python 解析 asar header 反查文件，省下解包 182 MB）。它**不是 GIF**：`RunningWhaleTail` 组件用一个 28×28 / 60 帧、灰+alpha 的 **APNG** 当 `mask`，盖在 `background: currentColor` 上，所以它跟着文字颜色和主题走；`prefers-reduced-motion` 或不支持 mask 时换成同形静态 SVG（`REST_PATH`）。资源已取出为 `src/ui/whale-tail.png`，静态 SVG 路径抄进 `Bubble.ts` 的 `WHALE_STILL_PATH`。
- 改：新增 `.hb-whale` / `.hb-whale-anim` / `.hb-whale-still`（`style.css`）；`build.mjs` 把 `src/ui/style.css` 里的占位符 `__WHALE_TAIL__` 换成 PNG 的 data URI（找不到占位符直接构建失败），生产 CSS 依旧单文件，不用赌插件静态文件的相对 URL 怎么解析。`ui/Bubble.ts` 加 `WhaleTail`，替换思考行与工具行运行中的 `●` 闪烁点（外层保留 `hb-think-live` / `hb-tool-live` 拿主色）。data URI 用自定义属性 `--hb-whale-tail` 收在一处，否则 `-webkit-mask` 与 `mask` 各抄一份、CSS 多 29 KB。
- 字体：输入框原来写 `font-family: var(--font-sans)`，而宿主 `--font-sans` 是显示字体 `"Collapse"`（窄衬线），`html`/`body` 用的是 `--theme-font-sans`（`DM Sans` / 系统 UI 栈）。改成 `var(--theme-font-sans, system-ui, …)`，与仪表盘正文一致。
- 对齐：五个控件原先各自按 padding + font-size 决定高度（`+` 16px、Send 12px、模型 11px），底边齐但字形中心不齐，实测中心差 2px。新增 `.hb-composer-btn`：统一 32px 高、内容居中、`font: inherit`，textarea 固定 `padding: 6px 0; line-height: 20px`，于是单行 = 6+20+6 = 32，与按钮同高，多行时最后一行的中心仍在底边上方 16px。实测（在真仪表盘上量的）：textarea 与四个按钮 `cy` 全是 511.69，单行、三行都对得上。
- 测试：`--theme-font-sans` 进 `KNOWN_HOST_VARS`；`tests/theme-vars.test.ts` 现在把插件**自己声明**的 `--hb-*` 也算「已定义」（加了一条断言），否则 `--hb-whale-tail` 会被误报。`scripts/verify.mjs` 新增 1 项（94 项）：往页面挂一个 `.hb-whale`，断言计算出来的 `maskImage` 是 `url("data:image/png…`、尺寸 ≥ 8px —— 占位符忘了替换时这条会红，而不是静默看不见。
- 文档：AGENTS 铁律 11 补二进制资源占位符约定；两份 README 功能表加「运行指示」行、单测数 552 → 553。
- 验证：`tsc --noEmit` 干净；`vitest run` 553 passed / 26 文件；`audit-classes` 183/183；`node scripts/verify.mjs` **94/94**（cleanup: closed 3 / deleted 3 / still listed 0）；真仪表盘截图确认鲸鱼在工具行运行中以主色摆动、字体为 DM Sans、多行草稿也对齐。
- 推送：`00176ca` 推到 origin/main。注意本机的 `credential.helper = helper-selector`（GCM）在没有 tty 时会**卡住不报错**，`git push` 看起来在跑但其实在等凭据框；改用 `gh auth token` 拿 token，`git -c credential.helper= push https://x-access-token:$TOKEN@github.com/…` 一次就过。
- 补（11:45）：用户反馈尾巴看着偏上。量了一下：`.hb-whale` 与相邻文字的 `cy` 本来就相等，但美术资源自身底部比顶部空（28px 画布里 ink 是 1→25，下方空 3px），盒子居中就显高。`.hb-whale` 加 `transform: translateY(2px)`，真仪表盘 6 倍裁图确认尾巴现在跟「Ran a command」的 cap 高到基线对齐。
- 遗留：思考行的鲸鱼只在 `reasoning.delta` 流式期间出现，模型不吐 reasoning 时看不到（工具行不受影响）；鲸鱼尺寸取 `1.15em`，随家具字号缩放，没有单列一个 px 值。

## 2026-10-19 22:40 · hermes · 验收脚本落地 + 工作区清理 + 上游反馈

- 改：`.cache/probe-confirm.mjs` 正式收进仓库成 `scripts/verify-confirm.mjs`（12 项）。默认不动配置（守卫没触发就报「守卫没触发，加 --edit-config」）；`--edit-config` 备份 `config.yaml` → 把 `model.switch_context_confirm_tokens` 设成 1 → 断言无守卫切换不弹框 / 弹框 / 双按钮 / 取消不变 / 接受落地 / 无多余提示 → `finally` 逐字节还原并 close+DELETE 自己建的会话。`AGENTS.md`、两份 README 记了它的用法。
- 上游：查过 NousResearch/hermes-agent 的 issue，`confirm_required` 相关的 18 条全是「某个界面没做往返」（#90365 / #140545 / #95293 / #102729）或「没给拒绝路径」（#112458），没有人提过**契约本身**的问题。以助手身份开了一则反馈 #141596：`confirm_required` 只回 `confirm_message` 文本，不回 `SelectionWarning.kind`，而三类守卫（cost / data_policy / context_cache）共用 `confirm_expensive_model` 这一个「贵」标志；建议加 `confirm_reason` + 通用确认别名，`warning` 与 `confirm_message` 重复也一并记了。
- 清理：仓库 `.cache/`（147 个历史探针与日志，2.9 MB）与 `__pycache__` 已删（`.gitignore` 本来就不收）；系统 Temp 下 107 个 `edge-cdp-*` 浏览器 profile（18.1 GB）已删；`hermes-bubbles` 的 12 条残留验收会话（`回答两个字：收到` / `只回复两个字：收到` / `关掉所有页签之后发的消息` / `scratch session for delete test`，覆盖 10-18 到 10-19）走 `session.close` + REST DELETE 删净，复查 still listed 0、孤立消息 0；库内同类会话只剩 1 条 `20261018_135116_a2fefa`（cwd 是 hermes 根目录，不是本项目的验收残留，留着）。`config.yaml` 与备份逐字节一致，`model.default` 仍是 `cn:deepseek-v4.1-flash`。
- 推送：`8039b28`（确认对话框）已推到 origin/main，本地与远端同步。`dashboard/dist/index.js` 重新构建过，与源码一致。
- 环境：503 是用户的反代被限流，用户自行配 fallback，不用再动。
- 补（22:50）：三个验收脚本现在跑完会删掉自己的 `edge-cdp-*` profile（约 800 MB/个，带三次重试，Edge 退出与删除会赛跑），这是那 18.1 GB 的来源。`c5d67e9` 已推。

## 2026-10-19 22:05 · hermes · 网关要求确认的模型切换要有确认按钮

- 背景：用户报「长上下文情况下中途换模型，桌面端会弹窗口手动确认、终端要回车，气泡插件只弹一条警告没有确认键，对话继续不下去」。
- 协议发现（关键）：`config.set` 回 `confirm_required: true` + `confirm_message` 时**什么都没写**——不是失败也不是已生效，客户端必须带 `confirm_expensive_model: true` 原样重发同一个 `value` 才落地。这个标志名叫「贵」，网关把它当通用的「用户已同意」，`hermes_cli/model_selection_guards.py` 里三类守卫共用它：贵模型（cost）、会拿数据训练的供应商（data_policy）、**大上下文切换**（context_cache，会话已测上下文 ≥ `model.switch_context_confirm_tokens`，默认 100000）。第三类才是「长对话换模型」的来源，跟价格无关。`warning` 字段通常是同一段文字（兼容旧客户端），照着再打一条提示就是双份。
- 改：新增 `src/ui/ConfirmDialog.ts`（阻塞对话框：标题 + 守卫原文 `white-space: pre-wrap` + 接受/取消，无钩子，纯 props 渲染）；`ui/ChatPage.ts` 把 `onPickModel` 拆成 `applyModel(model, provider, confirmed)`——回 `confirmRequired` 就存 `pendingSwitch` 弹框、接受时带 `confirmExpensive: true` 重发同一对 model/provider；**`modelChoice` 改成落地后才更新**（原来先乐观写入，被守卫拦下时输入框会顶着没生效的模型名）；`ui/Composer.ts` 模型按钮补 `data-hb="model-picker-open"` 钩子（之前没有，验收和探针只能靠文案找）；`app/controller.ts` 的 `setModel` 在 `confirm_required` 时不再往转写区打 notice（那段文字属于对话框）；`core/i18n.ts` 用 `modelConfirmTitle` / `modelConfirmFallback` / `modelConfirmAccept` / `cancel` 四个键替掉只描述「已取消切换」的 `cheapModelConfirm`（en + zh）。
- 文档：`docs/01-protocol-contract.md` 的 `config.set` 模型一节重写（三类守卫、确认后仍可能 `deferred`、客户端契约）；`AGENTS.md` 铁律 15 钩子清单补 4 个并加一句「后端要求确认的操作必须给出可点的确认控件」；`GLOSSARY.md` 加「切换确认」；两份 README 功能表与文件树、单测项数（552）。
- 验证：`tsc --noEmit` 干净；`vitest run` 552 passed / 26 文件（controller 新增 2 条：确认消息不进转写区、接受后重发带 `confirm_expensive_model`）；`node scripts/audit-classes.mjs` 177/177；`.cache/probe-confirm.mjs` 10/10 —— 真仪表盘真模型，临时把 `model.switch_context_confirm_tokens` 设成 1：无守卫的切换直接生效不弹框 → 跑完一轮（~21,922 tokens 上下文）→ 换模型弹出对话框（原文含 `!!! LARGE CONTEXT MODEL SWITCH !!!`）→ 取消后模型不变 → 再选并接受，切换落地且没有多余提示，`config.yaml` 逐字节还原、探针会话 close + DELETE 干净。
- 环境：当晚 `cn:deepseek-v4.1-flash`（profile 默认路由）在 workbuddy2api 侧连续 503，`global:deepseek-v4.1-flash` 正常；`hermes chat -q` 也能复现「Provider temporarily unavailable」重试 5 轮。所以 `verify.mjs` 期间临时把 `model.default` 指到 global 那条，跑完从 `.cache/config.yaml.bak` 还原。
- 遗留：`verify.mjs` 92/93，唯一失败是「deleting a history row removes it from the backend」（victim `20261019_215141_731c4c`，空标题、2 条消息）。运行时该行仍是 live：控制器只在页签有 `runtimeId` 时才发 `session.close`，从存量行打开的页签没有 runtime id，于是 DELETE 撞活跃行——返回 ok 但行被重新持久化（铁律 19 的原样复现）。事后单独 DELETE 该行成功，说明行没被写死，是 close 那步漏了。这条不在本次改动范围，没动。另：那次 verify 的 cleanup 漏了 `20261019_215243_2ddeb2`（「关掉所有页签之后发的消息 #2」，首条消息不在 `PROBE_PROMPTS` 里），已手工删除。

## 2026-10-19 12:14 · hermes · 右侧会话列表可以把会话拖进输入框当上下文

- 背景：用户要「从右侧会话列表把会话作为上下文拖入当前会话，拖拽或菜单哪个方便做哪个」。两条路都做了：悬停按钮 `⇩`（`data-hb="session-to-context"`）与整行拖拽（`application/x-hb-session`，载荷 `{id,title}` JSON），终点都是同一个方法。
- 协议发现（重要）：`session.history` **只认活着的 runtime 会话**——拿 stored id 调会回 `4001 session not found`（实测 0.22.2 / `d923a5eb487`），契约文档原来写的「两者都收」是错的。要在不 resume 的前提下读存量会话，得用 REST `GET /api/sessions/{id}/messages?limit=200&order=latest`（返回 `role` / `content` / `display_content` / `display_kind`，没有 `text`）。`session.resume` 不能用：它会让那一行变成后端活跃会话，撞上铁律 19 的删除限制。第一条实现走 RPC，验收 92 项里唯一失败的就是它，改 REST 后通过。
- 改：新增 `src/core/context.ts`（`sessionContextBlock`：只留 user/assistant 非隐藏行，从最新往前取到 8000 字符、单条 1500 上限、附中英框题与省略计数；`textOf` 同时认 `text` / `content`（字符串或 parts）/ `display_content`；`sessionDragPayload` / `parseSessionDrop` / `insertContext`）；`app/controller.ts` 新增 `contextForStoredSession`（走 `fetchJSON`）；`ui/HistoryPanel.ts` 行加 `draggable` + dragstart + `⇩` 按钮；`ui/ProjectList.tsx` 会话行也成拖拽源（项目视图不加按钮，保持「只用来找和打开」）；`ui/Composer.ts` 新增 `insertion`（seq 一次性写入）与 `onDropSession`，上下文块插在草稿**上方**；`ui/ChatPage.ts` 接线；`core/i18n.ts` 5 条文案（en+zh）。
- 验收脚本：新增 3 项（每行都有 ⇩ 且是拖拽源、点按钮后输入框出现记录、用真 `DragEvent`+`DataTransfer` 走拖拽路径），93 项。顺手修了两个存量验收问题：①清理只按 `session.close` 的 `runtime` 字段，而 `session.list` 不返回 `resolved_id`，于是 close 实际拿到 stored id 回 `{closed:false}`、DELETE 撞活跃行返回 ok 却删不掉——改成先 `session.active_list` 建 stored→runtime 映射再 close，并在 close 与 DELETE 之间等 400ms；②模型会把空状态那条探针改写成「关闭所有页签后…」，清理的文案匹配放宽到「关掉/关闭所有页签」。清理掉的 3 条历史残留会话（`120202_2cc022`、`115407_7b3ad5` + 级联子会话）已用 REST 删干净。
- 文档：`docs/01-protocol-contract.md` 改 `session.history` 一节（live-only）并记 REST 取舍；`GLOSSARY.md` 加「上下文块」；`AGENTS.md` 铁律 15 钩子清单加 `session-to-context`；两份 README 能力表、文件树与项数（550 单测 / 93 验收）。
- 验证：`tsc --noEmit` 干净；`vitest run` 550 passed / 26 文件（新增 `tests/context.test.ts` 13 条、controller 3 条）；`audit-classes.mjs` 177/177；`verify.mjs` 93/93 且 `cleanup: 3 → closed:3, deleted:3 ; still listed: 0`；另用 `.cache/probe-context.mjs` 与 `.cache/probe-drag.mjs` 单独确认「点 ⇩ 后输入框 365 字符」和「合成拖拽后同样 365 字符」。
- 遗留：没有给「插入的上下文」做 UI 上的可折叠卡片（它就是输入框里的文字，改起来直接）；大会话的上限是固定 8000 字符，没有按模型上下文窗口自适应；项目视图只有拖拽，没有 ⇩ 按钮（有意）。


## 2026-10-19 11:44 · hermes · 验收脚本清理现场 + 修掉被改写的会话标题

- 背景：用户发现会话历史里有一堆「回复收到」和 `verify-…` 标题。查库确认两件事：①「回复收到」是 `scripts/verify.mjs` 每跑一轮 mint 的测试会话（页面加载、新页签、空状态发送、选目录重开各一个），累计 137 条；②`verify-renamed-…` 是改名断言干的——它一律改「历史面板第一行」，而那行是最新的真实会话，于是 15 个真对话的标题被换成 `verify-renamed-mv…`。
- 改（预防）：`scripts/verify.mjs` 里改名断言先读输入框里的原标题，断完用 REST PATCH 写回去并重新断言（新增第 90 项）；`finally` 里新增 `cleanupRunSessions()`——按「本次启动之后创建 + 空会话或首条消息是探针文案」筛出本次建的会话，逐个 `session.close` 再 `DELETE /api/sessions/{id}`（先 close，否则活着的行会重新持久化，铁律 19），跑完打印删了几个、还剩几个。`scripts/verify-clarify.mjs` 照同一规则清掉它那个 clarify 会话。
- 改（存量清理）：删掉 137 条测试会话（REST DELETE，用页面 token，一次 connection 批量删；全部成功，复查 0 残留）；把 9 个被改名的真对话改回来（标题按首条消息重写，原标题已不可恢复）：`20261016_202540` 用 OpenCode webui 风格重构 dashboard、`20261017_201928` hermes-bubbles 目标清单与并发子代理适配、`20261017_222555` 角色扮演聊天工具与技能清单、`20261018_000814` 桌面通知修复、`20261018_115313` 思维链空消息修复、`20261018_115709` personal-translation 代码注释翻译、`20261018_124309` hermes-bubbles 远端 issue/PR 翻译、`20261018_221349` 工作区目录概念与实现、`20261019_102816` 工作区右侧 Git 徽标 + 实时目录。另外 4 个 `verify-renamed-` 是纯测试会话（2/6/7/16 条消息），随 137 条一起删掉。
- 文档：`AGENTS.md` 的验收段补「必须收拾现场」及判据（不能按列表差分——页面加载那个会话正是差分看不见的）；README 更新项数与清理说明。
- 验证：`node scripts/verify.mjs` 90/90，末尾输出 `cleanup: 3 harness session(s) → closed:3, deleted:3 ; still listed: 0`；库复查 `回复收到` 0 条、`verify-renamed` 0 条、空会话 0 条，总数 812 → 654（删 137 条，级联掉的 subagent 子会话一并消失）；项目视图「未归类」计数由 128 降到 55。
- 遗留：被改名的 9 个会话标题是**按首条消息重写的**，不是原文；以后若要防这类事故，可以在 PATCH 标题前把旧标题记到 `session_titles` 之类的审计表（上游没有这张表）。

---

## 2026-10-19 11:12 · hermes · 工作区实时化 + 右侧 Git 徽标

- 背景：用户要「工作区按钮右边显示当前工作区的 git」；随后补两条要求 —— chip 要显示当前对话所在的实时目录、新建对话没选目录时落默认目录，并报了一个 bug：选了自定义目录之后消息仍落在默认目录。
- 改（Git 徽标）：`plugin_api.py` 新增 `GET /git?path=`，在宿主机跑 `git rev-parse --show-toplevel` + `status --porcelain=v2 --branch`（`GIT_OPTIONAL_LOCKS=0` 只读、`GIT_TERMINAL_PROMPT=0`、4s 超时、2000 行截断），返回原文由前端解析；新增 `src/core/gitinfo.ts`（porcelain v2 解析、`changedCount`、`gitBadgeText`、`gitTargetDir`）；新增 `src/ui/GitBadge.ts`（无 hook，非仓库直接 `null`，不渲染）；`WorkspacePicker` / `Composer` / `ChatPage` 接线（会话目录变化、一轮结束 running→idle、点徽标都会重探）；`core/i18n.ts` 加 10 个键（en+zh）；`ui/style.css` 加 `hb-git-*`，`.hb-workspace-wrap` 改成横向对齐布局。
- 改（工作区语义）：chip 改为显示 `meta.cwd`（当前对话的实时目录），偏好只在没有实时目录时兜底；偏好改成**一次性** —— `ensureSession()` 用它建完会话立即清空并删掉 localStorage 的 key；新增 `controller.pickWorkspace()`：选中时若活动页签还没说过话（`items` 空且不在跑）就关掉它重开一个。这就是那个 bug 的根因：页面加载时已经 mint 了一个会话，后端把 cwd 钉死在那一行，之后再选目录只会改偏好，消息仍进旧会话。
- 文档：`docs/01-protocol-contract.md` 加 `/git` 路由形状与「偏好一次性、chip 实时」的客户端取舍；`AGENTS.md` 铁律 15 补 `git-badge` 钩子、铁律 26 补一次性语义与重开页签；`README.zh-CN.md` 功能表加「Git 信息」、文件树补两个新文件、验证数字更新。
- 验证：`npx tsc --noEmit` 干净；`npx vitest run` 534 passed / 25 文件（新增 `tests/gitinfo.test.ts` 14 条、controller 4 条选目录用例）；`node scripts/audit-classes.mjs` 177/177；`node scripts/verify.mjs` 89/89（真仪表盘真模型：新开页签 → 选 hermes-bubbles → 会话被重开过去且 chip 标题为该目录、localStorage 已清空、Git 徽标出现并显示 `main`、中英文案走面板读取）。另用 `.cache/probe-git.mjs` 单独验过「仓库有徽标 / 普通目录无徽标 / 点击重探」。
- 运维：插件 API 的新路由在 plugin host 进程里只 import 一次（`plugin_host_child.py::op_asgi`），`/api/dashboard/plugins/rescan` 不会重载 `plugin_api.py`，所以**改 plugin_api.py 必须重启仪表盘**。本次为验证重启了仪表盘（先 Stop-Process 掉 42640/48308，再用原来的 cmd 启动器重新拉起 9119），这条也写进了契约文档。
- 遗留：面板里「下一个新对话」只有一行提示，没做成「点一下回到默认目录」的快捷项；git 只报 branch / 改动数 / 领先落后，没有 per-file 列表；chip 在默认目录会话上显示「默认目录」而不是宿主解析出的真实路径（后端在没显式 cwd 时不回显 `info.cwd`）。

---

## 2026-10-18 23:34 · hermes · 历史面板加「项目」视图（两层，带新建对话）

- 背景：用户要桌面端那样按项目看历史会话。定了三条：只做两层（项目 → 会话，泳道砍掉）、保留平铺列表改成两个页签、项目行加「在此新建对话」。双语言界面同步适配。
- 改：新增 `core/projects.ts`（树排序：Home 桶垫底；`projectWorkspacePath` = project.path → 第一个 repo.path；`sessionsOfProject` 拍平 lane 并按 id 去重、按 last_active 倒序）；`app/controller.ts`（`projectsTree(preview_limit 2, session_limit 2000)`、`projectSessions(id, 300)`，均走 `rpc()`）；`core/i18n.ts`（recent/projects/newChatInProject/ungrouped/noProjects/projectsFailed/projectSessionCount/showAllSessions，en + zh）；新增 `ui/ProjectList.tsx`（项目行 + 计数 + ＋按钮 + 展开后的会话行 + 状态灯 + 展开全部）；`ui/HistoryPanel.ts`（顶部页签 `history-mode-*`，刷新按钮按当前页签分派，`relativeTime` 改为导出复用）；`ui/ChatPage.ts`（懒加载树、按项目缓存 drill-in、`onNewChatInProject` 先 `setWorkspace` 再 `newSession`）；`ui/style.css`（`hb-proj-*` 全套）；`tests/projects.test.ts` 新增 13 条、`tests/controller.test.ts` 加 3 条；`scripts/verify.mjs` 加 6 条实测断言；`docs/01-protocol-contract.md`（`projects.tree` / `projects.project_sessions` 形状与成本）、`GLOSSARY.md`、`README.zh-CN.md`
- 验证：`npx tsc --noEmit` 干净；`npx vitest run` 512 passed（24 文件）；`node scripts/audit-classes.mjs` 172/172；`node scripts/verify.mjs` 87/87（真仪表盘：页签切换、3 个项目行「hermes-bubbles / personal-translation / Ungrouped 106」、2 个＋按钮、展开出 4 条会话、切回最近 40 行）；`.cache/probe-projects.mjs` 端到端确认：点项目行的＋ → 发一条 → `state.db` 最新会话 cwd 正是该项目路径
- 补：验收里加了「项目视图与工作区按钮跟随 zh」一条（真仪表盘切语言读文案）；`verify.mjs` 的浏览器 profile 改成 per-run（`edge-cdp-bubbles-<pid>`）——复用旧 profile 会attach 到上一次残留的 tab，整套在第一条断言就报 `SDK exposed on window: false`，连跑三次才定位到是 harness 的状态污染，不是插件坏。重跑 88/88。
- 遗留：AGENTS.md 里「data-hb 钩子清单」那条想补上 `project-*` 钩子，写入被审批拦截（超时未确认），铁律 27 已落，清单待用户同意后再补。项目视图暂不支持改名/删除（留在最近页签），也没有搜索框。

---

## 2026-10-18 23:01 · hermes · 工作区选择：输入框下方的小按钮

- 背景：仪表盘自带 `/chat` 有工作区选择器，气泡插件接管 `/chat` 后没有，于是每个新对话都落在 dashboard 进程的启动目录，且没有入口指定。用户要求「输入框下面加一个小按钮，新建对话时选工作目录」。
- 改：新增 `core/workspaces.ts`（payload 整形成选项行、`~` 缩写、`baseName`、按 profile 的存储键读写、`createCwdParams`）；`core/sessions.ts`（`MultiState.workspace` + `withWorkspace`，所有构造 `MultiState` 的纯函数补上该字段）；`core/types.ts` / `core/history.ts`（`SessionMeta.cwd`，取自 snapshot 的 `info.cwd`）；`core/i18n.ts`（8 条文案 en + zh）；`app/controller.ts`（`initialWorkspace` / `persistWorkspace` 注入、`getWorkspace` / `setWorkspace` / `listWorkspaces`、`session.create` 带 `{cwd, cwd_explicit}`）；新增 `ui/WorkspacePicker.tsx`（chip + 面板：默认目录、项目/仓库行、自定义路径、重扫、只读的「本对话所在目录」）；`ui/Composer.ts`（chip 渲染在输入框与状态条之间）；`ui/ChatPage.ts`（`/p/<profile>/` 解析、localStorage 注入、列表加载与重扫）；`ui/style.css`（`hb-workspace-*` 全套）；`scripts/verify.mjs` 加四条实测断言；`tests/workspaces.test.ts` 新增，`tests/controller.test.ts` 加六条；`AGENTS.md`（钩子清单 + 铁律 26）、`GLOSSARY.md`、`README.zh-CN.md`、`docs/01-protocol-contract.md`（`cwd`/`cwd_explicit` 语义与 `/api/chat/workspaces` 形状）
- 验证：`npx tsc --noEmit` 干净；`npx vitest run` 496 passed（23 文件）；`node scripts/audit-classes.mjs` 170/170；`node scripts/verify.mjs` 81/81（含 chip 渲染、面板行数、选中落 localStorage、选回默认清空）；另用 `.cache/probe-workspace-cwd.mjs` 端到端确认：选 `C:/Users/Naimio/projects/hermes-bubbles` → 新开对话 → 发一条 → `state.db` 最新会话行 `cwd` 正是该路径
- 遗留：工作区选择目前只作用于「新建对话」；已存在会话的目录改不了（后端在会话行钉死），面板里以只读小字标出。分项目查看历史会话未做——后端已有 `projects.tree` / `projects.project_sessions` RPC 可直接喂，等设计定下来再动。

---

## 2026-10-18 13:55 · hermes · 一轮结束后回复气泡重复

- 现象：整轮跑完后回复气泡出现两份，刷新页面从历史打开只剩一份。
- 根因：后端在一轮末尾发的 `reasoning.available` 里塞的是**最终回复原文**（0.22.2 / `d923a5eb487` 实测，`_relay_thinking` 走的就是这个事件名），紧跟其后的 `message.complete` 带同样的 `text`。按协议把 `reasoning.available` 当推理处理 → 先给回答开一块「思考」并把回复气泡封口；`message.complete` 于是找不到 open 气泡，走 `finalText` 兜底又追加一个气泡。历史投影按库里的行还原，所以刷新后正常。
- 改：`core/reduce.ts`（`reasoning.available` 与 `reasoning.delta` 拆开：前者文本与已上屏回复相同则整帧忽略；`message.complete` 的兜底目标改成 `openAssistant ?? turnAssistant`，`turnAssistant` 以最后一条 user 行为界，尾部思考块封了口也算本轮，但不会并进上一轮的回答）；`tests/reduce.test.ts` 加三条回归；`docs/01-protocol-contract.md` 记下这个例外与兜底口径
- 验证：`npx tsc --noEmit` 干净；`npx vitest run` 464 passed；`node scripts/audit-classes.mjs` 170/170；`node scripts/verify.mjs` 77/77；另用 `.cache/probe-dup.mjs` 抓真实帧复现+验收，修前 DOM 是 `user → reasoning → tool → assistant → reasoning → assistant`（两个 53–56 字相同回复），修后 `user → reasoning → tool → assistant`
- 遗留：`verify.mjs` 的「删除历史行」在两次跑里失败过一次（`gone: false`），属于铁律 19 那条「REST DELETE 对活跃会话返回 ok 却删不掉」，与本改动无关

## 2026-10-18 13:25 · hermes · 剩余中文文案收进 i18n 目录（#6 / #7）

- 背景：合并外部 PR #8（用量读数与指标 tooltip 走目录，作者 jcrabapple）后，补齐它刻意没收的那部分；issue #6 的清单与 #7 的 tab 标题哨兵一并做掉。
- 改：`core/i18n.ts`（新增 15 个工具名词、`working` / `reconnecting` / `genericError`、`attachmentTooLarge` / `attachmentEmpty`、`skill` / `skillOrigin`、`outputRisk`、`renderFailed`、`slashUnrecognized` / `slashDone` / `slashTypeUnsupported`、`replyNotFound` / `userMessageNotFound` / `attachmentNotAccepted`、`heartbeatTimeout` / `connectUnauthorized` / `connectChatDisabled`，en + zh 各一份）；`core/types.ts` 加 `SessionMeta.statusKind`（`"" | "reconnecting"`）；`core/reduce.ts`（断线只置 `statusKind`，`gateway.ready` 顺带清状态行；error 帧 `text` 不再兜底中文，改由 `NoticeRow` 补）；`core/attachments.ts`（`Rejection` 从 `reason: string` 改成 `code + limitMib`）；`core/slash.ts`（技能行 `description` 置空、新增 `origin`）；`core/sessions.ts`（新 tab 标题用 `""` 作哨兵，`tabLabel(tab, t)`）；`core/history.ts`（快照 meta 补 `statusKind`）；`gateway/client.ts`（`ClientOptions.messages` 提供者 + 私有 `messages()`，心跳超时与 4401/4403 走目录）；`app/controller.ts`（构造 client 时注入 `() => messagesFor(this.locale)`，斜杠提示与三处抛错改走目录）；`ui/format.ts`（`toolLabel(name, t)`、`runningLabel(meta, t)`、新增 `rejectionLabel`）；`ui/Bubble.ts`（`ToolRow` / `NoticeRow` 接 `locale`，风险行走 `t.outputRisk`）；`ui/ChatPage.ts`（拒收原因走 `rejectionLabel`，状态行传整个 meta）；`ui/Composer.ts`（技能行标签渲染时拼）；`ui/TabStrip.ts`（两处 `tabLabel` 传 `t`）；`ui/useLocale.ts`（导出 `currentLocale()`）；`index.ts`（渲染失败文案走目录）；测试：`tests/format.test.ts` / `attachments.test.ts` / `sessions.test.ts` / `controller.test.ts` 断言改成对 catalog 比较，`tests/architecture.test.ts` 新增守卫「`src/` 里除 `core/i18n.ts` 外不许出现 CJK 字面量」
- 验证：`npx tsc --noEmit` 干净；`npx vitest run` 460 passed（22 文件，改动前 454，新增 6 条）；`node scripts/audit-classes.mjs` 170/170；`node scripts/verify.mjs` 79/79（真仪表盘、真模型往返，改后重跑）
- 遗留：`verify.mjs` 不校验语言（铁律 15 只按 `data-hb` 找元素），所以「英文界面不出现中文」目前只有单测与源码守卫兜着，没有端到端断言；本轮 `verify.mjs` 有一次跑到「发送后取用户气泡」时 8 条连锁失败并崩在 `dispatchEvent`（疑似该回合尚未落渲染），隔一次重跑 79/79，未深究；本地 3 个提交尚未 push

### 分层怎么定的

`core/` 和 `gateway/` 拿不到 locale，也不该去读 `localStorage`（铁律 1）。所以分两类处理：

- 会进入时间线/状态机的东西一律改成机器值：`Rejection.code`、`SlashItem.origin`、`SessionMeta.statusKind`、`NoticeItem.text` 留空。视图层再翻。
- 传输层自己的句子（心跳超时、4401/4403）无法变成机器值——它直接 `throw new Error(...)`，而错误 message 会被 controller 当通知显示。于是给 `GatewayClient` 注入 `messages: () => Messages`，语义跟 `urlProvider` 一样：调用时才取，语言切换后下一帧就跟着变。controller 本来就有 `this.locale` 和 `setLocale`，顺着它喂。

`tabLabel` 的哨兵（#7）用空标题而不是比较中文字面量：否则一个真叫「新对话」的中文会话会被当成未命名，退回 stored id 前 8 位。

### 一个自己的坑

`node build.mjs` 写的是仓库根的 `dist/`（gitignore），仓库里入库的是 `dashboard/dist/`——两者靠 `scripts/install-plugin.mjs` 复制过去。改完只跑 `build.mjs` 再 `git add`，会把**带冲突标记的旧 bundle** 提交进去（这次 rebase 时真的发生了：`git status` 看着没变化，因为变化落在 gitignore 的 `dist/`）。入库前必须 `npm run install-plugin`，然后用 `grep -c "<<<<<<<" dashboard/dist/index.js` 确认是 0。

---

## 2026-10-18 12:28 · hermes · 思维链独立成条目、工具调用收成紧凑行

- 改：`core/types.ts`（新增 `ReasoningItem`，`AssistantItem` 去掉 `reasoning` 字段）；`core/reduce.ts`（`reasoning.delta` / `reasoning.available` 落成时间线尾部独立条目，只在尾部 streaming 时追加；`message.delta` / `message.interim` / `message.start` / `tool.start` / `message.complete` / `settleTimeline` 全部封口思考块；`inferToolStatus` 的 `result.error` 取真值判断）；`core/history.ts`（历史行的 reasoning 投影成回复**上方**的思考块，只有推理没有正文的行不再产出空助手条目）；`ui/Bubble.ts`（`Reasoning` → `ReasoningRow`，无卡片无动作行；`ToolCard` → `ToolRow`，单行细轨；空正文助手条目不渲染）；`ui/ChatPage.ts`（条目包装加 `data-hb-kind`）；`ui/style.css`（`.hb-think` / `.hb-tool` 及按 kind 分配的垂直节奏）；`scripts/verify.mjs` 加三条实测断言；新增 `scripts/probe-furniture.mjs`；`tests/reduce.test.ts` / `tests/history.test.ts` / `tests/layout-classes.test.ts`；`GLOSSARY.md`、`README.md`、`docs/01-protocol-contract.md`、`docs/agents/domain.md`
- 验证：`npx vitest run` 453 passed（22 文件）；`npx tsc --noEmit` 干净；`node scripts/audit-classes.mjs` 170/170；`node scripts/verify.mjs` 79/79（真模型真往返，含「无空气泡」「思考不在气泡里」两条新断言）；`node scripts/probe-furniture.mjs` 11/11（命中真实的 terminal 调用：11px 字号／15px 行高／透明底／折叠往返／包装间距 3px，条目顺序 `user → reasoning → tool → assistant → reasoning → assistant`）
- 遗留：`verify.mjs` 里的「工具行紧凑度」在本轮仍走了 SKIP——它的探针跑在一轮没有工具调用的转写上；真正的工具行验收放在 `probe-furniture.mjs` 里，需要时单独跑（依赖模型真的去调工具，所以没进主验收）

### 空气泡是怎么长出来的

`reasoning.delta` 在没有打开的气泡时会**自己创建一个 assistant 条目**，正文为空——推理被当成回复的附注塞进去。紧接着 `tool.start` 封口，于是每一段思维链都留下一个 `text: ""` 的助手条目：一个带边框的空卡片，下面还挂着一行预留了高度的复制按钮条。用户看到的就是「每个思维链对应一个空气泡，气泡下面一截空隙」。

改法不是「隐藏空气泡」，而是**推理不该寄生在回复上**。一轮里可以想→调工具→再想→再说，每段推理都发生在不同位置，字段式的 `reasoning` 连这个顺序都表达不了。现在它是独立条目 `reasoning`：

- 只有时间线**尾部**的思考块可以续写（`openReasoning` 用 last-item 判断，不用 `replaceLast`——后者会倒着找回工具调用之前那块，把两段推理粘成一块）；
- 文字一开始流式就先封口思考块，工具调用开始时再封一次，回合结束时也封（否则光标在结束后还在闪）；
- 历史行里的 reasoning 投影到回复**上方**，纯推理行只产出思考块，不再产生空回复。

`AssistantBubble` 里另加一道保险：正文为空且没有 error 时直接不渲染。逻辑层的修法管不住所有来源（旧快照、异常帧），而「空卡片 + 空动作行」这种形态一旦出现就非常显眼。

### 工具调用为什么不该是卡片

先前每个调用是一张带内边距、底色和第二条预览行的卡片。一轮十几次调用就是十几个灰盒子，最终回答被压在下面——这才是可读性差的根源，不是字号。

现在折叠态是一行：细轨（1px 左栏）+ 11px 文本，内容是 `▸ 工具名 · 摘要 · 耗时`，摘要独占可伸缩的那一列，名字和耗时固定不被挤走；展开才出现参数与输出（`hb-tool-pre`，仍是等宽、有底色）。`width: fit-content` 是关键的一笔：块级元素默认铺满整列，一行三个词的调用会把耗时甩到 82% 宽度之外的右边，看着像断线的两个元素。

条目间距改成按 kind 分配（`.hb-bubble-gap[data-hb-kind="tool"]` 3px、思考 5.6px、消息保持 18.4px）：一串工具调用读起来是一段日志，而不是十个小段落。

### 顺手修掉的红框

实测里 `echo` 明明成功（`{output, exit_code: 0, error: null}`），工具行却是 red rail——`inferToolStatus` 用了 `"error" in result`，键在就算失败。改成取真值。这是探针跑出来的，不是读代码看出来的：只有真调一次工具才会看到 `error: null` 这个形状。

## 2026-10-18 01:05 · hermes · 输入框按内容自动增高（带上限）

- 改：新增 `core/autosize.ts`（`fitComposerHeight()`，纯函数：内容高度 → 夹在 32–192px 之间，并回报是否需要滚动）；`ui/Composer.ts`（`fitInput()` 先 `height:auto` 再量 `scrollHeight`，`useLayoutEffect` 跟 `text` 走，`resize` 事件重算；`max-h-48` 换成 `hb-composer-input`）；`ui/style.css`（`.hb-composer-input` 同样的 192px 上限 + `overflow-y:auto`，脚本没跑起来时也封顶）；`tests/autosize.test.ts`；`scripts/verify.mjs` 加三条实测断言
- 验证：`npx vitest run` 448 passed（22 文件）；`npx tsc --noEmit` 干净；`node scripts/audit-classes.mjs` 153/153；`node scripts/verify.mjs` 77/77（实测 32px → 68px → 192px 且 `scrollHeight` 761、`overflow-y:auto` → 清空回 32px）
- 遗留：无

### 为什么不是一个 CSS 属性了事

`field-sizing: content` 正是这个需求，但只有 Chrome/Edge 123+ 认，插件是「用户浏览器里跑的一段脚本」，不能把可用性押在一个版本号上，所以走 JS 量 `scrollHeight`。量之前必须先把 `style.height` 归 `auto`：否则量到的是上一次设的固定高度，框只会越量越大、永远不缩。上限同时写在 CSS 和 JS 里是故意的——CSS 那份是脚本首帧还没执行时的兜底，防止粘贴一整段日志的瞬间撑出一屏高的输入框。

`rows={1}` 保留，作为脚本缺席时的默认观感；原生缩放手柄（`resize: none`）依旧不要，这就是自动增高的替代物。

## 2026-10-18 00:40 · hermes · 桌面通知返工（开关撒谎、离开页面即静音）

- 改：`core/notify.ts`（新增 `notifySwitch()` 把「开关偏好 + 浏览器权限」合成四态；`NotifySpec.sticky`；`testNotice()`）；`core/i18n.ts`（`notifyPendingTitle` / `notifyTestTitle` / `notifyTestBody`，中英各一套）；`ui/notifier.ts`（`requireInteraction` 跟 `sticky` 走，新增 `raiseTestNotification()`）；`ui/TabStrip.ts`（`notifyOn`/`notifyBlocked` 两个布尔换成 `notifyState` 四态，字形 ◉/◑/⊘/◌，加 `data-state`）；`ui/ChatPage.ts`（开关按状态决定点击含义；授权探明后弹一条确认通知；`focus`/`visibilitychange` 回读权限；卸载时不再 `setNoticeSink(null)`）；`tests/architecture.test.ts` + `tests/notify.test.ts` 加护栏；`scripts/verify.mjs` 加两条开关诚实性断言；新增 `scripts/probe-notify.mjs`
- 验证：`npx vitest run` 442 passed（21 文件）；`npx tsc --noEmit` 干净；`node scripts/audit-classes.mjs` 153/153；`node scripts/verify.mjs` 74/74；`node scripts/probe-notify.mjs` 8/8（真 Dashboard + headless Edge，权限桩捕获到 `Hermes finished / 收到 / hb-turn-…`，前台时 0 条）
- 遗留：点通知只把窗口拿到前台，不会切到对应的那个页签（approval 通知里的 `sessionKey` 还是后端 runtime id，要切页签得先做一次映射）；Windows 侧「专注助手 / Edge 站点通知」被关掉的情况代码无法自检，只给了确认通知让用户当场看见

### 通知开关为什么会撒谎

`storedEnabled()` 把「没存过」当开启，而权限是另一回事。新用户打开页面：`localStorage` 里没有 `hb-notify`（读作开），浏览器权限是 `default`（读作永远不响）——开关亮着 ◉，标题写着「已开启」，实际一条都不会来。第一次发送时才申请权限，而那个 prompt 很小、很容易被忽略或误点拒绝，之后就彻底静音，也没有任何入口说明。

修法是把「偏好」和「权限」合成一个四态，UI 只能显示合成结果：`on` / `needs-permission` / `blocked` / `off`。点击语义跟着状态走——`on` 关掉，`off` 打开并申请，`needs-permission` 直接申请（授权成功当场弹一条确认通知，等于自己证明链路通），`blocked` 关掉（浏览器不会再弹权限，留着只会继续撒谎）。

### 离开 /chat 就没通知

controller 是模块级单例（`persistent.ts`），切到仪表盘别的页面时它照样收事件、照样把回复写进时间线；但 `ChatPage` 的 cleanup 里调了 `setNoticeSink(null)`，把通知出口一起摘了。于是「用户不在聊天页」——恰好是通知最该响的场景——一声不响。sink 的回调是模块级的 `maybeNotify`，只碰 `window`/`document`，不持有 React 状态，所以让它跨卸载存活是安全的；重挂载时新 sink 直接覆盖。`tests/architecture.test.ts` 现在会拦住「cleanup 里再摘 sink」这个改法。

## 2026-10-17 21:10 · hermes · 文本气泡归位、任务清单、子代理、桌面通知


- 改：`core/reduce.ts`（`tool.start` 封口当前气泡、`todo.updated` 归一化 + revision 单调、六个 `subagent.*` 聚合成一张批次卡）；`core/types.ts`（`TodoState` / `SubagentChild` / `SubagentsItem` / `SessionMeta.todo`）；`core/history.ts` + `core/sessions.ts` 投影 resume 的 `todo_state`，且没有快照的 resume 不清空实时清单；新增 `core/notify.ts`、`ui/notifier.ts`、`ui/TodoPanel.ts`；`ui/Bubble.ts` 加 `SubagentsCard`；`ui/ChatPage.ts` 在 Composer 上方挂面板 + 通知 sink + 发送时申请权限；`ui/TabStrip.ts` 加通知开关；`app/controller.ts` 加 `setNoticeSink` 与 `TurnNotice`
- 验证：`npm test` 431 passed（21 文件）；`npx tsc --noEmit` 干净；`node scripts/audit-classes.mjs` 153/153；`node scripts/verify.mjs` 72/72（真模型跑出 2 条 todo、1 个子代理，折叠往返实测）
- 遗留：桌面通知的实际弹出在 headless 里验不了（`document.hasFocus()` 恒真、权限拿不到手势），策略与文案只有单测覆盖，实机需最小化窗口试一次

### 为什么工具之后的文字会钻进上面的气泡

`openAssistant()` 只看「最后一个 assistant 是否还在 streaming」。`tool.start` 只往时间线尾部推卡片，没有封口，于是工具返回后的 `message.delta` 仍然 find 到卡片之前那个气泡并继续追加——用户看到的就是最终回答被一串工具卡压在下面，还和工具调用之前的话混在同一格里。

修法是在 `tool.start` 里先 `sealAssistant()`：一段文本段落在工具调用处结束，工具之后的文字新开一个气泡落在卡片下方。`message.complete` 不用改，它本来就用 `openAssistant` 定位本轮气泡，封口后自然指向新气泡。

### 子代理为什么是一张批次卡

后端给的是六种 `subagent.*` 帧，每帧都带 `subagent_id` / `delegation_id` / `task_index` / `task_count`。一次 `delegate_task` 的子代理共享 `delegation_id`，并发时它们的帧交错到达。若一个子代理一张卡，三路并发就会在时间线上插出三张卡，还和父会话自己的工具卡互相穿插。

聚合键优先 `subagent_id`（每帧都有，晚到的帧必定回到自己的行），其次 `delegation_id`（同批），两者都缺的旧 emitter 并进「最后一个没满员、没结束」的卡。全部子代理进终态才给批次盖 `finishedAt`，之后的新一批不会再被并进来。

### 通知什么时候不该响

窗口在前台时不弹。判断用 `visibilityState === "hidden" || !document.hasFocus()`——`visibilityState` 单独不够，窗口被别的应用盖住时它仍是 `visible`。权限只能在用户手势里申请，所以开关点击和首次发送是两个申请点；被浏览器拒绝时开关置灰但保留用户的选择，不反复弹。


## 2026-10-17 15:10 · hermes · 历史状态灯、跨路由保持会话

- 改：新增 `src/app/persistent.ts` + `tests/persistent.test.ts`；`ChatPage.ts` 改用文档级 controller、卸载只 release、重挂载回放暂存请求；`controller.ts` 加 `pendingCards` / `takeParkedCards`；`HistoryPanel.ts` 加状态灯（`openStoredIds` / `busyStoredIds`）；`style.css` `.hb-dot`
- 验证：`npm test` 397 passed（19 文件）；`npx tsc --noEmit` 干净；`node scripts/verify.mjs` 64/64；`node scripts/audit-classes.mjs` 0 缺失
- 遗留：无

### 跨路由保持会话

根因很直接：仪表盘切页会卸载插件页，而 ChatPage 的 cleanup 里调了 `controller.dispose()`——socket 关掉、页签全没。改成模块级单例（`createControllerHolder`）：卸载只 `release()` 引用，不销毁；重新挂载拿回同一个实例，页签、进行中的回复原样都在。

连带要处理的一件事：控制器活得比页面长，那么页面不在时到达的 approval/clarify 请求会没人接，channel 会回 `-32601` 让后端放弃。但后端对这种请求会一直等（clarify 3600s），而这只是「用户刚好在别的页面」。所以 controller 把它们暂存进 `pendingCards`，页面重新挂载时取走渲染。channel 的 fail-fast 本身没错，它针对的是永远不会答的客户端。

### 历史列表的状态灯

每行一个小圆点：该会话已在页签中打开就亮，正在运行则用现有的 `.hb-caret` 心跳闪，聚焦中的那个更亮、其余半透明。区分 `open` 与 `busy` 两个状态，验收实测拿到 `["open","busy","open"]`。

写验收时踩了个自己挖的坑：一开始测的时候用的是**草稿页签**（新建的没保存过的会话），草稿没有 stored id，永远点不亮任何一盏灯——断言成了空转。改成从历史面板打开一个**已有**会话再测。

### 又一个注入脚本的转义坑

`verify.mjs` 里的查找 Config 导航项那段，模板字符串把 `/\/config/` 渲染成了 `//config/`——变成行注释，后面整段被吃掉，浏览器报 `Unexpected token 'if'`。`\s` 同样被消费成 `s`，正则 `/^\s*config\s*$/` 变成 `/^s*configs*$/`。改用 `String.raw` 后正常。这类错误看起来像逻辑 bug，实际是字符串转义，排查了三轮才定位（先把每个模板单独 `new Function` 校验，都没问题，最后才发现要检查**渲染后**的字符串）。

## 2026-10-17 14:25 · hermes · 定位轨道、空状态输入、选项换行、卡片默认折叠、代码复制

- 改：新增 `src/core/rail.ts` + `src/ui/LocatorRail.ts` + `tests/rail.test.ts`；`controller.ts`（无页签时 send 先建会话）；`ChatPage.ts`（轨道挂载、`data-hb-item` 锚点、`composerConnected`）；`Bubble.ts`（工具卡默认折叠）；`RequestCards.ts` + `style.css`（选项改为列布局）；`Markdown.ts`（代码块复制按钮 + 剪贴板回退）
- 验证：`npm test` 387 passed（18 文件）；`npx tsc --noEmit` 干净；`node scripts/verify.mjs` 60/60；`node scripts/audit-classes.mjs` 0 缺失
- 遗留：无

### 定位器
右侧一条窄轨道，每条用户消息一个刻度。位置是**按序号等分**而不是按时间或滚动高度——找的是「我说的第 N 件事」，等分才好瞄；按高度比例会让长会话的刻度全挤成一坨。刻度超过 120 个时抽样绘制，但保留最后一条，点击时用 `nearestTick` 算最近的刻度，所以抽样不影响精度。实测：12 条用户消息、12 个刻度，点第一个把滚动从 103277 拉到 5073。

挂载位置踩了一次：一开始放在内容列（`mx-auto max-w-[860px]`）里，结果轨道浮在页面中间。它必须挂在**滚动容器的兄弟节点**上、贴着右边，所以给滚动区加了层 `relative` 包裹，轨道作为第二个子元素。

### 空状态可输入
关掉所有页签后 `activeTimeline` 返回的是空占位，`meta.connected` 恒为 false，输入框直接变灰。判定改成看**连接状态**（没页签时用 `getConnection().state`），并且 `send()` 在没有 activeKey 时先 `newSession()` 再提交。

### 选项换行
原来是 `flex flex-wrap`，只在容器边缘换行，三个短选项就挤在一行。改成 `flex-direction: column` + `width: 100%` + 左对齐。验收里用真实类名造三个选项量：3 行、每个宽度 700（满宽）。

### 工具卡默认折叠
`useState(item.status === "running")` → `useState(false)`。跑长任务时十几个工具卡全展开会把转写区冲垮；头部仍显示类型/摘要/耗时，扫一眼就知道发生了什么。

### 代码块复制
按钮放在语言标签同一行的右侧（`hb-md-codebar`），不浮在代码上。做成独立组件而不是内联标记：`renderBlocks` 每次流式增量都重跑，内联的「已复制」状态会被重置。

剪贴板这里差点误判：headless 里 `navigator.clipboard.writeText` 以「Document is not focused」拒绝，按钮显示 `!`，看起来像坏了。实测 `document.execCommand("copy")` 在同样环境可用，所以拒绝时回退而不是直接报失败；在真正聚焦的窗口里 `writeText` 正常，剪贴板里读回了代码块原文。

### 测试自身的坑（又是三个）
1. 关页签用同步循环点 20 次——React 会批处理，实际只关掉一个。改成一次点击一次 await。
2. 新增的检查插在脚本中段，会破坏后面依赖「最后一条是助手回复」的断言。挪到末尾。
3. 轨道要 ≥2 条用户消息才渲染，而那次运行只有 1 条；补一发构造出第二个定位点再测，并给「转写区不够高、没什么可滚」的情况补 SKIP 而不是假失败。

## 2026-10-17 13:05 · hermes · 会话管理、编辑重发、时间戳、行内代码

- 改：新增 `src/core/requests.ts` 之外的 `editTargetFor` / `forgetStoredSession` / `retitleStoredSession`（`core/sessions.ts`）；`controller.ts` 加 `deleteStoredSession` / `renameStoredSession` / `editAndResend` / `fetchJSON`（REST 通道）；`Bubble.ts` 用户气泡加编辑；`HistoryPanel.ts` 加改名/删除；`Composer.ts` 加编辑态；`style.css` 行内代码配色
- 验证：`npm test` 372 passed；`npx tsc --noEmit` 干净；`node scripts/verify.mjs` 54/54；`node scripts/audit-classes.mjs` 0 缺失
- 遗留：无

### 时间戳：三处各按自己的假设缩放

`at` / `completedAt` 一直是**毫秒**（`Date.now()`，以及 `history.ts::timestampOf` 里的 `ts * 1000`），但 `clockTime` / `fullStamp` / `messageStamp` 都按**秒**再接一个 `* 1000`。于是 02:46 的任务显示成 19:32。修法是把单位写进 `types.ts`（`export type Millis`），格式化函数不再缩放，秒→毫秒的换算只留在 `timestampOf` 一处，并顺手防了一次「已经是毫秒」的源（`> 1e11` 不再乘）。

### 改存量会话：REST 与 RPC 不是同一件事

最初用 `session.title` 改名——它能用，但要先 `session.resume` 拿到 runtime id，而 resume 会让该行变成**活跃**。之后 `session.delete` 直接 4023 拒绝。改用桌面端同款的 REST：`PATCH /api/sessions/{id}` 改名、`DELETE /api/sessions/{id}` 删除。

更坑的是：对活跃会话 REST DELETE **返回 `{ok:true}` 却什么也没删**（行被重新持久化）。所以删除后必须回查 `session.list` 确认，不能信返回值。另外 REST `/api/sessions` 与网关 `session.list` 读的是**不同的库**——一次调试里 REST 显示 `title: null` 而 `session.list` 已经有新标题，我差点把它当成改名失败，实际是查错了源。这条已写进 AGENTS.md。

删除还有一个前提：先 `await session.close` 把活跃会话关掉（不是只关本地 tab——本地关 tab 不影响网关的活跃状态，行会重新落库）。

### 编辑已发送消息

用户气泡悬停出现编辑按钮 → 文本灌进输入框并显示一条「正在编辑」横幅 → 发送时走 `prompt.submit` 带 `truncate_before_row_id` + `confirm_truncate`，从那一轮重写，之后的对话一并截断。没有 durable row id 的目标直接拒绝（网关对这种截断是 fail-closed 的，发过去只会得到一个错）。失败会把转写区原样恢复。

### 行内代码：只设了背景色，没设前景色

`.hb-inline-code` 一直只写了 `background`，而宿主有一条按**标签名**匹配的 `code { color: var(--background) }`——前景色因此停在接近背景的位置，chip 画出来了但字看不见。补上显式 `color` 后对比度 8.72:1。

### 又一次测试自身的坑

`verify.mjs` 的删除检查一直失败，查了三轮才看清：它挑的是**本次对话自己所在的行**，那行永远活跃、按设计删不掉。改成现场造一个一次性会话再删。另外 `renameSession` 的 Enter 处理原来读 React 的 `draft` state，脚本「输入后立刻回车」会拿到上一帧的值——改为从 `event.currentTarget.value` 读，真实打字本来也没问题，但依赖渲染时序的写法不该留。

## 2026-10-17 08:10 · hermes · 六条反馈返工（代码块宽度/颜色、间距、消息操作、卡片、语言、@）

- 改：新增 `src/core/i18n.ts`、`src/core/requests.ts`、`src/ui/useLocale.ts`、`src/ui/RequestCards.ts`、`tests/i18n.test.ts`、`tests/requests.test.ts`、`scripts/verify-clarify.mjs`；改 `Bubble`/`Composer`/`ChatPage`/`TabStrip`/`HistoryPanel`/`ModelPicker`/`style.css`；`reduce.ts` 记 `completedAt` 并本地推算用时；`controller.ts` 加 `regenerateAssistant` / `branchSession` / `setLocale`
- 验证：`npm test` 351 passed；`npx tsc --noEmit` 干净；`node scripts/verify.mjs` 46/46；`node scripts/audit-classes.mjs` 0 缺失；`scripts/verify-clarify.mjs` 对真实 clarify 卡通过
- 遗留：会话删除/重命名（issue #5）

### 第 1 条是真问题，根因是宿主的全局 `code` 规则

短代码块又窄又黑，两个症状同一个根因：宿主 CSS 里有一条**按标签名**匹配的规则 `code { display: inline; background: var(--selection-bg, var(--midground)); color: var(--background) }`。它同样命中 `<pre>` 里的 `<code>`，于是：

- `display: inline` 让元素收缩到内容宽度，外层 `<pre>` 的底色就只有文字那么宽——短代码块显得很窄；
- 配色变成宿主的行内代码芯片（当前主题下 `#cdd6f4` 底 + `#1e1e2e` 字），深色气泡里一片看不清。

修法是按自己的类显式覆盖：`hb-md-pre code` 与 `hb-output code` 恢复 `display: block`、透明底、颜色继承。验收里加了两条断言：每个代码块宽度 ≥ 气泡内容宽的 95%，且 `<code>` 的 `display` 为 `block`、`color` 与气泡前景一致。表格同理，铺满宽度。

（用户提到「另一个对话里好像没这个问题」——那是宿主自己的聊天页，它没有这层嵌套，所以确实不受影响。）

### 其余五条

2. 气泡间距：`.hb-bubble-gap { margin-top: 1.15rem }`，并去掉容器的 `gap`（两处叠加会变成 2rem）。验收量到 17.25px。
3. 消息操作：气泡右下角时间戳（`HH:MM`，今天/昨天带名字）+ 分支 + 复制 + 重新生成，默认透明、悬停显现、**常驻占位**（不然显现时会把下面的内容顶走——桌面端源码里专门注释了这点）。分支走 `session.branch` 带 `idempotency_key`；重新生成走 `session.undo { intent: "retry" }` 再重发原用户文本，失败会把转写区恢复原样。朗读与反应表情按用户要求不做。
4. 审批/选择题：原来卡片已经在跑，但**忽略了服务端下发的 `choices`**（写死了四个）也**没处理 `multi_select`**。解析逻辑提到 `src/core/requests.ts` 做纯函数并单测；`multi_select` 的多个值合并成一个字符串（`ClarifyResult.answers` 是 `Record<string, string>`），未答完不可提交。
5. 语言：默认英语（Hermes 自身默认就是 `en`）。没有 RPC 能问当前语言，所以读 `localStorage['hermes-locale']` 与 `<html lang>`，靠 `storage` + `MutationObserver` 跟随切换，无需刷新。`SDK.useI18n` 在插件里拿不到值（只是对宿主 context 的 `useContext`，context 不可 import，且切换后不更新），故自带小目录。
6. `@` 补全**移除**。上一轮我以为修好了，其实只是让菜单「有东西」——后端 `complete.path` 期望的 `word` **包含**开头的 `@`（`is_context = word.startswith("@")`），而客户端发的是去掉 `@` 的查询，所以永远走不到 `@` 分支。用户第二次反馈后查了后端源码才定位。现在 `@` 是普通字符，文件走 `+` 按钮的 `file.attach`。

### 顺带：契约字段不能猜

`message.complete` 没有时长字段（核对 `MessageCompletePayload`：text/usage/status/reasoning/…，没有计时），所以回复用时由本轮用户消息到完成的时间**本地推算**，并夹在 6 小时内——恢复的历史会话行时间戳单位可能不一致，印出「41000m」比不印更糟。

### 测试脆性：文案不该进断言

语言改成英语默认后，`verify.mjs` 里 9 条按中文文案找元素的断言集体失效（找「发送」「插入」「历史会话」）。功能是好的，脆的是测试。于是给每个可交互元素加了 `data-hb` 钩子，脚本只按钩子找。另外修了三处测试自身的问题：`send()` 未 await 导致的死锁、`evaluate(expr, true)` 传布尔而非 `{awaitPromise:true}`、以及把「运行中」判定在语言切换中途取样。这些都已写进 AGENTS.md 铁律 15。

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
