import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts'
import raw from './data/models.json'
import meta from './data/meta.json'
import type { ModelPoint, ScaleMode } from './types'
import { buildFamilyLinks, dimColor } from './families'
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
const X_MIN_LOG = COST_FLOOR
const Y_MAX = 70

type Row = ModelPoint & { displayCost: number; onFrontier: boolean; ratio: number; depth: number }

const ROWS: Row[] = (raw as ModelPoint[])
  .map((m) => ({
    ...m,
    displayCost: Math.max(m.costPerTask, COST_FLOOR),
    onFrontier: false,
    depth: 0,
    ratio: m.intelligence / Math.max(m.costPerTask, COST_FLOOR),
  }))
  .sort((a, b) => b.intelligence - a.intelligence)

/** 坐标轴默认范围与缩放边界（滚轮缩放 / 复位用）
 *  按实际数据最大值向上取整，别让 x 轴右半边空着（旧值固定 100，数据只到 ~26.5） */
const X_MAX = Math.max(1, Math.ceil((Math.max(...ROWS.map((r) => r.displayCost)) * 1.08) / 5) * 5)

/**
 * 帕累托深度（非支配排序分层）：
 *   深度 0 = 帕累托前沿，不存在「更便宜且更聪明」的替代；
 *   把前沿剥掉后剩下的点再求一次前沿 = 深度 1，以此类推。
 * 越是深度大的点，越是被别的模型同时压住（更贵又更笨），标签优先级越低。
 */
;(() => {
  let pool = [...ROWS]
  let depth = 0
  while (pool.length) {
    const next: Row[] = []
    for (const a of pool) {
      const dominated = pool.some(
        (b) =>
          b !== a &&
          b.displayCost <= a.displayCost &&
          b.intelligence >= a.intelligence &&
          (b.displayCost < a.displayCost || b.intelligence > a.intelligence),
      )
      if (dominated) {
        next.push(a)
      } else {
        a.depth = depth
        a.onFrontier = depth === 0
      }
    }
    pool = next
    depth++
  }
})()

const CREATORS = [...new Set(ROWS.map((r) => r.creator))].sort((a, b) => {
  const ca = ROWS.filter((r) => r.creator === a).length
  const cb = ROWS.filter((r) => r.creator === b).length
  return cb - ca || a.localeCompare(b)
})

const CREATOR_COLOR = new Map(ROWS.map((r) => [r.creator, r.color] as const))
const CREATOR_COUNT = new Map<string, number>()
for (const r of ROWS) CREATOR_COUNT.set(r.creator, (CREATOR_COUNT.get(r.creator) ?? 0) + 1)

/** 最大帕累托深度：滑条右端 = 全部标签 */
const MAX_DEPTH = ROWS.reduce((m, r) => Math.max(m, r.depth), 0)
const DEPTH_FRONT = ROWS.filter((r) => r.depth === 0).length

/** 标签字号倍率：滑条 0.5×–2.0×，默认 1.0× 正好在中点 */
const LABEL_SCALE_MIN = 0.5
const LABEL_SCALE_MAX = 2
const LABEL_SCALE_STEP = 0.05

const fmtUsd = (v: number) =>
  v >= 1 ? '$' + v.toFixed(2) : v >= 0.1 ? '$' + v.toFixed(3) : '$' + v.toFixed(4)

const fmtCtx = (v: number | null) => {
  if (v == null) return '—'
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M'
  return Math.round(v / 1024) + 'K'
}

/** 视口尺寸：图表字号、栅格留白、符号大小都跟着它走，窄屏才有合理密度 */
function useViewport() {
  const read = () => ({
    w: typeof window === 'undefined' ? 1560 : window.innerWidth,
    h: typeof window === 'undefined' ? 900 : window.innerHeight,
  })
  const [vp, setVp] = useState(read)
  useEffect(() => {
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setVp(read()))
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])
  return vp
}

export default function App() {
  const vp = useViewport()
  const [scale, setScale] = useState<ScaleMode>('log')
  const [hidden, setHidden] = useState<Set<string>>(() => new Set<string>())
  const [query, setQuery] = useState('')
  // 标签按「帕累托深度」分层：0 = 前沿，越往右加入越外围的点。
  // 宽屏默认右端（全部）；窄屏（<900px，手机/平板/半屏窗口）默认只标前沿层，避免一上来糊成一片。
  const [labelDepth, setLabelDepth] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 900 ? 0 : MAX_DEPTH,
  )
  const [labelScale, setLabelScale] = useState(1)
  const [showFrontier, setShowFrontier] = useState(true)
  const [showFamilies, setShowFamilies] = useState(true)
  const [pinned, setPinned] = useState<Row | null>(null)
  const [zoom, setZoom] = useState(0)
  // 仅用于决定 tooltip 触发方式（触屏点按 / 桌面悬停）；缩放平移两端都开放
  const touch = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(hover: none) and (pointer: coarse)').matches,
    [],
  )

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

  const labeledCount = useMemo(
    () => visible.filter((r) => r.depth <= labelDepth).length,
    [visible, labelDepth],
  )

  const option = useMemo<echarts.EChartsOption>(() => {
    const narrow = vp.w < 900
    const mobile = vp.w < 640
    // 手机端优先把宽度让给绘图区：坐标轴名缩短、留白压到最小
    const gridLeft = mobile ? 34 : narrow ? 56 : 68
    const gridRight = mobile ? 18 : narrow ? 104 : 132
    const gridBottom = mobile ? 30 : 56
    const labelFont = (mobile ? 9 : narrow ? 10.5 : 11) * labelScale
    const symbolK = mobile ? 0.8 : narrow ? 0.9 : 1
    // 估算绘图区宽度：用于把贴近右侧边界的标签翻到圆点左边，避免被裁
    const chartW = Math.max(260, vp.w - (narrow ? 26 : 58) - 14)

    // 标签优先级 = 帕累托深度：越靠前沿越先出现，深度阈值之外的保持无标签
    const labeled = new Set(visible.filter((r) => r.depth <= labelDepth).map((r) => r.slug))

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

    // 同一模型的不同思考档位：细实线，用公司强调色的暗淡版本，明显区别于帕累托虚线
    if (showFamilies) {
      for (const fam of buildFamilyLinks(visible)) {
        series.push({
          name: fam.key,
          type: 'line',
          data: fam.points.map((p) => [p.x, p.y]),
          showSymbol: false,
          symbol: 'none',
          silent: true,
          connectNulls: false,
          lineStyle: {
            color: dimColor(fam.color, 0.55),
            width: 1.6,
            type: 'solid',
            opacity: 1,
            curveness: 0,
          },
          emphasis: { disabled: true },
          tooltip: { show: false },
          z: 2,
        })
      }
    }

    // 所有厂商共用一个 scatter 系列：labelLayout 的避让才能跨厂商全局生效
    series.push({
      name: '模型',
      type: 'scatter',
      data: visible.map((r) => ({
        value: [r.displayCost, r.intelligence],
        row: r,
        itemStyle: { color: r.color },
      })),
      symbolSize: (val: unknown) => {
        const r = (val as { row?: Row }).row
        const base = (9 + Math.min(18, (r?.intelligence ?? 0) * 0.32)) * symbolK
        return r && pinned && r.slug === pinned.slug ? base + 8 : base
      },
      itemStyle: {
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
        distance: mobile ? 4 : 7,
        color: 'rgba(226,232,244,0.88)',
        fontSize: labelFont,
        lineHeight: labelFont + 3 * labelScale,
        formatter: (p: unknown) => {
          const r = (p as { data?: { row?: Row } }).data?.row
          if (!r || !labeled.has(r.slug)) return ''
          return r.name.replace(/\s*\((?:[^)]*fallback[^)]*)\)/i, '').trim()
        },
      },
      // 关键：hideOverlap:false 让标签全部出现；moveOverlap 让重叠的标签上下错位而不是叠死；
      // 贴近右边缘的标签整体翻到圆点左侧，保证不被裁掉。
      labelLayout: (p: unknown) => {
        const rect = (p as { rect?: { x: number; y: number; width: number; height: number } }).rect
        const base = { hideOverlap: false, moveOverlap: 'shiftY' as const }
        if (!rect) return base
        if (rect.x + rect.width > chartW - gridRight * 0.55) {
          return {
            ...base,
            align: 'right' as const,
            x: rect.x - 6,
            y: rect.y + rect.height / 2,
            verticalAlign: 'middle' as const,
          }
        }
        return base
      },
      z: 3,
    })

    return {
      backgroundColor: 'transparent',
      animationDuration: 480,
      grid: {
        left: gridLeft,
        right: gridRight,
        top: mobile ? 12 : 26,
        bottom: gridBottom,
      },
      tooltip: {
        trigger: 'item',
        confine: true,
        triggerOn: touch ? 'click' : 'mousemove|click|mousewheel',
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
            <div class="tt-hint">${touch ? '点空白处关闭' : '单击可固定该模型详情'}</div>
          </div>`
        },
      },
      xAxis: {
        type: scale === 'log' ? 'log' : 'value',
        name: mobile ? '成本 $ →' : '每任务成本 (USD)  →',
        nameLocation: 'middle',
        nameGap: mobile ? 20 : 32,
        nameTextStyle: { color: '#98a1b5', fontSize: mobile ? 10 : 12 },
        min: scale === 'log' ? X_MIN_LOG : 0,
        max: X_MAX,
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.18)' } },
        axisLabel: {
          color: '#8b93a7',
          fontSize: mobile ? 9.5 : 11,
          formatter: (v: number) => (v >= 1 ? '$' + v : v >= 0.01 ? '$' + v.toFixed(2) : '$' + v),
        },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.055)' } },
      },
      yAxis: {
        type: 'value',
        name: mobile ? '智能 ↑' : 'AA 智能指数  ↑',
        nameLocation: 'middle',
        nameGap: mobile ? 24 : 42,
        nameTextStyle: { color: '#98a1b5', fontSize: mobile ? 10 : 12 },
        min: 0,
        max: Y_MAX,
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.18)' } },
        axisLabel: { color: '#8b93a7', fontSize: mobile ? 9.5 : 11 },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.055)' } },
      },
      // 桌面滚轮缩放 / 按住拖拽平移；触屏双指缩放 / 单指拖拽平移。
      // 容器上的 touch-action:none 让图表独占手势，避免与浏览器原生页面缩放双重触发。
      // minSpan 限制最小窗口，防止无限放大后坐标轴飘走。
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'none',
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
          preventDefaultMouseMove: false,
          zoomLock: false,
          startValue: scale === 'log' ? X_MIN_LOG : 0,
          endValue: X_MAX,
          minSpan: 12,
          maxSpan: 100,
          minValueSpan: scale === 'log' ? 0.02 : 0.5,
          maxValueSpan: scale === 'log' ? X_MAX - X_MIN_LOG : X_MAX,
        },
        {
          type: 'inside',
          yAxisIndex: 0,
          filterMode: 'none',
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
          preventDefaultMouseMove: false,
          startValue: 0,
          endValue: Y_MAX,
          minSpan: 12,
          maxSpan: 100,
          minValueSpan: 5,
          maxValueSpan: Y_MAX,
        },
      ],
      series: series as never,
    }
  }, [visible, scale, labelDepth, labelScale, showFrontier, showFamilies, pinned, vp.w, touch])

  const toggleCreator = (c: string) => {
    const next = new Set(hidden)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    setHidden(next)
  }

  /** 反选：当前显示的厂商全部隐藏，已隐藏的全部显示 */
  const invertCreators = () => {
    const next = new Set<string>()
    for (const c of CREATORS) if (!hidden.has(c)) next.add(c)
    setHidden(next)
  }

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

        <div className="group lblgroup">
          <span className="glabel">标签深度</span>
          <div className="lblctl">
            <button
              className="stepbtn"
              onClick={() => setLabelDepth(Math.max(0, labelDepth - 1))}
              disabled={labelDepth <= 0}
              aria-label="只保留更靠近帕累托前沿的标签"
            >
              −
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(MAX_DEPTH, 1)}
              step={1}
              value={labelDepth}
              onChange={(e) => setLabelDepth(Number(e.target.value))}
              aria-label="标签显示到第几层帕累托深度"
              title={'0 = 只标帕累托前沿点，向右逐层加入被支配的模型'}
            />
            <button
              className="stepbtn"
              onClick={() => setLabelDepth(Math.min(MAX_DEPTH, labelDepth + 1))}
              disabled={labelDepth >= MAX_DEPTH}
              aria-label="再展开一层"
            >
              +
            </button>
          </div>
          <span className="gdepth" title={'帕累托深度 0 = 前沿，共 ' + DEPTH_FRONT + ' 个点'}>
            {labelDepth === 0 ? '仅前沿' : '≤' + labelDepth + ' 层'}
          </span>
          <span className="gval" title="已标名 / 当前筛选出的模型数">
            {labeledCount}/{visible.length}
          </span>
          <button
            className={'ghost mini' + (labelDepth >= MAX_DEPTH ? ' on' : '')}
            onClick={() => setLabelDepth(MAX_DEPTH)}
            title="显示全部入选模型的标签"
          >
            全部
          </button>
        </div>

        <div className="group fontgroup">
          <span className="glabel">标签字号</span>
          <div className="lblctl">
            <button
              className="stepbtn"
              onClick={() => setLabelScale((s) => Math.max(LABEL_SCALE_MIN, +(s - LABEL_SCALE_STEP).toFixed(2)))}
              disabled={labelScale <= LABEL_SCALE_MIN}
              aria-label="缩小标签字号"
            >
              −
            </button>
            <input
              type="range"
              min={LABEL_SCALE_MIN}
              max={LABEL_SCALE_MAX}
              step={LABEL_SCALE_STEP}
              value={labelScale}
              onChange={(e) => setLabelScale(Number(e.target.value))}
              aria-label="标签字号倍率"
              title="0.5× – 2.0×，默认 1.0×"
            />
            <button
              className="stepbtn"
              onClick={() => setLabelScale((s) => Math.min(LABEL_SCALE_MAX, +(s + LABEL_SCALE_STEP).toFixed(2)))}
              disabled={labelScale >= LABEL_SCALE_MAX}
              aria-label="放大标签字号"
            >
              +
            </button>
          </div>
          <span className="gdepth">{labelScale.toFixed(2)}×</span>
          <button
            className={'ghost mini' + (labelScale === 1 ? ' on' : '')}
            onClick={() => setLabelScale(1)}
            title="恢复默认字号"
          >
            默认
          </button>
        </div>

        <div className="group grow">
          <input className="search" placeholder="搜索模型或厂商…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        <label className="switch">
          <input type="checkbox" checked={showFrontier} onChange={(e) => setShowFrontier(e.target.checked)} />
          <span>帕累托前沿</span>
        </label>

        <label className="switch">
          <input type="checkbox" checked={showFamilies} onChange={(e) => setShowFamilies(e.target.checked)} />
          <span>档位连线</span>
        </label>

        <button className="ghost" onClick={() => setZoom((z) => z + 1)} title="滚轮缩放后恢复完整坐标范围">
          缩放复位
        </button>

        <div className="group btnrow">
          <button className="ghost" onClick={invertCreators} title="显示的厂商全部隐藏，隐藏的全部显示">
            反选厂商
          </button>
          <button className="ghost" onClick={() => setHidden(new Set<string>())} disabled={hidden.size === 0}>
            重置厂商
          </button>
          <button className="ghost" onClick={() => downloadPng(scale)}>
            导出 PNG
          </button>
        </div>
      </div>

      <div className="chips">
        {CREATORS.map((c) => {
          const off = hidden.has(c)
          return (
            <button key={c} className={'chip' + (off ? ' off' : '')} onClick={() => toggleCreator(c)}>
              <i style={{ background: CREATOR_COLOR.get(c) }} />
              {c}
              <em className="cn">{CREATOR_COUNT.get(c) ?? 0}</em>
            </button>
          )
        })}
      </div>

      <div className="board">
        <Chart option={option} onPick={setPinned} zoom={zoom} />
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

function Chart({ option, onPick, zoom }: { option: echarts.EChartsOption; onPick: (r: Row) => void; zoom: number }) {
  const box = useRef<HTMLDivElement | null>(null)
  const inst = useRef<echarts.ECharts | null>(null)
  const pick = useRef(onPick)
  pick.current = onPick
  // 平移坐标轴时不要顺手把点选/详情弹出来
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const dragged = useRef(false)

  useLayoutEffect(() => {
    if (!box.current) return
    const chart = echarts.init(box.current, undefined, { renderer: 'canvas' })
    inst.current = chart
    chartInstance = chart
    chart.on('click', (p: unknown) => {
      if (dragged.current) return
      const r = (p as { data?: { row?: Row } }).data?.row
      if (r) pick.current(r)
    })
    const el = box.current
    const onDown = (e: PointerEvent) => {
      dragStart.current = { x: e.clientX, y: e.clientY }
      dragged.current = false
    }
    const onMove = (e: PointerEvent) => {
      const s = dragStart.current
      if (!s) return
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 6) dragged.current = true
    }
    const onUp = () => {
      dragStart.current = null
      // 让 click 事件先跑完再清标记
      window.setTimeout(() => { dragged.current = false }, 0)
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(box.current)
    return () => {
      ro.disconnect()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      chart.dispose()
      inst.current = null
    }
  }, [])

  useEffect(() => {
    inst.current?.setOption(option, { notMerge: true })
  }, [option])

  // 复位：把 dataZoom 的窗口拉回全量范围（跳过首次渲染）
  useEffect(() => {
    if (zoom === 0) return
    inst.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
  }, [zoom])

  return <div className="chart" ref={box} />
}

function Detail({ row, onClose }: { row: Row; onClose: () => void }) {
  const items: [string, string][] = [
    ['AA 智能指数', row.intelligence.toFixed(2)],
    ['帕累托深度', row.depth === 0 ? '0（前沿）' : String(row.depth)],
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
        <li>
          <b>标签深度</b>：0 层 = 只标前沿，向右逐层放开外围点
        </li>
        <li>
          <b>滚轮</b>缩放坐标轴，<b>拖拽</b>平移；右上角「缩放复位」还原
        </li>
      </ul>
    </div>
  )
}
