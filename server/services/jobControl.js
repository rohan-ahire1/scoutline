// Job outcome and retry policy for research jobs (ROH-23).
//
// Cancellation propagation points (wired in server/index.js):
// - POST /api/jobs/:id/cancel marks Queued/Waiting jobs Cancelled immediately.
// - A Running job gets an AbortController (jobSignals) plus a persisted
//   payload.cancelRequested flag. auditWebsite observes the signal (ROH-22);
//   synthesis/refresh/discovery check the flag between phases.
// - Every run function claims completion (claim text in index.js): results are
//   saved only while its job is still Running, so a late finish after a
//   cancel or watchdog timeout can neither overwrite state nor advance the
//   pipeline nor emit a second terminal notification.
// - The processNextJob watchdog marks Running jobs past their deadline as
//   Timed out; their late completions are ignored by the same guard.

export const JOB_STATUSES = ['Queued', 'Waiting', 'Running', 'Completed', 'Failed', 'Error', 'Timed out', 'Cancelled']

export const TERMINAL_JOB_STATUSES = ['Completed', 'Failed', 'Error', 'Timed out', 'Cancelled']

export const ACTIVE_JOB_STATUSES = ['Queued', 'Waiting', 'Running']

// Plain-language outcome copy. Labels never expose codes or jargon.
const OUTCOME_BY_CODE = {
  CANCELLED: { status: 'Cancelled', retryable: true, autoRetry: false, label: 'Audit cancelled', detail: 'You stopped this run. Nothing was overwritten; queue it again to resume.' },
  TIMEOUT: { status: 'Timed out', retryable: true, autoRetry: false, label: 'Audit timed out', detail: 'The run exceeded its time budget and was stopped. Nothing from the incomplete attempt was saved.' },
  FETCH_FAILED: { status: 'Error', retryable: true, autoRetry: true, label: 'Website unreachable', detail: 'The website could not be reached. The same audit can be safely retried.' },
  DNS_FAILED: { status: 'Error', retryable: true, autoRetry: true, label: 'Website address failed', detail: 'The website address did not resolve. Check the domain, then retry.' },
  HTTP_ERROR: { status: 'Error', retryable: true, autoRetry: true, label: 'Website returned an error', detail: 'The website answered with an error page. Retry later or fix the site first.' },
  ARTIFACT_WRITE_FAILED: { status: 'Error', retryable: true, autoRetry: true, label: 'Results could not be saved', detail: 'The audit ran but its evidence files could not be written. Retry the audit.' },
  PROVIDER_TIMEOUT: { status: 'Error', retryable: true, autoRetry: true, label: 'Provider never answered', detail: 'The data provider never produced a result before the polling deadline. Retry resumes the same provider snapshot.' },
  PROVIDER_FAILED: { status: 'Error', retryable: true, autoRetry: true, label: 'Provider reported a failure', detail: 'The data provider reported this request as failed. Retry resumes the same provider snapshot.' },
  PROVIDER_ERROR: { status: 'Error', retryable: true, autoRetry: true, label: 'Provider returned an error', detail: 'The data provider answered with an error payload. Retry resumes the same provider snapshot.' },
  BAD_PROVIDER_RESPONSE: { status: 'Error', retryable: true, autoRetry: true, label: 'Provider answer was unusable', detail: 'The data provider returned a malformed answer. Retry resumes the same provider snapshot.' },
  NOT_CONFIGURED: { status: 'Error', retryable: true, autoRetry: false, label: 'Provider not configured', detail: 'The provider key is missing. Add it in settings, then retry.' },
  SOURCE_URL_MISSING: { status: 'Error', retryable: false, autoRetry: false, label: 'No source record', detail: 'This client has no saved provider source URL to refresh.' },
}

const NON_RETRYABLE = { status: 'Failed', retryable: false, autoRetry: false, label: 'Audit failed', detail: 'This run cannot proceed as queued. Fix the underlying issue, then start a fresh run.' }

export function classifyJobError(error) {
  const code = error?.code || 'UNKNOWN'
  const known = OUTCOME_BY_CODE[code]
  if (known) return { code, ...known }
  if (code === 'VALIDATION' || /lead not found|unsupported job type|completed website audit is required/i.test(error?.message || '')) {
    return { code, ...NON_RETRYABLE }
  }
  return { code, status: 'Error', retryable: true, autoRetry: true, label: 'Audit hit an error', detail: 'Something went wrong while running. The same audit can be safely retried.' }
}

export function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.includes(status)
}

export function isActiveJobStatus(status) {
  return ACTIVE_JOB_STATUSES.includes(status)
}

// Jobs eligible for a manual retry: terminal, and either classified retryable
// (persisted as payload.jobOutcome by the failure path) or cancelled.
export function canRetryJob(job) {
  if (!job || !isTerminalJobStatus(job.status)) return false
  if (job.status === 'Cancelled') return true
  if (job.status === 'Completed') return false
  return job.payload?.jobOutcome?.retryable === true
}

// Pure watchdog selection over parsed job rows: Running jobs whose recorded
// start is older than the deadline. Never touches history rows.
export function findTimedOutJobs(jobs, nowMs, timeoutMs) {
  return (jobs || []).filter((job) => {
    if (!job || job.status !== 'Running') return false
    const started = Date.parse(job.payload?.startedAt || job.startedAt || '')
    if (!Number.isFinite(started)) return false
    return nowMs - started > timeoutMs
  })
}
