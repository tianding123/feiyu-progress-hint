# feiyu-progress-hint

给 DSH 的一条**任务进度条** —— 长任务时出现在输入框正上方，干完自动消失。

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

## 两种触发方式

### ① Agent 主动标记（推荐）

```js
progress_hint({
  action: 'set',
  title: '安装 feiyu-bili-studio',
  detail: '已下载 42MB / 120MB',
  percent: 42,          // -1 或不填 = 不定进度（只显示转圈 + 已用时间）
})

progress_hint({ action: 'clear' })   // 干完清掉
```

### ② 写状态文件

```bash
echo '{"title":"装依赖","percent":30,"detail":"...","startedAt":<ms>,"updatedAt":<ms>}' \
  > "$DSH_HOME/progress-hint.json"
```

**前端每 2 秒轮询 `/api/feiyu-progress`，所以最多 2 秒延迟。**

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

**而外面的 `try/catch` 会把错误吞掉 —— 表现是「插件装了但工具没出现」。**

### ④ `connection.fetch.register` 的 `requestBody` 是**必填**

```ts
export interface ConnectionFetchRoute {
  readonly path: string
  readonly methods: readonly ConnectionFetchMethod[]
  readonly requestBody: ConnectionRequestBodyMode   // ← 没有 ?
  readonly fetch: (request: Request) => Promise<Response>
}
```

**漏了它 → 路由注册失败。**

### ⑤ 宽度要套 `--dsh-composer-card-max-width`

**直接 `width: 100%` 会撑满 `composerStack`（993px），比输入框（804px）宽。**
**必须加 `maxWidth: var(--dsh-composer-card-max-width)` + `margin: 0 auto`。**

## 安装

从本仓库装 tgz 即可。

## License

MIT
