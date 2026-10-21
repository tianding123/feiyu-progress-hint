/**
 * feiyu-progress-hint —— 浏览器半边
 *
 * 在输入框**上方**挂一条任务进度条（全宽）。
 *
 * ⚠️ 2026-10-22 的教训（把 DSH 弄白屏过一次）：
 *    第一版写了 `inject: ['react']` + `require('react-dom/client').createRoot()`
 *    手动往 DOM 里插 React 根 —— 两处都错：
 *      ① 'react' 不是 cordis 服务名，客户端插件等不到它，整个 client bundle 卡住
 *      ② 绕过 slot 体系自己造渲染根，跟 DSH 的渲染打架
 *    正确做法（照 feiyu-ui-tune 抄）：
 *      `inject: ['slots']` + `slots.inject(<slot 名>, () => slots.register(...))`
 *
 * 位置：slot `conversation.input.dock`
 *      —— "Full-width entries above the composer card."，就是输入框卡片上方。
 */
window.__ModuleLoader__.load({
  id: 'feiyu-progress-hint',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/feiyu-progress'
    const POLL_MS = 2000

    function fmtElapsed(ms) {
      const s = Math.max(0, Math.floor(ms / 1000))
      if (s < 60) return s + ' 秒'
      const m = Math.floor(s / 60)
      const r = s % 60
      if (m < 60) return m + ' 分 ' + r + ' 秒'
      return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分'
    }

    /** 进度条组件：不 active 时返回 null（不占位，完全看不见） */
    const Bar = () => {
      const [st, setSt] = React.useState(null)
      const [, tick] = React.useReducer((x) => x + 1, 0)

      React.useEffect(() => {
        let alive = true
        const poll = async () => {
          try {
            const r = await fetch(API, { credentials: 'same-origin', cache: 'no-store' })
            const j = await r.json()
            if (!alive) return
            setSt(j && j.active ? j : null)
          } catch {
            /* 拉不到就保持现状，下次再拉 */
          }
        }
        poll()
        const t1 = setInterval(poll, POLL_MS)
        const t2 = setInterval(() => {
          if (alive) tick()
        }, 1000)
        return () => {
          alive = false
          clearInterval(t1)
          clearInterval(t2)
        }
      }, [])

      if (!st) return null

      const raw = Number(st.percent)
      const indeterminate = !(raw >= 0 && raw <= 100)
      const pct = Math.max(0, Math.min(100, raw))
      const started = Number(st.startedAt) || Date.now()
      const elapsed = fmtElapsed(Date.now() - started)

      // 宽度跟输入框卡片对齐：
      //   输入框是 `.RlGAzG_card { width:100%; max-width: var(--dsh-composer-card-max-width) }`
      //   本框在 `.Dc7zOa_composerStack` 里（比 card 的父容器宽一点），
      //   所以套同一组约束 + 水平居中，才能跟卡片左右边缘对齐。
      //   （2026-10-22 用户反馈：「太宽啦，让他始终保持和输入栏一样宽」）
      const box = {
        margin: '0 auto 8px',
        width: '100%',
        maxWidth: 'var(--dsh-composer-card-max-width, 804px)',
        boxSizing: 'border-box',
        borderRadius: 10,
        padding: '8px 12px',
        background: 'rgba(59,130,246,.10)',
        border: '1px solid rgba(59,130,246,.35)',
        fontSize: 12,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary, #e8eaed)',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }

      return h('div', { 'data-fph': '', style: box },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          h('span', {
            style: {
              fontWeight: 600, flex: 1, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
          }, '⏳ ' + (st.title || '正在处理…')),
          indeterminate ? null : h('span', {
            style: { flex: 'none', fontVariantNumeric: 'tabular-nums', color: '#7ea6e0', fontWeight: 600 },
          }, Math.round(pct) + '%'),
          h('span', {
            style: { flex: 'none', fontVariantNumeric: 'tabular-nums', opacity: 0.6, fontSize: 11 },
          }, elapsed),
        ),
        h('div', {
          style: { height: 4, borderRadius: 2, background: 'rgba(128,128,128,.22)', overflow: 'hidden' },
        },
          h('div', {
            style: {
              height: '100%', borderRadius: 2,
              width: indeterminate ? '100%' : pct + '%',
              background: 'linear-gradient(90deg,#3b82f6,#7ea6e0)',
              transition: 'width .4s ease',
              opacity: indeterminate ? 0.5 : 1,
            },
          }),
        ),
        st.detail ? h('div', {
          style: { opacity: 0.65, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, st.detail) : null,
      )
    }

    return {
      // ⚠️ 只有 slots 是真实存在的 cordis 服务；写 'react' 会让客户端插件永远等不到
      inject: ['slots'],

      apply(ctx) {
        try {
          const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
          if (!slots) return

          slots.inject('conversation.input.dock', () =>
            slots.register(
              {
                name: 'conversation.input.dock',
                id: 'feiyu-progress-hint',
                order: 10,
                label: '任务进度',
              },
              () => h(Bar),
            ),
          )
        } catch {
          /* 注册失败只是这一条不出现，绝不影响 DSH */
        }
      },
    }
  },
})
