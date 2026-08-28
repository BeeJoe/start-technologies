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
  output,
  signal,
  viewChild,
} from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import {
  convertBytes,
  DialogService,
  ErrorService,
  getErrorMessage,
  i18nPipe,
  TaskService,
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
  TuiLoader,
  TuiNotification,
  TuiTitle,
} from '@taiga-ui/core'
import {
  TuiAccordion,
  TuiBadge,
  TuiBlock,
  TuiChevron,
  TuiInputNumber,
  TuiSelect,
  TuiSwitch,
} from '@taiga-ui/kit'
import { PatchDB } from 'patch-db-client'
import { filter, firstValueFrom, map, take } from 'rxjs'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { DataModel } from 'src/app/services/patch-db/data-model'
import { BackupService, formatCifsLocation } from './backup.service'
import { BackupScheduleBrowser } from './schedule-browser'
import { BackupScheduleControls } from './schedule-controls'
import {
  backupRetentionIntervalLabel,
  BACKUP_RETENTION_INTERVALS,
  BackupRetentionTierEditor,
  BackupScheduleFormValue,
  BackupServiceSelection,
  formatBackupScheduleSummary,
  formatBackupServiceSummary,
  hasDuplicateRetentionRules,
  isValidBackupSchedule,
  parseBackupRetentionTier,
  parseBackupSchedule,
  parseBackupServiceSelection,
  retentionIntervalFromSeconds,
  retentionIntervalSeconds,
  retentionPeriodLabel,
  removeBackupRetentionRule,
  serializeBackupRetentionTier,
  serializeBackupServiceSelection,
  serializeBackupSchedule,
  SYSTEM_PACKAGE_ID,
} from './scheduled-utils'
import { DeleteScheduleService } from './delete-schedule'

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

interface ConfirmedRetentionChange {
  history: T.ServiceTargetHistory
  policy: T.RetentionPolicy
  preview: T.RetentionPolicyChangePreview
}

interface JobEditor
  extends
    EditableRetentionRule,
    BackupScheduleFormValue,
    BackupServiceSelection {
  id?: string
  name: string
  targetId: string
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
            size="s"
            [ngModelOptions]="{ standalone: true }"
            [ngModel]="allReviewJobsSelected(review)"
            (ngModelChange)="setAllReviewJobs(review, $event)"
          />
        </label>
        @for (job of jobs(); track job.id) {
          <label tuiLabel class="checkbox-row review-job">
            <span tuiTitle>
              <b>{{ jobName(job.id) }}</b>
            </span>
            <input
              tuiCheckbox
              type="checkbox"
              size="s"
              [ngModelOptions]="{ standalone: true }"
              [ngModel]="reviewDecision(review.packageId, job.id)"
              (ngModelChange)="
                setReviewDecision(review.packageId, job.id, $event)
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
        <tui-loader [textContent]="'Loading' | i18n" />
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
        <backup-schedule-browser
          [jobs]="jobs()"
          [packageIds]="packageIds()"
          [targets]="targets()"
          (enabledChange)="setJobEnabled($event.job, $event.enabled)"
          (runRequested)="runNow($event)"
          (editRequested)="edit($event)"
          (deleteRequested)="deleteJob($event)"
          (createRequested)="create()"
        />
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
            <tui-textfield
              tuiChevron
              [stringify]="stringifyTarget"
              [tuiTextfieldCleaner]="false"
            >
              <label tuiLabel>{{ 'Backup location' | i18n }}</label>
              <input
                tuiSelect
                name="target"
                required
                [disabled]="!!form.id"
                [(ngModel)]="form.targetId"
              />
              <tui-data-list *tuiDropdown>
                @for (target of targets(); track target.id) {
                  <button tuiOption [value]="target.id">
                    {{ target.name }}
                  </button>
                }
              </tui-data-list>
            </tui-textfield>
          </div>

          <div class="setting-row vertical">
            <span tuiTitle>
              <b>{{ 'Schedule' | i18n }}</b>
              <span tuiSubtitle>{{ scheduleSummary(form) }}</span>
            </span>
            <backup-schedule-controls [schedule]="form" />
          </div>

          <div class="setting-row vertical services-setting">
            <tui-accordion class="g-wrap-accordion">
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
                      <b>{{ 'Toggle all services' | i18n }}</b>
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
                @for (rule of form.additionalTiers; track rule) {
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
              @if (retentionHasDuplicates(form)) {
                <div tuiNotification appearance="negative">
                  {{ 'Each version-history rule must be unique.' | i18n }}
                </div>
              }
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
                    <span class="g-primary more-info">
                      {{ 'More info' | i18n }}
                    </span>
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
                [type]="passwordMasked ? 'password' : 'text'"
                name="password"
                required
                autocomplete="off"
                [(ngModel)]="form.password"
              />
              <button
                tuiIconButton
                type="button"
                size="xs"
                appearance="icon"
                [iconStart]="passwordMasked ? '@tui.eye' : '@tui.eye-off'"
                (click)="passwordMasked = !passwordMasked"
              >
                {{
                  (passwordMasked ? 'Show password' : 'Hide password') | i18n
                }}
              </button>
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
            <button tuiButton type="submit" [disabled]="!canSave(form)">
              {{ 'Save' | i18n }}
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
            <tui-textfield
              tuiChevron
              [stringify]="stringifyTarget"
              [tuiTextfieldCleaner]="false"
            >
              <label tuiLabel>{{ 'New backup location' | i18n }}</label>
              <input
                tuiSelect
                name="newTarget"
                required
                [(ngModel)]="reassignTargetId"
              />
              <tui-data-list *tuiDropdown>
                @for (target of targets(); track target.id) {
                  <button tuiOption [value]="target.id">
                    {{ target.name }}
                  </button>
                }
              </tui-data-list>
            </tui-textfield>
            <tui-textfield>
              <label tuiLabel>{{ 'Master Password' | i18n }}</label>
              <input
                tuiInput
                name="reassignPassword"
                [type]="reassignPasswordMasked ? 'password' : 'text'"
                required
                autocomplete="off"
                [(ngModel)]="reassignPassword"
              />
              <button
                tuiIconButton
                type="button"
                size="xs"
                appearance="icon"
                [iconStart]="
                  reassignPasswordMasked ? '@tui.eye' : '@tui.eye-off'
                "
                (click)="reassignPasswordMasked = !reassignPasswordMasked"
              >
                {{
                  (reassignPasswordMasked ? 'Show password' : 'Hide password')
                    | i18n
                }}
              </button>
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
      margin-block-end: 2rem;
      min-inline-size: 0;
      container-type: inline-size;
    }

    [tuiTitle] {
      min-inline-size: 0;
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
      inline-size: 100%;
      max-inline-size: 100%;
      min-inline-size: 0;
      overflow-x: auto;
    }

    .actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.35rem;
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
      min-inline-size: 0;
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
      inline-size: 100%;
      min-inline-size: 0;
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

    .editor {
      display: grid;
      gap: 1rem;
      margin-block-start: 1rem;
      padding: 1rem;
      border: 1px solid var(--tui-border-normal);
      border-radius: 0.75rem;
      min-inline-size: 0;
      overflow: hidden;
    }

    .review {
      display: grid;
      gap: 1rem;
      margin-block-start: 1rem;
      padding: 1rem;
      min-inline-size: 0;
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
      align-items: center;
      justify-content: space-between;
    }

    .review .checkbox-row > input {
      inset-block-start: 0;
      margin-inline-start: auto;
      transform: none;
    }

    .review .toggle-all {
      justify-content: flex-end;
    }

    .review .toggle-all > input {
      margin-inline-start: 0;
    }

    .review-job [tuiTitle] {
      text-align: start;
    }

    .editor.panel {
      inline-size: 100%;
      padding: 1.25rem;
      box-sizing: border-box;
    }

    .setting-row.vertical {
      align-items: stretch;
      flex-direction: column;
    }

    [tuiGroup] {
      inline-size: 100%;
    }

    [tuiBlock] img {
      inline-size: 2.5rem;
      border-radius: 50%;
    }

    [tuiBlock] [tuiTitle],
    .include-future [tuiTitle] {
      flex: 1;
    }

    [tuiBlock],
    [tuiBlock] [tuiTitle] {
      justify-content: flex-start;
      text-align: start;
    }

    .toggle-all,
    .first-backup {
      inline-size: fit-content;
      max-inline-size: 100%;
      justify-content: flex-start;
    }

    .toggle-all {
      inline-size: 100%;
      gap: 0.5rem;
      padding: 0 1rem 1rem;
      border-block-end: 1px solid var(--tui-border-normal);
      box-sizing: border-box;
    }

    .include-future {
      align-items: flex-start;
      inline-size: 100%;
      max-inline-size: 100%;
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
      inline-size: fit-content;
      justify-content: flex-start;
    }

    .retention-heading .inline-switch {
      flex: 0 0 auto;
      justify-content: flex-start;
      inline-size: fit-content;
      margin-inline-start: auto;
    }

    .retention-rule {
      display: grid;
      grid-template-columns:
        auto minmax(9rem, 1fr) auto minmax(10rem, 0.75fr)
        auto auto;
      gap: 0.5rem;
      align-items: center;
      inline-size: 100%;
      min-inline-size: 0;
    }

    .retention-rules {
      display: grid;
      gap: 0.75rem;
      inline-size: 100%;
      min-inline-size: 0;
    }

    .retention-rules {
      justify-items: stretch;
    }

    .add-retention-rule {
      justify-self: end;
    }

    .duration-field {
      min-inline-size: 10rem;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
      gap: 1rem;
      align-items: end;
    }

    label > span:first-child {
      display: block;
      margin-block-end: 0.35rem;
      color: var(--tui-text-secondary);
    }

    fieldset {
      display: grid;
      gap: 0.65rem;
      min-inline-size: 0;
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
      min-block-size: 2.75rem;
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
      max-inline-size: 100%;
      block-size: auto;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .grid > *,
    .histories td {
      min-inline-size: 0;
      overflow-wrap: anywhere;
    }

    .history-heading {
      margin-block-start: 2rem;
    }

    .view-all-jobs {
      inline-size: 100%;
      min-inline-size: 0;
      text-align: start;
      box-sizing: border-box;
    }

    .view-all-jobs [tuiTitle] {
      flex: 1;
    }

    .estimate-heading {
      margin: 0 0 0.5rem;
    }

    .capacity-list,
    .capacity-details {
      display: grid;
      min-inline-size: 0;
    }

    .capacity-list {
      gap: 0.5rem;
    }

    .capacity-service {
      min-inline-size: 0;
      overflow: hidden;
      border: 1px solid var(--tui-border-normal);
      border-radius: var(--tui-radius-m);
    }

    .capacity-summary {
      inline-size: 100%;
      min-inline-size: 0;
      min-block-size: 3.5rem;
      block-size: auto;
      white-space: normal;
    }

    .capacity-summary [tuiTitle] {
      flex: 1;
      min-inline-size: 0;
      text-align: start;
    }

    .capacity-summary [tuiSubtitle] {
      display: block;
      margin-block-start: 0.2rem;
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
      border-block-start: 1px solid var(--tui-border-normal);
    }

    .capacity-details dt {
      color: var(--tui-text-secondary);
      font-weight: 600;
    }

    .capacity-details dd {
      margin: 0;
      text-align: end;
    }

    .capacity-unknown {
      margin: 0;
      padding: 0 1rem 1rem;
      color: var(--tui-text-secondary);
    }

    @container (max-inline-size: 30rem) {
      [tuiBlock] img,
      [tuiBlock] > tui-icon {
        display: none;
      }

      .include-future {
        flex-direction: column;
        gap: 0.5rem;
        padding-inline: 0.75rem;
      }

      .include-future [tuiTitle] {
        inline-size: 100%;
        min-inline-size: 0;
      }

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

      .retention-heading {
        align-items: flex-start;
      }

      .retention-heading > [tuiTitle] {
        flex: 1;
        min-inline-size: 0;
      }

      .retention-heading .inline-switch {
        flex: 0 0 auto;
        inline-size: fit-content;
      }

      .retention-heading .retention-toggle-label {
        display: none;
      }

      .capacity-details div {
        grid-template-columns: 1fr;
        gap: 0.2rem;
      }

      .capacity-details dd {
        text-align: start;
      }

      .capacity-summary {
        flex-wrap: wrap;
      }

      .capacity-summary .more-info {
        flex-basis: 100%;
        text-align: end;
      }
    }
  `,
  host: {
    class: 'g-wrap-content',
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
    TuiLoader,
    TuiNotification,
    TuiSelect,
    TuiSwitch,
    TuiTitle,
    BackupScheduleBrowser,
    BackupScheduleControls,
    i18nPipe,
  ],
})
export class ScheduledBackups {
  readonly mode = input.required<'manage' | 'restore'>()
  readonly createRequest = input(false)
  readonly reviewPackageId = input('')
  readonly createRequestHandled = output<void>()
  readonly collapseRequested = output<string | null>()

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
  private readonly tasks = inject(TaskService)

  protected readonly jobs = signal<T.BackupJob[]>([])
  protected readonly histories = signal<T.ServiceTargetHistory[]>([])
  protected readonly reviews = signal<T.NewServiceBackupReview[]>([])
  protected readonly visibleReviews = computed(() =>
    this.reviews().filter(
      review => review.packageId === this.reviewPackageId(),
    ),
  )
  protected readonly loading = signal(true)
  protected readonly editor = signal<JobEditor | null>(null)
  private showSingleJobList = false
  protected readonly selectedJobId = signal('')
  protected readonly showServices = signal(false)
  protected readonly reassigning = signal<T.BackupJob | null>(null)
  protected readonly policyHistory = signal<T.ServiceTargetHistory | null>(null)
  protected readonly policyTiers = signal<EditableRetentionRule[]>([])
  protected readonly policyPreview =
    signal<T.RetentionPolicyChangePreview | null>(null)
  protected readonly estimates = signal<T.BackupServiceCapacityEstimate[]>([])
  protected readonly capacityDetailsOpen = signal<ReadonlySet<string>>(
    new Set(),
  )

  protected reassignTargetId = ''
  protected reassignPassword = ''
  protected passwordMasked = true
  protected reassignPasswordMasked = true
  protected waitForSchedule = false
  protected confirmPrune = false
  private editorBaseline: string | null = null
  private pendingReview: T.NewServiceBackupReview | null = null

  constructor() {
    void this.initialize()
    effect(() => {
      if (!this.createRequest() || this.loading()) return
      this.createRequestHandled.emit()
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

  protected readonly targets = computed(() => [
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
  protected readonly stringifyTarget = (targetId: string) =>
    this.targetName(targetId)

  protected readonly packages = computed(() => [
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
  protected readonly packageIds = computed(() =>
    this.packages().map(pkg => pkg.id),
  )
  protected readonly selectedJob = computed(() =>
    this.jobs().find(job => job.id === this.selectedJobId()),
  )

  protected readonly retentionIntervals = BACKUP_RETENTION_INTERVALS
  isEditorOpen(): boolean {
    return this.editor() !== null
  }
  protected readonly stringifyRetentionInterval = (
    interval: BackupRetentionTierEditor['interval'],
  ) => this.i18n.transform(backupRetentionIntervalLabel(interval))

  private async initialize() {
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
      jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      this.jobs.set(jobs)
      this.histories.set(histories)
      this.reviews.set(reviews)
      for (const review of reviews) {
        this.reviewDecisions.set(
          review.packageId,
          Object.fromEntries(
            jobs.map(job => [
              job.id,
              this.jobIncludesService(job, review.packageId),
            ]),
          ),
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
    } catch (error) {
      this.errors.handleError(getErrorMessage(error))
    } finally {
      this.loading.set(false)
    }
  }

  protected async create(): Promise<boolean> {
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

  protected async viewAllJobs() {
    if (!(await this.confirmDiscardChanges())) return
    this.reassigning.set(null)
    this.showSingleJobList = true
    this.selectedJobId.set('')
    this.editor.set(null)
    this.editorBaseline = null
    this.pendingReview = null
    this.showServices.set(false)
  }

  protected async cancelEditor() {
    if (!(await this.confirmDiscardChanges())) return
    this.selectedJobId.set('')
    this.editor.set(null)
    this.editorBaseline = null
    this.pendingReview = null
    this.showServices.set(false)
    this.collapseRequested.emit(null)
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

  protected async createForReview(review: T.NewServiceBackupReview) {
    if (!(await this.create())) return
    const form = this.editor()
    if (!form) return
    form.packageIds = [SYSTEM_PACKAGE_ID, review.packageId]
    form.includeFuture = false
    this.pendingReview = review
    this.editorBaseline = this.editorSnapshot(form)
    void this.refreshEstimates(form)
  }

  protected isDefaultJob(form: JobEditor): boolean {
    return !!form.id && this.jobs().length === 1 && form.name === 'Default'
  }

  protected async edit(job?: T.BackupJob) {
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

  protected removeRetentionRule(form: JobEditor, index: number) {
    const result = removeBackupRetentionRule<EditableRetentionRule>(
      form,
      form.additionalTiers,
      index,
      this.newRetentionRule(),
    )
    Object.assign(form, result.primary)
    form.additionalTiers = result.additional
    form.keepAdditional = result.keepAdditional
    form.capacityConfirmed = false
  }

  protected togglePackage(
    form: JobEditor,
    packageId: string,
    checked: boolean,
  ) {
    form.packageIds = checked
      ? [...new Set([...form.packageIds, packageId])]
      : form.packageIds.filter(id => id !== packageId)
    if (!checked) delete form.retentionOverrides[packageId]
    form.capacityConfirmed = false
  }

  protected allPackagesSelected(form: JobEditor): boolean {
    const services = this.packages().filter(pkg => pkg.id !== SYSTEM_PACKAGE_ID)
    return (
      services.length > 0 &&
      services.every(pkg => form.packageIds.includes(pkg.id))
    )
  }

  protected setAllPackages(form: JobEditor, checked: boolean) {
    const includesSystem = form.packageIds.includes(SYSTEM_PACKAGE_ID)
    const services = this.packages().filter(pkg => pkg.id !== SYSTEM_PACKAGE_ID)
    form.packageIds = [
      ...(includesSystem ? [SYSTEM_PACKAGE_ID] : []),
      ...(checked ? services.map(service => service.id) : []),
    ]
    if (!checked) {
      services.forEach(service => delete form.retentionOverrides[service.id])
    }
    form.capacityConfirmed = false
  }

  protected async save(form: JobEditor) {
    if (!this.canSave(form)) return
    if (this.hasDuplicateJobName(form)) {
      this.dialogs
        .openAlert(
          'Every backup schedule needs a unique name. Choose a different name.',
          {
            label: 'Schedule name already in use',
            size: 's',
          },
        )
        .subscribe()
      this.jobNameInput()?.nativeElement.focus()
      return
    }
    const existingJob = form.id
      ? this.jobs().find(job => job.id === form.id)
      : null
    const common = {
      name: form.name.trim(),
      services: serializeBackupServiceSelection(
        form,
        this.packages().map(pkg => pkg.id),
      ),
      schedule: serializeBackupSchedule(form),
      defaultRetention: this.defaultPolicy(form),
      retentionOverrides: Object.fromEntries(
        Object.entries(form.retentionOverrides).map(([packageId, override]) => [
          packageId,
          this.policy(override.tiers),
        ]),
      ),
    }
    const valid = await this.tasks.run(
      () =>
        this.api.validateScheduledBackupJob({
          id: form.id || null,
          targetId: existingJob?.targetId || form.targetId,
          services: common.services,
          schedule: common.schedule,
          defaultRetention: common.defaultRetention,
          retentionOverrides: common.retentionOverrides,
          enabled: existingJob
            ? (existingJob.enabled && !existingJob.pause) ||
              (form.firstBackupNow && !existingJob.enabled)
            : true,
        }),
      'Validating',
    )
    if (!valid) return
    const retentionChanges = form.id
      ? await this.confirmJobRetentionChanges(form)
      : []
    if (retentionChanges === null) return
    await this.tasks.run(async () => {
      if (form.id) {
        const selectedJob = this.selectedJob()
        const updated = await this.api.updateScheduledBackupJob({
          id: form.id!,
          ...common,
        })
        this.jobs.update(jobs =>
          jobs.map(job => (job.id === updated.id ? updated : job)),
        )
        for (const change of retentionChanges) {
          await this.api.updateScheduledRetention({
            targetId: change.history.targetId,
            packageId: change.history.packageId,
            policy: change.policy,
            confirmedRemovals: change.preview.removed.map(
              snapshot => snapshot.id,
            ),
          })
        }
        this.finishSave(form.firstBackupNow ? form.id! : null)
        if (form.firstBackupNow && selectedJob && !selectedJob.enabled) {
          await this.api.setScheduledBackupJobEnabled({
            id: form.id!,
            enabled: true,
          })
        }
        if (form.firstBackupNow) {
          await this.waitForRunProgress(
            form.id!,
            this.api.runScheduledBackupJob({ id: form.id! }),
          )
        }
        return
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
            decisions: Object.fromEntries([
              ...this.jobs().map(job => [job.id, false] as const),
              [created.id, true] as const,
            ]),
          })
        }
      }
      this.finishSave(null)
      await this.reload()
    }, 'Saving')
  }

  private async confirmJobRetentionChanges(
    form: JobEditor,
  ): Promise<ConfirmedRetentionChange[] | null> {
    const job = this.jobs().find(candidate => candidate.id === form.id)
    if (!job) return []
    const selected = new Set(this.selectedPackages(form).map(pkg => pkg.id))
    const defaultPolicy = this.defaultPolicy(form)
    const overrides = Object.fromEntries(
      Object.entries(form.retentionOverrides).map(([packageId, override]) => [
        packageId,
        this.policy(override.tiers),
      ]),
    )
    const candidates = this.histories().flatMap(history => {
      if (
        !selected.has(history.packageId) ||
        history.feedingJobs.length !== 1 ||
        history.feedingJobs[0] !== job.id
      ) {
        return []
      }
      const policy = overrides[history.packageId] || defaultPolicy
      return JSON.stringify(policy) === JSON.stringify(history.policy)
        ? []
        : [{ history, policy }]
    })
    let changes: ConfirmedRetentionChange[] = []
    const loaded = await this.tasks.run(async () => {
      changes = await Promise.all(
        candidates.map(async ({ history, policy }) => ({
          history,
          policy,
          preview: await this.api.previewScheduledRetention({
            targetId: history.targetId,
            packageId: history.packageId,
            policy,
          }),
        })),
      )
    }, 'Loading')
    if (!loaded) return null
    const removals = changes.flatMap(change => change.preview.removed)
    if (!removals.length) return changes
    const confirmed = await firstValueFrom(
      this.dialogs.openConfirm({
        label: 'Apply version-history change?',
        size: 's',
        data: {
          content:
            'This permanently deletes the checkpoints listed in the preview.',
          yes: 'Apply',
          no: 'Cancel',
        },
      }),
      { defaultValue: false },
    )
    return confirmed ? changes : null
  }

  private hasDuplicateJobName(form: JobEditor): boolean {
    const name = form.name.trim()
    return this.jobs().some(
      job => job.id !== form.id && job.name.trim() === name,
    )
  }

  private finishSave(runNowJobId: string | null) {
    this.selectedJobId.set('')
    this.editor.set(null)
    this.editorBaseline = null
    this.pendingReview = null
    this.showSingleJobList = true
    this.collapseRequested.emit(runNowJobId)
  }

  private async waitForRunProgress(
    jobId: string,
    run: Promise<T.BackupRun>,
  ): Promise<void> {
    const visible = firstValueFrom(
      this.patch.watch$('scheduledBackups', 'activities').pipe(
        filter(activities =>
          Object.values(activities).some(
            activity =>
              activity.jobId === jobId && activity.state === 'running',
          ),
        ),
        map(() => 'visible' as const),
        take(1),
      ),
    )
    const outcome = await Promise.race([
      run.then(() => 'completed' as const),
      visible,
    ])
    if (outcome === 'visible') {
      void run.catch(error => this.errors.handleError(getErrorMessage(error)))
    }
  }

  protected async runNow(job: T.BackupJob) {
    await this.perform(() => this.api.runScheduledBackupJob({ id: job.id }))
  }

  protected async setJobEnabled(job: T.BackupJob, enabled: boolean) {
    if (enabled === job.enabled && !job.pause) return
    await this.perform(() =>
      this.api.setScheduledBackupJobEnabled({
        id: job.id,
        enabled,
      }),
    )
  }

  protected async deleteJob(job: T.BackupJob) {
    if (await this.deleteSchedule.delete(job)) {
      this.showSingleJobList = true
      this.selectedJobId.set('')
      this.editor.set(null)
      this.editorBaseline = null
      this.pendingReview = null
      await this.reload()
      if (this.jobs().length <= 1) this.collapseRequested.emit(null)
    }
  }

  protected async retry(job: T.BackupJob) {
    const password = await firstValueFrom(
      this.dialogs.openPrompt<string>({
        label: 'Enter password',
        data: {
          message: 'Enter password',
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

  protected async beginReassign(job: T.BackupJob) {
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

  protected cancelReassign(job: T.BackupJob) {
    this.reassigning.set(null)
    void this.edit(job)
  }

  protected async reassign(job: T.BackupJob) {
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

  protected reviewDecision(packageId: string, jobId: string): boolean {
    return this.reviewDecisions.get(packageId)?.[jobId] ?? false
  }

  protected setReviewDecision(
    packageId: string,
    jobId: string,
    value: boolean,
  ) {
    const decisions = this.reviewDecisions.get(packageId) || {}
    decisions[jobId] = value
    this.reviewDecisions.set(packageId, decisions)
  }

  protected allReviewJobsSelected(review: T.NewServiceBackupReview): boolean {
    const decisions = this.reviewDecisions.get(review.packageId)
    return (
      this.jobs().length > 0 &&
      this.jobs().every(job => decisions?.[job.id] === true)
    )
  }

  protected setAllReviewJobs(
    review: T.NewServiceBackupReview,
    checked: boolean,
  ) {
    this.reviewDecisions.set(
      review.packageId,
      Object.fromEntries(this.jobs().map(job => [job.id, checked])),
    )
  }

  protected async resolveReview(review: T.NewServiceBackupReview) {
    const selected = this.reviewDecisions.get(review.packageId) || {}
    const decisions = Object.fromEntries(
      this.jobs().map(job => [job.id, selected[job.id] === true]),
    )
    await this.perform(() =>
      this.api.resolveNewServiceBackupReview({
        packageId: review.packageId,
        decisions,
      }),
    )
  }

  private jobIncludesService(job: T.BackupJob, packageId: string): boolean {
    return (
      job.services.type === 'all' ||
      (job.services.type === 'allExcept' &&
        !job.services.excludedPackageIds.includes(packageId)) ||
      (job.services.type === 'selected' &&
        job.services.packageIds.includes(packageId))
    )
  }

  protected editPolicy(history: T.ServiceTargetHistory) {
    this.policyHistory.set(history)
    this.policyTiers.set(this.toTierEditors(history.policy))
    this.policyPreview.set(null)
    this.confirmPrune = false
  }

  protected async previewPolicy(history: T.ServiceTargetHistory) {
    await this.tasks.run(async () => {
      this.policyPreview.set(
        await this.api.previewScheduledRetention({
          targetId: history.targetId,
          packageId: history.packageId,
          policy: this.policy(this.policyTiers()),
        }),
      )
      this.confirmPrune = false
    }, 'Loading')
  }

  protected async applyPolicy(history: T.ServiceTargetHistory) {
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

  protected async deleteArchive(history: T.ServiceTargetHistory) {
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
    const password = await firstValueFrom(
      this.dialogs.openPrompt<string>({
        label: 'Enter password',
        data: {
          message: 'Enter your current master password',
          label: 'Password',
          placeholder: 'Password',
          buttonText: 'Delete',
          useMask: true,
        },
      }),
      { defaultValue: '' },
    )
    if (!password) return
    await this.perform(() =>
      this.api.deleteArchivedBackupSnapshots({
        targetId: history.targetId,
        packageId: history.packageId,
        snapshotIds: this.archivedSnapshots(history).map(
          snapshot => snapshot.id,
        ),
        password,
      }),
    )
  }

  protected restoreLatest(history: T.ServiceTargetHistory) {
    const latest = this.newestFirst(history.snapshots)[0]
    if (latest) this.restoreSnapshot(history, latest)
  }

  protected async restoreSnapshot(
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

  protected jobName(id: string): string {
    return this.jobs().find(job => job.id === id)?.name || id
  }

  protected packageName(id: string): string {
    if (id === SYSTEM_PACKAGE_ID) return this.i18n.transform('System')
    return this.packages().find(pkg => pkg.id === id)?.name || id
  }

  protected affectedJobNames(history: T.ServiceTargetHistory): string[] {
    return history.feedingJobs.map(id => this.jobName(id))
  }

  protected targetName(id: string): string {
    return this.targets().find(target => target.id === id)?.name || id
  }

  protected pauseLabel(pause: T.BackupJobPause) {
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

  protected scheduleSummary(form: JobEditor): string {
    return formatBackupScheduleSummary(form, label =>
      this.i18n.transform(label),
    )
  }

  protected selectedServiceSummary(form: JobEditor): string {
    const total = this.packages().filter(
      pkg => pkg.id !== SYSTEM_PACKAGE_ID,
    ).length
    const selected = form.packageIds.filter(
      id => id !== SYSTEM_PACKAGE_ID,
    ).length
    return formatBackupServiceSummary(
      selected,
      total,
      form.includeFuture,
      form.packageIds.includes(SYSTEM_PACKAGE_ID),
      label => this.i18n.transform(label),
    )
  }

  protected retentionSummary(form: JobEditor): string {
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

  protected retentionPeriod(form: JobEditor) {
    return this.retentionPeriodFor(form)
  }

  protected retentionPeriodFor(rule: BackupRetentionTierEditor) {
    return rule.interval === 'custom'
      ? 'hours'
      : retentionPeriodLabel(rule.interval, rule.duration)
  }

  protected newRetentionRule(): EditableRetentionRule {
    return {
      ...parseBackupRetentionTier(),
      preserved: null,
    }
  }

  protected canSave(form: JobEditor): boolean {
    return !!(
      form.name.trim() &&
      form.targetId &&
      form.packageIds.length &&
      isValidBackupSchedule(form) &&
      this.validRetention(form) &&
      (form.id || form.password) &&
      (this.projectedCount(form) <= 1 || form.capacityConfirmed)
    )
  }

  private validRetention(form: JobEditor): boolean {
    if (!form.keepAdditional) return true
    const tiers = [form, ...form.additionalTiers]
    return (
      !hasDuplicateRetentionRules(tiers) &&
      tiers.every(
        rule =>
          this.retentionIntervals.includes(
            rule.interval as (typeof this.retentionIntervals)[number],
          ) &&
          Number.isInteger(rule.duration) &&
          rule.duration >= 1 &&
          rule.duration <= 365,
      )
    )
  }

  protected retentionHasDuplicates(form: JobEditor): boolean {
    return hasDuplicateRetentionRules([form, ...form.additionalTiers])
  }

  protected projectedCount(form: JobEditor): number {
    return Math.max(
      this.maximumProjected(this.defaultPolicy(form)),
      ...Object.values(form.retentionOverrides).map(override =>
        this.maximumProjected(this.policy(override.tiers)),
      ),
    )
  }

  protected selectedPackages(form: JobEditor) {
    return this.packages().filter(pkg => form.packageIds.includes(pkg.id))
  }

  protected capacityEstimate(packageId: string) {
    return this.estimates().find(estimate => estimate.packageId === packageId)
  }

  protected setCapacityDetailsOpen(packageId: string, open: boolean) {
    this.capacityDetailsOpen.update(current => {
      const next = new Set(current)
      if (open) next.add(packageId)
      else next.delete(packageId)
      return next
    })
  }

  protected async refreshEstimates(form: JobEditor) {
    if (!form.targetId) return
    await this.tasks.run(async () => {
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
    }, 'Loading')
  }

  protected maximumProjected(policy: T.RetentionPolicy): number {
    return (
      1 +
      policy.tiers.reduce(
        (sum, tier) =>
          sum + Math.ceil(tier.coverageSeconds / tier.intervalSeconds),
        0,
      )
    )
  }

  protected stagingBytes(history: T.ServiceTargetHistory): number | null {
    const latest = this.newestFirst(
      history.snapshots.filter(snapshot => !snapshot.archived),
    )[0]
    return latest
      ? Math.ceil((latest.physicalSize ?? latest.logicalSize) * 1.1)
      : null
  }

  protected lastChanged(history: T.ServiceTargetHistory): number | null {
    return this.newestFirst(history.snapshots)[0]?.changedBytes ?? null
  }

  protected bytes(value: number | null): string {
    return value === null ? '—' : convertBytes(value)
  }

  protected newestFirst(snapshots: T.ServiceSnapshot[]): T.ServiceSnapshot[] {
    return [...snapshots].sort((a, b) =>
      b.completedAt.localeCompare(a.completedAt),
    )
  }

  protected archivedSnapshots(
    history: T.ServiceTargetHistory,
  ): T.ServiceSnapshot[] {
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
    await this.tasks.run(async () => {
      await action()
      await this.reload()
    }, 'Saving')
  }
}
