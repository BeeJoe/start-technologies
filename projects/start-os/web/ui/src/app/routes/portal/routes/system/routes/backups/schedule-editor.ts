import { BackupScheduleFormValue } from './scheduled-utils'

export class BackupScheduleEditor implements BackupScheduleFormValue {
  frequency: BackupScheduleFormValue['frequency']
  minute: number
  hour: number
  weekday: number
  dayOfMonth: number
  timezone: string

  constructor(value: BackupScheduleFormValue) {
    this.frequency = value.frequency
    this.minute = value.minute
    this.hour = value.hour
    this.weekday = value.weekday
    this.dayOfMonth = value.dayOfMonth
    this.timezone = value.timezone
  }

  protected scheduleValue(): BackupScheduleFormValue {
    return {
      frequency: this.frequency,
      minute: this.minute,
      hour: this.hour,
      weekday: this.weekday,
      dayOfMonth: this.dayOfMonth,
      timezone: this.timezone,
    }
  }
}
