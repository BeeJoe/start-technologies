import { Component, inject, input } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { i18nPipe } from '@start9labs/shared'
import { TuiDataList } from '@taiga-ui/core'
import { TuiChevron, TuiSelect } from '@taiga-ui/kit'
import {
  backupFrequencyLabel,
  backupWeekdayLabel,
  BACKUP_FREQUENCIES,
  BACKUP_HOURS,
  BACKUP_MINUTES,
  BACKUP_MONTH_DAYS,
  BACKUP_WEEKDAYS,
  BackupScheduleFormValue,
  BackupScheduleFrequency,
  formatBackupTime,
} from './scheduled-utils'

@Component({
  selector: 'backup-schedule-controls',
  template: `
    <tui-textfield
      tuiChevron
      [stringify]="stringifyFrequency"
      [tuiTextfieldCleaner]="false"
    >
      <label tuiLabel>{{ 'Frequency' | i18n }}</label>
      <input
        tuiSelect
        required
        [ngModelOptions]="{ standalone: true }"
        [ngModel]="schedule().frequency"
        (ngModelChange)="schedule().frequency = $event"
      />
      <tui-data-list *tuiDropdown>
        @for (frequency of frequencies; track frequency) {
          <button tuiOption [value]="frequency">
            {{ stringifyFrequency(frequency) }}
          </button>
        }
      </tui-data-list>
    </tui-textfield>

    @if (schedule().frequency === 'weekly') {
      <tui-textfield
        tuiChevron
        [stringify]="stringifyWeekday"
        [tuiTextfieldCleaner]="false"
      >
        <label tuiLabel>{{ 'Day of week' | i18n }}</label>
        <input
          tuiSelect
          [ngModelOptions]="{ standalone: true }"
          [ngModel]="schedule().weekday"
          (ngModelChange)="schedule().weekday = $event"
        />
        <tui-data-list *tuiDropdown>
          @for (day of weekdays; track day.value) {
            <button tuiOption [value]="day.value">
              {{ stringifyWeekday(day.value) }}
            </button>
          }
        </tui-data-list>
      </tui-textfield>
    }

    @if (schedule().frequency === 'monthly') {
      <tui-textfield tuiChevron [tuiTextfieldCleaner]="false">
        <label tuiLabel>{{ 'Day of month' | i18n }}</label>
        <input
          tuiSelect
          required
          [ngModelOptions]="{ standalone: true }"
          [ngModel]="schedule().dayOfMonth"
          (ngModelChange)="schedule().dayOfMonth = $event"
        />
        <tui-data-list *tuiDropdown>
          @for (day of monthDays; track day) {
            <button tuiOption [value]="day">{{ day }}</button>
          }
        </tui-data-list>
      </tui-textfield>
    }

    @if (schedule().frequency !== 'hourly') {
      <tui-textfield
        tuiChevron
        [stringify]="stringifyTime"
        [tuiTextfieldCleaner]="false"
      >
        <label tuiLabel>{{ 'Hour' | i18n }}</label>
        <input
          tuiSelect
          required
          [ngModelOptions]="{ standalone: true }"
          [ngModel]="schedule().hour"
          (ngModelChange)="schedule().hour = $event"
        />
        <tui-data-list *tuiDropdown>
          @for (hour of hours; track hour) {
            <button tuiOption [value]="hour">
              {{ stringifyTime(hour) }}
            </button>
          }
        </tui-data-list>
      </tui-textfield>
    }

    <tui-textfield
      tuiChevron
      [stringify]="stringifyTime"
      [tuiTextfieldCleaner]="false"
    >
      <label tuiLabel>{{ 'Minute' | i18n }}</label>
      <input
        tuiSelect
        required
        [ngModelOptions]="{ standalone: true }"
        [ngModel]="schedule().minute"
        (ngModelChange)="schedule().minute = $event"
      />
      <tui-data-list *tuiDropdown>
        @for (minute of minutes; track minute) {
          <button tuiOption [value]="minute">
            {{ stringifyTime(minute) }}
          </button>
        }
      </tui-data-list>
    </tui-textfield>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
      gap: 0.75rem;
      align-items: end;
      inline-size: 100%;
      min-inline-size: 0;
    }

    :host > *,
    tui-textfield {
      inline-size: 100%;
      min-inline-size: 0;
    }

    @container (max-inline-size: 48rem) {
      :host {
        grid-template-columns: 1fr 1fr;
      }
    }

    @container (max-inline-size: 30rem) {
      :host {
        grid-template-columns: 1fr;
      }
    }
  `,
  imports: [FormsModule, TuiChevron, TuiDataList, TuiSelect, i18nPipe],
})
export class BackupScheduleControls {
  private readonly i18n = inject(i18nPipe)

  readonly schedule = input.required<BackupScheduleFormValue>()

  protected readonly frequencies = BACKUP_FREQUENCIES
  protected readonly weekdays = BACKUP_WEEKDAYS
  protected readonly hours = BACKUP_HOURS
  protected readonly minutes = BACKUP_MINUTES
  protected readonly monthDays = BACKUP_MONTH_DAYS
  protected readonly stringifyTime = formatBackupTime
  protected readonly stringifyFrequency = (
    frequency: BackupScheduleFrequency,
  ) => this.i18n.transform(backupFrequencyLabel(frequency))
  protected readonly stringifyWeekday = (weekday: number) =>
    this.i18n.transform(backupWeekdayLabel(weekday))
}
