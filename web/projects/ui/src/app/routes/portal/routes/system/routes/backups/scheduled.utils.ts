import type { T } from '@start9labs/start-sdk'

export type BackupScheduleFrequency = 'hourly' | 'daily' | 'weekly'

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

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(Number(value) || 0)))
}
