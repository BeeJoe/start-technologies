import { DatePipe, NgTemplateOutlet } from '@angular/common'
import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  effect,
  inject,
  Injector,
  input,
  OnInit,
  output,
  signal,
  viewChild,
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
  TuiDropdown,
  TuiGroup,
  TuiIcon,
  TuiInput,
  TuiLabel,
  TuiNotification,
  TuiTitle,
} from '@taiga-ui/core'
import {
  TuiAccordion,
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
  BACKUP_MONTH_DAYS,
  formatBackupTime,
  parseBackupRetentionTier,
  parseBackupSchedule,
  parseBackupServiceSelection,
  retentionIntervalFromSeconds,
  retentionIntervalSeconds,
  retentionPeriodLabel,
  serializeBackupRetentionTier,
  serializeBackupServiceSelection,
  serializeBackupSchedule,
  SYSTEM_PACKAGE_ID,
} from './scheduled.utils'
import { DeleteScheduleService } from './delete-schedule.dialog'

interface EditableRetentionRule extends BackupRetentionTierEditor {
  preserved: {
    tier: T.RetentionTier
    interval: BackupRetentionTierEditor['interval']
    duration: number
  } | null
}

interface RetentionOverrideEditor {
  tiers: EditableRetentionRule[]
}

interface JobEditor extends EditableRetentionRule {
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
  dayOfMonth: number
  timezone: string
  keepAdditional: boolean
  additionalTiers: EditableRetentionRule[]
  retentionOverrides: Record<string, RetentionOverrideEditor>
  password: string
  firstBackupNow: boolean
  capacityConfirmed: boolean
}

@Component({
  selector: 'section[scheduledBackups]',
  template: `
    <ng-template
      #retentionRule
      let-rule
      let-prefix="prefix"
      let-index="index"
      let-owner="owner"
    >
      <div class="retention-rule">
        <span>{{ 'Keep one backup every' | i18n }}</span>
        <tui-textfield
          tuiChevron
          [stringify]="stringifyRetentionInterval"
          [tuiTextfieldCleaner]="false"
        >
          <label tuiLabel>{{ 'Frequency' | i18n }}</label>
          <input
            tuiSelect
            [name]="prefix + '-interval'"
            required
            [(ngModel)]="rule.interval"
          />
          <tui-data-list *tuiDropdown>
            @for (interval of retentionIntervals; track interval) {
              <button tuiOption [value]="interval">
                {{ stringifyRetentionInterval(interval) }}
              </button>
            }
          </tui-data-list>
        </tui-textfield>
        <span>{{ 'for' | i18n }}</span>
        <tui-textfield class="duration-field">
          <label tuiLabel>{{ 'Duration' | i18n }}</label>
          <input
            tuiInputNumber
            [name]="prefix + '-duration'"
            [min]="1"
            [max]="365"
            [(ngModel)]="rule.duration"
          />
        </tui-textfield>
        <span>{{ retentionPeriodFor(rule) | i18n }}</span>
        <button
          tuiButton
          type="button"
          size="xs"
          appearance="flat-destructive"
          (click)="removeRetentionRule(owner, index)"
        >
          {{ 'Remove' | i18n }}
        </button>
      </div>
    </ng-template>

    @if (mode() !== 'manage' || (!loading() && jobs().length <= 1)) {
      <div tuiNotification appearance="info" icon="@tui.calendar-clock">
        {{
          'Automatic checkpoints are stored separately from your latest manual checkpoint.'
            | i18n
        }}
      </div>
    }

    @for (
      review of jobs().length > 1 && !editor() ? visibleReviews() : [];
      track review.packageId
    ) {
      <section class="review" tuiAppearance="floating">
        <div tuiTitle>
          <b>
            {{ 'Add to backup schedule' | i18n }} —
            {{ packageName(review.packageId) }}
          </b>
          <div tuiSubtitle>
            {{
              'Choose which automatic backup schedules should include this service.'
                | i18n
            }}
          </div>
        </div>
        <label tuiLabel class="checkbox-row toggle-all">
          <span tuiTitle>
            <b>{{ 'Toggle all' | i18n }}</b>
          </span>
          <input
            tuiCheckbox
            type="checkbox"
            [ngModelOptions]="{ standalone: true }"
            [ngModel]="allReviewJobsSelected(review)"
            (ngModelChange)="setAllReviewJobs(review, $event)"
          />
        </label>
        @for (jobId of review.affectedJobs; track jobId) {
          <label tuiLabel class="checkbox-row review-job">
            <span tuiTitle>
              <b>{{ jobName(jobId) }}</b>
            </span>
            <input
              tuiCheckbox
              type="checkbox"
              [ngModelOptions]="{ standalone: true }"
              [ngModel]="reviewDecision(review.packageId, jobId)"
              (ngModelChange)="
                setReviewDecision(review.packageId, jobId, $event)
              "
            />
          </label>
        }
        <footer class="review-actions">
          <button
            tuiButton
            type="button"
            size="s"
            appearance="flat"
            (click)="createForReview(review)"
          >
            {{ 'Add new schedule' | i18n }}
          </button>
          <button tuiButton size="s" (click)="resolveReview(review)">
            {{ 'Save backup schedules' | i18n }}
          </button>
        </footer>
      </section>
    }

    @if (mode() === 'manage') {
      @if (loading()) {
        <p>{{ 'Loading' | i18n }}…</p>
      }

      @if (jobs().length > 1 && editor()) {
        <button
          tuiCell
          type="button"
          class="view-all-jobs"
          (click)="viewAllJobs()"
        >
          <tui-icon icon="@tui.list" />
          <span tuiTitle>
            <b>{{ 'View all schedules' | i18n }}</b>
          </span>
          <tui-icon icon="@tui.chevron-left" />
        </button>
      } @else if (jobs().length && !editor()) {
        <section class="schedule-browser">
          <div class="schedule-list">
            @for (job of jobs(); track job.id) {
              <div tuiCell class="schedule-job">
                @let serviceCount = jobServiceCount(job);
                <tui-icon icon="@tui.calendar-clock" />
                <span tuiTitle>
                  <b>{{ job.name }}</b>
                  <span tuiSubtitle>
                    {{ targetName(job.targetId) }} · {{ serviceCount }}
                    {{ serviceCountLabel(serviceCount) }} ·
                    {{ 'Next run' | i18n }}:
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
                <div class="job-list-actions">
                  <label class="inline-switch job-switch">
                    <input
                      tuiSwitch
                      type="checkbox"
                      [showIcons]="false"
                      [attr.aria-label]="job.name"
                      [ngModelOptions]="{ standalone: true }"
                      [ngModel]="job.enabled && !job.pause"
                      [disabled]="!!job.pause && job.pause.reason !== 'user'"
                      (ngModelChange)="setJobEnabled(job, $event)"
                    />
                  </label>
                  <button
                    tuiIconButton
                    tuiDropdown
                    tuiDropdownAuto
                    type="button"
                    size="s"
                    appearance="flat-grayscale"
                    iconStart="@tui.ellipsis-vertical"
                  >
                    {{ 'More' | i18n }}
                    <tui-data-list *tuiDropdown="let close" (click)="close()">
                      <button
                        tuiOption
                        tuiAppearance="flat"
                        [disabled]="!!job.pause || !job.enabled"
                        (click)="runNow(job)"
                      >
                        {{ 'Run now' | i18n }}
                      </button>
                      <button tuiOption (click)="edit(job)">
                        {{ 'View/Edit' | i18n }}
                      </button>
                      <button
                        tuiOption
                        tuiAppearance="flat-destructive"
                        (click)="deleteJob(job)"
                      >
                        {{ 'Delete schedule' | i18n }}
                      </button>
                    </tui-data-list>
                  </button>
                </div>
              </div>
            }
          </div>
        </section>
        <div class="jobs-toolbar">
          <button
            tuiButton
            type="button"
            size="s"
            appearance="primary"
            iconStart="@tui.plus"
            (click)="create()"
          >
            {{ 'Add schedule' | i18n }}
          </button>
        </div>
      }

      @if (editor(); as form) {
        <form class="editor panel" (ngSubmit)="save(form)">
          <header class="editor-heading">
            <span tuiTitle>
              @if (isDefaultJob(form)) {
                <b>{{ 'Edit automatic schedule' | i18n }}</b>
              } @else {
                <b>{{ form.name || ('Create automatic schedule' | i18n) }}</b>
                <span tuiSubtitle>
                  {{
                    (form.id
                      ? 'Edit automatic schedule'
                      : 'Create automatic schedule'
                    ) | i18n
                  }}
                </span>
              }
            </span>
            <button
              tuiButton
              type="button"
              size="xs"
              appearance="primary"
              (click)="cancelEditor()"
            >
              {{ 'Cancel' | i18n }}
            </button>
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
                @if (job.pause && job.pause.reason !== 'user') {
                  <button
                    tuiButton
                    type="button"
                    size="xs"
                    appearance="primary"
                    (click)="retry(job)"
                  >
                    {{ 'Retry backup location' | i18n }}
                  </button>
                  <button
                    tuiButton
                    type="button"
                    size="xs"
                    appearance="primary"
                    (click)="beginReassign(job)"
                  >
                    {{ 'Change backup location' | i18n }}
                  </button>
                }
              </div>
            </div>
          }

          @if (!isDefaultJob(form)) {
            <div class="setting-row vertical">
              <span tuiTitle>
                <b>{{ 'Schedule name' | i18n }}</b>
              </span>
              <tui-textfield>
                <label tuiLabel>{{ 'Schedule name' | i18n }}</label>
                <input
                  #jobNameInput
                  tuiInput
                  name="name"
                  required
                  [(ngModel)]="form.name"
                />
              </tui-textfield>
            </div>
          }

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
              <tui-textfield
                tuiChevron
                [stringify]="stringifyFrequency"
                [tuiTextfieldCleaner]="false"
              >
                <label tuiLabel>{{ 'Frequency' | i18n }}</label>
                <input
                  tuiSelect
                  name="frequency"
                  required
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

              @if (form.frequency === 'monthly') {
                <tui-textfield tuiChevron [tuiTextfieldCleaner]="false">
                  <label tuiLabel>{{ 'Day of month' | i18n }}</label>
                  <input
                    tuiSelect
                    name="dayOfMonth"
                    required
                    [(ngModel)]="form.dayOfMonth"
                  />
                  <tui-data-list *tuiDropdown>
                    @for (day of monthDays; track day) {
                      <button tuiOption [value]="day">{{ day }}</button>
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
            <tui-accordion class="services-accordion">
              <button
                [tuiAccordion]="showServices()"
                (tuiAccordionChange)="showServices.set(!!$event)"
              >
                <span tuiTitle>
                  <b>{{ 'Services' | i18n }}</b>
                  <span tuiSubtitle>{{ selectedServiceSummary(form) }}</span>
                </span>
              </button>
              <tui-expand>
                <div class="services-options">
                  <label class="checkbox-row include-future">
                    <input
                      tuiCheckbox
                      type="checkbox"
                      name="includeFuture"
                      [(ngModel)]="form.includeFuture"
                    />
                    <span tuiTitle>
                      <b>
                        {{ 'Automatically include future services' | i18n }}
                      </b>
                      <span tuiSubtitle>
                        {{
                          'All current and future services are included unless you exclude them.'
                            | i18n
                        }}
                      </span>
                    </span>
                  </label>
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
                  <div tuiGroup orientation="vertical" [collapsed]="true">
                    @for (pkg of packages(); track pkg.id) {
                      <label tuiBlock="m">
                        <input
                          tuiCheckbox
                          type="checkbox"
                          [ngModelOptions]="{ standalone: true }"
                          [ngModel]="form.packageIds.includes(pkg.id)"
                          [disabled]="pkg.id === systemPackageId"
                          (ngModelChange)="togglePackage(form, pkg.id, $event)"
                        />
                        @if (pkg.id === systemPackageId) {
                          <tui-icon icon="@tui.settings" />
                        } @else {
                          <img alt="" [src]="pkg.icon" />
                        }
                        <span tuiTitle>
                          <b>{{ pkg.name }}</b>
                        </span>
                      </label>
                    }
                  </div>
                </div>
              </tui-expand>
            </tui-accordion>
          </div>

          <div class="setting-row vertical retention-setting">
            <div class="retention-heading setting-row">
              <span tuiTitle>
                <b>{{ 'Version history' | i18n }}</b>
                <span tuiSubtitle>{{ retentionSummary(form) }}</span>
              </span>
              <label class="inline-switch">
                <span class="retention-toggle-label">
                  {{ 'Keep additional versions' | i18n }}
                </span>
                <input
                  tuiSwitch
                  type="checkbox"
                  [showIcons]="false"
                  [attr.aria-label]="'Keep additional versions' | i18n"
                  name="keepAdditional"
                  [(ngModel)]="form.keepAdditional"
                />
              </label>
            </div>
            @if (form.keepAdditional) {
              <div class="retention-rules">
                <ng-container
                  *ngTemplateOutlet="
                    retentionRule;
                    context: {
                      $implicit: form,
                      prefix: 'default',
                      index: 0,
                      owner: form,
                    }
                  "
                />
                @for (rule of form.additionalTiers; track $index) {
                  <ng-container
                    *ngTemplateOutlet="
                      retentionRule;
                      context: {
                        $implicit: rule,
                        prefix: 'default-' + $index,
                        index: $index + 1,
                        owner: form,
                      }
                    "
                  />
                }
                <button
                  tuiIconButton
                  type="button"
                  class="add-retention-rule"
                  size="s"
                  appearance="primary"
                  iconStart="@tui.plus"
                  [attr.aria-label]="'Add' | i18n"
                  (click)="form.additionalTiers.push(newRetentionRule())"
                >
                  {{ 'Add' | i18n }}
                </button>
              </div>
            }
          </div>

          <fieldset>
            <div class="heading estimate-heading">
              <legend>{{ 'Capacity estimates' | i18n }}</legend>
              <button
                tuiButton
                type="button"
                size="xs"
                appearance="primary"
                (click)="refreshEstimates(form)"
              >
                {{ 'Refresh estimates' | i18n }}
              </button>
            </div>
            <div class="capacity-list">
              @for (pkg of selectedPackages(form); track pkg.id) {
                <tui-accordion class="capacity-service">
                  <button
                    class="capacity-summary"
                    [tuiAccordion]="capacityDetailsOpen().has(pkg.id)"
                    (tuiAccordionChange)="
                      setCapacityDetailsOpen(pkg.id, !!$event)
                    "
                  >
                    <span tuiTitle>
                      <b>{{ pkg.name }}</b>
                      <span tuiSubtitle>
                        {{ 'Maximum required space' | i18n }}:
                        @if (capacityEstimate(pkg.id); as estimate) {
                          {{
                            bytes(estimate.conservativePeakExcludingManualBytes)
                          }}
                        } @else {
                          {{ 'Unknown' | i18n }}
                        }
                      </span>
                    </span>
                    <span class="more-info">{{ 'More Info' | i18n }}</span>
                  </button>
                  <tui-expand>
                    @if (capacityEstimate(pkg.id); as estimate) {
                      <dl class="capacity-details">
                        <div>
                          <dt>{{ 'Live data estimate' | i18n }}</dt>
                          <dd>{{ bytes(estimate.liveLogicalBytes) }}</dd>
                        </div>
                        <div>
                          <dt>{{ 'Checkpoints' | i18n }}</dt>
                          <dd>
                            {{ estimate.retainedSnapshotCount }} /
                            {{ estimate.maximumProjectedSnapshotCount }}
                          </dd>
                        </div>
                        <div>
                          <dt>{{ 'Automatic storage' | i18n }}</dt>
                          <dd>{{ bytes(estimate.scheduledRetainedBytes) }}</dd>
                        </div>
                        <div>
                          <dt>{{ 'Next-run staging' | i18n }}</dt>
                          <dd>{{ bytes(estimate.stagingHeadroomBytes) }}</dd>
                        </div>
                      </dl>
                    } @else {
                      <p class="capacity-unknown">{{ 'Unknown' | i18n }}</p>
                    }
                  </tui-expand>
                </tui-accordion>
              }
            </div>
          </fieldset>

          @if (projectedCount(form) > 1) {
            <div tuiNotification appearance="warning">
              {{
                'Every retained version is a full copy. Each run also makes a full target-side staging copy. This can substantially increase storage use, runtime, and I/O, especially on network storage and slow external devices.'
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

          <label class="checkbox-row first-backup">
            <input
              tuiCheckbox
              type="checkbox"
              name="firstBackupNow"
              [(ngModel)]="form.firstBackupNow"
            />
            <span tuiTitle>
              <b>
                {{
                  (form.id ? 'Run now' : 'Create the first backup now') | i18n
                }}
              </b>
              @if (!form.id) {
                <span tuiSubtitle>
                  {{ 'Recommended so protection begins immediately.' | i18n }}
                </span>
              }
            </span>
          </label>

          @if (!form.id) {
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
          <footer class="editor-actions">
            @if (selectedJob(); as job) {
              <button
                tuiButton
                type="button"
                appearance="primary-destructive"
                (click)="deleteJob(job)"
              >
                {{ 'Delete schedule' | i18n }}
              </button>
            }
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

      @if (jobs().length <= 1 && editor()) {
        <div class="jobs-toolbar">
          <button
            tuiButton
            type="button"
            size="s"
            appearance="primary"
            iconStart="@tui.plus"
            (click)="create()"
          >
            {{ 'Add schedule' | i18n }}
          </button>
        </div>
      }

      @if (reassigning(); as job) {
        <form class="editor" (ngSubmit)="reassign(job)">
          <div class="heading">
            <h3>{{ 'Change backup location' | i18n }} — {{ job.name }}</h3>
            <button
              tuiButton
              type="button"
              size="xs"
              appearance="primary"
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
      align-items: center;
      flex-wrap: wrap;
      gap: 0.35rem;
    }

    .job-list-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .more-info {
      color: var(--tui-text-action);
    }

    .services-options {
      display: grid;
      gap: 1rem;
    }

    .jobs-toolbar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 1rem;
      min-width: 0;
    }

    .editor-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.75rem;
    }

    .editor-actions > :last-child {
      margin-inline-start: auto;
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

    .inline-switch.job-switch {
      width: fit-content;
      justify-content: flex-start;
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

    .editor {
      display: grid;
      gap: 1rem;
      margin-top: 1rem;
      padding: 1rem;
      border: 1px solid var(--tui-border-normal);
      border-radius: 0.75rem;
      min-width: 0;
      overflow: hidden;
    }

    .review {
      display: grid;
      gap: 1rem;
      margin-top: 1rem;
      padding: 1rem;
      min-width: 0;
      overflow: hidden;
    }

    .review-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.75rem;
    }

    .review .checkbox-row {
      inline-size: 100%;
      max-inline-size: 100%;
      padding-inline: 0;
      justify-content: space-between;
    }

    .review .checkbox-row > input {
      margin-inline-start: auto;
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
      grid-template-columns:
        auto minmax(9rem, 1fr) auto minmax(10rem, 0.75fr)
        auto auto;
      gap: 0.5rem;
      align-items: center;
      width: 100%;
      min-width: 0;
    }

    .retention-rules {
      display: grid;
      gap: 0.75rem;
      width: 100%;
      min-width: 0;
    }

    .retention-rules {
      justify-items: stretch;
    }

    .add-retention-rule {
      justify-self: end;
    }

    .duration-field {
      min-width: 10rem;
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
    .histories td {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .history-heading {
      margin-top: 2rem;
    }

    .schedule-job,
    .view-all-jobs {
      inline-size: 100%;
      min-inline-size: 0;
      text-align: left;
      box-sizing: border-box;
    }

    .schedule-job {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 0;
      border-bottom: 1px solid var(--tui-border-normal);
    }

    .schedule-job:last-child {
      border-bottom: 0;
    }

    .schedule-job [tuiTitle],
    .view-all-jobs [tuiTitle] {
      flex: 1;
    }

    .schedule-browser,
    .schedule-list {
      display: grid;
      gap: 0.75rem;
      min-width: 0;
    }

    .estimate-heading {
      margin: 0 0 0.5rem;
    }

    .capacity-list,
    .capacity-details {
      display: grid;
      min-width: 0;
    }

    .capacity-list {
      gap: 0.5rem;
    }

    .capacity-service {
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--tui-border-normal);
      border-radius: var(--tui-radius-m);
    }

    .capacity-summary {
      width: 100%;
      min-width: 0;
      min-height: 3.5rem;
      height: auto;
      white-space: normal;
    }

    .capacity-summary [tuiTitle] {
      flex: 1;
      min-width: 0;
      text-align: left;
    }

    .capacity-summary [tuiSubtitle] {
      display: block;
      margin-top: 0.2rem;
      white-space: normal;
    }

    .more-info {
      flex: 0 0 auto;
      margin-inline-start: auto;
      white-space: nowrap;
    }

    .capacity-details {
      margin: 0;
      padding: 0 1rem 1rem;
    }

    .capacity-details div {
      display: grid;
      grid-template-columns: minmax(10rem, 1fr) auto;
      gap: 1rem;
      padding-block: 0.65rem;
      border-top: 1px solid var(--tui-border-normal);
    }

    .capacity-details dt {
      color: var(--tui-text-secondary);
      font-weight: 600;
    }

    .capacity-details dd {
      margin: 0;
      text-align: right;
    }

    .capacity-unknown {
      margin: 0;
      padding: 0 1rem 1rem;
      color: var(--tui-text-secondary);
    }

    /* Embedded schedule cards need the narrow layout below the app-wide mobile breakpoint. */
    @media (max-width: 30rem) {
      .heading,
      .jobs-toolbar,
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
      .retention-rule {
        grid-template-columns: 1fr;
      }

      .editor.panel,
      .selected-job {
        padding: 0.75rem;
      }

      .selected-job {
        justify-content: flex-start;
      }

      .selected-job > [tuiTitle] {
        flex: 0 1 auto;
      }

      .schedule-job {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        padding-inline: 0.75rem;
        box-sizing: border-box;
      }

      .schedule-job > tui-icon:first-child {
        grid-column: 1;
        grid-row: 1;
      }

      .schedule-job > [tuiTitle] {
        display: contents;
      }

      .schedule-job > [tuiTitle] > b {
        grid-column: 2;
        grid-row: 1;
        min-inline-size: 0;
        overflow-wrap: anywhere;
      }

      .schedule-job > [tuiTitle] > [tuiSubtitle] {
        grid-column: 1 / -1;
        grid-row: 2;
        min-inline-size: 0;
        white-space: normal;
        overflow-wrap: anywhere;
      }

      .schedule-job > [tuiBadge] {
        grid-column: 1 / -1;
        grid-row: 3;
        justify-self: start;
      }

      .job-list-actions {
        grid-column: 3;
        grid-row: 1;
        align-self: start;
        justify-self: end;
        flex-wrap: nowrap;
      }

      .job-switch {
        width: fit-content;
      }

      .retention-heading {
        align-items: flex-start;
      }

      .retention-heading > [tuiTitle] {
        flex: 1;
        min-width: 0;
      }

      .retention-heading .inline-switch {
        flex: 0 0 auto;
        width: fit-content;
      }

      .retention-heading .retention-toggle-label {
        display: none;
      }

      .capacity-details div {
        grid-template-columns: 1fr;
        gap: 0.2rem;
      }

      .capacity-details dd {
        text-align: left;
      }

      .capacity-summary {
        flex-wrap: wrap;
      }

      .capacity-summary .more-info {
        flex-basis: 100%;
        text-align: right;
      }
    }
  `,
  host: {
    class: 'backup-settings',
    '(window:beforeunload)': 'confirmBrowserExit($event)',
  },
  imports: [
    DatePipe,
    FormsModule,
    NgTemplateOutlet,
    TuiAccordion,
    TuiAppearance,
    TuiBadge,
    TuiBlock,
    TuiButton,
    TuiCell,
    TuiCheckbox,
    TuiChevron,
    TuiDataList,
    TuiDropdown,
    TuiGroup,
    TuiIcon,
    TuiInput,
    TuiLabel,
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
  readonly createRequest = input(0)
  readonly reviewPackageId = input('')
  readonly collapseRequested = output<void>()

  private readonly api = inject(ApiService)
  private readonly backupService = inject(BackupService)
  private readonly dialogs = inject(DialogService)
  private readonly deleteSchedule = inject(DeleteScheduleService)
  private readonly errors = inject(ErrorService)
  private readonly i18n = inject(i18nPipe)
  private readonly injector = inject(Injector)
  private readonly jobNameInput =
    viewChild<ElementRef<HTMLInputElement>>('jobNameInput')
  private readonly patch = inject<PatchDB<DataModel>>(PatchDB)
  private readonly packageData = toSignal(this.patch.watch$('packageData'))

  readonly jobs = signal<T.BackupJob[]>([])
  readonly histories = signal<T.ServiceTargetHistory[]>([])
  readonly reviews = signal<T.NewServiceBackupReview[]>([])
  protected readonly visibleReviews = computed(() =>
    this.reviews().filter(
      review => review.packageId === this.reviewPackageId(),
    ),
  )
  readonly loading = signal(true)
  readonly saving = signal(false)
  readonly editor = signal<JobEditor | null>(null)
  private showSingleJobList = false
  protected readonly selectedJobId = signal('')
  protected readonly showServices = signal(false)
  readonly reassigning = signal<T.BackupJob | null>(null)
  readonly policyHistory = signal<T.ServiceTargetHistory | null>(null)
  readonly policyTiers = signal<EditableRetentionRule[]>([])
  readonly policyPreview = signal<T.RetentionPolicyChangePreview | null>(null)
  readonly estimates = signal<T.BackupServiceCapacityEstimate[]>([])
  protected readonly capacityDetailsOpen = signal<ReadonlySet<string>>(
    new Set(),
  )

  reassignTargetId = ''
  reassignPassword = ''
  waitForSchedule = false
  confirmPrune = false
  private editorBaseline: string | null = null
  private handledCreateRequest = 0
  private pendingReview: T.NewServiceBackupReview | null = null

  constructor() {
    effect(() => {
      const request = this.createRequest()
      if (!request || request === this.handledCreateRequest || this.loading()) {
        return
      }
      this.handledCreateRequest = request
      const review = this.visibleReviews()[0]
      if (review) {
        void this.createForReview(review)
      } else {
        void this.create()
      }
    })
  }

  private readonly reviewDecisions = new Map<string, Record<string, boolean>>()
  protected readonly systemPackageId = SYSTEM_PACKAGE_ID

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

  readonly packages = computed(() => [
    {
      id: SYSTEM_PACKAGE_ID,
      name: this.i18n.transform('System'),
      icon: '',
    },
    ...Object.entries(this.packageData() || {}).flatMap(([id, entry]) => {
      const state = entry.stateInfo
      const manifest =
        state.state === 'installed' || state.state === 'removing'
          ? state.manifest
          : state.installingInfo?.newManifest
      return manifest ? [{ id, name: manifest.title, icon: entry.icon }] : []
    }),
  ])
  protected readonly selectedJob = computed(() =>
    this.jobs().find(job => job.id === this.selectedJobId()),
  )

  protected readonly frequencies: BackupScheduleFrequency[] = [
    'hourly',
    'daily',
    'weekly',
    'monthly',
  ]
  protected readonly retentionIntervals: Exclude<
    BackupRetentionTierEditor['interval'],
    'custom'
  >[] = ['hour', 'day', 'week', 'month']
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
  protected readonly monthDays = BACKUP_MONTH_DAYS
  protected readonly stringifyTime = formatBackupTime
  protected readonly stringifyFrequency = (
    frequency: BackupScheduleFrequency,
  ) =>
    this.i18n.transform(
      frequency === 'hourly'
        ? 'Hourly'
        : frequency === 'weekly'
          ? 'Weekly'
          : frequency === 'monthly'
            ? 'Monthly'
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
              : 'Custom',
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
      this.jobs.set(jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
      this.histories.set(histories)
      this.reviews.set(reviews)
      for (const review of reviews) {
        this.reviewDecisions.set(
          review.packageId,
          Object.fromEntries(review.affectedJobs.map(id => [id, false])),
        )
      }
      const selected = this.jobs().find(job => job.id === this.selectedJobId())
      if (this.editor()?.id && !selected) this.editor.set(null)
      if (!this.editor()) {
        if (selected) {
          void this.edit(selected)
        } else if (this.jobs().length === 1 && !this.showSingleJobList) {
          void this.edit(this.jobs()[0])
        }
      }
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    } finally {
      this.loading.set(false)
    }
  }

  async create(): Promise<boolean> {
    if (!(await this.confirmDiscardChanges())) return false
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
      dayOfMonth: now.getDate(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      keepAdditional: false,
      ...this.newRetentionRule(),
      additionalTiers: [],
      retentionOverrides: {},
      password: '',
      firstBackupNow: true,
      capacityConfirmed: false,
    }
    this.showServices.set(false)
    this.showSingleJobList = false
    this.reassigning.set(null)
    this.pendingReview = null
    this.selectedJobId.set('')
    this.editor.set(form)
    this.editorBaseline = this.editorSnapshot(form)
    void this.refreshEstimates(form)
    afterNextRender(() => this.jobNameInput()?.nativeElement.focus(), {
      injector: this.injector,
    })
    return true
  }

  async viewAllJobs() {
    if (!(await this.confirmDiscardChanges())) return
    this.reassigning.set(null)
    this.showSingleJobList = true
    this.selectedJobId.set('')
    this.editor.set(null)
    this.editorBaseline = null
    this.pendingReview = null
    this.showServices.set(false)
  }

  async cancelEditor() {
    if (!(await this.confirmDiscardChanges())) return
    this.selectedJobId.set('')
    this.editor.set(null)
    this.editorBaseline = null
    this.pendingReview = null
    this.showServices.set(false)
    this.collapseRequested.emit()
  }

  protected confirmBrowserExit(event: BeforeUnloadEvent) {
    if (!this.hasUnsavedChanges()) return
    event.preventDefault()
    event.returnValue = ''
  }

  private hasUnsavedChanges(): boolean {
    const form = this.editor()
    return !!(
      form &&
      this.editorBaseline !== null &&
      this.editorSnapshot(form) !== this.editorBaseline
    )
  }

  async confirmDiscardChanges(): Promise<boolean> {
    if (!this.hasUnsavedChanges()) return true
    const confirmed = await firstValueFrom(
      this.dialogs.openConfirm({
        label: 'Unsaved changes',
        size: 's',
        data: {
          content: 'Changes were not saved',
          yes: 'Discard changes',
          no: 'Back',
        },
      }),
      { defaultValue: false },
    )
    if (confirmed) {
      const form = this.editor()
      this.editorBaseline = form ? this.editorSnapshot(form) : null
    }
    return confirmed
  }

  async createForReview(review: T.NewServiceBackupReview) {
    if (!(await this.create())) return
    const form = this.editor()
    if (!form) return
    form.packageIds = [SYSTEM_PACKAGE_ID, review.packageId]
    form.includeFuture = false
    this.pendingReview = review
    this.editorBaseline = this.editorSnapshot(form)
    void this.refreshEstimates(form)
  }

  isDefaultJob(form: JobEditor): boolean {
    return !!form.id && this.jobs().length === 1 && form.name === 'Default'
  }

  async edit(job?: T.BackupJob) {
    if (!job) return
    if (!(await this.confirmDiscardChanges())) return
    this.showSingleJobList = false
    this.showServices.set(false)
    this.pendingReview = null
    const schedule = parseBackupSchedule(job.schedule)
    const selection = parseBackupServiceSelection(
      job.services,
      this.packages().map(pkg => pkg.id),
    )
    selection.packageIds = [
      ...new Set([SYSTEM_PACKAGE_ID, ...selection.packageIds]),
    ]
    const [tier, ...additionalTiers] = job.defaultRetention.tiers
    const retention = this.editableRetentionTier(tier)
    const form: JobEditor = {
      id: job.id,
      name: job.name,
      targetId: job.targetId,
      ...selection,
      ...schedule,
      keepAdditional: !!tier,
      ...retention,
      additionalTiers: additionalTiers.map(item =>
        this.editableRetentionTier(item),
      ),
      retentionOverrides: Object.fromEntries(
        Object.entries(job.retentionOverrides).map(([packageId, policy]) => [
          packageId,
          {
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
    this.editorBaseline = this.editorSnapshot(form)
    void this.refreshEstimates(form)
  }

  removeRetentionRule(form: JobEditor, index: number) {
    if (index === 0 && form.additionalTiers.length) {
      const next = form.additionalTiers.shift()!
      Object.assign(form, next)
    } else if (index > 0) {
      form.additionalTiers.splice(index - 1, 1)
    } else {
      form.keepAdditional = false
      Object.assign(form, this.newRetentionRule())
    }
    form.capacityConfirmed = false
  }

  togglePackage(form: JobEditor, packageId: string, checked: boolean) {
    if (packageId === SYSTEM_PACKAGE_ID) return
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
    form.packageIds = checked
      ? this.packages().map(pkg => pkg.id)
      : [SYSTEM_PACKAGE_ID]
    if (!checked) form.retentionOverrides = {}
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
        const selectedJob = this.selectedJob()
        await this.api.updateScheduledBackupJob({
          id: form.id,
          ...common,
        })
        if (form.firstBackupNow && selectedJob && !selectedJob.enabled) {
          await this.api.setScheduledBackupJobEnabled({
            id: form.id,
            enabled: true,
          })
        }
        if (form.firstBackupNow) {
          await this.api.runScheduledBackupJob({ id: form.id })
        }
      } else {
        const created = await this.api.createScheduledBackupJob({
          ...common,
          targetId: form.targetId,
          password: form.password,
          enabled: true,
          runNow: form.firstBackupNow,
        })
        this.selectedJobId.set(created.id)
        this.backupService.showQueuedNotification(created)
        if (
          this.pendingReview &&
          form.packageIds.includes(this.pendingReview.packageId)
        ) {
          await this.api.resolveNewServiceBackupReview({
            packageId: this.pendingReview.packageId,
            decisions: Object.fromEntries(
              this.pendingReview.affectedJobs.map(jobId => [jobId, false]),
            ),
          })
        }
      }
      this.selectedJobId.set('')
      this.editor.set(null)
      this.editorBaseline = null
      this.pendingReview = null
      this.showSingleJobList = true
      this.collapseRequested.emit()
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

  async setJobEnabled(job: T.BackupJob, enabled: boolean) {
    if (enabled === job.enabled && !job.pause) return
    await this.perform(() =>
      this.api.setScheduledBackupJobEnabled({
        id: job.id,
        enabled,
      }),
    )
  }

  async deleteJob(job: T.BackupJob) {
    try {
      if (await this.deleteSchedule.delete(job)) {
        this.showSingleJobList = true
        this.selectedJobId.set('')
        this.editor.set(null)
        this.editorBaseline = null
        this.pendingReview = null
        await this.reload()
        if (this.jobs().length <= 1) this.collapseRequested.emit()
      }
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    }
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

  async beginReassign(job: T.BackupJob) {
    if (!(await this.confirmDiscardChanges())) return
    this.editor.set(null)
    this.editorBaseline = null
    this.pendingReview = null
    this.showServices.set(false)
    this.reassigning.set(job)
    this.reassignTargetId =
      this.targets().find(t => t.id !== job.targetId)?.id || ''
    this.reassignPassword = ''
    this.waitForSchedule = false
  }

  cancelReassign(job: T.BackupJob) {
    this.reassigning.set(null)
    void this.edit(job)
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

  reviewDecision(packageId: string, jobId: string): boolean {
    return this.reviewDecisions.get(packageId)?.[jobId] ?? false
  }

  setReviewDecision(packageId: string, jobId: string, value: boolean) {
    const decisions = this.reviewDecisions.get(packageId) || {}
    decisions[jobId] = value
    this.reviewDecisions.set(packageId, decisions)
  }

  allReviewJobsSelected(review: T.NewServiceBackupReview): boolean {
    const decisions = this.reviewDecisions.get(review.packageId)
    return (
      review.affectedJobs.length > 0 &&
      review.affectedJobs.every(jobId => decisions?.[jobId] === true)
    )
  }

  setAllReviewJobs(review: T.NewServiceBackupReview, checked: boolean) {
    this.reviewDecisions.set(
      review.packageId,
      Object.fromEntries(review.affectedJobs.map(jobId => [jobId, checked])),
    )
  }

  async resolveReview(review: T.NewServiceBackupReview) {
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

  jobName(id: string): string {
    return this.jobs().find(job => job.id === id)?.name || id
  }

  packageName(id: string): string {
    if (id === SYSTEM_PACKAGE_ID) return this.i18n.transform('System')
    return this.packages().find(pkg => pkg.id === id)?.name || id
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
    if (form.frequency === 'monthly') {
      return `${this.i18n.transform('Monthly')} · ${this.i18n.transform('Day of month')} ${form.dayOfMonth} · ${time}`
    }
    return `${this.i18n.transform('Daily')} · ${time}`
  }

  jobServiceCount(job: T.BackupJob): number {
    const selection = parseBackupServiceSelection(
      job.services,
      this.packages().map(pkg => pkg.id),
    ).packageIds
    return new Set([SYSTEM_PACKAGE_ID, ...selection]).size
  }

  protected serviceCountLabel(count: number): string {
    return this.i18n.transform(count === 1 ? 'Service' : 'Services')
  }

  selectedServiceSummary(form: JobEditor): string {
    const total = this.packages().length
    const count = `${form.packageIds.length} / ${total} ${this.serviceCountLabel(total)}`
    const future = this.i18n.transform(
      form.includeFuture
        ? 'Future services included'
        : 'Future services not included',
    )
    return `${count} · ${future}`
  }

  retentionSummary(form: JobEditor): string {
    if (!form.keepAdditional) {
      return this.i18n.transform('Keep only the latest automatic checkpoint')
    }
    return [form, ...form.additionalTiers]
      .map(rule => this.retentionRuleSummary(rule))
      .join(' · ')
  }

  private retentionRuleSummary(rule: BackupRetentionTierEditor): string {
    const every = this.i18n.transform('Keep one backup every')
    if (rule.interval === 'custom') {
      const intervalUnit = this.i18n.transform(
        rule.customIntervalHours === 1 ? 'hour' : 'hours',
      )
      const coverageUnit = this.i18n.transform(
        rule.customCoverageHours === 1 ? 'hour' : 'hours',
      )
      return `${every} ${rule.customIntervalHours} ${intervalUnit} ${this.i18n.transform('for')} ${rule.customCoverageHours} ${coverageUnit}`
    }
    const interval = this.i18n.transform(rule.interval)
    const forLabel = this.i18n.transform('for')
    const period = this.i18n.transform(this.retentionPeriodFor(rule))
    return `${every} ${interval} ${forLabel} ${rule.duration} ${period}`
  }

  retentionPeriod(form: JobEditor) {
    return this.retentionPeriodFor(form)
  }

  retentionPeriodFor(rule: BackupRetentionTierEditor) {
    return rule.interval === 'custom'
      ? 'hours'
      : retentionPeriodLabel(rule.interval, rule.duration)
  }

  newRetentionRule(): EditableRetentionRule {
    return {
      ...parseBackupRetentionTier(),
      preserved: null,
    }
  }

  canSave(form: JobEditor): boolean {
    return !!(
      form.name.trim() &&
      form.targetId &&
      form.packageIds.length &&
      this.validSchedule(form) &&
      this.validRetention(form) &&
      (form.id || form.password) &&
      (this.projectedCount(form) <= 1 || form.capacityConfirmed)
    )
  }

  private validSchedule(form: JobEditor): boolean {
    const validFrequency = this.frequencies.includes(form.frequency)
    const validMinute =
      Number.isInteger(form.minute) && form.minute >= 0 && form.minute <= 59
    const validHour =
      form.frequency === 'hourly' ||
      (Number.isInteger(form.hour) && form.hour >= 0 && form.hour <= 23)
    const validDayOfMonth =
      form.frequency !== 'monthly' ||
      (Number.isInteger(form.dayOfMonth) &&
        form.dayOfMonth >= 1 &&
        form.dayOfMonth <= 31)
    return validFrequency && validMinute && validHour && validDayOfMonth
  }

  private validRetention(form: JobEditor): boolean {
    if (!form.keepAdditional) return true
    return [form, ...form.additionalTiers].every(
      rule =>
        this.retentionIntervals.includes(
          rule.interval as (typeof this.retentionIntervals)[number],
        ) &&
        Number.isInteger(rule.duration) &&
        rule.duration >= 1 &&
        rule.duration <= 365,
    )
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

  setCapacityDetailsOpen(packageId: string, open: boolean) {
    this.capacityDetailsOpen.update(current => {
      const next = new Set(current)
      if (open) next.add(packageId)
      else next.delete(packageId)
      return next
    })
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
        this.serializeRetentionRule(form),
        ...this.policy(form.additionalTiers).tiers,
      ],
    }
  }

  private policy(tiers: EditableRetentionRule[]): T.RetentionPolicy {
    return {
      tiers: tiers.map(tier => this.serializeRetentionRule(tier)),
    }
  }

  private toTierEditors(policy: T.RetentionPolicy): EditableRetentionRule[] {
    return policy.tiers.map(tier => this.editableRetentionTier(tier))
  }

  private editorSnapshot(form: JobEditor): string {
    return JSON.stringify(form)
  }

  private editableRetentionTier(tier?: T.RetentionTier): EditableRetentionRule {
    const parsed = parseBackupRetentionTier(tier)
    if (parsed.interval !== 'custom' || !tier) {
      return {
        ...parsed,
        preserved: null,
      }
    }

    const interval = retentionIntervalFromSeconds(tier.intervalSeconds)
    const duration = Math.max(
      1,
      Math.min(
        365,
        Math.round(tier.coverageSeconds / retentionIntervalSeconds(interval)),
      ),
    )
    return {
      ...parsed,
      interval,
      duration,
      preserved: {
        tier: structuredClone(tier),
        interval,
        duration,
      },
    }
  }

  private serializeRetentionRule(rule: EditableRetentionRule): T.RetentionTier {
    if (
      rule.preserved &&
      rule.interval === rule.preserved.interval &&
      rule.duration === rule.preserved.duration
    ) {
      return structuredClone(rule.preserved.tier)
    }
    return serializeBackupRetentionTier(rule)
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
