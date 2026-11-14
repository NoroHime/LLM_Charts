/**
 * 从 Artificial Analysis LLM Leaderboard 抓取模型数据并生成前端数据文件。
 *
 * 用法：
 *   npm run refresh                                          # 联网抓取（命中缓存则复用）
 *   node scripts/fetch-models.mjs --force                    # 忽略缓存，强制重新抓取
 *   node scripts/fetch-models.mjs --ttl 24                   # 缓存有效期改为 24 小时
 *   node scripts/fetch-models.mjs --offline                  # 完全离线，只用归档快照
 *   node scripts/fetch-models.mjs --html path/to/page.html   # 用指定 HTML 重放
 *   node scripts/fetch-models.mjs --out src/data/models.json # 指定输出路径
 *
 * 缓存：抓取到的原始 HTML 会存到 .cache/page.html（默认 12 小时内复用），
 *       避免频繁请求上游；上游拉取失败时自动回退到过期缓存或 data/ 下的归档快照。
 *
 * 原理说明见 README.md「数据源与更新」一节。
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const SOURCE_URL = 'https://artificialanalysis.ai/leaderboards/models'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const DEFAULT_TTL_HOURS = 12

/* ---------------- CLI 参数 ---------------- */
const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const OUT = resolve(ROOT, arg('out', 'src/data/models.json'))
const META_OUT = resolve(ROOT, arg('meta', 'src/data/meta.json'))
const CACHE_DIR = resolve(ROOT, arg('cache-dir', '.cache'))
const CACHE_HTML = join(CACHE_DIR, 'page.html')
const CACHE_INFO = join(CACHE_DIR, 'page.json')
const TTL_HOURS = Number(arg('ttl', DEFAULT_TTL_HOURS))
const FORCE = has('force')
const OFFLINE = has('offline')
const HTML_PATH = has('html') ? resolve(process.cwd(), arg('html', '')) : null

const hoursSince = (iso) => (Date.now() - new Date(iso).getTime()) / 36e5

function readCacheInfo() {
  if (!existsSync(CACHE_HTML) || !existsSync(CACHE_INFO)) return null
  try {
    return JSON.parse(readFileSync(CACHE_INFO, 'utf8'))
  } catch {
    return null
  }
}

/** data/ 目录下归档的页面快照，作为最后的兜底 */
function latestArchivedSnapshot() {
  const dir = join(ROOT, 'data')
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('snapshot-') && f.endsWith('.html'))
    .sort()
  return files.length ? join(dir, files[files.length - 1]) : null
}

function useLocal(path, reason) {
  console.log(`· ${reason}：${path}`)
  const info = readCacheInfo()
  return {
    html: readFileSync(path, 'utf8'),
    fetchedAt: info?.url === path ? null : null,
    fromCache: true,
  }
}

/* ---------------- 1. 取页面（带缓存与回退） ---------------- */
async function fetchHtml() {
  if (HTML_PATH) {
    if (!existsSync(HTML_PATH)) throw new Error(`指定的 HTML 不存在：${HTML_PATH}`)
    return { html: readFileSync(HTML_PATH, 'utf8'), fetchedAt: null, fromCache: true }
  }

  const cache = readCacheInfo()

  if (OFFLINE) {
    if (cache) return useLocal(CACHE_HTML, '离线模式，使用缓存页面')
    const snap = latestArchivedSnapshot()
    if (snap) return useLocal(snap, '离线模式，使用归档快照')
    throw new Error('离线模式下既没有缓存也没有归档快照')
  }

  if (!FORCE && cache) {
    const age = hoursSince(cache.fetchedAt)
    if (age < TTL_HOURS) {
      console.log(`· 命中缓存（${age.toFixed(1)}h 前抓取，TTL ${TTL_HOURS}h），跳过请求`)
      return { html: readFileSync(CACHE_HTML, 'utf8'), fetchedAt: cache.fetchedAt, fromCache: true }
    }
    console.log(`· 缓存已过期（${age.toFixed(1)}h ≥ TTL ${TTL_HOURS}h），重新抓取`)
  }

  try {
    console.log(`· 请求 ${SOURCE_URL}`)
    const res = await fetch(SOURCE_URL, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const html = await res.text()
    if (html.length < 50_000) throw new Error(`响应过短（${html.length} 字节），疑似拦截页`)

    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(CACHE_HTML, html)
    const fetchedAt = new Date().toISOString()
    writeFileSync(CACHE_INFO, JSON.stringify({ url: SOURCE_URL, fetchedAt, bytes: html.length }, null, 2))
    console.log(`· 已写入缓存 ${CACHE_HTML}`)
    return { html, fetchedAt, fromCache: false }
  } catch (err) {
    console.warn(`· 抓取失败：${err.message}`)
    if (cache) return useLocal(CACHE_HTML, '回退到过期缓存')
    const snap = latestArchivedSnapshot()
    if (snap) return useLocal(snap, '回退到归档快照')
    throw new Error('抓取失败且无可用缓存/快照')
  }
}

/* ---------------- 2. 解出 RSC flight 载荷 ----------------
 * Next.js App Router 会把 SSR 数据以
 *   self.__next_f.push([1,"<转义后的 JSON 片段>"])
 * 形式内联在 HTML 里。逐个 JSON.parse 再拼接即得到完整 flight 文本。
 */
function extractFlight(html) {
  const re = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g
  const parts = []
  let m
  while ((m = re.exec(html))) {
    try {
      parts.push(JSON.parse(m[1]))
    } catch {
      /* 个别片段可能不完整，跳过 */
    }
  }
  const flight = parts.join('')
  if (!flight) throw new Error('未找到 RSC flight 载荷，页面结构可能已变化')
  return flight
}

/* ---------------- 3. 从 flight 中抠出模型对象 -------------
 * 旧版：模型对象以 {"slug":...,"name":...,"shortName":... 开头，散落在 flight 里。
 * 新版（2026-11）：改为 initialModels:[{...}] 数组，主键变成 id，
 *   slug 挪到嵌套的 release.slug；且 push 片段里的 JSON 带一层反斜杠转义。
 * 两种形状都兼容：优先按对象前缀扫描，扫不到则回退到 initialModels 数组。
 */
function unescapeFlight(text) {
  // 新版片段内层把 " 写成了 \"，需要先还原才能被 JSON.parse 识别
  return text.includes('\\"') ? text.replace(/\\"/g, '"') : text
}

function sliceBalanced(text, start, open, close) {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function extractModels(html) {
  // 新版数据内嵌在 push 片段的转义 JSON 里，extractFlight 未必能覆盖全部片段，
  // 所以直接在整份 HTML 上还原一层转义再定位。
  const text = unescapeFlight(html)
  const byKey = new Map()
  let bad = 0

  const collect = (obj) => {
    if (!obj || typeof obj !== 'object') return
    // 新版同一 release（如 Claude Fable 5.2）下多个思考档位共用 release.slug，
    // 用 name 或 id 做唯一键，避免档位被去重合并；旧版直接用 slug。
    const key = obj.slug ?? obj.id ?? obj.name
    if (!key) return
    if (!byKey.has(key)) byKey.set(key, obj)
  }

  // 路径 A（新版，优先）：initialModels:[...] 整包解析，避免把嵌套子对象误算成模型
  const marker = text.indexOf('"initialModels":[')
  if (marker >= 0) {
    const arrStart = text.indexOf('[', marker)
    const chunk = sliceBalanced(text, arrStart, '[', ']')
    if (chunk) {
      try {
        for (const obj of JSON.parse(chunk)) collect(obj)
      } catch (e) {
        console.log(`· initialModels 解析失败：${e.message}`)
      }
    }
  }

  // 路径 B（旧版，兜底）：散落的 {"slug":...,"name":...,"shortName" 对象
  if (!byKey.size) {
    const startRe = /\{"slug":"[^"]*","name":"[^"]*","shortName"/g
    let m
    while ((m = startRe.exec(text))) {
      const chunk = sliceBalanced(text, m.index, '{', '}')
      if (!chunk) continue
      try { collect(JSON.parse(chunk)) } catch { bad++ }
    }
  }

  if (bad) console.log(`· 跳过 ${bad} 个无法解析的片段`)
  return [...byKey.values()]
}

/* ---------------- 4. 清洗成前端需要的形状 ---------------- */
function toRows(models) {
  return models
    .filter((o) => typeof o.intelligenceIndex === 'number' && typeof o.intelligenceIndexCostPerTask === 'number')
    .map((o) => ({
      // id 是每行唯一的 UUID；release.slug 只用于拼 AA 详情链接（同 release 多档共用）
      slug: o.slug ?? o.id,
      linkSlug: o.slug ?? o.release?.slug ?? o.id,
      name: o.name,
      creator: o.modelCreatorName ?? 'Unknown',
      color: o.modelCreatorColor || '#8b93a7',
      intelligence: +o.intelligenceIndex.toFixed(2),
      costPerTask: o.intelligenceIndexCostPerTask,
      // 新版字段改名：medianOutputTokensPerSecond -> outputSpeed，
      // timeToFirstToken 单位从秒变成毫秒，e2e 由 timePerTask / 速度推算
      outputTps:
        o.outputSpeed != null
          ? +o.outputSpeed.toFixed(1)
          : o.medianOutputTokensPerSecond != null
            ? +o.medianOutputTokensPerSecond.toFixed(1)
            : null,
      ttft:
        o.timeToFirstToken != null
          ? +(o.timeToFirstToken / 1000).toFixed(2)
          : o.medianTimeToFirstTokenSeconds != null
            ? +o.medianTimeToFirstTokenSeconds.toFixed(2)
            : null,
      e2e:
        o.intelligenceIndexTimePerTask != null
          ? +(o.intelligenceIndexTimePerTask / 1000).toFixed(2)
          : o.medianEndToEndResponseTimeSeconds != null
            ? +o.medianEndToEndResponseTimeSeconds.toFixed(2)
            : null,
      context: o.contextWindowTokens ?? null,
      pIn: o.price1mInputTokens ?? null,
      pOut: o.price1mOutputTokens ?? null,
      openWeights: !!o.isOpenWeights,
      reasoning: !!o.isReasoning,
    }))
    .sort((a, b) => b.intelligence - a.intelligence)
}

/* ---------------- 5. 主流程 ---------------- */
const { html, fetchedAt, fromCache } = await fetchHtml()
const flight = extractFlight(html)
const all = extractModels(html.includes('initialModels') ? html : flight)
const rows = toRows(all)

if (rows.length < 10) {
  throw new Error(`只解析到 ${rows.length} 条有效模型，疑似页面结构变化，已中止写入`)
}

const meta = {
  source: SOURCE_URL,
  fetchedAt: fetchedAt ?? new Date().toISOString(),
  generatedAt: new Date().toISOString(),
  fromCache,
  totalModelsOnSite: all.length,
  plottedModels: rows.length,
  metrics: {
    x: 'intelligenceIndexCostPerTask（每任务成本，USD）',
    y: 'intelligenceIndex（AA 智能指数）',
  },
  note: '仅为同时具备两项指标的模型；成本为 0 的免费模型在对数轴上按 0.005 下限绘制。',
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(rows, null, 1) + '\n')
writeFileSync(META_OUT, JSON.stringify(meta, null, 2) + '\n')

console.log(`· 站点模型总数 ${all.length}，可绘制 ${rows.length}`)
console.log(`✓ 已写入 ${OUT}`)
console.log(`✓ 已写入 ${META_OUT}`)
const top = rows.slice(0, 3).map((r) => `${r.name} (${r.intelligence} / $${r.costPerTask.toFixed(2)})`)
console.log('· 智能指数 Top3：' + top.join(' | '))
if (existsSync(CACHE_HTML)) {
  console.log(`· 缓存体积 ${(statSync(CACHE_HTML).size / 1024 / 1024).toFixed(2)} MB`)
}
