export interface ModelPoint {
  slug: string
  name: string
  creator: string
  color: string
  /** Artificial Analysis Intelligence Index (AA 智能指数) */
  intelligence: number
  /** Cost per task, USD (每任务成本) */
  costPerTask: number
  outputTps: number | null
  ttft: number | null
  e2e: number | null
  context: number | null
  pIn: number | null
  pOut: number | null
  openWeights: boolean
  reasoning: boolean
}

export type ScaleMode = 'log' | 'linear'
