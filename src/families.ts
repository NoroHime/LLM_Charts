import type { ModelPoint } from './types'

/**
 * Family grouping for the "same model, different thinking tiers" links.
 * Standalone module: the grouping rule can be swapped without touching the chart.
 *
 * Rule (per user): creator + model name + FULL numeric version is enough.
 *   - "GPT-6 Luna (Low)" and "GPT-6 Astra (Max)" share "GPT-6" -> linked.
 *   - "GPT-6.1 Sol (High)" and "GPT-6.1 Terra (Max)" share "GPT-6.1" -> linked.
 *   - "GPT-6" and "GPT-6.1" are DIFFERENT versions -> never merged.
 * Grade subtitles after the version (Luna / Terra / Sol / Astra ...) are different
 * grades of the same model family, so they are intentionally grouped together.
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

/** Strip a trailing tier tail such as "(Max, Default Fallback)" or "(Non-reasoning)". */
function stripTier(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim()
}

/** Keep brand + full version; drop the grade subtitle after it. */
function familyKey(r: PlotRow): string {
  const base = stripTier(r.name)
  // Capture up to the last standalone numeric version (6, 6.1, 5.2, 4.7, 3.8 ...).
  const m = base.match(/^(.*?\d+(?:\.\d+)?)\s+(.+)$/)
  const stem = (m ? m[1] : base).toLowerCase().replace(/[\s._-]+$/, '')
  return r.creator + '|' + stem
}

/** Build link groups; only groups with >= 2 visible members produce a line. */
export function buildFamilyLinks(rows: PlotRow[]): FamilyLink[] {
  const groups = new Map<string, PlotRow[]>()
  for (const r of rows) {
    const k = familyKey(r)
    const arr = groups.get(k) ?? []
    arr.push(r)
    groups.set(k, arr)
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
export function dimColor(color: string, alpha = 0.22): string {
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
