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
  TuiButton,
  TuiCheckbox,
  TuiInput,
  TuiNotification,
  TuiTitle,
} from '@taiga-ui/core'
import {
  TuiBadge,
  TuiNotificationMiddleService,
  TuiSwitch,
} from '@taiga-ui/kit'
import { PatchDB } from 'patch-db-client'
import { filter, firstValueFrom, map } from 'rxjs'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { DataModel } from 'src/app/services/patch-db/data-model'
import { BackupService } from './backup.service'
import {
  BackupScheduleFrequency,
  parseBackupSchedule,
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

interface JobEditor {
  id?: string
  name: string
  targetId: string
  scope: 'all' | 'allExcept' | 'selected'
  packageIds: string[]
  frequency: BackupScheduleFrequency
  minute: number
  hour: number
  weekday: number
  timezone: string
  retentionPreset: RetentionPreset
  tiers: TierEditor[]
  retentionOverrides: Record<string, RetentionOverrideEditor>
  enabled: boolean
  password: string
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

    @if (mode() === 'create') {
      <div class="heading">
        <h3>{{ 'Advanced schedules' | i18n }}</h3>
        <button tuiButton size="s" iconStart="@tui.plus" (click)="create()">
          {{ 'Create Job' | i18n }}
        </button>
      </div>

      @if (loading()) {
        <p>{{ 'Loading' | i18n }}…</p>
      } @else {
        <div class="table-wrap">
          <table class="g-table jobs">
            <thead>
              <tr>
                <th>{{ 'Name' | i18n }}</th>
                <th>{{ 'Backup location' | i18n }}</th>
                <th>{{ 'Scope' | i18n }}</th>
                <th>{{ 'Next run' | i18n }}</th>
                <th>{{ 'Last result' | i18n }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (job of jobs(); track job.id) {
                <tr>
                  <td>
                    <strong>{{ job.name }}</strong>
                    @if (job.pause; as pause) {
                      <span tuiBadge appearance="warning">
                        {{ pauseLabel(pause) | i18n }}
                      </span>
                    } @else if (!job.enabled) {
                      <span tuiBadge>{{ 'Paused' | i18n }}</span>
                    }
                  </td>
                  <td>{{ targetName(job.targetId) }}</td>
                  <td>{{ scopeLabel(job.services) }}</td>
                  <td>
                    {{
                      job.status.nextRunAt
                        ? (job.status.nextRunAt | date: 'medium')
                        : ('None' | i18n)
                    }}
                  </td>
                  <td>{{ resultLabel(job.status.lastResult) | i18n }}</td>
                  <td class="actions">
                    <button
                      tuiButton
                      size="xs"
                      appearance="secondary"
                      [disabled]="!!job.pause || !job.enabled"
                      (click)="runNow(job)"
                    >
                      {{ 'Run now' | i18n }}
                    </button>
                    <button
                      tuiButton
                      size="xs"
                      appearance="secondary"
                      (click)="toggle(job)"
                    >
                      {{ (job.enabled ? 'Pause' : 'Resume') | i18n }}
                    </button>
                    <button
                      tuiButton
                      size="xs"
                      appearance="secondary"
                      (click)="edit(job)"
                    >
                      {{ 'Edit' | i18n }}
                    </button>
                    @if (job.pause && job.pause.reason !== 'user') {
                      <button
                        tuiButton
                        size="xs"
                        appearance="secondary"
                        (click)="retry(job)"
                      >
                        {{ 'Retry backup location' | i18n }}
                      </button>
                      <button
                        tuiButton
                        size="xs"
                        appearance="secondary"
                        (click)="beginReassign(job)"
                      >
                        {{ 'Change backup location' | i18n }}
                      </button>
                    }
                    <button
                      tuiButton
                      size="xs"
                      appearance="flat-destructive"
                      (click)="deleteJob(job)"
                    >
                      {{ 'Delete' | i18n }}
                    </button>
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="6">{{ 'No automatic schedules' | i18n }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }

      @if (editor(); as form) {
        <form class="editor" (ngSubmit)="save(form)">
          <div class="heading">
            <h3>
              {{
                (form.id
                  ? 'Edit automatic schedule'
                  : 'Create automatic schedule'
                ) | i18n
              }}
            </h3>
            <button
              tuiButton
              type="button"
              size="xs"
              appearance="secondary"
              (click)="editor.set(null)"
            >
              {{ 'Cancel' | i18n }}
            </button>
          </div>

          <div class="grid">
            <tui-textfield>
              <label tuiLabel>{{ 'Job name' | i18n }}</label>
              <input tuiInput name="name" required [(ngModel)]="form.name" />
            </tui-textfield>

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

            <label>
              <span>{{ 'Services' | i18n }}</span>
              <select name="scope" [(ngModel)]="form.scope">
                <option value="all">
                  {{ 'All installed services' | i18n }}
                </option>
                <option value="selected">
                  {{ 'Selected services' | i18n }}
                </option>
                <option value="allExcept">
                  {{ 'All current and future services with exclusions' | i18n }}
                </option>
              </select>
            </label>

            <label>
              <span>{{ 'Schedule' | i18n }}</span>
              <select name="frequency" [(ngModel)]="form.frequency">
                <option value="hourly">{{ 'Every hour' | i18n }}</option>
                <option value="daily">{{ 'Every day' | i18n }}</option>
                <option value="weekly">{{ 'Every week' | i18n }}</option>
              </select>
            </label>

            <tui-textfield>
              <label tuiLabel>{{ 'Minute' | i18n }}</label>
              <input
                tuiInput
                type="number"
                name="minute"
                min="0"
                max="59"
                [(ngModel)]="form.minute"
              />
            </tui-textfield>

            @if (form.frequency !== 'hourly') {
              <tui-textfield>
                <label tuiLabel>{{ 'Hour' | i18n }}</label>
                <input
                  tuiInput
                  type="number"
                  name="hour"
                  min="0"
                  max="23"
                  [(ngModel)]="form.hour"
                />
              </tui-textfield>
            }

            @if (form.frequency === 'weekly') {
              <label>
                <span>{{ 'Day of week' | i18n }}</span>
                <select name="weekday" [(ngModel)]="form.weekday">
                  @for (day of weekdays; track day.value) {
                    <option [ngValue]="day.value">
                      {{ day.label | i18n }}
                    </option>
                  }
                </select>
              </label>
            }

            <label>
              <span>{{ 'Retention' | i18n }}</span>
              <select
                name="retention"
                [(ngModel)]="form.retentionPreset"
                (ngModelChange)="applyPreset(form)"
              >
                <option value="latest">{{ 'Latest only' | i18n }}</option>
                <option value="custom">{{ 'Custom tiers' | i18n }}</option>
              </select>
            </label>

            @if (!form.id) {
              <tui-textfield>
                <label tuiLabel>{{ 'Password' | i18n }}</label>
                <input
                  tuiInput
                  type="password"
                  name="password"
                  required
                  autocomplete="off"
                  [(ngModel)]="form.password"
                />
              </tui-textfield>
            }

            <label class="switch-row">
              <input
                tuiSwitch
                type="checkbox"
                [showIcons]="false"
                name="enabled"
                [(ngModel)]="form.enabled"
              />
              <span>{{ 'Enabled' | i18n }}</span>
            </label>
          </div>

          @if (form.scope !== 'all') {
            <fieldset>
              <legend>{{ 'Selected services' | i18n }}</legend>
              @for (pkg of packages(); track pkg.id) {
                <label class="check-row">
                  <input
                    tuiCheckbox
                    type="checkbox"
                    [ngModelOptions]="{ standalone: true }"
                    [ngModel]="form.packageIds.includes(pkg.id)"
                    (ngModelChange)="togglePackage(form, pkg.id, $event)"
                  />
                  {{ pkg.name }}
                </label>
              }
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
                            tuiInput
                            type="number"
                            min="1"
                            [name]="
                              'override-interval-' + pkg.id + '-' + $index
                            "
                            [(ngModel)]="tier.intervalHours"
                          />
                        </tui-textfield>
                        <tui-textfield>
                          <label tuiLabel>{{ 'Coverage hours' | i18n }}</label>
                          <input
                            tuiInput
                            type="number"
                            min="1"
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

          @if (form.retentionPreset === 'custom') {
            <fieldset>
              <legend>{{ 'Retention tiers' | i18n }}</legend>
              @for (tier of form.tiers; track $index) {
                <div class="tier">
                  <tui-textfield>
                    <label tuiLabel>{{ 'Interval hours' | i18n }}</label>
                    <input
                      tuiInput
                      type="number"
                      min="1"
                      [name]="'interval-' + $index"
                      [(ngModel)]="tier.intervalHours"
                    />
                  </tui-textfield>
                  <tui-textfield>
                    <label tuiLabel>{{ 'Coverage hours' | i18n }}</label>
                    <input
                      tuiInput
                      type="number"
                      min="1"
                      [name]="'coverage-' + $index"
                      [(ngModel)]="tier.coverageHours"
                    />
                  </tui-textfield>
                  <button
                    tuiButton
                    type="button"
                    size="xs"
                    appearance="flat-destructive"
                    (click)="form.tiers.splice($index, 1)"
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
                  form.tiers.push({ intervalHours: 24, coverageHours: 168 })
                "
              >
                {{ 'Add tier' | i18n }}
              </button>
            </fieldset>
          }

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

          <p class="muted">
            {{ 'Captured timezone' | i18n }}: {{ form.timezone }} ·
            {{ 'Maximum automatic checkpoints per service' | i18n }}:
            {{ projectedCount(form) }}
          </p>
          <footer class="g-buttons">
            <button
              tuiButton
              [disabled]="
                saving() ||
                !form.name.trim() ||
                !form.targetId ||
                (form.scope !== 'all' && !form.packageIds.length) ||
                (!form.id && !form.password) ||
                (projectedCount(form) > 1 && !form.capacityConfirmed)
              "
            >
              {{ (saving() ? 'Saving' : 'Save') | i18n }}
            </button>
          </footer>
        </form>
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
              (click)="reassigning.set(null)"
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
              <label tuiLabel>{{ 'Password' | i18n }}</label>
              <input
                tuiInput
                name="reassignPassword"
                type="password"
                required
                autocomplete="off"
                [(ngModel)]="reassignPassword"
              />
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

    <div class="heading history-heading">
      <h3>{{ 'Automatic backup history' | i18n }}</h3>
    </div>
    <div class="table-wrap">
      <table class="g-table histories">
        <thead>
          <tr>
            <th>{{ 'Service' | i18n }}</th>
            <th>{{ 'Backup location' | i18n }}</th>
            <th>{{ 'Checkpoints' | i18n }}</th>
            <th>{{ 'Automatic storage' | i18n }}</th>
            <th>{{ 'Next-run staging' | i18n }}</th>
            <th>{{ 'Last changed bytes' | i18n }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (
            history of histories();
            track history.targetId + history.packageId
          ) {
            <tr>
              <td>
                {{ packageName(history.packageId) }}
                @if (history.archived) {
                  <span tuiBadge>{{ 'Archived' | i18n }}</span>
                }
              </td>
              <td>{{ targetName(history.targetId) }}</td>
              <td>
                {{ history.snapshots.length }} /
                {{ maximumProjected(history.policy) }}
              </td>
              <td>{{ bytes(historyBytes(history)) }}</td>
              <td>{{ bytes(stagingBytes(history)) }}</td>
              <td>
                @if (lastChanged(history) !== null) {
                  {{ bytes(lastChanged(history)) }}
                } @else {
                  {{ 'Unknown' | i18n }}
                }
              </td>
              <td class="actions">
                <button
                  tuiButton
                  size="xs"
                  appearance="secondary"
                  [disabled]="!history.snapshots.length"
                  (click)="restoreLatest(history)"
                >
                  {{ 'Restore' | i18n }}
                </button>
                @if (mode() === 'create') {
                  <button
                    tuiButton
                    size="xs"
                    appearance="secondary"
                    (click)="editPolicy(history)"
                  >
                    {{ 'Retention' | i18n }}
                  </button>
                }
                @if (archivedSnapshots(history).length) {
                  <button
                    tuiButton
                    size="xs"
                    appearance="flat-destructive"
                    (click)="deleteArchive(history)"
                  >
                    {{ 'Delete archive' | i18n }}
                  </button>
                }
              </td>
            </tr>
            @if (history.snapshots.length) {
              <tr class="snapshot-row">
                <td colspan="7">
                  @for (
                    snapshot of newestFirst(history.snapshots);
                    track snapshot.id
                  ) {
                    <button
                      tuiButton
                      size="xs"
                      appearance="flat"
                      (click)="restoreSnapshot(history, snapshot)"
                    >
                      {{ 'Automatic' | i18n }} · {{ snapshot.jobName }} ·
                      {{ snapshot.completedAt | date: 'medium' }} ·
                      {{ bytes(snapshot.logicalSize) }}
                      @if (snapshot.archived) {
                        · {{ 'Archived' | i18n }}
                      }
                    </button>
                  }
                </td>
              </tr>
            }
          } @empty {
            <tr>
              <td colspan="7">{{ 'No automatic checkpoints' | i18n }}</td>
            </tr>
          }
        </tbody>
      </table>
    </div>

    @if (policyHistory(); as history) {
      <form class="editor" (ngSubmit)="applyPolicy(history)">
        <div class="heading">
          <h3>
            {{ 'Edit shared retention' | i18n }} —
            {{ packageName(history.packageId) }}
          </h3>
          <button
            tuiButton
            type="button"
            size="xs"
            appearance="secondary"
            (click)="policyHistory.set(null)"
          >
            {{ 'Cancel' | i18n }}
          </button>
        </div>
        <p class="muted">
          {{ 'This policy is shared by jobs' | i18n }}:
          {{ affectedJobNames(history).join(', ') }}
        </p>
        @for (tier of policyTiers(); track $index) {
          <div class="tier">
            <tui-textfield>
              <label tuiLabel>{{ 'Interval hours' | i18n }}</label>
              <input
                tuiInput
                type="number"
                min="1"
                [name]="'policy-interval-' + $index"
                [(ngModel)]="tier.intervalHours"
                (ngModelChange)="policyPreview.set(null)"
              />
            </tui-textfield>
            <tui-textfield>
              <label tuiLabel>{{ 'Coverage hours' | i18n }}</label>
              <input
                tuiInput
                type="number"
                min="1"
                [name]="'policy-coverage-' + $index"
                [(ngModel)]="tier.coverageHours"
                (ngModelChange)="policyPreview.set(null)"
              />
            </tui-textfield>
            <button
              tuiButton
              type="button"
              size="xs"
              appearance="flat-destructive"
              (click)="policyTiers().splice($index, 1); policyPreview.set(null)"
            >
              {{ 'Remove' | i18n }}
            </button>
          </div>
        }
        <div class="actions">
          <button
            tuiButton
            type="button"
            size="s"
            appearance="secondary"
            (click)="
              policyTiers().push({ intervalHours: 24, coverageHours: 168 });
              policyPreview.set(null)
            "
          >
            {{ 'Add tier' | i18n }}
          </button>
          <button
            tuiButton
            type="button"
            size="s"
            (click)="previewPolicy(history)"
          >
            {{ 'Preview changes' | i18n }}
          </button>
        </div>
        @if (policyPreview(); as preview) {
          <div
            tuiNotification
            [appearance]="preview.removed.length ? 'warning' : 'positive'"
          >
            {{ 'Estimated reclaimed space' | i18n }}:
            {{ bytes(preview.estimatedReclaimedBytes) }}
            @for (snapshot of preview.removed; track snapshot.id) {
              <div>
                {{ snapshot.completedAt | date: 'medium' }} —
                {{ bytes(snapshot.logicalSize) }}
              </div>
            }
            <label class="check-row">
              <input
                tuiCheckbox
                type="checkbox"
                name="confirmPrune"
                [(ngModel)]="confirmPrune"
              />
              {{ 'Delete exactly the checkpoints listed above' | i18n }}
            </label>
          </div>
          <footer class="g-buttons">
            <button
              tuiButton
              [disabled]="preview.removed.length > 0 && !confirmPrune"
            >
              {{ 'Apply retention' | i18n }}
            </button>
          </footer>
        }
      </form>
    }
  `,
  styles: `
    :host {
      display: block;
      margin-bottom: 2rem;
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

    .estimate-heading {
      margin: 0 0 0.5rem;
    }

    @media (max-width: 30rem) {
      .heading {
        align-items: stretch;
        flex-direction: column;
      }

      .heading > button {
        align-self: flex-start;
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
    TuiBadge,
    TuiButton,
    TuiCheckbox,
    TuiInput,
    TuiNotification,
    TuiSwitch,
    TuiTitle,
    i18nPipe,
  ],
})
export class ScheduledBackupsComponent implements OnInit {
  readonly mode = input.required<'create' | 'restore'>()

  private readonly api = inject(ApiService)
  private readonly backupService = inject(BackupService)
  private readonly dialogs = inject(DialogService)
  private readonly errors = inject(ErrorService)
  private readonly notifications = inject(TuiNotificationMiddleService)
  private readonly packageData = toSignal(
    inject<PatchDB<DataModel>>(PatchDB).watch$('packageData'),
  )

  readonly jobs = signal<T.BackupJob[]>([])
  readonly histories = signal<T.ServiceTargetHistory[]>([])
  readonly reviews = signal<T.NewServiceBackupReview[]>([])
  readonly loading = signal(true)
  readonly saving = signal(false)
  readonly editor = signal<JobEditor | null>(null)
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
      name: `${target.entry.hostname}${target.entry.path}`,
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
      return manifest ? [{ id, name: manifest.title }] : []
    }),
  )

  readonly weekdays = [
    { value: 0, label: 'Sunday' as const },
    { value: 1, label: 'Monday' as const },
    { value: 2, label: 'Tuesday' as const },
    { value: 3, label: 'Wednesday' as const },
    { value: 4, label: 'Thursday' as const },
    { value: 5, label: 'Friday' as const },
    { value: 6, label: 'Saturday' as const },
  ]

  async ngOnInit() {
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
      scope: 'all',
      packageIds: this.packages().map(pkg => pkg.id),
      frequency: 'daily',
      minute: now.getMinutes(),
      hour: now.getHours(),
      weekday: now.getDay(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      retentionPreset: 'latest',
      tiers: [],
      retentionOverrides: {},
      enabled: true,
      password: '',
      capacityConfirmed: false,
    }
    this.editor.set(form)
    void this.refreshEstimates(form)
  }

  edit(job: T.BackupJob) {
    const schedule = parseBackupSchedule(job.schedule)
    const form: JobEditor = {
      id: job.id,
      name: job.name,
      targetId: job.targetId,
      scope: job.services.type,
      packageIds:
        job.services.type === 'selected'
          ? [...job.services.packageIds]
          : job.services.type === 'allExcept'
            ? this.packages()
                .map(pkg => pkg.id)
                .filter(id => {
                  const services = job.services
                  return (
                    services.type !== 'allExcept' ||
                    !services.excludedPackageIds.includes(id)
                  )
                })
            : this.packages().map(pkg => pkg.id),
      ...schedule,
      retentionPreset: job.defaultRetention.tiers.length ? 'custom' : 'latest',
      tiers: this.toTierEditors(job.defaultRetention),
      retentionOverrides: Object.fromEntries(
        Object.entries(job.retentionOverrides).map(([packageId, policy]) => [
          packageId,
          {
            preset: this.retentionPreset(policy),
            tiers: this.toTierEditors(policy),
          },
        ]),
      ),
      enabled: job.enabled,
      password: '',
      capacityConfirmed: false,
    }
    this.editor.set(form)
    void this.refreshEstimates(form)
  }

  applyPreset(form: JobEditor) {
    if (form.retentionPreset === 'latest') form.tiers = []
    if (form.retentionPreset === 'daily-week') {
      form.tiers = [{ intervalHours: 24, coverageHours: 168 }]
    }
    form.capacityConfirmed = false
  }

  togglePackage(form: JobEditor, packageId: string, checked: boolean) {
    form.packageIds = checked
      ? [...new Set([...form.packageIds, packageId])]
      : form.packageIds.filter(id => id !== packageId)
    if (!checked) delete form.retentionOverrides[packageId]
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
    this.saving.set(true)
    const loader = this.notifications.open('Saving').subscribe()
    try {
      const common = {
        name: form.name.trim(),
        services:
          form.scope === 'all'
            ? ({ type: 'all' } as const)
            : form.scope === 'allExcept'
              ? ({
                  type: 'allExcept',
                  excludedPackageIds: this.packages()
                    .map(pkg => pkg.id)
                    .filter(id => !form.packageIds.includes(id)),
                } as const)
              : ({ type: 'selected', packageIds: form.packageIds } as const),
        schedule: serializeBackupSchedule(form),
        defaultRetention: this.policy(form.tiers),
        retentionOverrides: Object.fromEntries(
          Object.entries(form.retentionOverrides).map(
            ([packageId, override]) => [packageId, this.policy(override.tiers)],
          ),
        ),
      }
      if (form.id) {
        const updated = await this.api.updateScheduledBackupJob({
          id: form.id,
          ...common,
        })
        if (updated.enabled !== form.enabled) {
          await this.api.setScheduledBackupJobEnabled({
            id: updated.id,
            enabled: form.enabled,
          })
        }
      } else {
        await this.api.createScheduledBackupJob({
          ...common,
          targetId: form.targetId,
          password: form.password,
          enabled: form.enabled,
        })
      }
      this.editor.set(null)
      await this.reload()
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    } finally {
      loader.unsubscribe()
      this.saving.set(false)
    }
  }

  async runNow(job: T.BackupJob) {
    await this.perform('Running backup', () =>
      this.api.runScheduledBackupJob({ id: job.id }),
    )
  }

  async toggle(job: T.BackupJob) {
    await this.perform(job.enabled ? 'Pausing' : 'Resuming', () =>
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

    await this.perform('Deleting', async () => {
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
    await this.perform('Retrying', () =>
      this.api.retryScheduledBackupTarget({
        targetId: job.targetId,
        password,
      }),
    )
  }

  beginReassign(job: T.BackupJob) {
    this.reassigning.set(job)
    this.reassignTargetId =
      this.targets().find(t => t.id !== job.targetId)?.id || ''
    this.reassignPassword = ''
    this.waitForSchedule = false
  }

  async reassign(job: T.BackupJob) {
    await this.perform('Changing target', () =>
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
    await this.perform('Saving', () =>
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
    await this.perform('Saving', () =>
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
    await this.perform('Deleting', () =>
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
    await this.perform('Restoring', () =>
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

  scopeLabel(scope: T.BackupServiceScope): string {
    if (scope.type === 'all') return 'All services'
    if (scope.type === 'allExcept') return 'All services with exclusions'
    return 'Selected services'
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

  resultLabel(result: T.BackupRunState | null) {
    switch (result) {
      case 'succeeded':
        return 'Succeeded' as const
      case 'partiallyFailed':
        return 'Partially failed' as const
      case 'failed':
        return 'Failed' as const
      case 'running':
        return 'Running' as const
      default:
        return 'Never run' as const
    }
  }

  projectedCount(form: JobEditor): number {
    return Math.max(
      this.maximumProjected(this.policy(form.tiers)),
      ...Object.values(form.retentionOverrides).map(override =>
        this.maximumProjected(this.policy(override.tiers)),
      ),
    )
  }

  selectedPackages(form: JobEditor) {
    return form.scope === 'all'
      ? this.packages()
      : this.packages().filter(pkg => form.packageIds.includes(pkg.id))
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
          services:
            form.scope === 'all'
              ? { type: 'all' }
              : form.scope === 'allExcept'
                ? {
                    type: 'allExcept',
                    excludedPackageIds: this.packages()
                      .map(pkg => pkg.id)
                      .filter(id => !form.packageIds.includes(id)),
                  }
                : { type: 'selected', packageIds: form.packageIds },
          defaultRetention: this.policy(form.tiers),
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

  private async perform<T>(label: string, action: () => Promise<T>) {
    const loader = this.notifications.open(label).subscribe()
    try {
      await action()
      await this.reload()
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    } finally {
      loader.unsubscribe()
    }
  }
}
