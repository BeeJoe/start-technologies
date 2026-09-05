import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import {
  FormControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms'
import { ActivatedRoute, Router, RouterLink } from '@angular/router'
import {
  convertBytes,
  DialogService,
  i18nPipe,
  TaskService,
} from '@start9labs/shared'
import { T } from '@start9labs/start-core'
import {
  TuiButton,
  TuiCheckbox,
  TuiError,
  TuiGroup,
  TuiIcon,
  TuiInput,
  TuiLoader,
  TuiNotification,
  TuiTitle,
} from '@taiga-ui/core'
import { TuiAccordion, TuiBlock, TuiSwitch } from '@taiga-ui/kit'
import { TuiCardLarge, TuiHeader } from '@taiga-ui/layout'
import { PatchDB } from 'patch-db-client'
import { firstValueFrom } from 'rxjs'

import { ApiService } from 'src/app/services/api/embassy-api.service'
import { DataModel } from 'src/app/services/patch-db/data-model'
import { TitleDirective } from 'src/app/services/title.service'
import {
  BackupService,
  formatCifsLocation,
} from '../system/routes/backups/backup.service'
import {
  BACKUP_RETENTION_INTERVALS,
  BackupRetentionInterval,
  BackupRetentionRuleValue,
  BackupRetentionTierEditor,
  BackupScheduleFormValue,
  BackupServiceSelection,
  formatBackupScheduleSummary,
  formatBackupServiceSummary,
  hasDuplicateRetentionRules,
  isValidBackupRetentionRules,
  isValidBackupSchedule,
  removeBackupRetentionRule,
  retentionPeriodLabel,
  scheduleNeedsMoreFrequentRuns,
  serializeBackupRetentionPolicy,
  serializeBackupSchedule,
  serializeBackupServiceSelection,
  SYSTEM_PACKAGE_ID,
} from '../system/routes/backups/scheduled-utils'
import { BackupRetentionRules } from '../system/routes/backups/retention-rules'
import { BackupScheduleControls } from '../system/routes/backups/schedule-controls'
import { BackupScheduleEditor } from '../system/routes/backups/schedule-editor'
import { ScheduledBackups } from '../system/routes/backups/scheduled'
import { BackupLocationPicker } from './location-picker'

interface ServiceChoice {
  id: string
  title: string
  icon: string
  selected: FormControl<boolean>
  system: boolean
}

interface AutomaticRetentionRule extends Pick<
  BackupRetentionTierEditor,
  'duration'
> {
  interval: BackupRetentionInterval
}

class AutomaticEditor
  extends BackupScheduleEditor
  implements BackupScheduleFormValue, Omit<BackupServiceSelection, 'packageIds'>
{
  services: ServiceChoice[] = []
  preservedSelectedPackageIds: string[] = []
  preservedExcludedPackageIds: string[] = []
  interval: BackupRetentionInterval = 'day'
  duration = 7
  additionalRules: AutomaticRetentionRule[] = []

  readonly form

  constructor(
    formBuilder: NonNullableFormBuilder,
    dayOfMonth: number,
    timezone: string,
  ) {
    super({
      frequency: 'daily',
      minute: 0,
      hour: 3,
      weekday: 0,
      dayOfMonth,
      timezone,
    })
    this.form = formBuilder.group({
      includeFuture: [true],
      keepAdditional: [false],
      password: ['', Validators.required],
      firstBackupNow: [true],
      capacityConfirmed: [false],
    })
  }

  get includeFuture() {
    return this.form.controls.includeFuture.value
  }
  set includeFuture(value: boolean) {
    this.form.controls.includeFuture.setValue(value)
  }

  get keepAdditional() {
    return this.form.controls.keepAdditional.value
  }
  set keepAdditional(value: boolean) {
    this.form.controls.keepAdditional.setValue(value)
  }

  get password() {
    return this.form.controls.password.value
  }
  set password(value: string) {
    this.form.controls.password.setValue(value)
  }

  get firstBackupNow() {
    return this.form.controls.firstBackupNow.value
  }
  set firstBackupNow(value: boolean) {
    this.form.controls.firstBackupNow.setValue(value)
  }

  get capacityConfirmed() {
    return this.form.controls.capacityConfirmed.value
  }
  set capacityConfirmed(value: boolean) {
    this.form.controls.capacityConfirmed.setValue(value)
  }

  toJSON() {
    return {
      ...this.scheduleValue(),
      services: this.services.map(service => ({
        id: service.id,
        selected: service.selected.value,
        system: service.system,
      })),
      preservedSelectedPackageIds: this.preservedSelectedPackageIds,
      preservedExcludedPackageIds: this.preservedExcludedPackageIds,
      interval: this.interval,
      duration: this.duration,
      additionalRules: this.additionalRules,
      ...this.form.getRawValue(),
    }
  }
}

@Component({
  selector: 'automatic-backups',
  template: `
    @if (!embedded()) {
      <ng-container *title>
        <a
          tuiIconButton
          appearance="flat-grayscale"
          iconStart="@tui.arrow-left"
          routerLink="/system/backups"
        >
          {{ 'Back' | i18n }}
        </a>
        {{
          (setupMode()
            ? 'Set up automatic backups'
            : 'Manage automatic backups'
          ) | i18n
        }}
      </ng-container>

      <header class="page-heading">
        <span tuiTitle>
          <h2>
            {{
              (setupMode()
                ? 'Set up automatic backups'
                : 'Manage automatic backups'
              ) | i18n
            }}
          </h2>
          <span tuiSubtitle>
            {{
              (setupMode()
                ? 'Choose where and when StartOS protects your services.'
                : 'Change your primary schedule or review backup history'
              ) | i18n
            }}
          </span>
        </span>
      </header>
    }

    @if (loading()) {
      <tui-loader [textContent]="'Loading' | i18n" />
    } @else if (setupMode() && jobs().length) {
      <div tuiNotification appearance="info">
        {{ 'Automatic backups are already set up.' | i18n }}
      </div>
    } @else if (setupMode()) {
      <nav class="steps" [attr.aria-label]="'Setup progress' | i18n">
        @for (item of setupSteps; track item.number) {
          <span [class._active]="step() === item.number">
            <b>{{ item.number }}</b>
            {{ item.label | i18n }}
          </span>
        }
      </nav>

      @if (step() === 1) {
        <section
          tuiCardLarge="compact"
          class="panel"
          [class._embedded-panel]="embedded()"
        >
          <header tuiHeader>
            <span tuiTitle>
              <b>{{ 'Choose a backup location' | i18n }}</b>
              <span tuiSubtitle>
                {{
                  'Unavailable locations stay visible so you can repair them.'
                    | i18n
                }}
              </span>
            </span>
          </header>

          <backup-location-picker
            mode="automatic"
            [selectedId]="targetId()"
            (selected)="targetId.set($event.id)"
            (manage)="manageLocations.emit()"
          />
        </section>
      }

      @if (step() === 2) {
        <section
          tuiCardLarge="compact"
          class="panel"
          [class._embedded-panel]="embedded()"
          [formGroup]="editor.form"
        >
          <header tuiHeader>
            <span tuiTitle>
              <b>{{ 'Schedule and services' | i18n }}</b>
              <span tuiSubtitle>
                {{ scheduleSummary() }}
              </span>
            </span>
          </header>

          <button
            tuiButton
            type="button"
            size="s"
            appearance="primary"
            (click)="showSchedule.set(!showSchedule())"
          >
            {{ (showSchedule() ? 'Hide schedule' : 'Change schedule') | i18n }}
          </button>

          @if (showSchedule()) {
            <backup-schedule-controls
              [schedule]="editor"
              (scheduleChange)="updateSchedule($event)"
            />
          }

          <tui-accordion class="g-wrap-accordion">
            <button
              [tuiAccordion]="showServices()"
              (tuiAccordionChange)="showServices.set(!!$event)"
            >
              <span tuiTitle>
                <b>{{ 'Services' | i18n }}</b>
                <span tuiSubtitle>
                  {{ selectedServiceSummary() }}
                </span>
              </span>
            </button>
            <tui-expand>
              <div class="services-options">
                <label class="checkbox-row include-future">
                  <input
                    tuiCheckbox
                    type="checkbox"
                    formControlName="includeFuture"
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
                <label class="checkbox-row toggle-all">
                  <input
                    tuiCheckbox
                    type="checkbox"
                    [formControl]="allServicesControl"
                    (change)="setAllServices(allServicesControl.value)"
                  />
                  <span tuiTitle>
                    <b>{{ 'Toggle all services' | i18n }}</b>
                  </span>
                </label>
                <div tuiGroup orientation="vertical" [collapsed]="true">
                  @for (service of editor.services; track service.id) {
                    <label tuiBlock="m">
                      <input
                        tuiCheckbox
                        type="checkbox"
                        [formControl]="service.selected"
                        (change)="syncAllServicesControl()"
                      />
                      @if (service.system) {
                        <tui-icon icon="@tui.settings" />
                      } @else {
                        <img alt="" [src]="service.icon" />
                      }
                      <span tuiTitle>
                        <b>{{ service.title }}</b>
                      </span>
                    </label>
                  }
                </div>
              </div>
            </tui-expand>
          </tui-accordion>

          <div class="setting-row retention-heading">
            <span tuiTitle>
              <b>{{ 'Version history' | i18n }}</b>
              <span tuiSubtitle>
                {{
                  (editor.keepAdditional
                    ? retentionSummary()
                    : 'Keep only the latest automatic checkpoint'
                  ) | i18n
                }}
              </span>
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
                formControlName="keepAdditional"
              />
            </label>
          </div>

          @if (editor.keepAdditional) {
            <backup-retention-rules
              [rules]="retentionRules()"
              (ruleChange)="updateRetentionRule($event.index, $event.value)"
              (addRequested)="addRetentionRule()"
              (removeRequested)="removeRetentionRule($event)"
            />
            @if (retentionHasDuplicates()) {
              <div tuiNotification appearance="negative">
                {{ 'Each version-history rule must be unique.' | i18n }}
              </div>
            }
            @if (retentionNeedsMoreFrequentRuns()) {
              <div tuiNotification appearance="warning">
                {{
                  'This schedule runs less often than the version-history interval, so some intervals may have no checkpoint.'
                    | i18n
                }}
              </div>
            }
          }
        </section>
      }

      @if (step() === 3) {
        <section
          tuiCardLarge="compact"
          class="panel review-panel"
          [class._embedded-panel]="embedded()"
          [formGroup]="editor.form"
        >
          <header tuiHeader>
            <span tuiTitle>
              <b>{{ 'Review automatic backups' | i18n }}</b>
              <span tuiSubtitle>
                {{ 'Confirm the setup with your master password.' | i18n }}
              </span>
            </span>
          </header>

          <dl>
            <div>
              <dt>{{ 'Backup location' | i18n }}</dt>
              <dd>{{ selectedTargetName() }}</dd>
            </div>
            <div>
              <dt>{{ 'Schedule' | i18n }}</dt>
              <dd>{{ scheduleSummary() }}</dd>
            </div>
            <div>
              <dt>{{ 'Services' | i18n }}</dt>
              <dd>{{ selectedServiceSummary() }}</dd>
            </div>
            <div>
              <dt>{{ 'Version history' | i18n }}</dt>
              <dd>
                {{
                  (editor.keepAdditional
                    ? retentionSummary()
                    : 'Latest automatic checkpoint only'
                  ) | i18n
                }}
              </dd>
            </div>
          </dl>

          @if (capacityNeeded() !== null) {
            <div tuiNotification [appearance]="capacityAppearance()">
              {{ capacitySummary() }}
              @if (capacityBlocked()) {
                <span class="block-helper">
                  {{ 'Choose a location with more free space.' | i18n }}
                </span>
              }
            </div>
          }

          @if (editor.keepAdditional) {
            <div tuiNotification appearance="warning">
              {{
                'Every retained version is a full copy. Each run also makes a full target-side staging copy. This can substantially increase storage use, runtime, and I/O, especially on network storage and slow external devices.'
                  | i18n
              }}
              <label class="check-row">
                <input
                  tuiCheckbox
                  type="checkbox"
                  formControlName="capacityConfirmed"
                />
                {{ 'I understand the full-copy storage impact' | i18n }}
              </label>
            </div>
          }

          <label class="checkbox-row first-backup">
            <input
              tuiCheckbox
              type="checkbox"
              formControlName="firstBackupNow"
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
              [type]="passwordMasked ? 'password' : 'text'"
              autocomplete="new-password"
              formControlName="password"
              (keyup.enter)="createAutomaticBackup()"
            />
            <button
              tuiIconButton
              type="button"
              size="xs"
              appearance="icon"
              [iconStart]="passwordMasked ? '@tui.eye' : '@tui.eye-off'"
              [attr.aria-label]="
                (passwordMasked ? 'Show password' : 'Hide password') | i18n
              "
              (click)="passwordMasked = !passwordMasked"
            >
              {{ (passwordMasked ? 'Show password' : 'Hide password') | i18n }}
            </button>
          </tui-textfield>
          <tui-error formControlName="password" />
        </section>
      }

      <footer class="wizard-actions">
        @if (step() > 1) {
          <button tuiButton appearance="flat-grayscale" (click)="previous()">
            {{ 'Back' | i18n }}
          </button>
        }
        <span></span>
        @if (step() < 3) {
          <button tuiButton (click)="next()">
            {{ 'Continue' | i18n }}
          </button>
        } @else {
          <button tuiButton (click)="createAutomaticBackup()">
            {{ 'Turn on automatic backups' | i18n }}
          </button>
        }
      </footer>
    } @else {
      @if (primary(); as job) {
        @if (!embedded()) {
          <section tuiCardLarge="compact" class="panel">
            <header tuiHeader>
              <span tuiTitle>
                <b>{{ 'Automatic backups' | i18n }}</b>
                <span tuiSubtitle>
                  {{
                    (job.enabled && !job.pause
                      ? 'Your primary schedule is on.'
                      : 'Automatic backups are off. Settings and checkpoints are kept.'
                    ) | i18n
                  }}
                </span>
              </span>
              <span tuiAccessories>
                <label class="inline-switch main-switch">
                  <input
                    tuiSwitch
                    type="checkbox"
                    [showIcons]="false"
                    [attr.aria-label]="'Automatic backups' | i18n"
                    [checked]="job.enabled && !job.pause"
                    (change)="toggleAllJobs($any($event.target).checked)"
                  />
                </label>
              </span>
            </header>
          </section>
        }
        @if (bulkScheduleControlVisible()) {
          <div class="bulk-schedule-control">
            <span class="bulk-schedule-summary">
              {{ activeJobCount() }} {{ 'active' | i18n }} ·
              {{ pausedJobCount() }} {{ 'paused' | i18n }}
            </span>
            <button
              tuiButton
              type="button"
              size="s"
              appearance="outline-grayscale"
              (click)="allJobsPaused() ? toggleAllJobs(true) : pauseAllJobs()"
            >
              {{ (allJobsPaused() ? 'Resume all' : 'Pause all') | i18n }}
            </button>
          </div>
        }
        <section
          scheduledBackups
          mode="manage"
          [createRequest]="createRequest()"
          [reviewPackageId]="reviewPackageId()"
          (createRequestHandled)="createRequestHandled.emit()"
          (collapseRequested)="collapseRequested.emit($event)"
        ></section>
      } @else {
        <div tuiNotification appearance="info">
          {{ 'Automatic backups are not set up yet.' | i18n }}
        </div>
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: 1rem;
      inline-size: 100%;
      min-inline-size: 0;
      max-inline-size: 64rem;
      margin-inline: auto;
      container-type: inline-size;
    }

    h2,
    p {
      margin: 0;
    }

    [tuiSubtitle],
    .helper,
    .block-helper {
      display: block;
      margin-block-start: 0.25rem;
    }

    [tuiTitle] {
      min-inline-size: 0;
      overflow-wrap: anywhere;
    }

    .steps,
    .wizard-actions,
    .save-row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }

    .steps {
      justify-content: center;
      color: var(--tui-text-secondary);
    }

    .steps span {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.5rem 0.75rem;
    }

    .steps b {
      display: grid;
      place-items: center;
      inline-size: 1.5rem;
      block-size: 1.5rem;
      border-radius: 50%;
      background: var(--tui-background-neutral-1);
    }

    .steps ._active {
      color: var(--tui-text-primary);
    }

    .steps ._active b {
      background: var(--tui-background-accent-1);
      color: var(--tui-text-primary-on-accent-1);
    }

    .panel {
      display: grid;
      gap: 1rem;
      inline-size: 100%;
      min-inline-size: 0;
      padding: 1.25rem;
      box-sizing: border-box;
    }

    .setting-row,
    .checkbox-row,
    .inline-switch {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }

    .setting-row {
      inline-size: 100%;
      min-inline-size: 0;
    }

    .services-options {
      display: grid;
      gap: 1rem;
    }

    label > span:first-child,
    .helper {
      color: var(--tui-text-secondary);
    }

    [tuiGroup] {
      inline-size: 100%;
    }

    [tuiBlock] img {
      inline-size: 2.5rem;
      border-radius: 50%;
    }

    [tuiBlock] [tuiTitle] {
      flex: 1;
    }

    [tuiBlock],
    [tuiBlock] [tuiTitle] {
      justify-content: flex-start;
      text-align: start;
    }

    .inline-switch {
      justify-content: flex-end;
    }

    .inline-switch.left {
      justify-content: flex-start;
    }

    .main-switch,
    .toggle-all {
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

    .include-future [tuiTitle] {
      flex: 1;
    }

    .include-future [tuiSubtitle] {
      color: inherit;
    }

    .first-backup {
      justify-content: flex-start;
    }

    .setting-row.vertical {
      align-items: stretch;
      flex-direction: column;
    }

    dl {
      display: grid;
      gap: 0.75rem;
      margin: 0;
    }

    dl div {
      display: grid;
      grid-template-columns: minmax(10rem, 1fr) 2fr;
      gap: 1rem;
    }

    dt {
      color: var(--tui-text-secondary);
    }

    dd {
      margin: 0;
      font-weight: bold;
    }

    .wizard-actions span {
      flex: 1;
    }

    .advanced-link {
      inline-size: 100%;
      min-inline-size: 0;
      text-align: start;
      gap: 0.75rem;
      box-sizing: border-box;
    }

    .advanced-link [tuiTitle] {
      flex: 1;
    }

    ._embedded-panel {
      padding: 0;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      background: transparent;
    }

    .bulk-schedule-control {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      min-inline-size: 0;
      padding-block-end: 1rem;
      border-block-end: 1px solid var(--tui-border-normal);
    }

    .bulk-schedule-control > button {
      flex: 0 0 auto;
    }

    .bulk-schedule-summary {
      min-inline-size: 0;
      color: var(--tui-text-secondary);
      overflow-wrap: anywhere;
    }

    .save-row {
      justify-content: flex-end;
    }

    @container (max-inline-size: 48rem) {
      .steps span {
        font-size: 0;
      }

      .steps b {
        font-size: initial;
      }

      dl div {
        grid-template-columns: 1fr;
        gap: 0.2rem;
      }
    }

    @container (max-inline-size: 30rem) {
      [tuiBlock] img {
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

      .setting-row:not(.vertical),
      .advanced-link {
        align-items: stretch;
        flex-direction: column;
      }

      .setting-row:not(.vertical) > button,
      .advanced-link > tui-icon,
      .advanced-link > [tuiBadge] {
        align-self: flex-start;
      }

      .inline-switch {
        inline-size: fit-content;
        justify-content: flex-start;
      }

      .setting-row.retention-heading:not(.vertical) {
        align-items: flex-start;
        flex-direction: row;
      }

      .retention-heading > [tuiTitle] {
        flex: 1;
        min-inline-size: 0;
      }

      .retention-heading .inline-switch {
        flex: 0 0 auto;
      }

      .retention-heading .retention-toggle-label {
        display: none;
      }

      .wizard-actions {
        flex-wrap: wrap;
      }
    }
  `,
  host: { class: 'g-wrap-content' },
  imports: [
    ReactiveFormsModule,
    RouterLink,
    TuiAccordion,
    TuiBlock,
    TuiButton,
    TuiCardLarge,
    TuiCheckbox,
    TuiError,
    TuiGroup,
    TuiHeader,
    TuiIcon,
    TuiInput,
    TuiLoader,
    TuiNotification,
    TuiSwitch,
    TuiTitle,
    TitleDirective,
    ScheduledBackups,
    BackupRetentionRules,
    BackupScheduleControls,
    BackupLocationPicker,
    i18nPipe,
  ],
})
export default class AutomaticBackups {
  private readonly formBuilder = inject(NonNullableFormBuilder)
  private readonly api = inject(ApiService)
  private readonly backupService = inject(BackupService)
  private readonly tasks = inject(TaskService)
  private readonly dialogs = inject(DialogService)
  private readonly i18n = inject(i18nPipe)
  private readonly router = inject(Router)
  private readonly patch = inject<PatchDB<DataModel>>(PatchDB)
  private readonly packageData = toSignal(this.patch.watch$('packageData'))
  private readonly state = toSignal(this.patch.watch$('scheduledBackups'))
  private readonly scheduled = viewChild(ScheduledBackups)

  readonly mode = input<'setup' | 'manage'>()
  readonly embedded = input(false)
  readonly createRequest = input(false)
  readonly reviewPackageId = input('')
  readonly manageLocations = output<void>()
  readonly createRequestHandled = output<void>()
  readonly collapseRequested = output<string | null>()
  private readonly route = inject(ActivatedRoute)
  protected readonly setupMode = computed(
    () =>
      (this.mode() || this.route.snapshot.data['mode']) === ('setup' as const),
  )
  protected readonly loading = signal(true)
  protected readonly step = signal(1)
  protected readonly targetId = signal('')
  protected readonly showSchedule = signal(false)
  protected readonly showServices = signal(false)

  protected readonly setupSteps = [
    { number: 1, label: 'Location' as const },
    { number: 2, label: 'Schedule and services' as const },
    { number: 3, label: 'Review' as const },
  ]

  protected readonly jobs = computed(() =>
    Object.values(this.state()?.jobs || {}).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    ),
  )
  protected readonly activeJobCount = computed(
    () => this.jobs().filter(job => job.enabled && !job.pause).length,
  )
  protected readonly pausedJobCount = computed(
    () => this.jobs().length - this.activeJobCount(),
  )
  protected readonly bulkScheduleControlVisible = computed(
    () =>
      this.embedded() &&
      this.jobs().length > 1 &&
      !this.scheduled()?.isEditorOpen(),
  )
  protected readonly allJobsPaused = computed(
    () => this.jobs().length > 0 && this.activeJobCount() === 0,
  )
  protected readonly primary = computed(() => this.jobs()[0])
  protected readonly targets = computed(() => [
    ...this.backupService.cifs().map(target => ({
      id: target.id,
      name: target.entry.path.split('/').pop() || target.entry.path,
      detail: formatCifsLocation(target.entry),
      icon: '@tui.network',
      available: target.entry.mountable,
      capacity: null as number | null,
      used: null as number | null,
    })),
    ...this.backupService.drives().map(target => ({
      id: target.id,
      name:
        [target.entry.vendor, target.entry.model].filter(Boolean).join(' ') ||
        target.entry.logicalname,
      detail: `${target.entry.logicalname} · ${convertBytes(target.entry.capacity)}`,
      icon: '@tui.hard-drive',
      available: target.entry.capacity > 0,
      capacity: target.entry.capacity,
      used: target.entry.used,
    })),
  ])

  protected editor: AutomaticEditor = this.defaultEditor()
  protected readonly allServicesControl = this.formBuilder.control(true)
  protected passwordMasked = true
  private setupBaseline = ''
  protected readonly estimates = signal<T.BackupServiceCapacityEstimate[]>([])

  constructor() {
    void this.initialize()
  }

  private async initialize() {
    await this.backupService.getBackupTargets()
    this.targetId.set(this.targets().find(target => target.available)?.id || '')
    this.setupBaseline = this.setupSnapshot()
    this.loading.set(false)
  }

  async confirmDiscardChanges(): Promise<boolean> {
    if (!this.setupMode()) {
      return (await this.scheduled()?.confirmDiscardChanges()) ?? true
    }
    if (!this.setupBaseline || this.setupSnapshot() === this.setupBaseline) {
      return true
    }
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
    if (confirmed) this.setupBaseline = this.setupSnapshot()
    return confirmed
  }

  private setupSnapshot(): string {
    return JSON.stringify({ targetId: this.targetId(), editor: this.editor })
  }

  private defaultEditor(): AutomaticEditor {
    const now = new Date()
    return new AutomaticEditor(
      this.formBuilder,
      now.getDate(),
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    )
  }

  private serviceChoices(selected?: Set<string>): ServiceChoice[] {
    return [
      {
        id: SYSTEM_PACKAGE_ID,
        title: this.i18n.transform('System'),
        icon: '',
        selected: this.formBuilder.control(true),
        system: true,
      },
      ...Object.entries(this.packageData() || {})
        .flatMap(([id, entry]) => {
          const state = entry.stateInfo
          const manifest =
            state.state === 'installed' || state.state === 'removing'
              ? state.manifest
              : state.installingInfo?.newManifest
          return manifest
            ? [
                {
                  id,
                  title: manifest.title,
                  icon: entry.icon,
                  selected: this.formBuilder.control(
                    selected ? selected.has(id) : true,
                  ),
                  system: false,
                },
              ]
            : []
        })
        .sort((a, b) => a.title.localeCompare(b.title)),
    ]
  }

  private ensureServices() {
    if (!this.editor.services.length) {
      this.editor.services = this.serviceChoices()
      this.syncAllServicesControl()
    }
  }

  protected canContinue(): boolean {
    if (this.step() === 1) return !!this.targetId()
    if (this.step() === 2) {
      this.ensureServices()
      return (
        isValidBackupSchedule(this.editor) &&
        this.validRetention() &&
        this.editor.services.some(service => service.selected.value)
      )
    }
    return true
  }

  protected canSaveSetup(): boolean {
    return (
      !!this.editor.password &&
      isValidBackupSchedule(this.editor) &&
      this.validRetention() &&
      !this.capacityBlocked() &&
      (!this.editor.keepAdditional || this.editor.capacityConfirmed) &&
      this.editor.services.some(service => service.selected.value)
    )
  }

  protected async next() {
    if (!this.canContinue()) return
    if (this.step() === 1) this.ensureServices()
    if (this.step() === 2) {
      if (!(await this.validateSetup())) return
      await this.refreshCapacity()
    }
    this.step.update(step => Math.min(3, step + 1))
  }

  protected previous() {
    if (this.step() === 3) this.editor.capacityConfirmed = false
    this.step.update(step => Math.max(1, step - 1))
  }

  protected setAllServices(checked: boolean) {
    this.ensureServices()
    this.editor.services
      .filter(service => !service.system)
      .forEach(service => service.selected.setValue(checked))
    this.allServicesControl.setValue(checked, { emitEvent: false })
  }

  protected syncAllServicesControl() {
    const services = this.editor.services.filter(service => !service.system)
    this.allServicesControl.setValue(
      services.length > 0 && services.every(service => service.selected.value),
      { emitEvent: false },
    )
  }

  protected scheduleSummary(): string {
    return formatBackupScheduleSummary(this.editor, label =>
      this.i18n.transform(label),
    )
  }

  protected updateSchedule(schedule: BackupScheduleFormValue) {
    Object.assign(this.editor, schedule)
  }

  protected retentionSummary(): string {
    const every = this.i18n.transform('Keep one backup every')
    const forLabel = this.i18n.transform('for')
    return this.retentionRules()
      .map(rule => {
        const interval = this.i18n.transform(rule.interval)
        const period = this.i18n.transform(this.retentionPeriod(rule))
        return `${every} ${interval} ${forLabel} ${rule.duration} ${period}`
      })
      .join(', ')
  }

  protected retentionPeriod(rule: AutomaticRetentionRule) {
    return retentionPeriodLabel(rule.interval, rule.duration)
  }

  protected retentionRules(): AutomaticRetentionRule[] {
    return [this.editor, ...this.editor.additionalRules]
  }

  protected newRetentionRule(): AutomaticRetentionRule {
    return { interval: 'day', duration: 7 }
  }

  protected updateRetentionRule(
    index: number,
    value: BackupRetentionRuleValue,
  ) {
    const rule = this.retentionRules()[index]
    if (!rule) return
    Object.assign(rule, value)
    this.editor.capacityConfirmed = false
  }

  protected addRetentionRule() {
    this.editor.additionalRules.push(this.newRetentionRule())
    this.editor.capacityConfirmed = false
  }

  protected removeRetentionRule(index: number) {
    const result = removeBackupRetentionRule(
      { interval: this.editor.interval, duration: this.editor.duration },
      this.editor.additionalRules,
      index,
      this.newRetentionRule(),
    )
    Object.assign(this.editor, result.primary)
    this.editor.additionalRules = result.additional
    this.editor.keepAdditional = result.keepAdditional
    this.editor.capacityConfirmed = false
  }

  private validRetention(): boolean {
    if (!this.editor.keepAdditional) return true
    return isValidBackupRetentionRules(this.retentionRules())
  }

  protected retentionHasDuplicates(): boolean {
    return hasDuplicateRetentionRules(this.retentionRules())
  }

  protected retentionNeedsMoreFrequentRuns(): boolean {
    return scheduleNeedsMoreFrequentRuns(this.editor.frequency, [this.policy()])
  }

  protected selectedServiceSummary(): string {
    const services = this.editor.services.filter(service => !service.system)
    return formatBackupServiceSummary(
      services.filter(service => service.selected.value).length,
      services.length,
      this.editor.includeFuture,
      this.editor.services.some(
        service => service.system && service.selected.value,
      ),
      label => this.i18n.transform(label),
    )
  }

  protected selectedTargetName(): string {
    return (
      this.targets().find(target => target.id === this.targetId())?.name || '—'
    )
  }

  private serviceScope(): T.BackupServiceScope {
    return serializeBackupServiceSelection(
      {
        packageIds: this.editor.services
          .filter(service => service.selected.value)
          .map(service => service.id),
        includeFuture: this.editor.includeFuture,
        preservedSelectedPackageIds: this.editor.preservedSelectedPackageIds,
        preservedExcludedPackageIds: this.editor.preservedExcludedPackageIds,
      },
      this.editor.services.map(service => service.id),
    )
  }

  private policy(): T.RetentionPolicy {
    if (!this.editor.keepAdditional) return { tiers: [] }
    return serializeBackupRetentionPolicy(this.retentionRules())
  }

  protected async refreshCapacity() {
    this.estimates.set([])
    await this.tasks.run(async () => {
      this.estimates.set(
        await this.api.estimateScheduledBackupCapacity({
          targetId: this.targetId(),
          services: this.serviceScope(),
          defaultRetention: this.policy(),
          retentionOverrides: {},
        }),
      )
    }, 'Loading')
  }

  protected capacityNeeded(): number | null {
    if (!this.estimates().length) return null
    return this.estimates().reduce(
      (sum, item) => sum + item.conservativePeakExcludingManualBytes,
      0,
    )
  }

  protected capacityAvailable(): number | null {
    const target = this.targets().find(item => item.id === this.targetId())
    return target?.capacity != null && target.used != null
      ? Math.max(0, target.capacity - target.used)
      : null
  }

  protected capacityBlocked(): boolean {
    const needed = this.capacityNeeded()
    const available = this.capacityAvailable()
    return needed !== null && available !== null && needed > available
  }

  protected capacityAppearance(): 'info' | 'negative' {
    return this.capacityBlocked() ? 'negative' : 'info'
  }

  protected capacitySummary(): string {
    const needed = this.capacityNeeded()
    if (needed === null) return ''
    const available = this.capacityAvailable()
    const summary = `${this.i18n.transform('About')} ${convertBytes(needed)} ${this.i18n.transform('needed')}`
    return available === null
      ? `${summary}.`
      : `${summary}; ${convertBytes(available)} ${this.i18n.transform('available')}.`
  }

  protected async createAutomaticBackup() {
    this.editor.form.markAllAsTouched()
    if (!this.canSaveSetup()) return
    if (!(await this.validateSetup())) return
    await this.tasks.run(async () => {
      const created = await this.api.createScheduledBackupJob({
        name: 'Default',
        targetId: this.targetId(),
        services: this.serviceScope(),
        schedule: serializeBackupSchedule(this.editor),
        defaultRetention: this.policy(),
        retentionOverrides: {},
        password: this.editor.password,
        enabled: true,
        runNow: this.editor.firstBackupNow,
      })
      this.backupService.showQueuedNotification(created)
      this.setupBaseline = this.setupSnapshot()
      if (this.embedded()) this.collapseRequested.emit(null)
      const packageId = this.reviewPackageId()
      if (packageId) {
        const [jobs, reviews] = await Promise.all([
          this.api.getScheduledBackupJobs({}),
          this.api.getNewServiceBackupReviews({}),
        ])
        const review = reviews.find(item => item.packageId === packageId)
        if (review) {
          await this.api.resolveNewServiceBackupReview({
            packageId,
            decisions: Object.fromEntries(
              jobs.map(job => [job.id, job.id === created.id]),
            ),
          })
        }
      }
      if (!this.embedded()) {
        await this.router.navigate(['/system/backups'])
      }
    }, 'Creating backup schedule')
  }

  private async validateSetup(): Promise<boolean> {
    return this.tasks.run(
      () =>
        this.api.validateScheduledBackupJob({
          id: null,
          targetId: this.targetId(),
          services: this.serviceScope(),
          schedule: serializeBackupSchedule(this.editor),
          defaultRetention: this.policy(),
          retentionOverrides: {},
          enabled: true,
        }),
      'Validating',
    )
  }

  protected async toggleAllJobs(enabled: boolean) {
    await this.tasks.run(
      async () => {
        await this.api.setScheduledBackupJobsEnabled({
          ids: this.jobs().map(job => job.id),
          enabled,
        })
        await this.scheduled()?.reload()
      },
      enabled ? 'Enabling backup schedules' : 'Pausing backup schedules',
    )
  }

  protected async pauseAllJobs() {
    const confirmed = await firstValueFrom(
      this.dialogs.openConfirm({
        label: 'Pause all automatic backups?',
        size: 's',
        data: {
          content:
            'All schedules will stop running. Existing checkpoints and schedule settings will be kept.',
          yes: 'Pause all',
          no: 'Cancel',
        },
      }),
      { defaultValue: false },
    )
    if (confirmed) await this.toggleAllJobs(false)
  }
}
