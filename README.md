# feiyu-progress-hint

给 DSH 的一条**任务进度条** + **下载门禁** —— 一个包，两个功能。

## 它长什么样

```
┌──────────────────────────────────────────────────┐
│ ⏳ 安装 feiyu-bili-studio              42%  1分12秒  │
│ ████████████░░░░░░░░░░░░                         │
│ 已下载 42MB / 120MB                              │
└──────────────────────────────────────────────────┘
        ↑ 输入框正上方，跟输入框同宽、同步固定
```

**没有任务时它完全不出现（返回 null，不占位）。**

## 两个功能

### ① 进度条（`progress_hint` 工具）

```js
progress_hint({ action: 'set', title: '安装 xxx', detail: '已下载 42MB/120MB', percent: 42 })
progress_hint({ action: 'clear' })
```

### ② 下载门禁

**要跑 `pip install` / `pnpm install` / `git clone` 之类，却还没挂进度条 → 拦住。**

这是关键 —— **只装进度条而没有门禁的话，Agent 根本想不起来调它，等于装了个摆设。**

```
检测到要下载 → Agent 没挂条 → 拦住，逼它先挂
挂好之后 → 30 分钟内所有下载安装直接放行
```

**快速通道**：本地小 tgz（`file:` 开头、< 1MB）不联网、几秒完事，直接放行。

**关掉门禁**：`FEIYU_DOWNLOAD_GUARD=0`

## 位置是怎么定死的

**用 DSH 自己的 Slot：`conversation.input.dock`**

> "Full-width entries above the composer card."

**宽度也跟输入框卡片套同一个 CSS 变量：**

```js
width: '100%',
maxWidth: 'var(--dsh-composer-card-max-width, 804px)',
margin: '0 auto 8px',
```

**实测：跟输入框卡片左右边缘差 0 像素**（两边都是 `left=375 / right=1179 / w=804`）。

## 刷新机制

**前端每 2 秒轮询 `/api/feiyu-progress`，不经过对话队列，不打断 Agent。**

（这就是它比「定时发消息」强的地方 —— 定时消息会卡在待发送队列里，
等这一轮跑完才一起涌进来，用户看到的全是过时消息。）

## 自动消失

- Agent 调 `action: 'clear'`
- 或者超过 **10 分钟没更新**（防止忘了清而永远挂着）

## 踩过的坑（都很贵）

### ① `inject: ['react']` → 整个 web 起不来

```
feiyu-progress-hint: pending (waiting for service: react)
Error: web boot: 1 entry did not activate
→ 触发安全模式，bundles 被清空，所有插件失效
```

**`react` 不是 cordis 服务名。客户端插件只有 `slots` 这些是真服务。**
**正确写法（照 `feiyu-ui-tune` 抄）：**

```js
inject: ['slots'],
apply(ctx) {
  slots.inject('conversation.input.dock', () =>
    slots.register({ name: '...', id: '...', order: 10 }, () => h(Bar)))
}
```

### ② `require('react-dom/client').createRoot()` → 跟 DSH 打架

**别自己造渲染根。走 `slots.register` 让 DSH 管。**

### ③ host 侧 `inject` 缺 `tools` → 工具静默注册失败

```js
export const inject = ['connection', 'tools']   // 少了 tools 就 ctx.get('tools') 拿不到
```

### ④ `connection.fetch.register` 的 `requestBody` 是**必填**

```ts
export interface ConnectionFetchRoute {
  readonly path: string
  readonly methods: readonly ConnectionFetchMethod[]
  readonly requestBody: ConnectionRequestBodyMode   // ← 没有 ?
  readonly fetch: (request: Request) => Promise<Response>
}
```

### ⑤ 宽度要套 `--dsh-composer-card-max-width`

**直接 `width: 100%` 会撑满 `composerStack`（993px），比输入框（804px）宽。**

### ⑥ 门禁和进度条必须在同一个包里

**v0.1.x 只有进度条，用户装了什么都不会发生** —— 除非 Agent 自觉调工具。
v0.2.0 把下载门禁搬进来，才真正能跑。

## 与其他插件的关系

**本机另一个插件 `feiyu-delivery-guard` 也有第 19 条（下载门禁）。**
v0.2.0 起那边默认关闭自己的第 19 条，避免重复拦截。
想恢复由它负责：设 `FEIYU_DOWNLOAD_GUARD=1`。

## 安装

从本仓库装 tgz 即可。

## License

MIT
