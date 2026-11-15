import type { ModelPoint } from './types'
import type { ScaleMode } from './types'

/**
 * View definitions for the three scatter dimensions.
 * Standalone module (like families.ts) so adding a 4th view never touches the chart.
 *
 * Every view keeps AA Intelligence Index on Y. Only X changes, and in ALL views
 * "upper-left = better" holds, so the Pareto / depth / frontier code is reused as-is.
 *
 *   value      -> cost per task (USD)    : smaller is better
 *   speed      -> time per task (s)      : smaller is better
 *   throughput -> ms per output token    : smaller is better (i.e. faster)
 *
 * x() returns the REAL metric. The chart applies log10() only when scale === 'log'
 * (using a linear value axis with decade ticks), otherwise it plots the real value
 * directly on a plain linear axis. Both modes therefore genuinely change the
 * distribution of the points, not just the tick density.
 */

export type ViewId = 'value' | 'speed' | 'throughput'

export interface ViewDef {
  id: ViewId
  title: string
  hint: string
  xLabel: string
  xLabelShort: string
  /** Format the REAL (plotted) metric value for tooltips / detail cards. */
  formatX: (v: number) => string
  /** Format a LOG-mode tick: input is a log10 position. */
  formatTickLog: (logV: number) => string
  /** Format a LINEAR-mode tick: input is the real metric value. */
  formatTickLinear: (v: number) => string
  /** Real x metric (not transformed). null means not plottable in this view. */
  x: (m: ModelPoint) => number | null
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
    formatTickLog: (e) => { const v = p10(e); return v >= 1 ? '$' + v.toFixed(0) : '$' + v.toPrecision(1) },
    formatTickLinear: (v) => '$' + (v >= 10 ? v.toFixed(0) : v.toFixed(1)),
    x: (m) => Math.max(m.costPerTask, 0.005),
  },
  {
    id: 'speed',
    title: '又快又聪明',
    hint: '每任务耗时 × 智能指数',
    xLabel: '每任务耗时 (s)  →',
    xLabelShort: '耗时 s →',
    formatX: (v) => v.toFixed(2) + ' s',
    formatTickLog: (e) => { const v = p10(e); return v >= 1 ? v.toFixed(0) + 's' : v.toPrecision(1) + 's' },
    formatTickLinear: (v) => v.toFixed(1) + 's',
    x: (m) => (m.e2e != null && m.e2e > 0 ? m.e2e : null),
  },
  {
    id: 'throughput',
    // X = outputSpeed (tok/s): the dimension is measured in tokens per second.
    title: '吞吐（token 效率）',
    hint: '输出速度 × 智能指数',
    xLabel: '输出速度 (tok/s)  ←',
    xLabelShort: 'tok/s ←',
    // x (real metric) is ms/tok; display it back as tok/s
    formatX: (v) => (1000 / v).toFixed(0) + ' tok/s',
    // ticks are likewise labelled with the equivalent tok/s (left = faster)
    formatTickLog: (e) => (1000 / p10(e)).toFixed(0) + ' tok/s',
    formatTickLinear: (v) => (1000 / v).toFixed(0) + ' tok/s',
    x: (m) => (m.outputTps != null && m.outputTps > 0 ? 1000 / m.outputTps : null),
  },
]

export const DEFAULT_VIEW: ViewId = 'value'
export const getView = (id: ViewId): ViewDef => VIEWS.find((v) => v.id === id) ?? VIEWS[0]

/** Transform a real metric into the plotted x for the given scale mode. */
export function projectX(real: number, scale: ScaleMode): number {
  return scale === 'log' ? Math.log10(real) : real
}

/** Axis extent for the transformed x values, aligned to the tick grid. */
export function viewExtent(xs: number[], scale: ScaleMode): { min: number; max: number; interval?: number } {
  if (!xs.length) return scale === 'log' ? { min: -3, max: 2, interval: 0.5 } : { min: 0, max: 1 }
  const lo = Math.min(...xs)
  const hi = Math.max(...xs)
  if (scale === 'log') {
    const min = Math.floor(lo * 2) / 2
    const max = Math.ceil(hi * 2) / 2
    return { min, max: max > min ? max : min + 0.5, interval: 0.5 }
  }
  // Plain linear axis: start at 0, cap at a friendly upper bound, let ECharts pick ticks
  return { min: 0, max: hi * 1.08 }
}
