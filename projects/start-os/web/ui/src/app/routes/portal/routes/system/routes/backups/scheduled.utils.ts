import type { T } from '@start9labs/start-core'

export type BackupScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly'
export type BackupRetentionInterval = 'hour' | 'day' | 'week' | 'month'
export type BackupRetentionPeriodLabel =
  | BackupRetentionInterval
  | 'hours'
  | 'days'
  | 'weeks'
  | 'months'

export const BACKUP_HOURS = Array.from({ length: 24 }, (_, hour) => hour)
export const BACKUP_MINUTES = Array.from({ length: 60 }, (_, minute) => minute)
export const BACKUP_MONTH_DAYS = Array.from({ length: 31 }, (_, day) => day + 1)

export function formatBackupTime(value: number): string {
  return String(value).padStart(2, '0')
}

export interface BackupScheduleFormValue {
  frequency: BackupScheduleFrequency
  minute: number
  hour: number
  weekday: number
  dayOfMonth: number
  timezone: string
}

export interface BackupJobAttentionState {
  enabled: boolean
  pause: { reason: string } | null
  status: { lastResult: string | null }
}

/** Returns whether an enabled job should surface the automatic-backup warning. */
export function backupJobNeedsAttention(job: BackupJobAttentionState): boolean {
  return (
    job.enabled &&
    ((!!job.pause && job.pause.reason !== 'user') ||
      job.status.lastResult === 'failed' ||
      job.status.lastResult === 'partiallyFailed')
  )
}

/** Editable service scope plus IDs that are not represented by the current package list. */
export interface BackupServiceSelection {
  packageIds: string[]
  includeFuture: boolean
  preservedSelectedPackageIds: string[]
  preservedExcludedPackageIds: string[]
}

/** Primary retention controls, including an exact custom rule for advanced jobs. */
export interface BackupRetentionTierEditor {
  interval: BackupRetentionInterval | 'custom'
  duration: number
  customIntervalHours: number
  customCoverageHours: number
}

export function serializeBackupSchedule(
  form: BackupScheduleFormValue,
): T.Schedule {
  const minute = clampInteger(form.minute, 0, 59)
  const hour = clampInteger(form.hour, 0, 23)
  const weekday = clampInteger(form.weekday, 0, 6)
  const dayOfMonth = clampInteger(form.dayOfMonth, 1, 31)
  const cron =
    form.frequency === 'hourly'
      ? `${minute} * * * *`
      : form.frequency === 'daily'
        ? `${minute} ${hour} * * *`
        : form.frequency === 'weekly'
          ? `${minute} ${hour} * * ${weekday}`
          : `${minute} ${hour} ${dayOfMonth} * *`
  return { cron, timezone: form.timezone }
}

export function parseBackupSchedule(
  schedule: T.Schedule,
): BackupScheduleFormValue {
  const fields = schedule.cron.split(/\s+/)
  const frequency: BackupScheduleFrequency =
    fields[2] !== '*'
      ? 'monthly'
      : fields[4] !== '*'
        ? 'weekly'
        : fields[1] !== '*'
          ? 'daily'
          : 'hourly'
  return {
    frequency,
    minute: Number(fields[0]) || 0,
    hour: Number(fields[1]) || 0,
    weekday: Number(fields[4]) || 0,
    dayOfMonth: Number(fields[2]) || 1,
    timezone: schedule.timezone,
  }
}

/** Projects a stored service scope into the installed-service editor without dropping hidden IDs. */
export function parseBackupServiceSelection(
  services: T.BackupServiceScope,
  installedPackageIds: string[],
): BackupServiceSelection {
  const installed = new Set(installedPackageIds)
  if (services.type === 'selected') {
    return {
      packageIds: services.packageIds.filter(id => installed.has(id)),
      includeFuture: false,
      preservedSelectedPackageIds: services.packageIds.filter(
        id => !installed.has(id),
      ),
      preservedExcludedPackageIds: [],
    }
  }
  if (services.type === 'allExcept') {
    const excluded = new Set(services.excludedPackageIds)
    return {
      packageIds: installedPackageIds.filter(id => !excluded.has(id)),
      includeFuture: true,
      preservedSelectedPackageIds: [],
      preservedExcludedPackageIds: services.excludedPackageIds.filter(
        id => !installed.has(id),
      ),
    }
  }
  return {
    packageIds: [...installedPackageIds],
    includeFuture: true,
    preservedSelectedPackageIds: [],
    preservedExcludedPackageIds: [],
  }
}

/** Rebuilds a service scope while retaining IDs hidden from the installed-service editor. */
export function serializeBackupServiceSelection(
  selection: BackupServiceSelection,
  installedPackageIds: string[],
): T.BackupServiceScope {
  if (!selection.includeFuture) {
    return {
      type: 'selected',
      packageIds: [
        ...new Set([
          ...selection.packageIds,
          ...selection.preservedSelectedPackageIds,
        ]),
      ],
    }
  }
  const selected = new Set(selection.packageIds)
  return {
    type: 'allExcept',
    excludedPackageIds: [
      ...new Set([
        ...selection.preservedExcludedPackageIds,
        ...installedPackageIds.filter(id => !selected.has(id)),
      ]),
    ],
  }
}

/** Maps a stored tier to standard controls when lossless and custom controls otherwise. */
export function parseBackupRetentionTier(
  tier?: T.RetentionTier,
): BackupRetentionTierEditor {
  if (!tier) {
    return {
      interval: 'day',
      duration: 7,
      customIntervalHours: 24,
      customCoverageHours: 168,
    }
  }
  const interval = retentionIntervalFromSeconds(tier.intervalSeconds)
  const duration = tier.coverageSeconds / tier.intervalSeconds
  const standard =
    retentionIntervalSeconds(interval) === tier.intervalSeconds &&
    Number.isInteger(duration) &&
    duration >= 1 &&
    duration <= 365
  return {
    interval: standard ? interval : 'custom',
    duration: standard ? duration : 7,
    customIntervalHours: tier.intervalSeconds / 3600,
    customCoverageHours: tier.coverageSeconds / 3600,
  }
}

/** Serializes the primary version-history controls without normalizing custom rules. */
export function serializeBackupRetentionTier(
  editor: BackupRetentionTierEditor,
): T.RetentionTier {
  if (editor.interval === 'custom') {
    const minimumHours = 1 / 3600
    return {
      intervalSeconds: Math.round(
        Math.max(
          minimumHours,
          Number(editor.customIntervalHours) || minimumHours,
        ) * 3600,
      ),
      coverageSeconds: Math.round(
        Math.max(
          minimumHours,
          Number(editor.customCoverageHours) || minimumHours,
        ) * 3600,
      ),
    }
  }
  const intervalSeconds = retentionIntervalSeconds(editor.interval)
  return {
    intervalSeconds,
    coverageSeconds:
      intervalSeconds * Math.max(1, Number(editor.duration) || 1),
  }
}

export function retentionIntervalSeconds(
  interval: BackupRetentionInterval,
): number {
  if (interval === 'hour') return 60 * 60
  if (interval === 'week') return 7 * 24 * 60 * 60
  if (interval === 'month') return 30 * 24 * 60 * 60
  return 24 * 60 * 60
}

export function retentionIntervalFromSeconds(
  seconds?: number,
): BackupRetentionInterval {
  if (!seconds) return 'day'
  if (seconds < 24 * 60 * 60) return 'hour'
  if (seconds < 7 * 24 * 60 * 60) return 'day'
  if (seconds < 30 * 24 * 60 * 60) return 'week'
  return 'month'
}

export function retentionPeriodLabel(
  interval: BackupRetentionInterval,
  count: number,
): BackupRetentionPeriodLabel {
  if (count === 1) return interval
  return `${interval}s` as BackupRetentionPeriodLabel
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(Number(value) || 0)))
}
