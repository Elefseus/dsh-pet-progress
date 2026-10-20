# dsh-pet-progress

**中文** · [English](README.md)

**给你的桌面宠物加一个进度条。**

[dsh 网页宠物](https://github.com/zhu1090093659/dsh-pet) 只会告诉你 agent
*此刻*在干什么——思考、调工具、做完。它没法表达一个长任务完成了多少，
所以一个已经做了九成的任务，看起来和刚开始一模一样。

这个插件补上这一块：它读取 agent 本来就写进会话的 todo 列表和目标，
折算成百分比气泡显示在宠物上。如果一个会话压根没写过 todo 列表，也不会
空着——这时气泡退回成一行纯文字，说明当下正在做什么。

## 安装

一条命令，用插件的完整 GitHub 地址：

```bash
dsh plugin add https://github.com/Elefseus/dsh-pet-progress
```

前提是已经装了 [dsh 网页宠物](https://github.com/zhu1090093659/dsh-pet)。
少了它插件不会崩，只是什么都不显示，dsh 日志里会留一行说明。

装完要**重启 DSH**——bundle 只在启动时读取，不重启插件不会挂载。之后
agent 写下 todo 列表或开始一个目标时，气泡自己就会出现，不需要额外开启什么。

需要多 profile 时，用 `dsh plugin --profile <name> add …` 指定 profile 名。

## 你会看到什么

宠物上方冒出一个小气泡，todo 列表或目标一变就更新：

| 情况 | 气泡内容 |
| --- | --- |
| 有 todo 列表，一个任务进行中 | `3/7 · 43%`，标题是这个任务 |
| 有 todo 列表，多个任务同时进行中 | `3/7 · 43%`，把进行中的任务都点名——最多三个，其余用 `+N` |
| todo 全部完成 | `任务全部完成`，绿色——这是一次性提示，约 10 秒后自己消失 |
| 有长期目标但没有 todo | `2/8 轮`——目标的轮次预算 |
| 目标完成 | `目标完成`，绿色——同样是一次性提示 |
| 目标被阻塞 | 直接显示阻塞原因，替代进度 |
| 既没有 todo 列表也没有目标 | 一行不带百分比的文字——模型此刻正在写的话（`最近输出`），或它刚调用的工具要干什么（`当前过程`） |

常态气泡在最后一次进度更新后约 30 秒自动淡出，这样已经结束的一轮不会把过期的
百分比留在屏幕上；工作重新开始时它会自己回来。而「一次性提示」——列表完成或目标
完成——只播报一次、不再续期，所以它会自己消失，而不是赖在那里。

可以同时开着多个会话——最近有动静的那个占据这个气泡。

## 查看完整列表

气泡只有一行，剩下的内容留了个按钮：点宠物面板上的 **进度**，完整 todo 列表
会写进 dsh 日志。

## 几点说明

- **不会虚报进度。** 状态认不出来的 todo 一律算「没做完」。如果一次写入里
  每一条都读不出来，插件当成「没有信息」处理，保留原来的显示。
- **不会瞎猜。** 它只点名真正在进行中的任务——最多三个，每个截到 32 个字，
  超过三个用 `+N` 收尾。同时有好几个在跑时，它绝不会挑一个出来假装那就是
  当前的工作。
- **只读不猜。** 百分比来自 agent 自己写的 todo 和目标，插件绝不根据「跑了
  多久」去推断进度。两者都没有时，它显示那行活动文字，而不是一个数字。
- **显示正在发生什么，而不只是走到了哪个阶段。** 没有任务列表时，它跟着模型
  正在写的话走——取最新写下的那几句，因为那才是「此刻在做什么」；它还会说清
  工具调用是**为了什么**（`正在调用 pwsh：npm test`、`正在调用 read：progress.ts`），
  而不是只说有个工具在跑。

## 环境要求

| | |
| --- | --- |
| DSH | `>=0.1.7-rc.1` |
| `@linxin666/dsh-pet` | `>=0.4.0`（peer） |
| Node | `^22.19.0 \|\| >=24.0.0` |

本插件绑定的是宠物的插件接缝契约（`announce`、`registerPanelAction` 以及
`session/event` 通道），版本过旧的宠物不会同时提供这三者。

## 配置

```ts
apply(ctx, { enabled?: boolean, heartbeatMs?: number })
```

`enabled: false` 时什么都不挂载。`heartbeatMs` 默认 `10000`。

## 在代码里使用

本插件只跑在宿主侧（没有客户端 bundle），宠物服务暴露为 `ctx.pet`。
下面三个接缝是宠物对外提供的全部扩展点，本插件也只用了这三个：

| 接缝 | 用途 |
| --- | --- |
| `ctx.on('session/event', …)` | 读取 `todo/write`、`goal/change`，以及活动行背后的 turn/step/tool/message 事件 |
| `ctx.pet.announce(…)` | 发布进度气泡 |
| `ctx.pet.registerPanelAction(…)` | 面板上的 `进度` 按钮 |

想调整淡出时间和同时跟踪的会话数，改
[`src/progress.ts`](src/progress.ts) 里的 `PROGRESS_TTL_MS` 和
`MAX_TRACKED_SESSIONS`。

## 开发

`src/*.ts` 是唯一事实来源；`lib/` 是提交进仓库的构建产物，因为 cordis
加载器不做转译。**改完 `src/` 后必须重新构建并把 `lib/` 一起提交——
两者不一致 CI 会失败。**

```bash
node build.mjs              # 从 src/ 重新构建 lib/
node --test src/*.test.ts   # 75 个测试，只用 node:test
```

要改代码就别装，直接把 profile 指向你的工作副本：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-pet-progress": "file:<本目录的绝对路径>" },
  "dsh": { "profile": { "bundles": ["…原有的…", "dsh-pet-progress"] } }
}
```

只加 `bundles` 不够——这个包同时必须是一个依赖。路径里若含非 ASCII 字符，
应写成 `file://` URL。改完重启应用。

Node 版本固定在 `package.json` 的 `engines` 里，CI 覆盖 `22.19.0` 和 `24.x`。

```bash
dsh plugin --profile desktop up dsh-pet-progress          # 更新到最新默认分支
dsh plugin --profile desktop add "<repo>#<tag>"           # 改用某个 tag（可复现）
```

## 更多

- [设计说明](docs/DESIGN.zh.md)——为什么是这样做的：它填补的事件缺口、为什么是
  兄弟插件而不是打补丁、它汇报什么，以及两个不明显的坑（延迟挂载、公告槽位
  没有撤回）。

MIT
