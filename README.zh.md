# dsh-pet-progress

让 [dsh 网页宠物](https://github.com/zhu1090093659/dsh-pet) 汇报**还剩多少活没干完**，而不只是"模型此刻在做什么"。

[English](./README.md)

## 它补的是什么缺口

宠物本身已经有一套很丰富的**瞬时活动**词汇：

```
'idle' | 'waiting' | 'thinking' | 'tool' | 'review' | 'done' | 'failed'
```

这七个词描述的都是"此刻"。它们没有一个能表达*"7 个任务完成了 3 个"*，所以一个长任务在刚开工和快收尾时看起来一模一样；而当模型在步骤之间安静下来时，宠物会退回 `idle`——哪怕还剩一大堆活。

持久化的进度信息其实一直都在会话日志里。DSH 把它记成 `todo/write` 和 `goal/change` 事件，但宠物的事件投影只对 `turn/start`、`step/start`、`assistant/message`、`tool/call`、`tool/result`、`turn/end` 做分支，其余一律 `undefined` 丢掉：

```ts
// 宠物 event-projection.ts 的实际行为
default:
  return undefined
```

也就是说：信息早就写进会话了，只是一直没人读。

## 工作方式

这是一个**独立的姊妹插件**，不是补丁。宠物的源码一行都不改——它是 npm 依赖，将来一次 `dsh plugin add` 就会把它覆盖掉。本插件只使用宠物已经公开的三个扩展点：

| 接缝 | 用途 |
| --- | --- |
| `ctx.on('session/event', …)` | 读取 `todo/write` + `goal/change`，在 `turn/end` 时退休气泡，在 `turn/start` 时重新发布——与宠物监听的是同一个通道，双方都能看到全部持久事件 |
| `ctx.pet.announce(…)` | 把进度气泡发进宠物已有的公告气泡栈 |
| `ctx.pet.registerPanelAction(…)` | 一个 `进度` 按钮，用来打印完整待办列表（气泡只有一行，放不下） |

气泡以 `kind: 'plan'` 发布，直接复用宠物现成的百分比条渲染。不需要客户端 bundle——本插件是纯宿主端（host-only）。

## 它汇报什么

优先级从高到低：

1. **被阻塞的目标优先级最高**，并显示人类可读的原因——一个卡住的任务是唯一值得打断用户的事。
2. **有待办列表**时显示百分比条加 `已完成/总数`，标题用当前 `in_progress` 的那条任务。
3. **只有目标、没有待办**时退回轮次预算，例如 `2/8 轮`。

两条关于可信度的刻意规则：

- **进度绝不虚报。** 无法识别的待办状态一律算作 `pending`（而不是 `completed`）；整份列表都无法解析时，当作*没有信息*，而不是*无事可做*。空写入不会清掉已有气泡。
- **只有在指代明确时才点名任务。** 如果同时有多条 `in_progress`，气泡只显示数量、不点名任何一条——因为报错任务名的进度报告，比不报名字更糟。

气泡 30 秒过期，并由心跳持续刷新，所以它能扛过安静时段，而不是模型一停止发事件就消失。

但"持续"不等于"永久"：**`turn/end` 会让气泡退休，`turn/start` 会把它带回来。** 给一件已经没人在做的活显示百分比，比不显示更糟；所以回合结束时插件丢掉气泡并停止刷新，让它自然过期。这一点很关键，因为宠物的公告契约**没有撤回操作**——`announce()` 只是*设置*槽位，只有 TTL 能让它过期。所以"撤回气泡"的实现方式是*不再刷新它*；只要再刷新一次，TTL 就会重启，把一个已结束回合的百分比永远钉在屏幕上。

退休只停在气泡这一层，这是刻意设计的。`todo/write` 只在待办列表**发生变化**时才发出，所以一个新回合如果没动这份列表，就什么都不会发；如果退休时把折叠后的视图也一起丢掉，插件就会在该会话第一次回合结束后**永久失声**。因此视图保留，下一个 `turn/start` 直接从它重新发布。

## 环境要求

| | |
| --- | --- |
| DSH | `>=0.1.7-rc.1` |
| `@linxin666/dsh-pet` | `>=0.4.0`（peer） |
| Node | `^22.19.0 \|\| >=24.0.0` |

本插件绑定的是宠物的插件接缝契约（`announce`、`registerPanelAction` 以及 `session/event` 通道），版本过旧的宠物不会同时提供这三者。

## 安装

```bash
node build.mjs          # 从 src/*.ts 生成 lib/*.js
```

cordis 插件加载器**不做任何转译**，所以 `main` 必须指向普通 JavaScript。为了不引入工具链，`build.mjs` 使用 Node 自带的 TypeScript 转换器——就是 `node file.ts` 背后那一个——并额外重写相对导入路径（这一步转换器本身不做）。

`lib/` 已提交进仓库，所以克隆下来无需构建即可加载。只有改动 `src/` 后才需要重新构建。

然后在该 profile 里声明它并重启 DSH：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-pet-progress": "file:<本目录的绝对路径>" },
  "dsh": { "profile": { "bundles": ["…原有的…", "dsh-pet-progress"] } }
}
```

只加 `bundles` 是不够的——这个包同时必须是一个依赖；并且由于 profile 的包管理器要解析 `file:` 规格，路径里若含非 ASCII 字符，应写成 `file://` URL。改完要重启应用：bundle 只在启动时读取。

从 git 检出安装：

```bash
dsh plugin add "file:<本目录的路径>"
```

## 测试

```bash
node --test src/*.test.ts
```

48 个测试，除 `node:test` 外不依赖任何测试框架：

- `src/progress.test.ts` —— 投影核心：计数、百分比边界、活动任务歧义、拒绝畸形输入、目标轮次预算、`turn/end` 退休，以及每一条发出的标题/备注都落在公告契约的边界内。
- `src/wire.test.ts` —— 用宠物真实的 `parseAnnouncement` 限制来校验气泡载荷，确保本插件发出的气泡不会被宠物悄悄丢掉。
- `src/index.test.ts` —— 宿主端：订阅了正确的事件、忽略其余事件、遇到畸形载荷绝不抛异常、跨事件组合目标与待办状态、停止刷新已退休的气泡、在下一回合把它带回来、在宠物服务尚未就绪时也能挂载、并遵守自己的开关。

## 配置

```ts
apply(ctx, { enabled?: boolean, heartbeatMs?: number })
```

`enabled: false` 时什么都不挂载。`heartbeatMs` 默认 `10000`。

## 目录结构

```
src/progress.ts   纯投影：事件 → ProgressView → 气泡文案（不 import cordis）
src/index.ts      宿主适配层：订阅、会话表、announce + 面板动作
build.mjs         去类型构建
cordis.patch.yml  插入宿主行
```

## 两个不那么显然的细节

**挂载是延迟的，不是立即的。** 宠物是在它自己的 fiber 内部发布服务的，所以一个姊妹行完全可能在 `ctx.pet` 存在*之前*就被 apply。如果读一次 `ctx.pet` 为 `undefined` 就直接 return，插件会挂载成功、然后在整个启动周期里静默失效，且任何地方都不会报错。因此当服务尚未就绪时，`apply()` 会通过 `ctx.inject(['pet'], …)` 等待它。

**公告槽位没有撤回。** `announce()` 只是*设置*槽位，只有 TTL 能让它过期。这就是为什么"撤回气泡"被实现为"停止刷新它"而不是"清除它"，也是为什么插件在回合结束后绝不能再次发布。

## 许可证

[MIT](./LICENSE)
