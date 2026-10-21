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
  /** Set when the check never returned and its wall-clock cap cut it off.
   *  A timeout is an infrastructure failure, not the product failure a
   *  known-fail entry describes, so run-all.ts must NOT let KNOWN_FAILS
   *  downgrade it to XFAIL — otherwise listing a check as a known-fail
   *  would also silence it hanging, which is the same "gate cannot fail"
   *  hole this suite exists to close. */
  timedOut?: boolean
}

export interface CheckContext {
  baseUrl: string
  /** Directory to write failure-diagnostic screenshots into. */
  artifactsDir: string
}
