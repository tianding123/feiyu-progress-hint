/**
 * feiyu-progress-hint —— host 半边（v0.2.0 起：进度条 + 下载门禁合一）
 *
 * 干三件事：
 *   ① 提供 GET /api/feiyu-progress —— 前端轮询拿「当前在干什么」
 *   ② 提供 progress_hint 工具 —— Agent 主动标记；干完 clear
 *   ③ 下载/安装门禁 —— 要跑 pip/pnpm/git clone 之类却没挂进度条 → 拦住
 *
 * 为什么把门禁塞进这里（2026-10-22 用户决定）：
 *   原来门禁在 feiyu-delivery-guard、进度条在这里。但只装进度条的用户，
 *   长任务时进度条根本不会出来（没有任何东西逼 Agent 调它）= 装了个摆设。
 *   所以把「下载门禁」这一条搬进来，一个包就能真正跑起来。
 *   （delivery-guard 里还有第 11 条删文件、第 18 条建清单 —— 不搬。）
 *
 * 状态存哪：$DSH_HOME/progress-hint.json
 * 约定：全程 try/catch，绝不向上抛。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'feiyu-progress-hint'
// connection：注册 /api/feiyu-progress 路由
// tools：注册 progress_hint 工具 + 挂 tools/pre-execute 门禁
export const inject = ['connection', 'tools']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_FILE = join(DSH_HOME, 'progress-hint.json')

const STALE_MS = 10 * 60 * 1000

const DOWNLOAD_ARM_TTL_MS = 30 * 60 * 1000
const DOWNLOAD_TOOL_NAMES = new Set(['bili_setup'])
const COMMAND_TOOLS = new Set(['bash', 'ops_bash', 'pwsh', 'command'])
const LOCAL_TGZ_FAST_PATH_BYTES = 1024 * 1024

const DOWNLOAD_COMMAND_PATTERNS = [
  { re: /\bnpm\s+(i|install|add|ci|update|upgrade)\b/i, what: 'npm 安装依赖' },
  { re: /\bpnpm\s+(i|install|add|dlx|update|upgrade)\b/i, what: 'pnpm 安装依赖' },
  { re: /\byarn\s+(add|install|upgrade)\b/i, what: 'yarn 安装依赖' },
  { re: /\bbun\s+(add|install|i)\b/i, what: 'bun 安装依赖' },
  { re: /\bpip3?\s+install\b/i, what: 'pip 安装 Python 包' },
  { re: /\bpython[0-9.]*\s+-m\s+pip\s+install\b/i, what: 'pip 安装 Python 包' },
  { re: /\buv\s+(pip\s+install|pip\s+sync|add|sync|install)\b/i, what: 'uv 安装依赖' },
  { re: /\bwinget\s+install\b/i, what: 'winget 安装软件' },
  { re: /\bchoco\s+install\b/i, what: 'choco 安装软件' },
  { re: /\bscoop\s+install\b/i, what: 'scoop 安装软件' },
  { re: /\bgit\s+clone\b/i, what: 'git clone 下载仓库' },
  { re: /\bcurl(\.exe)?\b[^\n]*\s(-o|--output|-O|--remote-name|-J)\b/i, what: 'curl 下载文件' },
  { re: /\bwget\b/i, what: 'wget 下载文件' },
  { re: /\bInvoke-WebRequest\b[^\n]*-(OutFile|o)\b/i, what: 'Invoke-WebRequest 下载文件' },
  { re: /\bdsh\s+plugin\b[^\n]*\b(add|install|update|upgrade)\b/i, what: 'dsh plugin 安装 / 更新' },
  { re: /\bcorepack\s+(prepare|enable)\b/i, what: 'corepack 下载包管理器' },
]

function collectStrings(value, out, depth) {
  if (depth > 4 || out.length > 200) return out
  if (typeof value === 'string') {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out, depth + 1)
  }
  return out
}

function isProgressHintArgs(args) {
  if (!args || typeof args !== 'object') return false
  if (args.action !== undefined && args.action !== 'set') return false
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  return title.length > 0
}

function detectDownload(toolName, args) {
  if (DOWNLOAD_TOOL_NAMES.has(toolName)) return '工具 ' + toolName

  if (toolName === 'plugin_manager') {
    const action = args && typeof args.action === 'string' ? args.action : ''
    if (action === 'install_bundle') return 'plugin_manager 安装插件（要联网拉依赖）'
    return null
  }

  if (!COMMAND_TOOLS.has(toolName)) return null

  const cmd = collectStrings(args, [], 0).join(' \n ')
  if (cmd.length === 0) return null

  for (const p of DOWNLOAD_COMMAND_PATTERNS) {
    if (p.re.test(cmd)) return p.what
  }
  return null
}

function isLocalTinyTgz(target) {
  if (typeof target !== 'string') return false
  const t = target.trim()
  if (!/^file:/i.test(t)) return false
  if (!/\.(tgz|tar\.gz)$/i.test(t)) return false
  let p = t.replace(/^file:/i, '').replace(/^\/\//, '').replace(/\//g, '\\')
  try {
    const st = statSync(p)
    return st.isFile() && st.size > 0 && st.size <= LOCAL_TGZ_FAST_PATH_BYTES
  } catch {
    return false
  }
}

function downloadDenyReason(what) {
  return [
    '⛔ 下载/安装门禁（AGENTS.md 第 19 条）：要下载/安装东西了，先挂上进度条。',
    '',
    '本次检测到：' + what,
    '',
    '── 按下面两步走（第 1 步做完，本门禁立刻放行）──────',
    '',
    '1. 立刻调 progress_hint 挂一条进度条（显示在输入框正上方、实时刷新）：',
    '   progress_hint {',
    '     action: "set",',
    '     title: "安装 xxx",',
    '     detail: "已下载 42MB / 120MB",',
    '     percent: 35',
    '   }',
    '   ★ percent 传 -1 或不填 = 不定进度（显示转圈 + 已用时间）',
    '   ★ 进度变了就再调一次更新 percent；干完调 progress_hint { action: "clear" }',
    '',
    '2. 长任务最好丢后台，别用前台阻塞的命令（这样你还能说话）：',
    '   · pwsh { command: "...", run_in_background: true } → 拿 job id',
    '   · 完成后 job_output(job_id) 看结果',
    '',
    '── 为什么是进度条而不是定时消息 ────────────────',
    '定时消息会卡在待发送队列里，等这一轮跑完才一起涌进来 —— 用户看到的全是过时消息。',
    'progress_hint 是实时浮条，不经过对话队列。',
    '',
    '★ 挂好进度条后，本会话 30 分钟内的下载安装不再拦你。',
    '★ 单独关掉：环境变量 FEIYU_DOWNLOAD_GUARD=0。',
  ].join('\n')
}

function readState() {
  try {
    if (!existsSync(STATE_FILE)) return null
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (!s || typeof s !== 'object') return null
    if (Date.now() - Number(s.updatedAt || 0) > STALE_MS) {
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
  const downloadState = new WeakMap()

  function downloadSt(agent) {
    if (agent === undefined || agent === null) return undefined
    let s = downloadState.get(agent)
    if (s === undefined) {
      s = { armed: false, armedAt: 0 }
      downloadState.set(agent, s)
    }
    return s
  }

  function downloadArmed(agent) {
    const s = downloadSt(agent)
    if (s === undefined || !s.armed) return false
    if (Date.now() - s.armedAt > DOWNLOAD_ARM_TTL_MS) {
      s.armed = false
      return false
    }
    return true
  }

  // ① HTTP 接口
  try {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/feiyu-progress',
      methods: ['GET'],
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
  } catch { /* ignore */ }

  // ② progress_hint 工具
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
          + '\n\n**注意**：正常输出对话时它不会自动消失（要显式 clear 或等 10 分钟过期）。',
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
              description: '进度 0~100；-1 或不填 = 不定进度（转圈 + 已用时间）',
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
  } catch { /* ignore */ }

  // ③ 下载/安装门禁
  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (process.env.FEIYU_DOWNLOAD_GUARD === '0') return next()

        const tname = exec?.name
        const args = exec?.arguments

        if (tname === 'progress_hint') {
          const ds = downloadSt(exec.agent)
          if (ds !== undefined && isProgressHintArgs(args)) {
            ds.armed = true
            ds.armedAt = Date.now()
            ctx.logger?.info?.('[feiyu-progress-hint] 已挂进度条，下载/安装门禁放行 30 分钟')
          }
          return next()
        }

        if (downloadArmed(exec?.agent)) return next()

        if (tname === 'plugin_manager') {
          const act = args && typeof args.action === 'string' ? args.action : ''
          if (act === 'install_bundle' && isLocalTinyTgz(args && args.target)) {
            return next()
          }
        }

        const what = detectDownload(tname, args)
        if (!what) return next()

        ctx.logger?.info?.('[feiyu-progress-hint] 拦下一次没挂进度条的下载/安装：' + what)
        return { kind: 'deny', reason: downloadDenyReason(what) }
      } catch {
        return next()
      }
    })
  } catch { /* ignore */ }

  // ④ 过期清理
  try {
    const sweep = setInterval(() => {
      try { readState() } catch { /* ignore */ }
    }, 30000)
    try { if (typeof sweep.unref === 'function') sweep.unref() } catch { /* ignore */ }
    ctx.effect(() => () => {
      try { clearInterval(sweep) } catch { /* ignore */ }
    }, 'feiyu-progress-hint: 过期清理')
  } catch { /* ignore */ }
}
