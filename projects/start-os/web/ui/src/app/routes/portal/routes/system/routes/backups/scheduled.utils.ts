import type { T } from '@start9labs/start-core'

export type BackupScheduleFrequency = 'hourly' | 'daily' | 'weekly'
export type BackupRetentionInterval = 'hour' | 'day' | 'week' | 'month'
export type BackupRetentionPeriodLabel =
  | BackupRetentionInterval
  | 'hours'
  | 'days'
  | 'weeks'
  | 'months'

export interface BackupScheduleFormValue {
  frequency: BackupScheduleFrequency
  minute: number
  hour: number
  weekday: number
  timezone: string
}

export function serializeBackupSchedule(
  form: BackupScheduleFormValue,
): T.Schedule {
  const minute = clampInteger(form.minute, 0, 59)
  const hour = clampInteger(form.hour, 0, 23)
  const weekday = clampInteger(form.weekday, 0, 6)
  const cron =
    form.frequency === 'hourly'
      ? `${minute} * * * *`
      : form.frequency === 'daily'
        ? `${minute} ${hour} * * *`
        : `${minute} ${hour} * * ${weekday}`
  return { cron, timezone: form.timezone }
}

export function parseBackupSchedule(
  schedule: T.Schedule,
): BackupScheduleFormValue {
  const fields = schedule.cron.split(/\s+/)
  const frequency: BackupScheduleFrequency =
    fields[4] !== '*' ? 'weekly' : fields[1] !== '*' ? 'daily' : 'hourly'
  return {
    frequency,
    minute: Number(fields[0]) || 0,
    hour: Number(fields[1]) || 0,
    weekday: Number(fields[4]) || 0,
    timezone: schedule.timezone,
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
