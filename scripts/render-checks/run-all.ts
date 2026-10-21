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
import { runOverviewCoverageCheck } from './checks/overview-coverage'
import { KNOWN_FAILS } from './known-fails'
import { CHECK_TIMEOUT_MS, TimeoutError, isHardFailure, withTimeout } from './lib/bounds'
import type { CheckResult } from './lib/types'

const CHECKS: Record<string, (baseUrl: string) => Promise<CheckResult>> = {
  determinism: runDeterminismCheck,
  'time-stability': runTimeStabilityCheck,
  'always-visible': runAlwaysVisibleCheck,
  'perf-budget': runPerfBudgetCheck,
  // Overview zooms (z9/z10/z11). SKIPs unless the local R2 has baked overview
  // cells — see scripts/render-checks/README.md.
  'overview-coverage': runOverviewCoverageCheck,
}

function printResult(result: CheckResult): void {
  const known = KNOWN_FAILS[result.name]
  let status: string
  if (result.passed) {
    status = known ? 'PASS (known-fail entry now stale!)' : 'PASS'
  } else if (result.timedOut) {
    // Deliberately not XFAIL even when listed: see CheckResult.timedOut.
    status = 'TIMEOUT'
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
  if (known && !result.passed && !result.timedOut) {
    console.log(`  (expected failure — see scripts/render-checks/known-fails.ts: ${known})`)
  }
}

/**
 * Run one check under a wall-clock cap, turning a hang into a reported
 * failure. Before this, `await CHECKS[name](...)` was unbounded: on
 * 2026-10-20 a dead browser left `always-visible` pending for 71 minutes
 * with no output at all, which reads exactly like a slow check.
 *
 * A timeout is reported, not thrown, so the checks after it still run —
 * one wedged check should cost its own result, not the whole suite's.
 */
async function runBounded(name: string, baseUrl: string): Promise<CheckResult> {
  try {
    return await withTimeout(`check "${name}"`, CHECK_TIMEOUT_MS, CHECKS[name](baseUrl))
  } catch (err) {
    if (err instanceof TimeoutError) {
      return {
        name,
        passed: false,
        timedOut: true,
        summary: err.message,
        details: [
          { label: 'cap', value: `${CHECK_TIMEOUT_MS}ms (override with RENDER_CHECK_TIMEOUT_MS)` },
          { label: 'note', value: 'a hang is an infrastructure failure — known-fails.ts cannot mask it' },
        ],
      }
    }
    throw err
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
      const result = await runBounded(name, app.url)
      results.push(result)
      printResult(result)
    }
  } finally {
    await app.stop()
  }

  // Suite fails only on a non-known-fail check failing. A known-fail
  // check passing is loudly flagged above but doesn't fail the suite —
  // it's good news that needs a follow-up edit, not a blocker.
  const hardFailures = results.filter((r) => isHardFailure(r, KNOWN_FAILS[r.name]))

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
