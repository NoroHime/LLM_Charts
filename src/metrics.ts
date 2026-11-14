import type { ModelPoint } from './types'

/**
 * View definitions for the three scatter dimensions.
 * Standalone module (like families.ts) so adding a 4th view never touches the chart.
 *
 * Every view keeps AA Intelligence Index on Y. Only X changes, and in ALL views
 * "upper-left = better" holds, so the Pareto / depth / frontier code is reused as-is.
 *
 *   value      -> cost per task (USD)       : smaller is better
 *   speed      -> time per task (seconds)   : smaller is better
 *   throughput -> ms per output token       : smaller is better (i.e. faster)
 *
 * The chart uses a LINEAR value axis whose ticks are log10 of the real value;
 * we return ticks as log-space positions and format them back to human units.
 * This is more reliable than ECharts' built-in 'log' axis, which emits no
 * labels for narrow ranges like 2–30 ms/tok.
 */

export type ViewId = 'value' | 'speed' | 'throughput'

export interface ViewDef {
  id: ViewId
  title: string
  hint: string
  xLabel: string
  xLabelShort: string
  /** Format the ORIGINAL metric value for tooltips / detail cards. */
  formatX: (v: number) => string
  /** Format an axis tick given a LOG10 position. */
  formatTick: (logV: number) => string
  /** Plotted x = log10(real metric). null means not plottable in this view. */
  x: (m: ModelPoint) => number | null
  /** Original (display) metric value for tooltips. */
  raw: (m: ModelPoint) => number | null
}

const fmtUsd = (v: number) => (v >= 1 ? '$' + v.toFixed(2) : v >= 0.1 ? '$' + v.toFixed(3) : '$' + v.toFixed(4))
const p10 = (e: number) => Math.pow(10, e)

export const VIEWS: ViewDef[] = [
  {
    id: 'value',
    title: '性价比',
    hint: '每任务成本 × 智能指数',
    xLabel: '每任务成本 (USD)  →',
    xLabelShort: '成本 $ →',
    formatX: (v) => (v === 0 ? '$0 (免费)' : fmtUsd(v)),
    formatTick: (e) => { const v = p10(e); return v >= 1 ? '$' + v.toFixed(0) : '$' + v.toPrecision(1) },
    x: (m) => Math.log10(Math.max(m.costPerTask, 0.005)),
    raw: (m) => m.costPerTask,
  },
  {
    id: 'speed',
    title: '又快又聪明',
    hint: '每任务耗时 × 智能指数',
    xLabel: '每任务耗时 (s)  →',
    xLabelShort: '耗时 s →',
    formatX: (v) => v.toFixed(2) + ' s',
    formatTick: (e) => { const v = p10(e); return v >= 1 ? v.toFixed(0) + 's' : v.toPrecision(1) + 's' },
    x: (m) => (m.e2e != null && m.e2e > 0 ? Math.log10(m.e2e) : null),
    raw: (m) => m.e2e,
  },
  {
    id: 'throughput',
    title: '吞吐',
    hint: '输出速度 × 智能指数',
    xLabel: '输出速度 (tok/s)  ←',
    xLabelShort: 'tok/s ←',
    formatX: (v) => v.toFixed(0) + ' tok/s',
    // x is log10(ms/tok); the label shows the equivalent tok/s
    formatTick: (e) => (1000 / p10(e)).toFixed(0) + ' tok/s',
    x: (m) => (m.outputTps != null && m.outputTps > 0 ? Math.log10(1000 / m.outputTps) : null),
    raw: (m) => m.outputTps,
  },
]

export const DEFAULT_VIEW: ViewId = 'value'
export const getView = (id: ViewId): ViewDef => VIEWS.find((v) => v.id === id) ?? VIEWS[0]

/** Linear-axis extent in log10 space, aligned to the 0.5 tick grid. */
export function viewExtent(xs: number[]): { min: number; max: number } {
  if (!xs.length) return { min: -3, max: 2 }
  // Snap to half-decades so interval:0.5 ticks land exactly on grid lines.
  const min = Math.floor(Math.min(...xs) * 2) / 2
  const max = Math.ceil(Math.max(...xs) * 2) / 2
  return { min, max: max > min ? max : min + 0.5 }
}
