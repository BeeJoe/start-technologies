import {
  Component,
  computed,
  inject,
  input,
  OnInit,
  output,
  signal,
} from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { ActivatedRoute, Router, RouterLink } from '@angular/router'
import { ErrorService, getErrorMessage, i18nPipe } from '@start9labs/shared'
import { T } from '@start9labs/start-core'
import {
  TuiButton,
  TuiCheckbox,
  TuiDataList,
  TuiGroup,
  TuiIcon,
  TuiInput,
  TuiNotification,
  TuiTitle,
} from '@taiga-ui/core'
import {
  TuiAccordion,
  TuiBlock,
  TuiChevron,
  TuiInputNumber,
  TuiPassword,
  TuiSelect,
  TuiSwitch,
} from '@taiga-ui/kit'
import { PatchDB } from 'patch-db-client'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { DataModel } from 'src/app/services/patch-db/data-model'
import { TitleDirective } from 'src/app/services/title.service'
import {
  BackupService,
  formatCifsLocation,
} from '../system/routes/backups/backup.service'
import {
  BackupRetentionInterval,
  BackupScheduleFrequency,
  BACKUP_HOURS,
  BACKUP_MINUTES,
  BACKUP_MONTH_DAYS,
  formatBackupTime,
  retentionIntervalSeconds,
  retentionPeriodLabel,
  serializeBackupServiceSelection,
  serializeBackupSchedule,
} from '../system/routes/backups/scheduled.utils'
import { ScheduledBackupsComponent } from '../system/routes/backups/scheduled.component'
import { BackupLocationPickerComponent } from './location-picker.component'

interface ServiceChoice {
  id: string
  title: string
  icon: string
  checked: boolean
}

interface AutomaticEditor {
  frequency: BackupScheduleFrequency
  minute: number
  hour: number
  weekday: number
  dayOfMonth: number
  timezone: string
  services: ServiceChoice[]
  includeFuture: boolean
  preservedSelectedPackageIds: string[]
  preservedExcludedPackageIds: string[]
  keepAdditional: boolean
  interval: BackupRetentionInterval
  duration: number
  additionalRules: AutomaticRetentionRule[]
  password: string
  firstBackupNow: boolean
}

interface AutomaticRetentionRule {
  interval: BackupRetentionInterval
  duration: number
}

@Component({
  selector: 'automatic-backups',
  template: `
    @if (!embedded()) {
      <ng-container *title>
        <a
          routerLink="/system/backups"
          tuiIconButton
          appearance="flat-grayscale"
          iconStart="@tui.arrow-left"
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
      <div class="loading">{{ 'Loading' | i18n }}…</div>
    } @else if (setupMode() && jobs().length) {
      <div tuiNotification appearance="info">
        {{ 'Automatic backups are already set up.' | i18n }}
      </div>
    } @else if (setupMode()) {
      <nav class="steps" [attr.aria-label]="'Setup progress' | i18n">
        @for (item of setupSteps; track item.number) {
          <span [class.active]="step() === item.number">
            <b>{{ item.number }}</b>
            {{ item.label | i18n }}
          </span>
        }
      </nav>

      @if (step() === 1) {
        <section
          class="panel"
          [class.g-card]="!embedded()"
          [class.embedded-panel]="embedded()"
        >
          <header>
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
          class="panel"
          [class.g-card]="!embedded()"
          [class.embedded-panel]="embedded()"
        >
          <header>
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
            <div class="schedule-controls">
              <label>
                <span>{{ 'Frequency' | i18n }}</span>
                <select
                  name="frequency"
                  required
                  [(ngModel)]="editor.frequency"
                >
                  <option value="hourly">{{ 'Hourly' | i18n }}</option>
                  <option value="daily">{{ 'Daily' | i18n }}</option>
                  <option value="weekly">{{ 'Weekly' | i18n }}</option>
                  <option value="monthly">{{ 'Monthly' | i18n }}</option>
                </select>
              </label>
              @if (editor.frequency === 'weekly') {
                <label>
                  <span>{{ 'Day of week' | i18n }}</span>
                  <select [(ngModel)]="editor.weekday">
                    @for (day of weekdays; track day.value) {
                      <option [ngValue]="day.value">
                        {{ day.label | i18n }}
                      </option>
                    }
                  </select>
                </label>
              }
              @if (editor.frequency === 'monthly') {
                <tui-textfield tuiChevron [tuiTextfieldCleaner]="false">
                  <label tuiLabel>{{ 'Day of month' | i18n }}</label>
                  <input
                    tuiSelect
                    name="dayOfMonth"
                    required
                    [(ngModel)]="editor.dayOfMonth"
                  />
                  <tui-data-list *tuiDropdown>
                    @for (day of monthDays; track day) {
                      <button tuiOption [value]="day">{{ day }}</button>
                    }
                  </tui-data-list>
                </tui-textfield>
              }
              @if (editor.frequency !== 'hourly') {
                <tui-textfield
                  tuiChevron
                  [stringify]="stringifyTime"
                  [tuiTextfieldCleaner]="false"
                >
                  <label tuiLabel>{{ 'Hour' | i18n }}</label>
                  <input tuiSelect [(ngModel)]="editor.hour" />
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
                <input tuiSelect [(ngModel)]="editor.minute" />
                <tui-data-list *tuiDropdown>
                  @for (minute of minutes; track minute) {
                    <button tuiOption [value]="minute">
                      {{ stringifyTime(minute) }}
                    </button>
                  }
                </tui-data-list>
              </tui-textfield>
            </div>
          }

          <tui-accordion class="services-accordion">
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
                    [(ngModel)]="editor.includeFuture"
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
                    [ngModel]="allServicesSelected()"
                    (ngModelChange)="setAllServices($event)"
                  />
                  <span tuiTitle>
                    <b>{{ 'Toggle all' | i18n }}</b>
                  </span>
                </label>
                <div tuiGroup orientation="vertical" [collapsed]="true">
                  @for (service of editor.services; track service.id) {
                    <label tuiBlock="m">
                      <input
                        tuiCheckbox
                        type="checkbox"
                        [(ngModel)]="service.checked"
                      />
                      <img alt="" [src]="service.icon" />
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
                [(ngModel)]="editor.keepAdditional"
              />
            </label>
          </div>

          @if (editor.keepAdditional) {
            <div class="retention-rules">
              @for (rule of retentionRules(); track $index) {
                <div class="retention-rule">
                  <span>{{ 'Keep one backup every' | i18n }}</span>
                  <select
                    [name]="'retention-frequency-' + $index"
                    required
                    [(ngModel)]="rule.interval"
                  >
                    <option value="hour">{{ 'Hour' | i18n }}</option>
                    <option value="day">{{ 'Day' | i18n }}</option>
                    <option value="week">{{ 'Week' | i18n }}</option>
                    <option value="month">{{ 'Month' | i18n }}</option>
                  </select>
                  <span>{{ 'for' | i18n }}</span>
                  <tui-textfield class="duration-field">
                    <label tuiLabel>{{ 'Duration' | i18n }}</label>
                    <input
                      tuiInputNumber
                      [min]="1"
                      [max]="365"
                      [(ngModel)]="rule.duration"
                    />
                  </tui-textfield>
                  <span>{{ retentionPeriod(rule) | i18n }}</span>
                  <button
                    tuiButton
                    type="button"
                    size="xs"
                    appearance="flat-destructive"
                    (click)="removeRetentionRule($index)"
                  >
                    {{ 'Remove' | i18n }}
                  </button>
                </div>
              }
              <button
                tuiIconButton
                type="button"
                class="add-retention-rule"
                size="s"
                appearance="primary"
                iconStart="@tui.plus"
                [attr.aria-label]="'Add' | i18n"
                (click)="editor.additionalRules.push(newRetentionRule())"
              >
                {{ 'Add' | i18n }}
              </button>
            </div>
            <div tuiNotification appearance="warning">
              {{
                'Every retained version is a full copy and each run also needs temporary staging space.'
                  | i18n
              }}
            </div>
          }
        </section>
      }

      @if (step() === 3) {
        <section
          class="panel review-panel"
          [class.g-card]="!embedded()"
          [class.embedded-panel]="embedded()"
        >
          <header>
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
              {{ 'About' | i18n }} {{ bytes(capacityNeeded()!) }}
              {{ 'needed' | i18n }}; {{ capacityAvailableLabel() }}
              {{ 'available' | i18n }}.
              @if (capacityBlocked()) {
                <span class="block-helper">
                  {{ 'Choose a location with more free space.' | i18n }}
                </span>
              }
            </div>
          }

          <label class="checkbox-row first-backup">
            <input
              tuiCheckbox
              type="checkbox"
              [(ngModel)]="editor.firstBackupNow"
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
              autocomplete="off"
              [(ngModel)]="editor.password"
              (keyup.enter)="createAutomaticBackup()"
            />
            <tui-icon tuiPassword />
          </tui-textfield>
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
          <button tuiButton [disabled]="!canContinue()" (click)="next()">
            {{ 'Continue' | i18n }}
          </button>
        } @else {
          <button
            tuiButton
            [disabled]="!canSaveSetup() || saving()"
            (click)="createAutomaticBackup()"
          >
            {{ 'Turn on automatic backups' | i18n }}
          </button>
        }
      </footer>
    } @else {
      @if (primary(); as job) {
        @if (!embedded()) {
          <section class="panel g-card">
            <header>
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
              <label class="inline-switch main-switch">
                <input
                  tuiSwitch
                  type="checkbox"
                  [showIcons]="false"
                  [attr.aria-label]="'Automatic backups' | i18n"
                  [ngModel]="job.enabled && !job.pause"
                  (ngModelChange)="toggleMain($event)"
                />
              </label>
            </header>
          </section>
        }
        <section
          scheduledBackups
          mode="manage"
          [createRequest]="createRequest()"
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
      width: 100%;
      min-width: 0;
      max-width: 64rem;
      margin-inline: auto;
    }

    h2,
    p {
      margin: 0;
    }

    [tuiSubtitle],
    .helper,
    .block-helper {
      display: block;
      margin-top: 0.25rem;
    }

    [tuiTitle],
    .schedule-controls > * {
      min-width: 0;
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
      width: 1.5rem;
      height: 1.5rem;
      border-radius: 50%;
      background: var(--tui-background-neutral-1);
    }

    .steps .active {
      color: var(--tui-text-primary);
    }

    .steps .active b {
      background: var(--tui-background-accent-1);
      color: var(--tui-text-primary-on-accent-1);
    }

    .panel {
      display: grid;
      gap: 1rem;
      width: 100%;
      min-width: 0;
      padding: 1.25rem;
      box-sizing: border-box;
    }

    .panel > header {
      position: static;
      inset: auto;
      height: auto;
      padding: 0;
      background: transparent;
      font: inherit;
      font-weight: inherit;
    }

    .panel > header,
    .setting-row,
    .checkbox-row,
    .inline-switch {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }

    .setting-row {
      width: 100%;
      min-width: 0;
    }

    .services-options {
      display: grid;
      gap: 1rem;
    }

    .services-accordion,
    .services-accordion > button,
    .services-accordion > button [tuiTitle] {
      width: 100%;
      min-width: 0;
    }

    .services-accordion > button {
      height: auto;
      min-height: 3.5rem;
      white-space: normal;
    }

    .services-accordion > button [tuiSubtitle] {
      display: block;
      white-space: normal;
      overflow: visible;
    }

    .schedule-controls {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
      gap: 0.75rem;
      align-items: end;
      width: 100%;
      min-width: 0;
    }

    .schedule-controls select,
    .schedule-controls tui-textfield {
      width: 100%;
    }

    label > span:first-child,
    .helper {
      color: var(--tui-text-secondary);
    }

    .retention-rule input {
      width: 100%;
      min-height: 3.5rem;
      padding: 0 1rem;
      color: var(--tui-text-primary);
      background-color: var(--tui-background-neutral-1);
      border: 0;
      border-radius: var(--tui-radius-m);
      box-shadow: inset 0 0 0 1px var(--tui-border-normal);
      font: var(--tui-typography-body-l);
      box-sizing: border-box;
    }

    [tuiGroup] {
      width: 100%;
    }

    [tuiBlock] img {
      width: 2.5rem;
      border-radius: 50%;
    }

    [tuiBlock] [tuiTitle] {
      flex: 1;
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
      justify-items: stretch;
      gap: 0.75rem;
      width: 100%;
      min-width: 0;
    }

    .add-retention-rule {
      justify-self: end;
    }

    .duration-field {
      min-width: 10rem;
    }

    .inline-switch {
      justify-content: flex-end;
    }

    .inline-switch.left {
      justify-content: flex-start;
    }

    .main-switch,
    .toggle-all {
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
      width: 100%;
      min-width: 0;
      text-align: left;
      gap: 0.75rem;
      box-sizing: border-box;
    }

    .advanced-link [tuiTitle] {
      flex: 1;
    }

    .embedded-panel {
      padding: 0;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      background: transparent;
    }

    .save-row {
      justify-content: flex-end;
    }

    @media (max-width: 48rem) {
      .steps span {
        font-size: 0;
      }

      .steps b {
        font-size: initial;
      }

      .schedule-controls {
        grid-template-columns: 1fr 1fr;
      }

      .retention-rule {
        grid-template-columns: 1fr;
      }

      dl div {
        grid-template-columns: 1fr;
        gap: 0.2rem;
      }
    }

    @media (max-width: 30rem) {
      .panel > header,
      .setting-row:not(.vertical),
      .advanced-link {
        align-items: stretch;
        flex-direction: column;
      }

      .panel > header > :last-child,
      .setting-row:not(.vertical) > button,
      .advanced-link > tui-icon,
      .advanced-link > [tuiBadge] {
        align-self: flex-start;
      }

      .inline-switch {
        width: fit-content;
        justify-content: flex-start;
      }

      .setting-row.retention-heading:not(.vertical) {
        align-items: flex-start;
        flex-direction: row;
      }

      .retention-heading > [tuiTitle] {
        flex: 1;
        min-width: 0;
      }

      .retention-heading .inline-switch {
        flex: 0 0 auto;
      }

      .retention-heading .retention-toggle-label {
        display: none;
      }

      .schedule-controls {
        grid-template-columns: 1fr;
      }

      .wizard-actions {
        flex-wrap: wrap;
      }
    }
  `,
  host: { class: 'backup-page' },
  imports: [
    FormsModule,
    RouterLink,
    TuiAccordion,
    TuiBlock,
    TuiButton,
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
    TitleDirective,
    ScheduledBackupsComponent,
    BackupLocationPickerComponent,
    i18nPipe,
  ],
})
export default class AutomaticBackupsComponent implements OnInit {
  private readonly api = inject(ApiService)
  private readonly backupService = inject(BackupService)
  private readonly errors = inject(ErrorService)
  private readonly i18n = inject(i18nPipe)
  private readonly router = inject(Router)
  private readonly patch = inject<PatchDB<DataModel>>(PatchDB)
  private readonly packageData = toSignal(this.patch.watch$('packageData'))
  private readonly state = toSignal(this.patch.watch$('scheduledBackups'))

  readonly mode = input<'setup' | 'manage'>()
  readonly embedded = input(false)
  readonly createRequest = input(0)
  readonly manageLocations = output<void>()
  private readonly route = inject(ActivatedRoute)
  readonly setupMode = computed(
    () =>
      (this.mode() || this.route.snapshot.data['mode']) === ('setup' as const),
  )
  readonly loading = signal(true)
  readonly saving = signal(false)
  readonly step = signal(1)
  readonly targetId = signal('')
  readonly showSchedule = signal(false)
  readonly showServices = signal(false)

  readonly setupSteps = [
    { number: 1, label: 'Location' as const },
    { number: 2, label: 'Schedule and services' as const },
    { number: 3, label: 'Review' as const },
  ]

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

  readonly jobs = computed(() =>
    Object.values(this.state()?.jobs || {}).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    ),
  )
  readonly primary = computed(() => this.jobs()[0])
  readonly targets = computed(() => [
    ...this.backupService.cifs().map(target => ({
      id: target.id,
      name: target.entry.path.split('/').pop() || target.entry.path,
      detail: formatCifsLocation(target.entry),
      icon: '@tui.folder-network',
      available: target.entry.mountable,
      capacity: null as number | null,
      used: null as number | null,
    })),
    ...this.backupService.drives().map(target => ({
      id: target.id,
      name:
        [target.entry.vendor, target.entry.model].filter(Boolean).join(' ') ||
        target.entry.logicalname,
      detail: `${target.entry.logicalname} · ${this.bytes(target.entry.capacity)}`,
      icon: '@tui.hard-drive',
      available: target.entry.capacity > 0,
      capacity: target.entry.capacity,
      used: target.entry.used,
    })),
  ])

  editor: AutomaticEditor = this.defaultEditor()
  readonly estimates = signal<T.BackupServiceCapacityEstimate[]>([])

  async ngOnInit() {
    await this.backupService.getBackupTargets()
    this.targetId.set(this.targets().find(target => target.available)?.id || '')
    this.loading.set(false)
  }

  private defaultEditor(): AutomaticEditor {
    const now = new Date()
    return {
      frequency: 'daily',
      minute: 0,
      hour: 3,
      weekday: 0,
      dayOfMonth: now.getDate(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      services: [],
      includeFuture: true,
      preservedSelectedPackageIds: [],
      preservedExcludedPackageIds: [],
      keepAdditional: false,
      interval: 'day',
      duration: 7,
      additionalRules: [],
      password: '',
      firstBackupNow: true,
    }
  }

  private serviceChoices(selected?: Set<string>): ServiceChoice[] {
    return Object.entries(this.packageData() || {})
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
                checked: selected ? selected.has(id) : true,
              },
            ]
          : []
      })
      .sort((a, b) => a.title.localeCompare(b.title))
  }

  private ensureServices() {
    if (!this.editor.services.length) {
      this.editor.services = this.serviceChoices()
    }
  }

  canContinue(): boolean {
    if (this.step() === 1) return !!this.targetId()
    if (this.step() === 2) {
      this.ensureServices()
      return (
        this.validSchedule() &&
        this.validRetention() &&
        this.editor.services.some(service => service.checked)
      )
    }
    return true
  }

  canSaveSetup(): boolean {
    return (
      !!this.editor.password &&
      this.validSchedule() &&
      this.validRetention() &&
      !this.capacityBlocked() &&
      this.editor.services.some(service => service.checked)
    )
  }

  async next() {
    if (!this.canContinue()) return
    if (this.step() === 1) this.ensureServices()
    if (this.step() === 2) await this.refreshCapacity()
    this.step.update(step => Math.min(3, step + 1))
  }

  previous() {
    this.step.update(step => Math.max(1, step - 1))
  }

  allServicesSelected(): boolean {
    this.ensureServices()
    return (
      this.editor.services.length > 0 &&
      this.editor.services.every(service => service.checked)
    )
  }

  setAllServices(checked: boolean) {
    this.ensureServices()
    this.editor.services.forEach(service => (service.checked = checked))
  }

  scheduleSummary(): string {
    const minute = String(this.editor.minute).padStart(2, '0')
    const time = `${String(this.editor.hour).padStart(2, '0')}:${minute}`
    if (this.editor.frequency === 'hourly') {
      return `${this.i18n.transform('Hourly')} · ${this.i18n.transform('Minute')} ${minute}`
    }
    if (this.editor.frequency === 'weekly') {
      const day = this.weekdays[this.editor.weekday]?.label || 'Sunday'
      return `${this.i18n.transform(day)} · ${time}`
    }
    if (this.editor.frequency === 'monthly') {
      return `${this.i18n.transform('Monthly')} · ${this.i18n.transform('Day of month')} ${this.editor.dayOfMonth} · ${time}`
    }
    return `${this.i18n.transform('Daily')} · ${time}`
  }

  retentionSummary(): string {
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

  retentionPeriod(rule: AutomaticRetentionRule) {
    return retentionPeriodLabel(rule.interval, rule.duration)
  }

  retentionRules(): AutomaticRetentionRule[] {
    return [this.editor, ...this.editor.additionalRules]
  }

  newRetentionRule(): AutomaticRetentionRule {
    return { interval: 'day', duration: 7 }
  }

  removeRetentionRule(index: number) {
    if (index === 0 && this.editor.additionalRules.length) {
      const next = this.editor.additionalRules.shift()!
      this.editor.interval = next.interval
      this.editor.duration = next.duration
    } else if (index > 0) {
      this.editor.additionalRules.splice(index - 1, 1)
    } else {
      this.editor.keepAdditional = false
      Object.assign(this.editor, this.newRetentionRule())
    }
  }

  private validSchedule(): boolean {
    const validFrequency = ['hourly', 'daily', 'weekly', 'monthly'].includes(
      this.editor.frequency,
    )
    const validMinute =
      Number.isInteger(this.editor.minute) &&
      this.editor.minute >= 0 &&
      this.editor.minute <= 59
    const validHour =
      this.editor.frequency === 'hourly' ||
      (Number.isInteger(this.editor.hour) &&
        this.editor.hour >= 0 &&
        this.editor.hour <= 23)
    const validDayOfMonth =
      this.editor.frequency !== 'monthly' ||
      (Number.isInteger(this.editor.dayOfMonth) &&
        this.editor.dayOfMonth >= 1 &&
        this.editor.dayOfMonth <= 31)
    return validFrequency && validMinute && validHour && validDayOfMonth
  }

  private validRetention(): boolean {
    if (!this.editor.keepAdditional) return true
    return this.retentionRules().every(
      rule =>
        ['hour', 'day', 'week', 'month'].includes(rule.interval) &&
        Number.isInteger(rule.duration) &&
        rule.duration >= 1 &&
        rule.duration <= 365,
    )
  }

  selectedServiceSummary(): string {
    const selected = this.editor.services.filter(service => service.checked)
    const count = `${selected.length} / ${this.editor.services.length} ${this.i18n.transform('Services')}`
    const future = this.i18n.transform(
      this.editor.includeFuture
        ? 'Future services included'
        : 'Future services not included',
    )
    return `${count} · ${future}`
  }

  selectedTargetName(): string {
    return (
      this.targets().find(target => target.id === this.targetId())?.name || '—'
    )
  }

  private serviceScope(): T.BackupServiceScope {
    return serializeBackupServiceSelection(
      {
        packageIds: this.editor.services
          .filter(service => service.checked)
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
    return {
      tiers: this.retentionRules().map(rule => {
        const intervalSeconds = retentionIntervalSeconds(rule.interval)
        return {
          intervalSeconds,
          coverageSeconds: intervalSeconds * Math.max(1, rule.duration),
        }
      }),
    }
  }

  async refreshCapacity() {
    try {
      this.estimates.set(
        await this.api.estimateScheduledBackupCapacity({
          targetId: this.targetId(),
          services: this.serviceScope(),
          defaultRetention: this.policy(),
          retentionOverrides: {},
        }),
      )
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
      this.estimates.set([])
    }
  }

  capacityNeeded(): number | null {
    if (!this.estimates().length) return null
    return this.estimates().reduce(
      (sum, item) => sum + item.conservativePeakExcludingManualBytes,
      0,
    )
  }

  capacityAvailable(): number | null {
    const target = this.targets().find(item => item.id === this.targetId())
    return target?.capacity != null && target.used != null
      ? Math.max(0, target.capacity - target.used)
      : null
  }

  capacityAvailableLabel(): string {
    const available = this.capacityAvailable()
    return available === null
      ? this.i18n.transform('Availability unknown')
      : this.bytes(available)
  }

  capacityBlocked(): boolean {
    const needed = this.capacityNeeded()
    const available = this.capacityAvailable()
    return needed !== null && available !== null && needed > available
  }

  capacityAppearance(): 'info' | 'negative' {
    return this.capacityBlocked() ? 'negative' : 'info'
  }

  async createAutomaticBackup() {
    if (!this.canSaveSetup() || this.saving()) return
    this.saving.set(true)
    try {
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
      if (!this.embedded()) await this.router.navigate(['/system/backups'])
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    } finally {
      this.saving.set(false)
    }
  }

  async toggleAllJobs(enabled: boolean) {
    try {
      await Promise.all(
        this.jobs().map(job =>
          this.api.setScheduledBackupJobEnabled({ id: job.id, enabled }),
        ),
      )
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    }
  }

  async toggleMain(enabled: boolean) {
    await this.toggleAllJobs(enabled)
  }

  bytes(value: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let amount = value
    let unit = 0
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024
      unit += 1
    }
    return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`
  }
}
