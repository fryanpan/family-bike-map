export interface CheckDetail {
  label: string
  value: string
}

export interface CheckResult {
  name: string
  /** True = the check's own assertions held. Independent of known-fail
   *  bookkeeping — run-all.ts decides suite pass/fail by combining this
   *  with the known-fails registry. */
  passed: boolean
  /** Short human-readable summary line. */
  summary: string
  /** Numeric/text details for the console table (measured values, counts). */
  details: CheckDetail[]
}

export interface CheckContext {
  baseUrl: string
  /** Directory to write failure-diagnostic screenshots into. */
  artifactsDir: string
}
