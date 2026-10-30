/**
 * 刷新数据 + 构建站点的一体化入口。
 *
 *   npm run update               # 抓数据（命中缓存则复用）→ 构建 dist/
 *   npm run update -- --force    # 忽略缓存，强制重新抓取
 *   npm run update -- --ttl 24   # 缓存有效期改为 24 小时
 *   npm run update -- --offline  # 完全离线：只用归档快照，不联网
 *
 * 对应 GitHub Actions 中每次 workflow run 所做的事。
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

function run(cmd, cmdArgs, label) {
  console.log(`\n▶ ${label}`)
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`✗ ${label} 失败（退出码 ${r.status}）`)
    process.exit(r.status ?? 1)
  }
}

const node = process.execPath
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

run(node, ['scripts/fetch-models.mjs', ...args], '刷新数据源')
run(npmCmd, ['run', 'build'], '构建站点')

console.log('\n✓ 完成：dist/ 已是最新数据')
