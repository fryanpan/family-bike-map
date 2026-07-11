#!/usr/bin/env bun
// Runs every render check against ONE served instance of the app (a
// single `bun run build` + server start is shared across all four checks
// — the expensive part — while each check gets its own browser/pages).
//
// Usage: bun run render-check
//        bun scripts/render-checks/run-all.ts [--only determinism,always-visible]

import { parseArgs } from 'node:util'
import { serveApp } from './lib/serve'
import { runDeterminismCheck } from './checks/determinism'
import { runTimeStabilityCheck } from './checks/time-stability'
import { runAlwaysVisibleCheck } from './checks/always-visible'
import { runPerfBudgetCheck } from './checks/perf-budget'
import { KNOWN_FAILS } from './known-fails'
import type { CheckResult } from './lib/types'

const CHECKS: Record<string, (baseUrl: string) => Promise<CheckResult>> = {
  determinism: runDeterminismCheck,
  'time-stability': runTimeStabilityCheck,
  'always-visible': runAlwaysVisibleCheck,
  'perf-budget': runPerfBudgetCheck,
}

function printResult(result: CheckResult): void {
  const known = KNOWN_FAILS[result.name]
  let status: string
  if (result.passed) {
    status = known ? 'PASS (known-fail entry now stale!)' : 'PASS'
  } else {
    status = known ? 'XFAIL (known)' : 'FAIL'
  }
  console.log(`\n=== ${result.name}: ${status} ===`)
  console.log(result.summary)
  for (const d of result.details) console.log(`  ${d.label}: ${d.value}`)
  if (known && result.passed) {
    console.log(`\n  ⚠ known-fails.ts lists '${result.name}' as expected-to-fail, but it just PASSED.`)
    console.log(`    Reason on file: ${known}`)
    console.log(`    Delete this entry from scripts/render-checks/known-fails.ts.`)
  }
  if (known && !result.passed) {
    console.log(`  (expected failure — see scripts/render-checks/known-fails.ts: ${known})`)
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { only: { type: 'string' } } })
  const names = values.only ? values.only.split(',').map((s) => s.trim()) : Object.keys(CHECKS)
  for (const n of names) {
    if (!CHECKS[n]) {
      console.error(`unknown check "${n}" — expected one of: ${Object.keys(CHECKS).join(', ')}`)
      process.exit(1)
    }
  }

  console.log(`[render-checks] serving app...`)
  const app = await serveApp()
  console.log(`[render-checks] serving via ${app.mode} at ${app.url}`)

  const results: CheckResult[] = []
  try {
    for (const name of names) {
      console.log(`\n[render-checks] running ${name}...`)
      const result = await CHECKS[name](app.url)
      results.push(result)
      printResult(result)
    }
  } finally {
    await app.stop()
  }

  // Suite fails only on a non-known-fail check failing. A known-fail
  // check passing is loudly flagged above but doesn't fail the suite —
  // it's good news that needs a follow-up edit, not a blocker.
  const hardFailures = results.filter((r) => !r.passed && !KNOWN_FAILS[r.name])

  console.log(`\n${'='.repeat(60)}`)
  console.log(`[render-checks] ${results.length} check(s) run, ${hardFailures.length} hard failure(s)`)
  if (hardFailures.length > 0) {
    console.log(`[render-checks] FAILED: ${hardFailures.map((r) => r.name).join(', ')}`)
    process.exit(1)
  }
  console.log('[render-checks] all checks passed (or are known-fails).')
}

main().catch((err) => {
  console.error('[render-checks] FAILED:', err)
  process.exit(1)
})
