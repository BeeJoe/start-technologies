import { DatePipe } from '@angular/common'
import {
  Component,
  computed,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import {
  DialogService,
  ErrorService,
  getErrorMessage,
  i18nPipe,
} from '@start9labs/shared'
import { T } from '@start9labs/start-core'
import {
  TuiAppearance,
  TuiButton,
  TuiCell,
  TuiCheckbox,
  TuiDataList,
  TuiGroup,
  TuiIcon,
  TuiInput,
  TuiNotification,
  TuiTitle,
} from '@taiga-ui/core'
import {
  TuiBadge,
  TuiBlock,
  TuiChevron,
  TuiInputNumber,
  TuiPassword,
  TuiSelect,
  TuiSwitch,
} from '@taiga-ui/kit'
import { PatchDB } from 'patch-db-client'
import { filter, firstValueFrom } from 'rxjs'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { DataModel } from 'src/app/services/patch-db/data-model'
import { BackupService, formatCifsLocation } from './backup.service'
import {
  BackupRetentionTierEditor,
  BackupScheduleFrequency,
  BACKUP_HOURS,
  BACKUP_MINUTES,
  formatBackupTime,
  parseBackupRetentionTier,
  parseBackupSchedule,
  parseBackupServiceSelection,
  retentionPeriodLabel,
  serializeBackupRetentionTier,
  serializeBackupServiceSelection,
  serializeBackupSchedule,
} from './scheduled.utils'

type RetentionPreset = 'latest' | 'daily-week' | 'custom'

interface TierEditor {
  intervalHours: number
  coverageHours: number
}

interface RetentionOverrideEditor {
  preset: RetentionPreset
  tiers: TierEditor[]
}

interface JobEditor extends BackupRetentionTierEditor {
  id?: string
  name: string
  targetId: string
  packageIds: string[]
  includeFuture: boolean
  preservedSelectedPackageIds: string[]
  preservedExcludedPackageIds: string[]
  frequency: BackupScheduleFrequency
  minute: number
  hour: number
  weekday: number
  timezone: string
  keepAdditional: boolean
  additionalTiers: TierEditor[]
  retentionOverrides: Record<string, RetentionOverrideEditor>
  password: string
  firstBackupNow: boolean
  capacityConfirmed: boolean
}

@Component({
  selector: 'section[scheduledBackups]',
  template: `
    <div tuiNotification appearance="info" icon="@tui.calendar-clock">
      <div tuiTitle>
        {{ 'Automatic backups' | i18n }}
        <div tuiSubtitle>
          {{
            'Automatic checkpoints are stored separately from your latest manual checkpoint.'
              | i18n
          }}
        </div>
      </div>
    </div>

    @for (review of reviews(); track review.packageId) {
      <article class="review" tuiNotification appearance="warning">
        <div tuiTitle>
          {{ 'New service backup review' | i18n }}:
          {{ packageName(review.packageId) }}
          <div tuiSubtitle>
            {{
              'Choose whether to add this service to every selective job. The service cannot start until this is resolved.'
                | i18n
            }}
          </div>
        </div>
        @for (jobId of review.affectedJobs; track jobId) {
          <label>
            <span>{{ jobName(jobId) }}</span>
            <select
              [ngModel]="reviewDecision(review.packageId, jobId)"
              (ngModelChange)="
                setReviewDecision(review.packageId, jobId, $event)
              "
              [ngModelOptions]="{ standalone: true }"
            >
              <option [ngValue]="null" disabled>
                {{ 'Choose action' | i18n }}
              </option>
              <option [ngValue]="true">{{ 'Add to this job' | i18n }}</option>
              <option [ngValue]="false">{{ 'Skip this job' | i18n }}</option>
            </select>
          </label>
        }
        <button
          tuiButton
          size="s"
          [disabled]="!reviewComplete(review)"
          (click)="resolveReview(review)"
        >
          {{ 'Resolve review' | i18n }}
        </button>
      </article>
    }

    @if (mode() === 'manage') {
      @if (loading()) {
        <p>{{ 'Loading' | i18n }}…</p>
      }

      @if (editor(); as form) {
        <form class="editor panel" (ngSubmit)="save(form)">
          <header class="editor-heading">
            <span tuiTitle>
              <b>{{ form.name || ('Create automatic schedule' | i18n) }}</b>
              <span tuiSubtitle>
                {{
                  (form.id
                    ? 'Edit automatic schedule'
                    : 'Create automatic schedule'
                  ) | i18n
                }}
              </span>
            </span>
            @if (!form.id) {
              <button
                tuiButton
                type="button"
                size="xs"
                appearance="secondary"
                (click)="cancelEditor()"
              >
                {{ 'Cancel' | i18n }}
              </button>
            }
          </header>

          @if (selectedJob(); as job) {
            <div class="selected-job">
              <span tuiTitle>
                <span tuiSubtitle>
                  {{ targetName(job.targetId) }} · {{ 'Next run' | i18n }}:
                  {{
                    job.status.nextRunAt
                      ? (job.status.nextRunAt | date: 'medium')
                      : ('None' | i18n)
                  }}
                </span>
              </span>
              @if (job.pause; as pause) {
                <span tuiBadge appearance="warning">
                  {{ pauseLabel(pause) | i18n }}
                </span>
              } @else if (!job.enabled) {
                <span tuiBadge>{{ 'Paused' | i18n }}</span>
              }
              <div class="actions">
                @if (job.id !== primaryJobId()) {
                  <button
                    tuiButton
                    type="button"
                    size="xs"
                    appearance="secondary"
                    [disabled]="!!job.pause || !job.enabled"
                    (click)="runNow(job)"
                  >
                    {{ 'Run now' | i18n }}
                  </button>
                  <button
                    tuiButton
                    type="button"
                    size="xs"
                    appearance="secondary"
                    (click)="toggle(job)"
                  >
                    {{ (job.enabled ? 'Pause' : 'Resume') | i18n }}
                  </button>
                }
                @if (job.pause && job.pause.reason !== 'user') {
                  <button
                    tuiButton
                    type="button"
                    size="xs"
                    appearance="secondary"
                    (click)="retry(job)"
                  >
                    {{ 'Retry backup location' | i18n }}
                  </button>
                  <button
                    tuiButton
                    type="button"
                    size="xs"
                    appearance="secondary"
                    (click)="beginReassign(job)"
                  >
                    {{ 'Change backup location' | i18n }}
                  </button>
                }
                @if (job.id !== primaryJobId()) {
                  <button
                    tuiButton
                    type="button"
                    size="xs"
                    appearance="flat-destructive"
                    (click)="deleteJob(job)"
                  >
                    {{ 'Delete' | i18n }}
                  </button>
                }
              </div>
            </div>
          }

          <div class="setting-row vertical">
            <span tuiTitle>
              <b>{{ 'Job name' | i18n }}</b>
            </span>
            <tui-textfield>
              <label tuiLabel>{{ 'Job name' | i18n }}</label>
              <input tuiInput name="name" required [(ngModel)]="form.name" />
            </tui-textfield>
          </div>

          <div class="setting-row vertical">
            <span tuiTitle>
              <b>{{ 'Backup location' | i18n }}</b>
              <span tuiSubtitle>{{ targetName(form.targetId) }}</span>
            </span>
            <label>
              <span>{{ 'Backup location' | i18n }}</span>
              <select
                name="target"
                required
                [disabled]="!!form.id"
                [(ngModel)]="form.targetId"
              >
                <option value="" disabled>
                  {{ 'Choose a backup location' | i18n }}
                </option>
                @for (target of targets(); track target.id) {
                  <option [value]="target.id">{{ target.name }}</option>
                }
              </select>
            </label>
          </div>

          <div class="setting-row vertical">
            <span tuiTitle>
              <b>{{ 'Schedule' | i18n }}</b>
              <span tuiSubtitle>{{ scheduleSummary(form) }}</span>
            </span>
            <div class="schedule-controls">
              <tui-textfield tuiChevron [stringify]="stringifyFrequency">
                <label tuiLabel>{{ 'Frequency' | i18n }}</label>
                <input
                  tuiSelect
                  name="frequency"
                  [(ngModel)]="form.frequency"
                />
                <tui-data-list *tuiDropdown>
                  @for (frequency of frequencies; track frequency) {
                    <button tuiOption [value]="frequency">
                      {{ stringifyFrequency(frequency) }}
                    </button>
                  }
                </tui-data-list>
              </tui-textfield>

              @if (form.frequency === 'weekly') {
                <tui-textfield tuiChevron [stringify]="stringifyWeekday">
                  <label tuiLabel>{{ 'Day of week' | i18n }}</label>
                  <input tuiSelect name="weekday" [(ngModel)]="form.weekday" />
                  <tui-data-list *tuiDropdown>
                    @for (day of weekdays; track day.value) {
                      <button tuiOption [value]="day.value">
                        {{ day.label | i18n }}
                      </button>
                    }
                  </tui-data-list>
                </tui-textfield>
              }

              @if (form.frequency !== 'hourly') {
                <tui-textfield
                  tuiChevron
                  [stringify]="stringifyTime"
                  [tuiTextfieldCleaner]="false"
                >
                  <label tuiLabel>{{ 'Hour' | i18n }}</label>
                  <input
                    tuiSelect
                    name="hour"
                    required
                    [(ngModel)]="form.hour"
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
                  name="minute"
                  required
                  [(ngModel)]="form.minute"
                />
                <tui-data-list *tuiDropdown>
                  @for (minute of minutes; track minute) {
                    <button tuiOption [value]="minute">
                      {{ stringifyTime(minute) }}
                    </button>
                  }
                </tui-data-list>
              </tui-textfield>
            </div>
          </div>

          <div class="setting-row vertical services-setting">
            <span tuiTitle>
              <b>{{ 'Services' | i18n }}</b>
              <span tuiSubtitle>{{ selectedServiceSummary(form) }}</span>
            </span>
            <div tuiGroup orientation="vertical" [collapsed]="true">
              @for (pkg of packages(); track pkg.id) {
                <label tuiBlock="m">
                  <input
                    tuiCheckbox
                    type="checkbox"
                    [ngModelOptions]="{ standalone: true }"
                    [ngModel]="form.packageIds.includes(pkg.id)"
                    (ngModelChange)="togglePackage(form, pkg.id, $event)"
                  />
                  <img alt="" [src]="pkg.icon" />
                  <span tuiTitle>
                    <b>{{ pkg.name }}</b>
                  </span>
                </label>
              }
            </div>
            <label class="checkbox-row toggle-all">
              <input
                tuiCheckbox
                type="checkbox"
                [ngModelOptions]="{ standalone: true }"
                [ngModel]="allPackagesSelected(form)"
                (ngModelChange)="setAllPackages(form, $event)"
              />
              <span tuiTitle>
                <b>{{ 'Toggle all' | i18n }}</b>
              </span>
            </label>
            <label class="checkbox-row include-future">
              <input
                tuiCheckbox
                type="checkbox"
                name="includeFuture"
                [(ngModel)]="form.includeFuture"
              />
              <span tuiTitle>
                <b>{{ 'Automatically include future services' | i18n }}</b>
                <span tuiSubtitle>
                  {{
                    'All current and future services are included unless you exclude them.'
                      | i18n
                  }}
                </span>
              </span>
            </label>
          </div>

          <div class="setting-row vertical retention-setting">
            <span tuiTitle>
              <b>{{ 'Version history' | i18n }}</b>
              <span tuiSubtitle>{{ retentionSummary(form) }}</span>
            </span>
            <label class="inline-switch left">
              <input
                tuiSwitch
                type="checkbox"
                [showIcons]="false"
                name="keepAdditional"
                [(ngModel)]="form.keepAdditional"
              />
              <span>{{ 'Keep additional versions' | i18n }}</span>
            </label>
            @if (form.keepAdditional) {
              <div class="retention-rule">
                <span>{{ 'Keep one backup every' | i18n }}</span>
                <tui-textfield
                  tuiChevron
                  [stringify]="stringifyRetentionInterval"
                >
                  <label tuiLabel>{{ 'Frequency' | i18n }}</label>
                  <input
                    tuiSelect
                    name="interval"
                    [(ngModel)]="form.interval"
                  />
                  <tui-data-list *tuiDropdown>
                    @for (interval of retentionIntervals; track interval) {
                      <button tuiOption [value]="interval">
                        {{ stringifyRetentionInterval(interval) }}
                      </button>
                    }
                  </tui-data-list>
                </tui-textfield>
                @if (form.interval !== 'custom') {
                  <span>{{ 'for' | i18n }}</span>
                  <tui-textfield>
                    <label tuiLabel>{{ 'Duration' | i18n }}</label>
                    <input
                      tuiInputNumber
                      name="duration"
                      [min]="1"
                      [max]="365"
                      [(ngModel)]="form.duration"
                    />
                  </tui-textfield>
                  <span>{{ retentionPeriod(form) | i18n }}</span>
                }
              </div>
              @if (form.interval === 'custom') {
                <div class="custom-tier">
                  <tui-textfield>
                    <label tuiLabel>{{ 'Interval hours' | i18n }}</label>
                    <input
                      tuiInputNumber
                      name="customIntervalHours"
                      [min]="1 / 3600"
                      [step]="1 / 3600"
                      [(ngModel)]="form.customIntervalHours"
                    />
                  </tui-textfield>
                  <tui-textfield>
                    <label tuiLabel>{{ 'Coverage hours' | i18n }}</label>
                    <input
                      tuiInputNumber
                      name="customCoverageHours"
                      [min]="1 / 3600"
                      [step]="1 / 3600"
                      [(ngModel)]="form.customCoverageHours"
                    />
                  </tui-textfield>
                </div>
              }
              <div tuiNotification appearance="warning">
                {{
                  'Every retained version is a full copy and each run also needs temporary staging space.'
                    | i18n
                }}
              </div>
            }
          </div>

          @if (form.keepAdditional) {
            <fieldset>
              <legend>{{ 'Retention tiers' | i18n }}</legend>
              @for (tier of form.additionalTiers; track $index) {
                <div class="tier">
                  <tui-textfield>
                    <label tuiLabel>{{ 'Interval hours' | i18n }}</label>
                    <input
                      tuiInputNumber
                      [min]="1"
                      [name]="'interval-' + $index"
                      [(ngModel)]="tier.intervalHours"
                    />
                  </tui-textfield>
                  <tui-textfield>
                    <label tuiLabel>{{ 'Coverage hours' | i18n }}</label>
                    <input
                      tuiInputNumber
                      [min]="1"
                      [name]="'coverage-' + $index"
                      [(ngModel)]="tier.coverageHours"
                    />
                  </tui-textfield>
                  <button
                    tuiButton
                    type="button"
                    size="xs"
                    appearance="flat-destructive"
                    (click)="form.additionalTiers.splice($index, 1)"
                  >
                    {{ 'Remove' | i18n }}
                  </button>
                </div>
              }
              <button
                tuiButton
                type="button"
                size="s"
                appearance="secondary"
                (click)="
                  form.additionalTiers.push({
                    intervalHours: 24,
                    coverageHours: 168,
                  })
                "
              >
                {{ 'Add tier' | i18n }}
              </button>
            </fieldset>
          }

          @if (selectedPackages(form).length) {
            <fieldset>
              <legend>{{ 'Per-service retention overrides' | i18n }}</legend>
              @for (pkg of selectedPackages(form); track pkg.id) {
                <div class="override">
                  <strong>{{ pkg.name }}</strong>
                  <select
                    [name]="'override-' + pkg.id"
                    [ngModel]="overridePreset(form, pkg.id)"
                    (ngModelChange)="setOverridePreset(form, pkg.id, $event)"
                  >
                    <option value="default">
                      {{ 'Use default retention' | i18n }}
                    </option>
                    <option value="latest">{{ 'Latest only' | i18n }}</option>
                    <option value="daily-week">
                      {{ 'Daily for one week' | i18n }}
                    </option>
                    <option value="custom">{{ 'Custom tiers' | i18n }}</option>
                  </select>
                </div>
                @if (form.retentionOverrides[pkg.id]; as override) {
                  @if (override.preset === 'custom') {
                    @for (tier of override.tiers; track $index) {
                      <div class="tier override-tier">
                        <tui-textfield>
                          <label tuiLabel>{{ 'Interval hours' | i18n }}</label>
                          <input
                            tuiInputNumber
                            [min]="1"
                            [name]="
                              'override-interval-' + pkg.id + '-' + $index
                            "
                            [(ngModel)]="tier.intervalHours"
                          />
                        </tui-textfield>
                        <tui-textfield>
                          <label tuiLabel>{{ 'Coverage hours' | i18n }}</label>
                          <input
                            tuiInputNumber
                            [min]="1"
                            [name]="
                              'override-coverage-' + pkg.id + '-' + $index
                            "
                            [(ngModel)]="tier.coverageHours"
                          />
                        </tui-textfield>
                        <button
                          tuiButton
                          type="button"
                          size="xs"
                          appearance="flat-destructive"
                          (click)="override.tiers.splice($index, 1)"
                        >
                          {{ 'Remove' | i18n }}
                        </button>
                      </div>
                    }
                    <button
                      tuiButton
                      type="button"
                      size="s"
                      appearance="secondary"
                      (click)="
                        override.tiers.push({
                          intervalHours: 24,
                          coverageHours: 168,
                        })
                      "
                    >
                      {{ 'Add tier' | i18n }}
                    </button>
                  }
                }
              }
            </fieldset>
          }

          <fieldset>
            <div class="heading estimate-heading">
              <legend>{{ 'Capacity estimates' | i18n }}</legend>
              <button
                tuiButton
                type="button"
                size="xs"
                appearance="secondary"
                (click)="refreshEstimates(form)"
              >
                {{ 'Refresh estimates' | i18n }}
              </button>
            </div>
            <div class="table-wrap">
              <table class="g-table">
                <thead>
                  <tr>
                    <th>{{ 'Service' | i18n }}</th>
                    <th>{{ 'Live data estimate' | i18n }}</th>
                    <th>{{ 'Checkpoints' | i18n }}</th>
                    <th>{{ 'Automatic storage' | i18n }}</th>
                    <th>{{ 'Manual checkpoint' | i18n }}</th>
                    <th>{{ 'Archived storage' | i18n }}</th>
                    <th>{{ 'Next-run staging' | i18n }}</th>
                    <th>{{ 'Last changed bytes' | i18n }}</th>
                    <th>{{ 'Projected peak' | i18n }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (pkg of selectedPackages(form); track pkg.id) {
                    @if (capacityEstimate(pkg.id); as estimate) {
                      <tr>
                        <td>{{ pkg.name }}</td>
                        <td>{{ bytes(estimate.liveLogicalBytes) }}</td>
                        <td>
                          {{ estimate.retainedSnapshotCount }} /
                          {{ estimate.maximumProjectedSnapshotCount }}
                        </td>
                        <td>{{ bytes(estimate.scheduledRetainedBytes) }}</td>
                        <td>
                          @if (estimate.manualCheckpointBytes === null) {
                            {{ 'Unknown' | i18n }}
                          } @else {
                            {{ bytes(estimate.manualCheckpointBytes) }}
                          }
                        </td>
                        <td>{{ bytes(estimate.archivedBytes) }}</td>
                        <td>{{ bytes(estimate.stagingHeadroomBytes) }}</td>
                        <td>
                          @if (estimate.lastChangedBytes === null) {
                            {{ 'Unknown' | i18n }}
                          } @else {
                            {{ bytes(estimate.lastChangedBytes) }}
                          }
                        </td>
                        <td>
                          {{
                            bytes(estimate.conservativePeakExcludingManualBytes)
                          }}
                        </td>
                      </tr>
                    } @else {
                      <tr>
                        <td>{{ pkg.name }}</td>
                        <td colspan="8">{{ 'Unknown' | i18n }}</td>
                      </tr>
                    }
                  }
                </tbody>
              </table>
            </div>
          </fieldset>

          @if (projectedCount(form) > 1) {
            <div tuiNotification appearance="warning">
              {{
                'Every retained version is a full copy. Each run also makes a full target-side staging copy. This can substantially increase storage use, runtime, and I/O, especially on CIFS and slow external devices.'
                  | i18n
              }}
              <label class="check-row">
                <input
                  tuiCheckbox
                  type="checkbox"
                  name="capacityConfirmed"
                  [(ngModel)]="form.capacityConfirmed"
                />
                {{ 'I understand the full-copy storage impact' | i18n }}
              </label>
            </div>
          }

          @if (!form.id) {
            <label class="checkbox-row first-backup">
              <input
                tuiCheckbox
                type="checkbox"
                name="firstBackupNow"
                [(ngModel)]="form.firstBackupNow"
              />
              <span tuiTitle>
                <b>{{ 'Create the first backup now' | i18n }}</b>
                <span tuiSubtitle>
                  {{ 'Recommended so protection begins immediately.' | i18n }}
                </span>
              </span>
            </label>

            <tui-textfield>
              <label tuiLabel>{{ 'Master Password' | i18n }}</label>
              <input
                tuiInput
                type="password"
                name="password"
                required
                autocomplete="off"
                [(ngModel)]="form.password"
              />
              <tui-icon tuiPassword />
            </tui-textfield>
          }

          <p class="muted">
            {{ 'Captured timezone' | i18n }}: {{ form.timezone }} ·
            {{ 'Maximum automatic checkpoints per service' | i18n }}:
            {{ projectedCount(form) }}
          </p>
          <footer class="g-buttons">
            <button
              tuiButton
              type="submit"
              [disabled]="saving() || !canSave(form)"
            >
              {{ (saving() ? 'Saving' : 'Save') | i18n }}
            </button>
          </footer>
        </form>
      }

      <button
        tuiCell
        tuiAppearance="outline-grayscale"
        type="button"
        class="schedules-toggle"
        [attr.aria-expanded]="showSchedules()"
        (click)="showSchedules.set(!showSchedules())"
      >
        <tui-icon icon="@tui.list" />
        <span tuiTitle>
          <b>{{ 'View all backup schedules' | i18n }}</b>
          <span tuiSubtitle>
            {{ jobs().length }} {{ 'Automatic backups' | i18n }}
          </span>
        </span>
        <tui-icon icon="@tui.chevron-down" [class.rotated]="showSchedules()" />
      </button>

      @if (showSchedules()) {
        <section class="schedule-browser">
          <header class="heading">
            <span tuiTitle>
              <b>{{ 'View all backup schedules' | i18n }}</b>
            </span>
            <button
              tuiButton
              type="button"
              size="s"
              iconStart="@tui.plus"
              (click)="create()"
            >
              {{ 'Create automatic schedule' | i18n }}
            </button>
          </header>

          <div class="schedule-list">
            @for (job of jobs(); track job.id) {
              <button
                tuiCell
                tuiAppearance="outline-grayscale"
                type="button"
                [class.selected]="job.id === selectedJobId()"
                (click)="selectJob(job.id)"
              >
                <tui-icon icon="@tui.calendar-clock" />
                <span tuiTitle>
                  <b>{{ job.name }}</b>
                  <span tuiSubtitle>
                    {{ targetName(job.targetId) }} · {{ 'Next run' | i18n }}:
                    {{
                      job.status.nextRunAt
                        ? (job.status.nextRunAt | date: 'medium')
                        : ('None' | i18n)
                    }}
                  </span>
                </span>
                @if (job.pause; as pause) {
                  <span tuiBadge appearance="warning">
                    {{ pauseLabel(pause) | i18n }}
                  </span>
                } @else if (!job.enabled) {
                  <span tuiBadge>{{ 'Paused' | i18n }}</span>
                }
              </button>
            }
          </div>
        </section>
      }

      @if (reassigning(); as job) {
        <form class="editor" (ngSubmit)="reassign(job)">
          <div class="heading">
            <h3>{{ 'Change backup location' | i18n }} — {{ job.name }}</h3>
            <button
              tuiButton
              type="button"
              size="xs"
              appearance="secondary"
              (click)="cancelReassign(job)"
            >
              {{ 'Cancel' | i18n }}
            </button>
          </div>
          <div class="grid">
            <label>
              <span>{{ 'New backup location' | i18n }}</span>
              <select name="newTarget" required [(ngModel)]="reassignTargetId">
                @for (target of targets(); track target.id) {
                  <option [value]="target.id">{{ target.name }}</option>
                }
              </select>
            </label>
            <tui-textfield>
              <label tuiLabel>{{ 'Master Password' | i18n }}</label>
              <input
                tuiInput
                name="reassignPassword"
                type="password"
                required
                autocomplete="off"
                [(ngModel)]="reassignPassword"
              />
              <tui-icon tuiPassword />
            </tui-textfield>
            <label class="switch-row">
              <input
                tuiSwitch
                [showIcons]="false"
                name="waitForSchedule"
                type="checkbox"
                [(ngModel)]="waitForSchedule"
              />
              <span>{{ 'Wait for next automatic run' | i18n }}</span>
            </label>
          </div>
          <div tuiNotification appearance="warning">
            {{
              'Existing checkpoints are not moved. They remain archived at the original backup location.'
                | i18n
            }}
          </div>
          <footer class="g-buttons">
            <button
              tuiButton
              [disabled]="!reassignTargetId || !reassignPassword"
            >
              {{ 'Change backup location' | i18n }}
            </button>
          </footer>
        </form>
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: 1rem;
      margin-bottom: 2rem;
    }

    [tuiTitle],
    .schedule-controls > *,
    .schedule-list > * {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      margin: 1.5rem 0 0.75rem;
    }

    .heading h3 {
      margin: 0;
    }

    .table-wrap {
      width: 100%;
      max-width: 100%;
      min-width: 0;
      overflow-x: auto;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
    }

    .selected-job,
    .editor-heading,
    .setting-row,
    .checkbox-row,
    .inline-switch {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    .selected-job {
      flex-wrap: wrap;
      padding: 1rem;
      border: 1px solid var(--tui-border-normal);
      border-radius: var(--tui-radius-m);
    }

    .selected-job > [tuiTitle] {
      flex: 1 1 16rem;
    }

    .editor,
    .review {
      display: grid;
      gap: 1rem;
      margin-top: 1rem;
      padding: 1rem;
      border: 1px solid var(--tui-border-normal);
      border-radius: 0.75rem;
      min-width: 0;
      overflow: hidden;
    }

    .editor.panel {
      width: 100%;
      padding: 1.25rem;
      box-sizing: border-box;
    }

    .setting-row.vertical {
      align-items: stretch;
      flex-direction: column;
    }

    .schedule-controls {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
      gap: 0.75rem;
      align-items: end;
      width: 100%;
      min-width: 0;
    }

    .schedule-controls tui-textfield,
    [tuiGroup] {
      width: 100%;
    }

    [tuiBlock] img {
      width: 2.5rem;
      border-radius: 50%;
    }

    [tuiBlock] [tuiTitle],
    .include-future [tuiTitle] {
      flex: 1;
    }

    .toggle-all,
    .first-backup {
      width: fit-content;
      max-width: 100%;
      justify-content: flex-start;
    }

    .toggle-all {
      padding-inline: 1rem;
      box-sizing: border-box;
    }

    .include-future {
      align-items: flex-start;
      width: 100%;
      max-width: 100%;
      padding-block: 0.75rem;
      padding-inline: 1rem;
      border-radius: var(--tui-radius-m);
      background: var(--tui-background-accent-2);
      color: var(--tui-text-primary-on-accent-2);
      box-sizing: border-box;
    }

    .include-future [tuiSubtitle] {
      color: inherit;
    }

    .inline-switch.left {
      width: fit-content;
      justify-content: flex-start;
    }

    .retention-rule {
      display: grid;
      grid-template-columns: auto minmax(7rem, 1fr) auto 6rem auto;
      gap: 0.5rem;
      align-items: center;
    }

    .custom-tier {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem;
      width: 100%;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
      gap: 1rem;
      align-items: end;
    }

    label > span:first-child {
      display: block;
      margin-bottom: 0.35rem;
      color: var(--tui-text-secondary);
    }

    fieldset {
      display: grid;
      gap: 0.65rem;
      min-width: 0;
      border: 1px solid var(--tui-border-normal);
      border-radius: 0.5rem;
    }

    .check-row,
    .switch-row {
      display: flex;
      align-items: center;
      gap: 0.65rem;
    }

    .switch-row {
      justify-content: flex-start;
      min-height: 2.75rem;
    }

    .tier {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 0.75rem;
      align-items: end;
    }

    .override {
      display: grid;
      grid-template-columns: minmax(10rem, 1fr) minmax(12rem, 1fr);
      gap: 0.75rem;
      align-items: center;
    }

    .override-tier {
      margin-left: 1rem;
    }

    .muted,
    .snapshot-row {
      color: var(--tui-text-secondary);
    }

    .snapshot-row td {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
    }

    .snapshot-row button,
    .actions button {
      max-width: 100%;
      height: auto;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .grid > *,
    .override > *,
    .histories td {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .history-heading {
      margin-top: 2rem;
    }

    .schedules-toggle,
    .schedule-list > button {
      width: 100%;
      min-width: 0;
      text-align: left;
      box-sizing: border-box;
    }

    .schedules-toggle [tuiTitle],
    .schedule-list [tuiTitle] {
      flex: 1;
    }

    .schedule-browser,
    .schedule-list {
      display: grid;
      gap: 0.75rem;
      min-width: 0;
    }

    .schedule-browser {
      padding: 1rem;
      border: 1px solid var(--tui-border-normal);
      border-radius: var(--tui-radius-m);
    }

    .schedule-browser .heading {
      margin: 0;
    }

    .schedule-list > button.selected {
      box-shadow: inset 0 0 0 2px var(--tui-border-focus);
    }

    .schedules-toggle > tui-icon:last-child {
      transition: transform var(--tui-duration, 0.2s);
    }

    .rotated {
      transform: rotate(180deg);
    }

    .estimate-heading {
      margin: 0 0 0.5rem;
    }

    @media (max-width: 30rem) {
      .heading,
      .selected-job,
      .editor-heading {
        align-items: stretch;
        flex-direction: column;
      }

      .heading > button,
      .editor-heading > button {
        align-self: flex-start;
      }

      .schedule-controls,
      .retention-rule,
      .custom-tier {
        grid-template-columns: 1fr;
      }

      .tier,
      .override {
        grid-template-columns: 1fr;
      }

      .override-tier {
        margin-left: 0;
      }
    }
  `,
  host: { class: 'backup-settings' },
  imports: [
    DatePipe,
    FormsModule,
    TuiAppearance,
    TuiBadge,
    TuiBlock,
    TuiButton,
    TuiCell,
    TuiCheckbox,
    TuiChevron,
    TuiDataList,
    TuiGroup,
    TuiIcon,
    TuiInput,
    TuiInputNumber,
    TuiNotification,
    TuiPassword,
    TuiSelect,
    TuiSwitch,
    TuiTitle,
    i18nPipe,
  ],
})
export class ScheduledBackupsComponent implements OnInit {
  readonly mode = input.required<'manage' | 'restore'>()
  readonly primaryJobId = input.required<string>()

  private readonly api = inject(ApiService)
  private readonly backupService = inject(BackupService)
  private readonly dialogs = inject(DialogService)
  private readonly errors = inject(ErrorService)
  private readonly i18n = inject(i18nPipe)
  private readonly packageData = toSignal(
    inject<PatchDB<DataModel>>(PatchDB).watch$('packageData'),
  )

  readonly jobs = signal<T.BackupJob[]>([])
  readonly histories = signal<T.ServiceTargetHistory[]>([])
  readonly reviews = signal<T.NewServiceBackupReview[]>([])
  readonly loading = signal(true)
  readonly saving = signal(false)
  readonly editor = signal<JobEditor | null>(null)
  protected readonly selectedJobId = signal('')
  protected readonly showSchedules = signal(false)
  readonly reassigning = signal<T.BackupJob | null>(null)
  readonly policyHistory = signal<T.ServiceTargetHistory | null>(null)
  readonly policyTiers = signal<TierEditor[]>([])
  readonly policyPreview = signal<T.RetentionPolicyChangePreview | null>(null)
  readonly estimates = signal<T.BackupServiceCapacityEstimate[]>([])

  reassignTargetId = ''
  reassignPassword = ''
  waitForSchedule = false
  confirmPrune = false

  private readonly reviewDecisions = new Map<
    string,
    Record<string, boolean | null>
  >()

  readonly targets = computed(() => [
    ...this.backupService.cifs().map(target => ({
      id: target.id,
      name: formatCifsLocation(target.entry),
    })),
    ...this.backupService.drives().map(target => ({
      id: target.id,
      name:
        [target.entry.vendor, target.entry.model].filter(Boolean).join(' ') ||
        target.id,
    })),
  ])

  readonly packages = computed(() =>
    Object.entries(this.packageData() || {}).flatMap(([id, entry]) => {
      const state = entry.stateInfo
      const manifest =
        state.state === 'installed' || state.state === 'removing'
          ? state.manifest
          : state.installingInfo?.newManifest
      return manifest ? [{ id, name: manifest.title, icon: entry.icon }] : []
    }),
  )
  protected readonly selectedJob = computed(() =>
    this.jobs().find(job => job.id === this.selectedJobId()),
  )

  protected readonly frequencies: BackupScheduleFrequency[] = [
    'hourly',
    'daily',
    'weekly',
  ]
  protected readonly retentionIntervals: BackupRetentionTierEditor['interval'][] =
    ['hour', 'day', 'week', 'month', 'custom']
  readonly weekdays = [
    { value: 0, label: 'Sunday' as const },
    { value: 1, label: 'Monday' as const },
    { value: 2, label: 'Tuesday' as const },
    { value: 3, label: 'Wednesday' as const },
    { value: 4, label: 'Thursday' as const },
    { value: 5, label: 'Friday' as const },
    { value: 6, label: 'Saturday' as const },
  ]
  protected readonly hours = BACKUP_HOURS
  protected readonly minutes = BACKUP_MINUTES
  protected readonly stringifyTime = formatBackupTime
  protected readonly stringifyFrequency = (
    frequency: BackupScheduleFrequency,
  ) =>
    this.i18n.transform(
      frequency === 'hourly'
        ? 'Hourly'
        : frequency === 'weekly'
          ? 'Weekly'
          : 'Daily',
    )
  protected readonly stringifyWeekday = (weekday: number) =>
    this.i18n.transform(this.weekdays[weekday]?.label || 'Sunday')
  protected readonly stringifyRetentionInterval = (
    interval: BackupRetentionTierEditor['interval'],
  ) =>
    this.i18n.transform(
      interval === 'hour'
        ? 'Hour'
        : interval === 'day'
          ? 'Day'
          : interval === 'week'
            ? 'Week'
            : interval === 'month'
              ? 'Month'
              : 'Custom tiers',
    )

  async ngOnInit() {
    await this.backupService.getBackupTargets()
    await this.reload()
  }

  async reload() {
    this.loading.set(true)
    try {
      const [jobs, histories, reviews] = await Promise.all([
        this.api.getScheduledBackupJobs({}),
        this.api.getScheduledBackupHistories({}),
        this.api.getNewServiceBackupReviews({}),
      ])
      this.jobs.set(jobs)
      this.histories.set(histories)
      this.reviews.set(reviews)
      for (const review of reviews) {
        this.reviewDecisions.set(
          review.packageId,
          Object.fromEntries(review.affectedJobs.map(id => [id, null])),
        )
      }
      const selected = this.jobs().find(job => job.id === this.selectedJobId())
      if (this.editor()?.id && !selected) this.editor.set(null)
      if (!this.editor()) {
        this.edit(
          selected ||
            this.jobs().find(job => job.id === this.primaryJobId()) ||
            this.jobs()[0],
        )
      }
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    } finally {
      this.loading.set(false)
    }
  }

  create() {
    const now = new Date()
    const form: JobEditor = {
      name: '',
      targetId: this.targets()[0]?.id || '',
      packageIds: this.packages().map(pkg => pkg.id),
      includeFuture: true,
      preservedSelectedPackageIds: [],
      preservedExcludedPackageIds: [],
      frequency: 'daily',
      minute: now.getMinutes(),
      hour: now.getHours(),
      weekday: now.getDay(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      keepAdditional: false,
      interval: 'day',
      duration: 7,
      customIntervalHours: 24,
      customCoverageHours: 168,
      additionalTiers: [],
      retentionOverrides: {},
      password: '',
      firstBackupNow: true,
      capacityConfirmed: false,
    }
    this.showSchedules.set(false)
    this.reassigning.set(null)
    this.selectedJobId.set('')
    this.editor.set(form)
    void this.refreshEstimates(form)
  }

  selectJob(id: string) {
    this.showSchedules.set(false)
    this.reassigning.set(null)
    this.edit(this.jobs().find(job => job.id === id))
  }

  cancelEditor() {
    this.edit(
      this.jobs().find(job => job.id === this.primaryJobId()) || this.jobs()[0],
    )
  }

  edit(job?: T.BackupJob) {
    if (!job) return
    const schedule = parseBackupSchedule(job.schedule)
    const selection = parseBackupServiceSelection(
      job.services,
      this.packages().map(pkg => pkg.id),
    )
    const [tier, ...additionalTiers] = job.defaultRetention.tiers
    const retention = parseBackupRetentionTier(tier)
    const form: JobEditor = {
      id: job.id,
      name: job.name,
      targetId: job.targetId,
      ...selection,
      ...schedule,
      keepAdditional: !!tier,
      ...retention,
      additionalTiers: this.toTierEditors({ tiers: additionalTiers }),
      retentionOverrides: Object.fromEntries(
        Object.entries(job.retentionOverrides).map(([packageId, policy]) => [
          packageId,
          {
            preset: this.retentionPreset(policy),
            tiers: this.toTierEditors(policy),
          },
        ]),
      ),
      password: '',
      firstBackupNow: false,
      capacityConfirmed: false,
    }
    this.selectedJobId.set(job.id)
    this.editor.set(form)
    void this.refreshEstimates(form)
  }

  togglePackage(form: JobEditor, packageId: string, checked: boolean) {
    form.packageIds = checked
      ? [...new Set([...form.packageIds, packageId])]
      : form.packageIds.filter(id => id !== packageId)
    if (!checked) delete form.retentionOverrides[packageId]
    form.capacityConfirmed = false
  }

  allPackagesSelected(form: JobEditor): boolean {
    return (
      this.packages().length > 0 &&
      this.packages().every(pkg => form.packageIds.includes(pkg.id))
    )
  }

  setAllPackages(form: JobEditor, checked: boolean) {
    form.packageIds = checked ? this.packages().map(pkg => pkg.id) : []
    if (!checked) form.retentionOverrides = {}
    form.capacityConfirmed = false
  }

  overridePreset(
    form: JobEditor,
    packageId: string,
  ): RetentionPreset | 'default' {
    return form.retentionOverrides[packageId]?.preset || 'default'
  }

  setOverridePreset(
    form: JobEditor,
    packageId: string,
    preset: RetentionPreset | 'default',
  ) {
    if (preset === 'default') {
      delete form.retentionOverrides[packageId]
    } else {
      const current = form.retentionOverrides[packageId]
      form.retentionOverrides[packageId] = {
        preset,
        tiers:
          preset === 'latest'
            ? []
            : preset === 'daily-week'
              ? [{ intervalHours: 24, coverageHours: 168 }]
              : current?.tiers || [],
      }
    }
    form.capacityConfirmed = false
  }

  async save(form: JobEditor) {
    if (this.saving() || !this.canSave(form)) return
    this.saving.set(true)
    try {
      const common = {
        name: form.name.trim(),
        services: serializeBackupServiceSelection(
          form,
          this.packages().map(pkg => pkg.id),
        ),
        schedule: serializeBackupSchedule(form),
        defaultRetention: this.defaultPolicy(form),
        retentionOverrides: Object.fromEntries(
          Object.entries(form.retentionOverrides).map(
            ([packageId, override]) => [packageId, this.policy(override.tiers)],
          ),
        ),
      }
      if (form.id) {
        await this.api.updateScheduledBackupJob({
          id: form.id,
          ...common,
        })
      } else {
        const created = await this.api.createScheduledBackupJob({
          ...common,
          targetId: form.targetId,
          password: form.password,
          enabled: true,
        })
        this.selectedJobId.set(created.id)
        if (form.firstBackupNow) {
          await this.api.runScheduledBackupJob({ id: created.id })
        }
      }
      this.editor.set(null)
      await this.reload()
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    } finally {
      this.saving.set(false)
    }
  }

  async runNow(job: T.BackupJob) {
    await this.perform(() => this.api.runScheduledBackupJob({ id: job.id }))
  }

  async toggle(job: T.BackupJob) {
    await this.perform(() =>
      this.api.setScheduledBackupJobEnabled({
        id: job.id,
        enabled: !job.enabled,
      }),
    )
  }

  async deleteJob(job: T.BackupJob) {
    const confirmed = await firstValueFrom(
      this.dialogs
        .openConfirm({
          label: 'Delete scheduled job?',
          size: 's',
          data: {
            content:
              'Snapshots that are no longer referenced will be kept as an archive by default.',
            yes: 'Delete',
            no: 'Cancel',
          },
        })
        .pipe(filter(Boolean)),
      { defaultValue: false },
    )
    if (!confirmed) return

    const unreferenced = this.histories().filter(
      history =>
        history.snapshots.length > 0 &&
        history.feedingJobs.length === 1 &&
        history.feedingJobs[0] === job.id,
    )
    const deleteCheckpoints = unreferenced.length
      ? await firstValueFrom(
          this.dialogs.openConfirm({
            label: 'Delete unreferenced checkpoints?',
            size: 's',
            data: {
              content:
                'This job is the last reference to these checkpoints. Keeping the archive is the safe default.',
              yes: 'Delete checkpoints',
              no: 'Keep archive',
            },
          }),
          { defaultValue: false },
        )
      : false

    await this.perform(async () => {
      await this.api.deleteScheduledBackupJob({ id: job.id })
      if (deleteCheckpoints) {
        for (const history of unreferenced) {
          await this.api.deleteArchivedBackupSnapshots({
            targetId: history.targetId,
            packageId: history.packageId,
            snapshotIds: history.snapshots.map(snapshot => snapshot.id),
          })
        }
      }
    })
  }

  async retry(job: T.BackupJob) {
    const password = await firstValueFrom(
      this.dialogs.openPrompt<string>({
        label: 'Enter Password',
        data: {
          message: 'Enter Password',
          label: 'Password',
          placeholder: 'Password',
          buttonText: 'Retry',
          useMask: true,
        },
      }),
      { defaultValue: '' },
    )
    if (!password) return
    await this.perform(() =>
      this.api.retryScheduledBackupTarget({
        targetId: job.targetId,
        password,
      }),
    )
  }

  beginReassign(job: T.BackupJob) {
    this.editor.set(null)
    this.showSchedules.set(false)
    this.reassigning.set(job)
    this.reassignTargetId =
      this.targets().find(t => t.id !== job.targetId)?.id || ''
    this.reassignPassword = ''
    this.waitForSchedule = false
  }

  cancelReassign(job: T.BackupJob) {
    this.reassigning.set(null)
    this.edit(job)
  }

  async reassign(job: T.BackupJob) {
    await this.perform(() =>
      this.api.reassignScheduledBackupTarget({
        id: job.id,
        targetId: this.reassignTargetId,
        password: this.reassignPassword,
        waitForSchedule: this.waitForSchedule,
      }),
    )
    this.reassigning.set(null)
  }

  reviewDecision(packageId: string, jobId: string): boolean | null {
    return this.reviewDecisions.get(packageId)?.[jobId] ?? null
  }

  setReviewDecision(packageId: string, jobId: string, value: boolean) {
    const decisions = this.reviewDecisions.get(packageId) || {}
    decisions[jobId] = value
    this.reviewDecisions.set(packageId, decisions)
  }

  reviewComplete(review: T.NewServiceBackupReview): boolean {
    const decisions = this.reviewDecisions.get(review.packageId)
    return review.affectedJobs.every(jobId => decisions?.[jobId] != null)
  }

  async resolveReview(review: T.NewServiceBackupReview) {
    if (!this.reviewComplete(review)) return
    const decisions = Object.fromEntries(
      Object.entries(this.reviewDecisions.get(review.packageId) || {}).map(
        ([jobId, decision]) => [jobId, decision === true],
      ),
    )
    await this.perform(() =>
      this.api.resolveNewServiceBackupReview({
        packageId: review.packageId,
        decisions,
      }),
    )
  }

  editPolicy(history: T.ServiceTargetHistory) {
    this.policyHistory.set(history)
    this.policyTiers.set(this.toTierEditors(history.policy))
    this.policyPreview.set(null)
    this.confirmPrune = false
  }

  async previewPolicy(history: T.ServiceTargetHistory) {
    try {
      this.policyPreview.set(
        await this.api.previewScheduledRetention({
          targetId: history.targetId,
          packageId: history.packageId,
          policy: this.policy(this.policyTiers()),
        }),
      )
      this.confirmPrune = false
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    }
  }

  async applyPolicy(history: T.ServiceTargetHistory) {
    const preview = this.policyPreview()
    if (!preview) return
    await this.perform(() =>
      this.api.updateScheduledRetention({
        targetId: history.targetId,
        packageId: history.packageId,
        policy: this.policy(this.policyTiers()),
        confirmedRemovals: preview.removed.map(snapshot => snapshot.id),
      }),
    )
    this.policyHistory.set(null)
  }

  async deleteArchive(history: T.ServiceTargetHistory) {
    const confirmed = await firstValueFrom(
      this.dialogs
        .openConfirm({
          label: 'Delete archived checkpoints?',
          size: 's',
          data: {
            content:
              'This permanently deletes every checkpoint in this archive.',
            yes: 'Delete',
            no: 'Cancel',
          },
        })
        .pipe(filter(Boolean)),
      { defaultValue: false },
    )
    if (!confirmed) return
    await this.perform(() =>
      this.api.deleteArchivedBackupSnapshots({
        targetId: history.targetId,
        packageId: history.packageId,
        snapshotIds: this.archivedSnapshots(history).map(
          snapshot => snapshot.id,
        ),
      }),
    )
  }

  restoreLatest(history: T.ServiceTargetHistory) {
    const latest = this.newestFirst(history.snapshots)[0]
    if (latest) this.restoreSnapshot(history, latest)
  }

  async restoreSnapshot(
    history: T.ServiceTargetHistory,
    snapshot: T.ServiceSnapshot,
  ) {
    const confirmed = await firstValueFrom(
      this.dialogs
        .openConfirm({
          label: 'Restore scheduled checkpoint?',
          size: 's',
          data: {
            content: 'The selected scheduled checkpoint will be restored.',
            yes: 'Restore',
            no: 'Cancel',
          },
        })
        .pipe(filter(Boolean)),
      { defaultValue: false },
    )
    if (!confirmed) return
    await this.perform(() =>
      this.api.restoreScheduledBackup({
        targetId: history.targetId,
        snapshots: { [history.packageId]: snapshot.id },
      }),
    )
  }

  packageName(id: string): string {
    return this.packages().find(pkg => pkg.id === id)?.name || id
  }

  jobName(id: string): string {
    return this.jobs().find(job => job.id === id)?.name || id
  }

  affectedJobNames(history: T.ServiceTargetHistory): string[] {
    return history.feedingJobs.map(id => this.jobName(id))
  }

  targetName(id: string): string {
    return this.targets().find(target => target.id === id)?.name || id
  }

  pauseLabel(pause: T.BackupJobPause) {
    switch (pause.reason) {
      case 'targetUnavailable':
        return 'Backup location unavailable' as const
      case 'targetIdentityMismatch':
        return 'Backup location changed' as const
      case 'reauthenticationRequired':
        return 'Authentication required' as const
      default:
        return 'Paused' as const
    }
  }

  scheduleSummary(form: JobEditor): string {
    const minute = String(form.minute).padStart(2, '0')
    const time = `${String(form.hour).padStart(2, '0')}:${minute}`
    if (form.frequency === 'hourly') {
      return `${this.i18n.transform('Hourly')} · ${this.i18n.transform('Minute')} ${minute}`
    }
    if (form.frequency === 'weekly') {
      const day = this.weekdays[form.weekday]?.label || 'Sunday'
      return `${this.i18n.transform(day)} · ${time}`
    }
    return `${this.i18n.transform('Daily')} · ${time}`
  }

  selectedServiceSummary(form: JobEditor): string {
    if (this.allPackagesSelected(form) && form.includeFuture) {
      return this.i18n.transform('All current and future services')
    }
    return `${form.packageIds.length} / ${this.packages().length} ${this.i18n.transform('Services')}`
  }

  retentionSummary(form: JobEditor): string {
    if (!form.keepAdditional) {
      return this.i18n.transform('Keep only the latest automatic checkpoint')
    }
    const every = this.i18n.transform('Keep one backup every')
    if (form.interval === 'custom') {
      const intervalUnit = this.i18n.transform(
        form.customIntervalHours === 1 ? 'hour' : 'hours',
      )
      const coverageUnit = this.i18n.transform(
        form.customCoverageHours === 1 ? 'hour' : 'hours',
      )
      return `${every} ${form.customIntervalHours} ${intervalUnit} ${this.i18n.transform('for')} ${form.customCoverageHours} ${coverageUnit}`
    }
    const interval = this.i18n.transform(form.interval)
    const forLabel = this.i18n.transform('for')
    const period = this.i18n.transform(this.retentionPeriod(form))
    return `${every} ${interval} ${forLabel} ${form.duration} ${period}`
  }

  retentionPeriod(form: JobEditor) {
    return form.interval === 'custom'
      ? 'hours'
      : retentionPeriodLabel(form.interval, form.duration)
  }

  canSave(form: JobEditor): boolean {
    return !!(
      form.name.trim() &&
      form.targetId &&
      form.packageIds.length &&
      this.validSchedule(form) &&
      (form.id || form.password) &&
      (this.projectedCount(form) <= 1 || form.capacityConfirmed)
    )
  }

  private validSchedule(form: JobEditor): boolean {
    const validMinute =
      Number.isInteger(form.minute) && form.minute >= 0 && form.minute <= 59
    const validHour =
      form.frequency === 'hourly' ||
      (Number.isInteger(form.hour) && form.hour >= 0 && form.hour <= 23)
    return validMinute && validHour
  }

  projectedCount(form: JobEditor): number {
    return Math.max(
      this.maximumProjected(this.defaultPolicy(form)),
      ...Object.values(form.retentionOverrides).map(override =>
        this.maximumProjected(this.policy(override.tiers)),
      ),
    )
  }

  selectedPackages(form: JobEditor) {
    return this.packages().filter(pkg => form.packageIds.includes(pkg.id))
  }

  capacityEstimate(packageId: string) {
    return this.estimates().find(estimate => estimate.packageId === packageId)
  }

  async refreshEstimates(form: JobEditor) {
    if (!form.targetId) return
    try {
      this.estimates.set(
        await this.api.estimateScheduledBackupCapacity({
          targetId: form.targetId,
          services: serializeBackupServiceSelection(
            form,
            this.packages().map(pkg => pkg.id),
          ),
          defaultRetention: this.defaultPolicy(form),
          retentionOverrides: Object.fromEntries(
            Object.entries(form.retentionOverrides).map(
              ([packageId, override]) => [
                packageId,
                this.policy(override.tiers),
              ],
            ),
          ),
        }),
      )
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    }
  }

  maximumProjected(policy: T.RetentionPolicy): number {
    return (
      1 +
      policy.tiers.reduce(
        (sum, tier) =>
          sum + Math.ceil(tier.coverageSeconds / tier.intervalSeconds),
        0,
      )
    )
  }

  historyBytes(history: T.ServiceTargetHistory): number {
    return history.snapshots.reduce(
      (sum, snapshot) => sum + (snapshot.physicalSize ?? snapshot.logicalSize),
      0,
    )
  }

  stagingBytes(history: T.ServiceTargetHistory): number | null {
    const latest = this.newestFirst(
      history.snapshots.filter(snapshot => !snapshot.archived),
    )[0]
    return latest
      ? Math.ceil((latest.physicalSize ?? latest.logicalSize) * 1.1)
      : null
  }

  lastChanged(history: T.ServiceTargetHistory): number | null {
    return this.newestFirst(history.snapshots)[0]?.changedBytes ?? null
  }

  bytes(value: number | null): string {
    if (value === null) return '—'
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let amount = value
    let unit = 0
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024
      unit++
    }
    return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`
  }

  newestFirst(snapshots: T.ServiceSnapshot[]): T.ServiceSnapshot[] {
    return [...snapshots].sort((a, b) =>
      b.completedAt.localeCompare(a.completedAt),
    )
  }

  archivedSnapshots(history: T.ServiceTargetHistory): T.ServiceSnapshot[] {
    return history.snapshots.filter(snapshot => snapshot.archived)
  }

  private defaultPolicy(form: JobEditor): T.RetentionPolicy {
    if (!form.keepAdditional) return { tiers: [] }
    return {
      tiers: [
        serializeBackupRetentionTier(form),
        ...this.policy(form.additionalTiers).tiers,
      ],
    }
  }

  private policy(tiers: TierEditor[]): T.RetentionPolicy {
    return {
      tiers: tiers.map(tier => ({
        intervalSeconds: Math.round(Number(tier.intervalHours) * 3600),
        coverageSeconds: Math.round(Number(tier.coverageHours) * 3600),
      })),
    }
  }

  private toTierEditors(policy: T.RetentionPolicy): TierEditor[] {
    return policy.tiers.map(tier => ({
      intervalHours: tier.intervalSeconds / 3600,
      coverageHours: tier.coverageSeconds / 3600,
    }))
  }

  private retentionPreset(policy: T.RetentionPolicy): RetentionPreset {
    if (!policy.tiers.length) return 'latest'
    if (
      policy.tiers.length === 1 &&
      policy.tiers[0]!.intervalSeconds === 24 * 60 * 60 &&
      policy.tiers[0]!.coverageSeconds === 7 * 24 * 60 * 60
    ) {
      return 'daily-week'
    }
    return 'custom'
  }

  private async perform<T>(action: () => Promise<T>) {
    try {
      await action()
      await this.reload()
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    }
  }
}
