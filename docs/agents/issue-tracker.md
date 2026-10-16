# Issue tracker: GitHub

本仓库的 issue 与 spec 都是 GitHub Issues，仓库 `NaimioChan/hermes-bubbles`。所有操作走 `gh` CLI。

## 约定

- **建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读 issue**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配 `--label` / `--state` 过滤。
- **评论**：`gh issue comment <number> --body "..."`。
- **加/去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。
- **关闭**：`gh issue close <number> --comment "..."`。

仓库从 `git remote -v` 推断；在克隆里跑 `gh` 会自动认。

## 本机注意（Windows）

- GitHub 直连被墙：每条 `gh` 命令前加 `HTTPS_PROXY=http://127.0.0.1:7897`。
- `gh.exe` 在 `C:\Program Files\GitHub CLI\`，不在 bash 默认 PATH 里：先 `export PATH="$PATH:/c/Program Files/GitHub CLI"`，或者写全路径。
- 凭据存在 Windows 凭据管理器里，`gh auth status` 的 backend 显示 `keyring`，scope 是 `gist, read:org, repo, workflow`。gh 在 Windows 上只读 `%APPDATA%\GitHub CLI\`，写 `~/.config/gh/hosts.yml` 不生效。若某次命令报 401，先看 `gh auth status`：backend 退回 `hosts.yml` 说明凭据被写成了文件里的明文，重跑一次 `gh auth login --hostname github.com --git-protocol https --web` 即可。

## 与 docs/agent-log.md 的分工

issue 是长期工作面：谁要做什么、做到哪一步。`docs/agent-log.md` 是每个 session 的交接记录：这次改了哪些文件、验证结果、遗留什么，Hermes 与 OpenCode 共用。两者都要写，不互相替代。

## Pull requests 作为 triage 面

**PRs as a request surface: no.**（本仓库不把外部 PR 当功能请求。要改就把这一行改成 `yes`，`/triage` 读的是这里。）

## 当技能说「publish to the issue tracker」

建一个 GitHub issue。

## 当技能说「fetch the relevant ticket」

按上面的**读 issue**读。
