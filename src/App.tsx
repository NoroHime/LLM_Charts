import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts'
import raw from './data/models.json'
import meta from './data/meta.json'
import type { ModelPoint, ScaleMode } from './types'
import './app.css'

const FETCHED_AT = new Date(meta.fetchedAt).toLocaleString('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** 免费模型成本为 0，对数轴无法表示，统一抬到下限 */
const COST_FLOOR = 0.005

type Row = ModelPoint & { displayCost: number; onFrontier: boolean; ratio: number }

const ROWS: Row[] = (raw as ModelPoint[])
  .map((m) => ({
    ...m,
    displayCost: Math.max(m.costPerTask, COST_FLOOR),
    onFrontier: false,
    ratio: m.intelligence / Math.max(m.costPerTask, COST_FLOOR),
  }))
  .sort((a, b) => b.intelligence - a.intelligence)

/** 帕累托前沿：按成本升序扫描，智能指数刷新最高值即为前沿点 */
;(() => {
  const sorted = [...ROWS].sort((a, b) => a.displayCost - b.displayCost || b.intelligence - a.intelligence)
  let best = -Infinity
  for (const r of sorted) {
    if (r.intelligence > best) {
      r.onFrontier = true
      best = r.intelligence
    }
  }
})()

const CREATORS = [...new Set(ROWS.map((r) => r.creator))].sort((a, b) => {
  const ca = ROWS.filter((r) => r.creator === a).length
  const cb = ROWS.filter((r) => r.creator === b).length
  return cb - ca || a.localeCompare(b)
})

const fmtUsd = (v: number) =>
  v >= 1 ? '$' + v.toFixed(2) : v >= 0.1 ? '$' + v.toFixed(3) : '$' + v.toFixed(4)

const fmtCtx = (v: number | null) => {
  if (v == null) return '—'
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M'
  return Math.round(v / 1024) + 'K'
}

export default function App() {
  const [scale, setScale] = useState<ScaleMode>('log')
  const [hidden, setHidden] = useState<Set<string>>(() => new Set<string>())
  const [query, setQuery] = useState('')
  const [labelTop, setLabelTop] = useState(14)
  const [showFrontier, setShowFrontier] = useState(true)
  const [pinned, setPinned] = useState<Row | null>(null)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return ROWS.filter(
      (r) =>
        !hidden.has(r.creator) &&
        (!q || r.name.toLowerCase().includes(q) || r.creator.toLowerCase().includes(q)),
    )
  }, [hidden, query])

  const stats = useMemo(() => {
    const best = visible.reduce<Row | null>((a, b) => (!a || b.intelligence > a.intelligence ? b : a), null)
    const cheapest = visible.reduce<Row | null>((a, b) => (!a || b.displayCost < a.displayCost ? b : a), null)
    const value = visible.reduce<Row | null>((a, b) => (!a || b.ratio > a.ratio ? b : a), null)
    return { n: visible.length, best, cheapest, value }
  }, [visible])

  const option = useMemo<echarts.EChartsOption>(() => {
    const byCreator = new Map<string, Row[]>()
    for (const r of visible) {
      const arr = byCreator.get(r.creator) ?? []
      arr.push(r)
      byCreator.set(r.creator, arr)
    }
    const labeled = new Set(
      [...visible].sort((a, b) => b.intelligence - a.intelligence).slice(0, labelTop).map((r) => r.slug),
    )

    const series: unknown[] = []

    if (showFrontier) {
      const frontier = visible.filter((r) => r.onFrontier).sort((a, b) => a.displayCost - b.displayCost)
      series.push({
        name: '帕累托前沿',
        type: 'line',
        data: frontier.map((r) => [r.displayCost, r.intelligence]),
        showSymbol: false,
        lineStyle: { color: 'rgba(125,211,252,0.35)', width: 1.5, type: 'dashed' },
        silent: true,
        z: 1,
      })
    }

    for (const [creator, rows] of byCreator) {
      series.push({
        name: creator,
        type: 'scatter',
        data: rows.map((r) => ({ value: [r.displayCost, r.intelligence], row: r })),
        symbolSize: (val: unknown) => {
          const r = (val as { row?: Row }).row
          const base = 9 + Math.min(18, (r?.intelligence ?? 0) * 0.32)
          return r && pinned && r.slug === pinned.slug ? base + 8 : base
        },
        itemStyle: {
          color: rows[0]?.color ?? '#888',
          opacity: 0.92,
          borderColor: 'rgba(255,255,255,0.3)',
          borderWidth: 1,
        },
        emphasis: {
          scale: 1.4,
          itemStyle: { borderColor: '#fff', borderWidth: 2, shadowBlur: 16, shadowColor: 'rgba(255,255,255,0.45)' },
        },
        label: {
          show: true,
          position: 'right',
          distance: 7,
          color: 'rgba(226,232,244,0.85)',
          fontSize: 11,
          formatter: (p: unknown) => {
            const r = (p as { data?: { row?: Row } }).data?.row
            if (!r || !labeled.has(r.slug)) return ''
            return r.name.replace(/\s*\((?:[^)]*fallback[^)]*)\)/i, '').trim()
          },
        },
        labelLayout: { hideOverlap: true },
        z: 3,
      })
    }

    return {
      backgroundColor: 'transparent',
      animationDuration: 480,
      grid: { left: 68, right: 110, top: 30, bottom: 64 },
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(15,18,26,0.96)',
        borderColor: 'rgba(255,255,255,0.14)',
        borderWidth: 1,
        padding: [10, 12],
        extraCssText:
          'backdrop-filter:blur(8px);box-shadow:0 14px 36px rgba(0,0,0,.55);border-radius:10px;',
        formatter: (p: unknown) => {
          const r = (p as { data?: { row?: Row } }).data?.row
          if (!r) return ''
          const line = (k: string, v: string) =>
            `<div class="tt-row"><span>${k}</span><b>${v}</b></div>`
          const tag = (t: string, c: string) =>
            `<span class="tt-tag" style="background:${c}22;color:${c};border-color:${c}55">${t}</span>`
          return `<div class="tt">
            <div class="tt-title">${r.name}</div>
            <div class="tt-tags">${tag(r.creator, r.color)}${
              r.openWeights ? tag('开源权重', '#4ade80') : ''
            }${r.reasoning ? tag('推理模型', '#a78bfa') : ''}${
              r.onFrontier ? tag('帕累托前沿', '#7dd3fc') : ''
            }</div>
            ${line('AA 智能指数', r.intelligence.toFixed(1))}
            ${line('每任务成本', r.costPerTask === 0 ? '$0 (免费)' : fmtUsd(r.costPerTask))}
            ${line('性价比', r.ratio.toFixed(1) + ' 指数/$')}
            <div class="tt-sep"></div>
            ${line('输出速度', r.outputTps ? r.outputTps.toFixed(0) + ' tok/s' : '—')}
            ${line('首字延迟', r.ttft != null ? r.ttft.toFixed(2) + ' s' : '—')}
            ${line('端到端响应', r.e2e != null ? r.e2e.toFixed(2) + ' s' : '—')}
            ${line('上下文窗口', fmtCtx(r.context))}
            ${line('价格 /1M 进·出', (r.pIn != null ? '$' + r.pIn : '—') + ' · ' + (r.pOut != null ? '$' + r.pOut : '—'))}
            <div class="tt-hint">单击可固定该模型详情</div>
          </div>`
        },
      },
      legend: {
        type: 'scroll',
        bottom: 8,
        left: 24,
        right: 24,
        itemWidth: 9,
        itemHeight: 9,
        itemGap: 12,
        textStyle: { color: '#98a1b5', fontSize: 11 },
        inactiveColor: '#39404f',
        pageIconColor: '#98a1b5',
        pageTextStyle: { color: '#98a1b5' },
      },
      xAxis: {
        type: scale === 'log' ? 'log' : 'value',
        name: '每任务成本 (USD)  →',
        nameLocation: 'middle',
        nameGap: 32,
        nameTextStyle: { color: '#98a1b5', fontSize: 12 },
        min: scale === 'log' ? COST_FLOOR : 0,
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.18)' } },
        axisLabel: {
          color: '#8b93a7',
          fontSize: 11,
          formatter: (v: number) => (v >= 1 ? '$' + v : v >= 0.01 ? '$' + v.toFixed(2) : '$' + v),
        },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.055)' } },
      },
      yAxis: {
        type: 'value',
        name: 'AA 智能指数  ↑',
        nameLocation: 'middle',
        nameGap: 42,
        nameTextStyle: { color: '#98a1b5', fontSize: 12 },
        min: 0,
        max: (v: { max: number }) => Math.ceil((v.max + 4) / 5) * 5,
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.18)' } },
        axisLabel: { color: '#8b93a7', fontSize: 11 },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.055)' } },
      },
      series: series as never,
    }
  }, [visible, scale, labelTop, showFrontier, pinned])

  return (
    <div className="page">
      <header className="hero">
        <div className="hero-main">
          <h1>
            LLM 性价比图鉴 <span className="sep">/</span> <em>每任务成本 × AA 智能指数</em>
          </h1>
          <p className="sub">
            数据源：
            <a href="https://artificialanalysis.ai/leaderboards/models" target="_blank" rel="noreferrer">
              Artificial Analysis · LLM Leaderboard
            </a>
            。共 {ROWS.length} 个同时具备两项指标的模型 —— 左上角 = 又聪明又便宜。
            <b>悬停</b>查看完整参数，<b>单击</b>固定详情。
          </p>
        </div>
        <div className="hero-stats">
          <Stat label="入选模型" value={String(stats.n)} />
          <Stat label="最强智能" value={stats.best ? stats.best.intelligence.toFixed(1) : '—'} hint={stats.best?.name} />
          <Stat label="最低成本" value={stats.cheapest ? fmtUsd(stats.cheapest.displayCost) : '—'} hint={stats.cheapest?.name} />
          <Stat label="最佳性价比" value={stats.value ? stats.value.ratio.toFixed(0) : '—'} unit=" 指数/$" hint={stats.value?.name} />
        </div>
      </header>

      <div className="toolbar">
        <div className="group">
          <span className="glabel">X 轴</span>
          <div className="seg">
            <button className={scale === 'log' ? 'on' : ''} onClick={() => setScale('log')}>
              对数
            </button>
            <button className={scale === 'linear' ? 'on' : ''} onClick={() => setScale('linear')}>
              线性
            </button>
          </div>
        </div>

        <div className="group">
          <span className="glabel">直显标签</span>
          <input type="range" min={0} max={40} value={labelTop} onChange={(e) => setLabelTop(Number(e.target.value))} />
          <span className="gval">{labelTop}</span>
        </div>

        <div className="group grow">
          <input className="search" placeholder="搜索模型或厂商…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        <label className="switch">
          <input type="checkbox" checked={showFrontier} onChange={(e) => setShowFrontier(e.target.checked)} />
          <span>帕累托前沿</span>
        </label>

        <button className="ghost" onClick={() => setHidden(new Set<string>())}>
          重置厂商
        </button>

        <button className="ghost" onClick={() => downloadPng(scale)}>
          导出 PNG
        </button>
      </div>

      <div className="chips">
        {CREATORS.map((c) => {
          const off = hidden.has(c)
          const color = ROWS.find((r) => r.creator === c)!.color
          return (
            <button
              key={c}
              className={'chip' + (off ? ' off' : '')}
              onClick={() => {
                const n = new Set(hidden)
                if (n.has(c)) n.delete(c)
                else n.add(c)
                setHidden(n)
              }}
            >
              <i style={{ background: color }} />
              {c}
            </button>
          )
        })}
      </div>

      <div className="board">
        <Chart option={option} onPick={setPinned} />
        <aside className={pinned ? 'panel on' : 'panel'}>
          {pinned ? <Detail row={pinned} onClose={() => setPinned(null)} /> : <Empty />}
        </aside>
      </div>

      <footer className="foot">
        全站 {meta.totalModelsOnSite} 个模型中，{meta.plottedModels} 个两项指标齐全 · 免费模型（每任务成本 $0）在对数轴上按 $
        {COST_FLOOR} 下限绘制 · 数据快照：{FETCHED_AT} · 执行 <code>npm run refresh</code> 可更新
      </footer>
    </div>
  )
}

function Stat({ label, value, hint, unit }: { label: string; value: string; hint?: string; unit?: string }) {
  return (
    <div className="stat">
      <span className="sl">{label}</span>
      <span className="sv">
        {value}
        {unit && <em>{unit}</em>}
      </span>
      {hint && <span className="sh">{hint}</span>}
    </div>
  )
}

/** 供「导出 PNG」使用的当前图表实例 */
let chartInstance: echarts.ECharts | null = null

function downloadPng(scale: ScaleMode) {
  if (!chartInstance) return
  const url = chartInstance.getDataURL({
    type: 'png',
    pixelRatio: 3,
    backgroundColor: '#0b0d13',
    excludeComponents: ['toolbox', 'dataZoom'],
  })
  const a = document.createElement('a')
  a.href = url
  a.download = `llm-cost-vs-intelligence-${scale}-${ROWS.length}models.png`
  a.click()
}

function Chart({ option, onPick }: { option: echarts.EChartsOption; onPick: (r: Row) => void }) {
  const box = useRef<HTMLDivElement | null>(null)
  const inst = useRef<echarts.ECharts | null>(null)
  const pick = useRef(onPick)
  pick.current = onPick

  useLayoutEffect(() => {
    if (!box.current) return
    const chart = echarts.init(box.current, undefined, { renderer: 'canvas' })
    inst.current = chart
    chartInstance = chart
    chart.on('click', (p: unknown) => {
      const r = (p as { data?: { row?: Row } }).data?.row
      if (r) pick.current(r)
    })
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(box.current)
    return () => {
      ro.disconnect()
      chart.dispose()
      inst.current = null
    }
  }, [])

  useEffect(() => {
    inst.current?.setOption(option, { notMerge: true })
  }, [option])

  return <div className="chart" ref={box} />
}

function Detail({ row, onClose }: { row: Row; onClose: () => void }) {
  const items: [string, string][] = [
    ['AA 智能指数', row.intelligence.toFixed(2)],
    ['每任务成本', row.costPerTask === 0 ? '$0 (免费)' : fmtUsd(row.costPerTask)],
    ['性价比', row.ratio.toFixed(1) + ' 指数/$'],
    ['输出速度', row.outputTps ? row.outputTps.toFixed(1) + ' tok/s' : '—'],
    ['首字延迟', row.ttft != null ? row.ttft.toFixed(2) + ' s' : '—'],
    ['端到端响应', row.e2e != null ? row.e2e.toFixed(2) + ' s' : '—'],
    ['上下文窗口', fmtCtx(row.context)],
    ['输入价格 /1M', row.pIn != null ? '$' + row.pIn : '—'],
    ['输出价格 /1M', row.pOut != null ? '$' + row.pOut : '—'],
  ]
  return (
    <div className="detail">
      <div className="dhead">
        <span className="ddot" style={{ background: row.color }} />
        <div className="dtitle">
          <h3>{row.name}</h3>
          <span>{row.creator}</span>
        </div>
        <button className="x" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
      <div className="dtags">
        {row.onFrontier && <span className="tag t1">帕累托前沿</span>}
        {row.openWeights && <span className="tag t2">开源权重</span>}
        {row.reasoning && <span className="tag t3">推理模型</span>}
      </div>
      <dl>
        {items.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <a className="dlink" href={`https://artificialanalysis.ai/models/${row.slug}`} target="_blank" rel="noreferrer">
        在 Artificial Analysis 查看 →
      </a>
    </div>
  )
}

function Empty() {
  return (
    <div className="empty">
      <div className="eicon">◎</div>
      <p className="etip">
        <b>悬停</b>任意圆点查看完整指标
        <br />
        <b>单击</b>把详情固定在这里
      </p>
      <ul>
        <li>
          越靠<b>上</b> → AA 智能指数越高
        </li>
        <li>
          越靠<b>左</b> → 每任务成本越低
        </li>
        <li>
          虚线为<b>帕累托前沿</b>，线上即最优取舍
        </li>
      </ul>
    </div>
  )
}
