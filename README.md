# LLM 性价比图鉴 · 每任务成本 × AA 智能指数

> **在线地址：https://NoroHime.github.io/LLM_Charts/**
> **源码仓库：https://github.com/NoroHime/LLM_Charts**

[![Deploy](https://github.com/NoroHime/LLM_Charts/actions/workflows/deploy.yml/badge.svg)](https://github.com/NoroHime/LLM_Charts/actions/workflows/deploy.yml)
[![Pages](https://img.shields.io/badge/GitHub%20Pages-live-4bc0fd?logo=github)](https://NoroHime.github.io/LLM_Charts/)
[![Data](https://img.shields.io/badge/data-Artificial%20Analysis-8b5cf6)](https://artificialanalysis.ai/leaderboards/models)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

以 [Artificial Analysis LLM Leaderboard](https://artificialanalysis.ai/leaderboards/models) 为数据源，把
**每任务成本（Cost per Task, USD）** 作为 X 轴、**AA 智能指数（Artificial Analysis Intelligence Index）** 作为 Y 轴
绘制散点图。左上方 = 又聪明又便宜。

技术栈：Vite 8 + React 19 + TypeScript 7 + ECharts 6（暗色主题）。

---

## 快速开始

```bash
git clone https://github.com/NoroHime/LLM_Charts.git
cd LLM_Charts
npm install
npm run dev        # http://127.0.0.1:5173
npm run update     # 抓数据（带缓存）→ 构建，等同于 CI 每次 run 做的事
npm run build      # 只构建，输出到 dist/（base 为 /LLM_Charts/）
```

本地想验证 Pages 产物：`npm run preview`（Vite 会按 `/LLM_Charts/` 提供）。

---

## 页面功能

| 能力 | 说明 |
| --- | --- |
| 悬停详情 | 鼠标悬停任意圆点弹出完整指标卡：智能指数、每任务成本、性价比、输出速度、首字延迟、端到端响应、上下文窗口、输入/输出单价 |
| 单击固定 | 单击圆点把详情固定到右侧面板，可点 × 取消 |
| X 轴对数/线性 | 成本跨近 4 个数量级（$0.005 – $26.54），默认对数轴；可切线性看绝对值差异 |
| 直显标签 | 按智能指数取前 N 个模型直接标名。**默认为最大值（全部入选模型）**，重叠的由 ECharts 自动隐藏；滑块上限 = 当前筛选出的模型数，显示 `已选/总数` |
| 厂商过滤 | 顶部 chips 点选；底部 legend 亦可点选 |
| 搜索 | 按模型名或厂商名过滤 |
| 帕累托前沿 | 虚线连接"不存在更便宜且更聪明替代品"的模型，即最优取舍边界 |
| 导出 PNG | 3x 像素比导出高清静态图 |

**为什么需要悬停**：96 个数据点全部平铺标签必然重叠，因此默认只标 Top N，其余靠悬停查看；需要纯静态图时用「导出 PNG」。

---

## GitHub Pages 部署与自动更新

站点由 `.github/workflows/deploy.yml` 自动发布到
**https://NoroHime.github.io/LLM_Charts/**。

### 仓库分支结构

同一个仓库里同时保留**源码**与**静态产物**，各占一条分支：

| 分支 | 内容 | 维护方式 |
| --- | --- | --- |
| `main` | 源码（Vite + React + TS）、抓取脚本、`src/data/*.json` 数据快照 | 人工改代码；数据由 CI 自动提交 |
| `gh-pages` | `dist/` 的完整构建产物（含 `.nojekyll`、`BUILD_INFO.txt`），可直接当纯静态站点托管 | **每次 CI 运行强制覆盖，始终只有一个孤立提交** |

- `gh-pages` 是产物镜像，**不要在上面直接提交**，下一次运行就会被整体覆盖。
- `BUILD_INFO.txt` 记录该产物对应的 commit、触发事件、构建时间与 workflow run 链接，线上也能直接访问 `/LLM_Charts/BUILD_INFO.txt` 对账。
- 线上发布仍走 GitHub Actions 的 Pages artifact（`deploy` job），`gh-pages` 是同一份产物的长期存档；若想改成「从分支发布」，把仓库 Pages 的 Source 切到 `gh-pages` 分支即可，产物内部路径已经带 `/LLM_Charts/` 前缀。

### 全自动，无需人工干预

配置完成后这个站点是零维护的：

| 环节 | 由谁完成 |
| --- | --- |
| 抓数据 | `cron: '23 */6 * * *'` 每 6 小时自动跑（12h 内复用缓存，因此每天真正请求上游约 2 次） |
| 数据入库 | 有变化时由 bot 自动 commit `src/data/` 回 `main`（`[skip ci]`，不会触发二次构建） |
| 构建 + 发布 | 同一个 workflow 内完成，产物同时上传 Pages 并镜像到 `gh-pages` |
| 上游异常 | 抓取脚本自动回退到缓存 / `data/snapshot-*.html`，不会把坏数据写进仓库 |

唯一需要人工介入的场景：上游榜单页面结构大改导致解析失败时（脚本在有效模型少于 10 条时会中止写入并让 run 失败），按下文「页面结构变化时的排查顺序」修 `scripts/fetch-models.mjs`。

### Run 入口（三种触发方式）

| 触发 | 说明 |
| --- | --- |
| `push` 到 `main` | 推代码即重新构建部署 |
| 定时 `cron: '23 */6 * * *'` | 每 6 小时自动跑一次，刷新数据后部署 |
| **Run workflow**（手动） | Actions 页右上角；可选勾 `force` 忽略缓存强制重新抓取 |

### 本地等价入口

```bash
npm run update                 # 抓数据（TTL 内复用缓存）→ 构建 dist/
npm run update -- --force      # 忽略缓存强制重抓
npm run update -- --ttl 24     # 缓存有效期改 24 小时
npm run update -- --offline    # 完全离线，只用归档快照
```

`scripts/run.mjs` 就是这个入口：先跑 `scripts/fetch-models.mjs`，再跑 `npm run build`。

### 缓存策略

每次 run 都会尝试刷新源数据，但不会无条件打上游：

1. `.cache/page.html` 在 **TTL（默认 12 小时）** 内 → 直接复用，跳过请求。
2. 超过 TTL → 重新抓取，成功后写回缓存与 `src/data/*`。
3. **抓取失败** → 回退到过期缓存；若缓存也没有，回退到 `data/snapshot-*.html` 归档快照；都没有才报错。
4. CI 里 `.cache` 通过 `actions/cache` 跨 run 保留（`restore-keys: aa-page-`）。
5. 数据有变化时，workflow 会把 `src/data/` 自动提交回仓库（`[skip ci]`，不会触发二次构建）。

缓存目录已在 `.gitignore` 中排除。

---

## 数据源与更新（可复现）

### 数据源

- 页面：<https://artificialanalysis.ai/leaderboards/models>
- 官方 API `https://artificialanalysis.ai/api/v2/data/llms/models` **需要 API key**（无 key 返回 401），本项目不使用。
- 抓取方式：解析榜单页面 HTML 中内联的 Next.js RSC flight 载荷（无需 key、无需浏览器）。

### 抓取原理

Next.js App Router 会把 SSR 数据以如下形式内联在 HTML 里：

```html
<script>self.__next_f.push([1,"{\"slug\":\"gemini-4-carbon\",...}"])</script>
```

脚本 `scripts/fetch-models.mjs` 的处理链路：

1. **取页面** — `fetch()` 带浏览器 UA 请求榜单页（或 `--html` 用本地 HTML 重放、 `--offline` 用归档快照）。
2. **解 flight** — 正则 `self.__next_f.push([1,"…"])` 抽出所有片段，逐个 `JSON.parse` 后拼接成完整 flight 文本。
3. **抠对象** — 模型对象固定以 `{"slug":…,"name":…,"shortName"` 开头，从这里做**括号平衡扫描**截取完整 JSON 并解析；按 `slug` 去重。
4. **筛选清洗** — 只保留同时具备 `intelligenceIndex` 与 `intelligenceIndexCostPerTask` 的模型，映射成前端字段，按智能指数降序。

### 更新数据

```bash
npm run refresh                                                # 联网抓取并覆盖 src/data/models.json
npm run refresh:force                                          # 忽略缓存强制重抓
npm run refresh:offline                                        # 离线，只用归档快照
node scripts/fetch-models.mjs --html data/snapshot-2026-10-31.html  # 用指定 HTML 重放
node scripts/fetch-models.mjs --out src/data/models.json       # 指定输出路径
```

> `data/snapshot-2026-10-31.html` 是首次抓取时的页面 HTML 归档（约 1.9 MB），用于断网或需要逐字节复现的场景。

产出两个文件：

- `src/data/models.json` — 图表数据（数组，按智能指数降序）
- `src/data/meta.json` — 溯源元信息：`source`、`fetchedAt`、`generatedAt`、`fromCache`、`totalModelsOnSite`、`plottedModels`、指标定义

页面底部显示的"数据快照时间"直接读自 `meta.json`，不会写死。

### 复现校验

脚本具备自我保护：有效模型少于 10 条时**中止写入**（防止页面改版导致静默写坏数据）。

离线重放已验证 —— 同一份 HTML 两次解析结果 JSON 逐行一致：

```
· 站点模型总数 299，可绘制 96
old 96 new 96
diff rows: 0
```

### 页面结构变化时的排查顺序

1. `curl -s <榜单URL> | grep -c '__next_f'` —— 若 0，说明不再是 Next.js App Router，需换解析策略。
2. `grep -o '"slug":"' flight.txt | head` —— 若为空，字段名可能已改名（如 `id`）。
3. 确认 `intelligenceIndex` / `intelligenceIndexCostPerTask` 字段名是否仍在。
4. 若官网开放了免费 API，优先改用 API：替换脚本第 1 步为 `fetch(API_URL)`，后续清洗逻辑不变。

---

## 数据字段

`src/data/models.json` 中每项的结构（对应 `src/types.ts` 的 `ModelPoint`）：

| 字段 | 含义 | 备注 |
| --- | --- | --- |
| `slug` | 模型标识 | 用于拼接 AA 详情页链接 |
| `name` / `creator` / `color` | 名称、厂商、厂商主题色 | 颜色直接取自官方 `modelCreatorColor` |
| `intelligence` | AA 智能指数 | Y 轴，0–100 分制 |
| `costPerTask` | 每任务成本（USD） | X 轴；`0` 表示免费额度模型 |
| `outputTps` | 输出速度 tok/s | 中位数 |
| `ttft` / `e2e` | 首字延迟 / 端到端响应秒数 | |
| `context` | 上下文窗口 token 数 | |
| `pIn` / `pOut` | 输入/输出每 1M token 价格 | |
| `openWeights` / `reasoning` | 开源权重 / 推理模型 | 详情面板与 tooltip 标签 |

### 已知边界

- **仅 96 / 299 个模型可绘制**：多数模型缺少成本或智能指数中的一项（页面上也显示为 `--`）。
- **免费模型的对数轴处理**：`Command A+`、`K2 Horizon 375B A23B`、`North Mini Code` 每任务成本为 `0`，对数轴无法表示，统一抬到 `$0.005` 下限，tooltip 中标注 `$0 (免费)`。
- **智能指数为浮点原值**，页面上按 `toFixed(1)` 展示，与官网四舍五入后的整数可能差 0.1。
- **名称带 `fallback` 后缀**（如 `Claude Fable 5.2 (Max, Default Fallback)`）在直显标签中会简化，tooltip 与详情面板显示全名。

---

## 项目结构

```
LLM_Charts/
├─ .github/workflows/deploy.yml  # Pages 部署 + 定时/手动刷新数据的 Run 入口
├─ scripts/
│  ├─ run.mjs                    # 一体化入口：刷新数据 → 构建
│  └─ fetch-models.mjs           # 数据抓取脚本（带缓存与回退，可复现）
├─ data/
│  └─ snapshot-2026-10-31.html   # 首次抓取的页面 HTML 归档（离线复现用）
├─ src/
│  ├─ App.tsx                    # 页面全部逻辑：图表配置、交互、详情面板
│  ├─ app.css                    # 布局与暗色主题样式（含 tooltip 样式）
│  ├─ index.css                  # 全局基础样式与 CSS 变量
│  ├─ main.tsx                   # 入口
│  ├─ types.ts                   # ModelPoint / ScaleMode
│  └─ data/
│     ├─ models.json             # 图表数据（由脚本生成，勿手改）
│     └─ meta.json               # 数据源与抓取时间（由脚本生成）
├─ index.html
├─ vite.config.ts                # base 在构建时为 /LLM_Charts/
├─ package.json                  # scripts: dev / build / update / refresh*
└─ LICENSE
```

### 关键实现位置

| 想要改什么 | 看哪里 |
| --- | --- |
| 坐标轴、tooltip 内容、帕累托线 | `src/App.tsx` 中 `option` 的 `useMemo` |
| 帕累托前沿算法 | `src/App.tsx` 顶部 IIFE（按成本升序扫描，刷新最高智能指数即前沿点） |
| 成本对数下限 | `src/App.tsx` 的 `COST_FLOOR` |
| 部署子路径 / base | `vite.config.ts`（`BASE_PATH` 环境变量可覆盖） |
| 抓取与字段映射、缓存 TTL | `scripts/fetch-models.mjs` |
| 刷新频率 | `.github/workflows/deploy.yml` 的 `cron` |

---

## 许可与署名

代码 MIT © NoroHime。数据版权归 [Artificial Analysis](https://artificialanalysis.ai/) 所有，本项目仅做可视化呈现，请在二次分发时保留数据来源署名。
