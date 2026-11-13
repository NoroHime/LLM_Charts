import type { ModelPoint } from './types'

/**
 * Family grouping for "same model, different thinking tiers" links.
 * Standalone module so the rule can be swapped without touching the chart.
 *
 * Strict rule (per user): the model name WITH its full version number must match
 * exactly; only a trailing thinking-tier suffix may differ.
 *   - "GPT-6.1 Sol (Low)" .. "(Max)"  -> one family (5 points)
 *   - "GPT-6.1 Terra (Low)" .. "(Max)" -> another family (6 points)
 *   - "GPT-6 Luna" and "GPT-6 Astra"   -> DIFFERENT families (never merged)
 *   - "GPT-6" and "GPT-6.1"            -> DIFFERENT versions (never merged)
 * Names without a recognised tier tail are excluded from linking.
 */

export interface FamilyPoint {
  x: number
  y: number
  name: string
  slug: string
}

export interface FamilyLink {
  key: string
  color: string
  points: FamilyPoint[]
}

type PlotRow = ModelPoint & { displayCost: number }

/**
 * Whitelist the effort/reasoning tails. "(0902)" (a date), "(Reasoning)"
 * (a capability flag) and similar are NOT tiers, so they never group.
 */
const TIER =
  /^(.*?)\s*\((?:Max|Xhigh|High|Medium|Low|Non-reasoning)(?:,\s*Default Fallback)?\)\s*$/i

/** Build link groups; only groups with >= 2 visible members produce a line. */
export function buildFamilyLinks(rows: PlotRow[]): FamilyLink[] {
  const groups = new Map<string, PlotRow[]>()
  for (const r of rows) {
    const base = r.name.match(TIER)?.[1]?.trim()
    if (!base) continue
    const key = r.creator + '|' + base.toLowerCase()
    const arr = groups.get(key) ?? []
    arr.push(r)
    groups.set(key, arr)
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length >= 2)
    .map(([key, items]) => ({
      key,
      color: items[0].color,
      // Sort along the x axis so the polyline does not zigzag back and forth.
      points: [...items]
        .sort(
          (a, b) =>
            a.displayCost - b.displayCost ||
            a.intelligence - b.intelligence ||
            a.slug.localeCompare(b.slug),
        )
        .map((r) => ({ x: r.displayCost, y: r.intelligence, name: r.name, slug: r.slug })),
    }))
}

/** Dim the company accent color so links stay quiet in the background. */
export function dimColor(color: string, alpha = 0.4): string {
  const hex = color.trim()
  const m3 = hex.match(/^#([0-9a-f]{3})$/i)
  const m6 = hex.match(/^#([0-9a-f]{6})$/i)
  let r = 139, g = 147, b = 167
  if (m3) {
    r = parseInt(m3[1][0] + m3[1][0], 16)
    g = parseInt(m3[1][1] + m3[1][1], 16)
    b = parseInt(m3[1][2] + m3[1][2], 16)
  } else if (m6) {
    r = parseInt(m6[1].slice(0, 2), 16)
    g = parseInt(m6[1].slice(2, 4), 16)
    b = parseInt(m6[1].slice(4, 6), 16)
  } else {
    const rgb = hex.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i)
    if (rgb) { r = +rgb[1]; g = +rgb[2]; b = +rgb[3] }
  }
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')'
}
