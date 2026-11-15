import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as echarts from 'echarts'
import raw from './data/models.json'
import meta from './data/meta.json'
import type { ModelPoint, ScaleMode } from './types'
import { buildFamilyLinks, dimColor } from './families'
import { VIEWS, DEFAULT_VIEW, getView, viewExtent, projectX } from './metrics'
import type { ViewId, ViewDef } from './metrics'
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
const Y_MAX = 70

type Row = ModelPoint & {
  /** Plotted x in the current view (cost / seconds / 1÷tps). */
  x: number
  /** Original metric value for tooltips. */
  rawX: number | null
  onFrontier: boolean
  depth: number
}

/**
 * 上游把 OpenAI 的强调色给成 #1f1f1f（近黑），在暗色背景上散点/连线/chip 全部看不见。
 * models.json 由 CI 自动抓取生成，不能手改数据，所以在前端统一覆盖成白色。
 */
const CREATOR_COLOR_OVERRIDE: Record<string, string> = {
  OpenAI: '#ffffff',
}

const ROWS: Row[] = (raw as ModelPoint[])
  .map((m) => ({
    ...m,
    color: CREATOR_COLOR_OVERRIDE[m.creator] ?? m.color,
    x: Math.max(m.costPerTask, COST_FLOOR),
    rawX: m.costPerTask,
    onFrontier: false,
    depth: 0,
  }))
  .sort((a, b) => b.intelligence - a.intelligence)

/**
 * 帕累托深度（非支配排序分层），按当前视图的 x 轴计算：
 *   深度 0 = 前沿，不存在「x 更小（更好）且更聪明」的替代；
 *   剥掉前沿后剩下的点再求一次前沿 = 深度 1，以此类推。
 * 三个视图都保持「左上 = 更好」，所以同一套算法可直接复用。
 */
function assignPareto(rows: Row[]) {
  let pool = [...rows]
  let depth = 0
  while (pool.length) {
    const next: Row[] = []
    for (const a of pool) {
      const dominated = pool.some(
        (b) =>
          b !== a &&
          b.x <= a.x &&
          b.intelligence >= a.intelligence &&
          (b.x < a.x || b.intelligence > a.intelligence),
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
  return Math.max(0, depth - 1)
}

// 初始视图（性价比）先算一次，供模块级常量使用
const INITIAL_MAX_DEPTH = assignPareto(ROWS)

const CREATORS = [...new Set(ROWS.map((r) => r.creator))].sort((a, b) => {
  const ca = ROWS.filter((r) => r.creator === a).length
  const cb = ROWS.filter((r) => r.creator === b).length
  return cb - ca || a.localeCompare(b)
})

const CREATOR_COLOR = new Map(ROWS.map((r) => [r.creator, r.color] as const))
const CREATOR_COUNT = new Map<string, number>()
for (const r of ROWS) CREATOR_COUNT.set(r.creator, (CREATOR_COUNT.get(r.creator) ?? 0) + 1)

/** 标签字号倍率：滑条 0.5×–2.0×，默认 1.0× 正好在中点 */
const LABEL_SCALE_MIN = 0.5
const LABEL_SCALE_MAX = 2
const LABEL_SCALE_STEP = 0.05

/** 比例尺（坐标轴缩放倍率）范围，1× = 全量 */
const ZOOM_MIN = 1
const ZOOM_MAX = 8
const clampZoom = (v: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v))

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
  const [viewId, setViewId] = useState<ViewId>(DEFAULT_VIEW)
  const [scale, setScale] = useState<ScaleMode>('log')
  const [hidden, setHidden] = useState<Set<string>>(() => new Set<string>())
  const [query, setQuery] = useState('')
  // 标签按「帕累托深度」分层：0 = 前沿，越往右加入越外围的点。
  // 宽屏默认右端（全部）；窄屏（<900px，手机/平板/半屏窗口）默认只标前沿层，避免一上来糊成一片。
  const [labelDepth, setLabelDepth] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 900 ? 0 : INITIAL_MAX_DEPTH,
  )
  const [labelScale, setLabelScale] = useState(1)
  const [zoomLevel, setZoomLevel] = useState(ZOOM_MIN)
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

  /**
   * 按当前视图重算每个点的 x、性价比、帕累托深度与前沿。
   * 缺该维度数据的点（如某些模型没有耗时）在本视图里直接不绘制。
   */
  const viewData = useMemo(() => {
    const view = getView(viewId)
    const q = query.trim().toLowerCase()
    const filtered = ROWS.filter((r) => {
      const xv = view.x(r)
      return (
        xv != null &&
        !hidden.has(r.creator) &&
        (!q || r.name.toLowerCase().includes(q) || r.creator.toLowerCase().includes(q))
      )
    })
    const rows: Row[] = filtered.map((r) => {
      const real = view.x(r) as number
      return {
        ...r,
        x: projectX(real, scale),
        rawX: real,
        onFrontier: false,
        depth: 0,
      }
    })
    const maxDepth = assignPareto(rows)
    const xs = rows.map((r) => r.x)
    return {
      view,
      rows,
      maxDepth,
      frontCount: rows.filter((r) => r.depth === 0).length,
      extent: viewExtent(xs, scale),
    }
  }, [viewId, hidden, query, scale])

  const { view, rows: visible, maxDepth: MAX_DEPTH, frontCount: DEPTH_FRONT, extent } = viewData

  const stats = useMemo(() => {
    const best = visible.reduce<Row | null>((a, b) => (!a || b.intelligence > a.intelligence ? b : a), null)
    const cheapest = visible.reduce<Row | null>((a, b) => (!a || b.x < a.x ? b : a), null)
    // 前沿上智能最高的点：三视图都自洽，不会因为量纲变化出现天文数字
    const frontBest = visible
      .filter((r) => r.onFrontier)
      .reduce<Row | null>((a, b) => (!a || b.intelligence > a.intelligence ? b : a), null)
    return { n: visible.length, best, cheapest, frontBest }
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
    const labelFont = (mobile ? 9 : narrow ? 10.5 : 11) * labelScale
    const symbolK = mobile ? 0.8 : narrow ? 0.9 : 1
    // 估算绘图区宽度：用于把贴近右侧边界的标签翻到圆点左边，避免被裁
    const chartW = Math.max(260, vp.w - (narrow ? 26 : 58) - 14)

    // 比例尺：以数据范围为锚点做对称缩放，1× = 全量，8× = 放大到 12.5% 窗口
    const span = 100 / zoomLevel
    const zoomStart = (100 - span) / 2
    const zoomEnd = zoomStart + span

    // 标签优先级 = 帕累托深度：越靠前沿越先出现，深度阈值之外的保持无标签
    const labeled = new Set(visible.filter((r) => r.depth <= labelDepth).map((r) => r.slug))

    const series: unknown[] = []

    if (showFrontier) {
      const frontier = visible.filter((r) => r.onFrontier).sort((a, b) => a.x - b.x)
      series.push({
        name: '帕累托前沿',
        type: 'line',
        data: frontier.map((r) => [r.x, r.intelligence]),
        showSymbol: false,
        lineStyle: { color: 'rgba(125,211,252,0.35)', width: 1.5, type: 'dashed' },
        silent: true,
        z: 1,
      })
    }

    // 同一模型的不同思考档位：细实线，用公司强调色的暗淡版本，明显区别于帕累托虚线
    if (showFamilies) {
      for (const fam of buildFamilyLinks(visible, (r) => r.x)) {
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
        value: [r.x, r.intelligence],
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
          // Keep the thinking tier inside the parentheses (Max / Xhigh / High ...).
          // Only trim Claude's redundant ", Default Fallback" wording.
          return r.name.replace(/,\s*Default Fallback(?=\))/i, '').trim()
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
      // 关闭补间动画：筛选厂商时 setOption(notMerge) 会重建标签，
      // moveOverlap 重新排布后的补间毫无逻辑、标签乱飞，不如直接瞬时切换。
      animation: false,
      grid: {
        left: gridLeft,
        right: gridRight,
        top: mobile ? 12 : 26,
        bottom: mobile ? 30 : 44,
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
            ${line(view.title + ' · X', r.rawX != null ? view.formatX(r.rawX) : '—')}
            ${line('每任务成本', r.costPerTask === 0 ? '$0 (免费)' : fmtUsd(r.costPerTask))}
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
        // 对数模式：数据点 = log10(真实指标) 画在线性轴上，半 decade 一个刻度；
        // 线性模式：数据点 = 真实指标，等距刻度。两者点的分布真实不同。
        type: 'value',
        min: extent.min,
        max: extent.max,
        interval: extent.interval,
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.18)' } },
        axisLabel: {
          color: '#8b93a7',
          fontSize: mobile ? 9.5 : 11,
          formatter: (v: number) =>
            scale === 'log' ? view.formatTickLog(v) : view.formatTickLinear(v),
        },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.055)' } },
      },
      yAxis: {
        type: 'value',
        // 标题不交给 ECharts 竖排（旋转后箭头方向会错），改由 HTML 放在左下角
        min: 0,
        max: Y_MAX,
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.18)' } },
        axisLabel: { color: '#8b93a7', fontSize: mobile ? 9.5 : 11 },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.055)' } },
      },
      // zoomLock:true 关掉 ECharts 内置 pinch（它对每个 touchmove 固定连乘 1.1 倍，
      // 双指稍动就会爆炸式放大）。缩放改由外侧「比例尺」滑条与自定义线性 pinch 控制，
      // 拖拽平移仍由 inside dataZoom 提供。filterMode:none 只改视窗不过滤数据。
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'none',
          zoomOnMouseWheel: false,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
          preventDefaultMouseMove: false,
          zoomLock: true,
          start: zoomStart,
          end: zoomEnd,
          minSpan: 12,
          maxSpan: 100,
        },
        {
          type: 'inside',
          yAxisIndex: 0,
          filterMode: 'none',
          zoomOnMouseWheel: false,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
          preventDefaultMouseMove: false,
          zoomLock: true,
          start: zoomStart,
          end: zoomEnd,
          minSpan: 12,
          maxSpan: 100,
        },
      ],
      series: series as never,
    }
  }, [visible, view, extent, scale, labelDepth, labelScale, zoomLevel, showFrontier, showFamilies, pinned, vp.w, touch])

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
            。共 {visible.length} 个模型在当前维度可绘制 —— 左上角 = 又聪明又{view.id === 'value' ? '便宜' : view.id === 'speed' ? '快' : '高吞吐'}。
            <b>悬停</b>查看完整参数，<b>单击</b>固定详情。
          </p>
        </div>
        <div className="hero-stats">
          <Stat label="入选模型" value={String(stats.n)} />
          <Stat label="最强智能" value={stats.best ? stats.best.intelligence.toFixed(1) : '—'} hint={stats.best?.name} />
          <Stat label={view.id === 'throughput' ? '最快' : view.id === 'speed' ? '最省时' : '最低成本'} value={stats.cheapest && stats.cheapest.rawX != null ? view.formatX(stats.cheapest.rawX) : '—'} hint={stats.cheapest?.name} />
          <Stat label="前沿最强" value={stats.frontBest ? stats.frontBest.intelligence.toFixed(1) : '—'} unit=" 指数" hint={stats.frontBest?.name} />
        </div>
      </header>

      {/* 大号分段 Tab：三个视图一眼可辨，切换后整个坐标系/前沿/标签深度都会重算 */}
      <div className="viewtabs" role="tablist" aria-label="图表维度">
        {VIEWS.map((v, i) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={viewId === v.id}
            className={'viewtab' + (viewId === v.id ? ' on' : '')}
            onClick={() => { setViewId(v.id); setZoomLevel(ZOOM_MIN); setLabelDepth(vp.w < 900 ? 0 : INITIAL_MAX_DEPTH) }}
          >
            <span className="vt-icon" aria-hidden="true">{['＄', '⚡', '⇢'][i]}</span>
            <span className="vt-text">
              <b>{v.title}</b>
              <small>{v.hint}</small>
            </span>
          </button>
        ))}
      </div>

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

        <button
          className="ghost"
          onClick={() => { setZoomLevel(ZOOM_MIN); setZoom((z) => z + 1) }}
          title="恢复完整坐标范围并回到数据中央"
        >
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
        <Chart
          option={option}
          onPick={setPinned}
          zoom={zoom}
          zoomLevel={zoomLevel}
          onZoom={setZoomLevel}
        />
        <aside className={pinned ? 'panel on' : 'panel'}>
          {pinned ? <Detail row={pinned} view={view} onClose={() => setPinned(null)} /> : <Empty />}
        </aside>
        <div className="axis-caption">
          <span className="ac-y">AA 智能指数 ↑</span>
          <span className="ac-x">{view.xLabel}</span>
        </div>
      </div>

      <div className="scalebar">
        <span className="glabel">比例尺</span>
        <button
          className="stepbtn"
          onClick={() => setZoomLevel((z) => clampZoom(+(z - 0.25).toFixed(2)))}
          disabled={zoomLevel <= ZOOM_MIN}
          aria-label="缩小比例尺"
        >
          −
        </button>
        <input
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={0.05}
          value={zoomLevel}
          onChange={(e) => setZoomLevel(clampZoom(Number(e.target.value)))}
          aria-label="坐标缩放倍率"
          title="1× = 全量范围，向右放大；也可滚轮 / 双指缩放"
        />
        <button
          className="stepbtn"
          onClick={() => setZoomLevel((z) => clampZoom(+(z + 0.25).toFixed(2)))}
          disabled={zoomLevel >= ZOOM_MAX}
          aria-label="放大比例尺"
        >
          +
        </button>
        <span className="gdepth">{zoomLevel.toFixed(2)}×</span>
        <button className={'ghost mini' + (zoomLevel === ZOOM_MIN ? ' on' : '')} onClick={() => setZoomLevel(ZOOM_MIN)}>
          复位
        </button>
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

function Chart({
  option,
  onPick,
  zoom,
  zoomLevel,
  onZoom,
}: {
  option: echarts.EChartsOption
  onPick: (r: Row) => void
  zoom: number
  zoomLevel: number
  onZoom: (v: number) => void
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const inst = useRef<echarts.ECharts | null>(null)
  const pick = useRef(onPick)
  pick.current = onPick
  // 平移坐标轴时不要顺手把点选/详情弹出来
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const dragged = useRef(false)
  // 自定义线性双指缩放：记录手势起始指距与起始倍率，按真实距离比例映射
  const pinch = useRef<{ dist: number; level: number } | null>(null)
  const zoomRef = useRef(ZOOM_MIN)
  const onZoomRef = useRef(onZoom)
  onZoomRef.current = onZoom

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
    const distOf = (t: TouchList) =>
      t.length >= 2 ? Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) : 0
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch.current = { dist: distOf(e.touches), level: zoomRef.current }
    }
    const onTouchMove = (e: TouchEvent) => {
      const p = pinch.current
      if (!p || e.touches.length !== 2 || p.dist < 1) return
      // 线性：指距变成 2 倍 => 倍率变成 2 倍，不再是每个 move 连乘 1.1
      const next = clampZoom(p.level * (distOf(e.touches) / p.dist))
      zoomRef.current = next
      onZoomRef.current(next)
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch.current = null
    }
    // 桌面滚轮：平滑指数映射，连续滚动直接累乘到本地 ref，不依赖 React 批处理
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const next = clampZoom(zoomRef.current * Math.exp(-e.deltaY * 0.0015))
      zoomRef.current = next
      onZoomRef.current(next)
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: false })
    const ro = new ResizeObserver(() => chart.resize())
    ro.observe(box.current)
    return () => {
      ro.disconnect()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('wheel', onWheel)
      chart.dispose()
      inst.current = null
    }
  }, [])

  useEffect(() => {
    inst.current?.setOption(option, { notMerge: true })
  }, [option])

  // 保持 pinch 起始倍率与外部状态同步
  useEffect(() => {
    zoomRef.current = zoomLevel
  }, [zoomLevel])

  // 复位：把 dataZoom 的窗口拉回全量范围（跳过首次渲染）
  useEffect(() => {
    if (zoom === 0) return
    inst.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })
  }, [zoom])

  return <div className="chart" ref={box} />
}

function Detail({ row, view, onClose }: { row: Row; view: ViewDef; onClose: () => void }) {
  const items: [string, string][] = [
    ['AA 智能指数', row.intelligence.toFixed(2)],
    ['帕累托深度', row.depth === 0 ? '0（前沿）' : String(row.depth)],
    ['每任务成本', row.costPerTask === 0 ? '$0 (免费)' : fmtUsd(row.costPerTask)],
    [view.title + ' · X', row.rawX != null ? view.formatX(row.rawX) : '—'],
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
      <a className="dlink" href={`https://artificialanalysis.ai/models/${row.linkSlug}`} target="_blank" rel="noreferrer">
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
