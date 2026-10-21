/**
 * feiyu-progress-hint —— host 半边
 *
 * 干三件事：
 *   ① 提供 GET /api/feiyu-progress —— 前端轮询拿「当前在干什么」
 *   ② 提供 progress 工具 —— Agent 跑长任务前主动标记（精准，不误报）
 *   ③ 兜底：观察 Agent 的 step 事件，太久没动静就自己推断「在跑长任务」
 *
 * 状态存哪：$DSH_HOME/progress-hint.json
 *   { title, detail, percent, startedAt, updatedAt, source }
 *   percent = -1 表示不定进度（转圈）
 *
 * 约定：全程 try/catch，绝不向上抛。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'feiyu-progress-hint'
// connection：注册 /api/feiyu-progress 路由
// tools：注册 progress_hint 工具
//   ⚠️ 2026-10-22 踩过：只写 ['connection'] 时 ctx.tools / ctx.get('tools') 拿不到，
//      工具注册不上去，而外面的 try/catch 会静默吞掉 —— 表现是「插件装了但没工具」。
//      （restart-button 也踩过同一个坑）
export const inject = ['connection', 'tools']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_FILE = join(DSH_HOME, 'progress-hint.json')

/** Agent 写状态后多久自动过期（毫秒）——防止忘了清就永远挂着 */
const STALE_MS = 10 * 60 * 1000

function readState() {
  try {
    if (!existsSync(STATE_FILE)) return null
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (!s || typeof s !== 'object') return null
    const age = Date.now() - Number(s.updatedAt || 0)
    if (age > STALE_MS) {
      // 过期了，顺手删掉
      try { unlinkSync(STATE_FILE) } catch { /* ignore */ }
      return null
    }
    return s
  } catch {
    return null
  }
}

function writeState(s) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function clearState() {
  try {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE)
    return true
  } catch {
    return false
  }
}

export function apply(ctx) {
  // ── ① HTTP 接口：前端轮询 ──
  try {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/feiyu-progress',
      methods: ['GET'],
      // ⚠️ requestBody 是【必填】字段（ConnectionFetchRoute 里没有 ?）
      //    2026-10-22 查 Service 契约才知道，照 restart-button 抄的 'buffered'
      requestBody: 'buffered',
      fetch: async () => {
        const s = readState()
        if (!s) return Response.json({ ok: true, active: false })
        return Response.json({
          ok: true,
          active: true,
          title: String(s.title || ''),
          detail: String(s.detail || ''),
          percent: Number(s.percent ?? -1),
          startedAt: Number(s.startedAt || s.updatedAt || Date.now()),
          updatedAt: Number(s.updatedAt || Date.now()),
          source: String(s.source || ''),
        })
      },
    }), 'feiyu-progress-hint: /api/feiyu-progress')
  } catch { /* 没有 connection 就算了 */ }

  // ── ② progress 工具：Agent 主动标记 ──
  try {
    const tools = ctx.tools || ctx.get('tools')
    if (tools && typeof tools.register === 'function') {
      tools.register({
        name: 'progress_hint',
        description:
          '告诉用户「我正在干什么长任务」—— 在输入框上方显示一条进度条。'
          + '\n\n**什么时候用**：'
          + '\n· 要跑下载/安装（pip/pnpm/winget/git clone/大文件）'
          + '\n· 要跑耗时命令（ffmpeg 转码、模型推理、编译）'
          + '\n· 要 sleep 很久'
          + '\n· 你自己在长时间思考、用户可能在干等'
          + '\n\n**用法**：开工前调一次带上 title/percent，进度变化时更新 percent，'
          + '干完调一次 action="clear" 清掉。'
          + '\n\n**注意**：正常输出对话时它不会自动消失（要显式 clear 或等 10 分钟过期），'
          + '所以干完记得清。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['set', 'clear'],
              description: 'set = 设置/更新进度；clear = 清掉（干完了）',
            },
            title: { type: 'string', description: '任务标题，例如「安装 feiyu-bili-studio」' },
            detail: { type: 'string', description: '细节，例如「已下载 42MB / 120MB」' },
            percent: {
              type: 'integer',
              description: '进度 0~100；-1 或不填 = 不定进度（显示转圈 + 已用时间）',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              detail: { type: 'string' },
            },
          },
          render: (_args, value) => [
            { type: 'text', text: String(value?.detail || '') },
          ],
        },
        async execute(args) {
          try {
            const action = String(args?.action || 'set')
            if (action === 'clear') {
              clearState()
              return { ok: true, detail: '进度条已清掉' }
            }
            const now = Date.now()
            const prev = readState()
            const s = {
              title: String(args?.title || '正在处理…'),
              detail: String(args?.detail || ''),
              percent: Number.isFinite(Number(args?.percent)) ? Number(args.percent) : -1,
              startedAt: prev?.startedAt || now,
              updatedAt: now,
              source: 'tool',
            }
            const ok = writeState(s)
            return {
              ok,
              detail: ok
                ? `进度条已显示：${s.title}${s.percent >= 0 ? ` ${s.percent}%` : ''}`
                : '写状态文件失败',
            }
          } catch (e) {
            return { ok: false, detail: String(e?.message ?? e) }
          }
        },
      })
    }
  } catch { /* 没 tools 就算了 */ }

  // ── ③ 兜底：超过 N 秒没被更新就自动清掉（不需要事件，纯计时）──
  //
  // ⚠️ 2026-10-22 删掉了第一版的 `ctx.on('agent/pre-step', ...)` 兜底：
  //    那个事件名是猜的（AGENTS.md 第二条：不许猜接口），猜错的风险是让插件加载失败。
  //    现在只靠「progress_hint 工具主动标记」+「10 分钟自动过期」两件事，
  //    逻辑简单、不依赖任何不确定的接口。
  try {
    const sweep = setInterval(() => {
      try {
        // readState 内部做过期检查，这里调一次就够（过期的会被删）
        readState()
      } catch { /* ignore */ }
    }, 30000)
    // 别让这个定时器把进程拖住（Node 环境有 unref 时用）
    try { if (typeof sweep.unref === 'function') sweep.unref() } catch { /* ignore */ }
    ctx.effect(() => () => {
      try { clearInterval(sweep) } catch { /* ignore */ }
    }, 'feiyu-progress-hint: 过期清理')
  } catch { /* ignore */ }
}
