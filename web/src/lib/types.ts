// Tipos de la API del monitor (src/server/http.js).

export type Severity = "noise" | "low" | "medium" | "high" | "critical"
export type IssueState = "open" | "ack" | "resolved" | "ignored"
export type AnalysisState = "none" | "queued" | "running" | "done" | "skipped" | "failed"

export interface IssueSummary {
  id: number
  title: string
  category: string
  severity: Severity
  expected: boolean
  reason: string | null
  method: string | null
  route: string | null
  status_code: number | null
  func: string | null
  handler: string | null
  first_seen: string
  last_seen: string
  count: number
  state: IssueState
  regression: boolean
  after_release: string | null
  spike: boolean
  users: number
  analysis_state: AnalysisState
  has_patch: boolean
  ai_title: string | null
  ai_kind: string | null
  ai_confidence: number | null
}

export interface Analysis {
  title: string
  summary: string
  root_cause: string
  exact_error: string
  kind: string
  severity: Severity
  location: { file: string; function: string | null; line: number | null; inferred?: boolean } | null
  fix: string
  fix_steps: string[]
  confidence: number
  grounded: boolean
  flags: string[]
  meta?: { model: string; durationMs: number; evalCount?: number; promptTokens?: number; contextChars?: number }
}

export interface Blame { author: string; date: string; sha: string; summary: string }

export interface IssueFull extends Omit<IssueSummary, "users" | "has_patch" | "ai_title" | "ai_kind" | "ai_confidence" | "expected" | "regression" | "spike"> {
  fingerprint: string
  expected: number
  regression: number
  spike: number
  handler_dir: string | null
  code_file: string | null
  code_line: number | null
  state_changed_at: string | null
  user_ids: string[]
  blame: Blame | null
  analysis: Analysis | null
  analysis_error: string | null
  analyzed_at: string | null
  patch: string | null
  patch_branch: string | null
  alerted_at: string | null
}

export interface IssueEvent {
  id: number
  ts: string
  kind: string
  method: string | null
  path: string | null
  status_code: number | null
  dyno: string | null
  request_id: string | null
  service_ms: number | null
  message: string | null
  evidence: string | null
  user_id: string | null
}

export interface IssueDetail { issue: IssueFull; events: IssueEvent[]; histogram: Record<string, number> }

export interface SourceStatus {
  name: string
  label: string
  state: "idle" | "connecting" | "live" | "reconnecting" | "error" | "done" | "stopped"
  since: string
  lastLine: string | null
  lines: number
  error: string | null
  reconnects: number
}

export interface Health {
  status: "ok" | "warning" | "critical" | "unknown"
  criticalOpen: number
  highOpen: number
  window: { minutes: number; requests: number; err5: number; err4: number; errorRate: number; apdex: number | null }
  sources: SourceStatus[]
  pipeline: { lines: number; dupes: number; parsed: number; requests: number; incidents: number; bySource: Record<string, { lines: number; last: string }> }
  ai: { enabled: boolean; model: string; ok: boolean | null; error: string | null; modelPresent: boolean | null; queue: { queued: number; running: number | null; processed: number; failed: number } }
  notifier: { enabled: boolean; sent: number; failed: number; lastError: string | null; minSeverity: Severity }
  app: string
  startedAt: string
  autofixMode: string
}

export interface TimelinePoint {
  t: string
  requests: number
  err4: number
  err5: number
  slow: number
  apdex: number | null
  avgMs: number | null
  p95: number | null
  by_category: Record<string, number>
}

export interface Stats {
  since: string
  bucketMinutes: number
  timeline: TimelinePoint[]
  totals: {
    requests: number; err4: number; err5: number; slow: number; apdex: number | null; avgMs: number | null
    p50: number | null; p95: number | null; p99: number | null; by_category: Record<string, number>
  }
  releases: { id: number; ts: string; version: string; description: string }[]
  latestTs: string | null
}

export interface RouteStat {
  method: string
  route: string
  handler: string | null
  requests: number
  err4: number
  err5: number
  slow: number
  errorRate: number
  rate5: number
  avgMs: number | null
  p50: number | null
  p95: number | null
  openIssues: number
  worstSeverity: Severity | null
}

export interface WindowStats { requests: number; err4: number; err5: number; rate5: number | null; p95: number | null }

export interface Release {
  id: number
  ts: string
  version: string
  description: string
  before: WindowStats
  after: WindowStats
  complete: boolean
  newIssues: number
  issues: { id: number; title: string; ai_title: string | null; method: string | null; route: string | null; severity: Severity; category: string; count: number; state: IssueState }[]
}

export interface TailLine { ts: string; level: "error" | "warn" | "platform" | "release"; dyno: string; text: string }

export interface Meta { categories: Record<string, string>; severities: Severity[]; app: string; model: string; autofixMode: string }

export interface PublicConfig {
  app: string
  host: string
  port: number
  sources: string[]
  backendPath: string
  backendFound: boolean
  routes: number
  functions: number
  ai: { enabled: boolean; url: string; model: string; language: "es" | "en"; numCtx: number; timeoutMs: number; analyzeMinSeverity: Severity; maxQueue: number }
  autofix: { mode: string; minConfidence: number; gofmt: boolean }
  alerts: { n8nConfigured: boolean; tokenConfigured: boolean; minSeverity: Severity }
  ingest: { tokenConfigured: boolean; herokuApiTokenConfigured: boolean }
  thresholds: { slowRequestMs: number; apdexTargetMs: number; correlationWindowMs: number; retentionDays: number }
  dbFile: string
}
