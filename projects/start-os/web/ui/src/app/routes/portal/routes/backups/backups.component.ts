import { Component, computed, inject, OnInit, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { Router } from '@angular/router'
import {
  DialogService,
  DocsLinkDirective,
  ErrorService,
  getErrorMessage,
  i18nPipe,
} from '@start9labs/shared'
import { T } from '@start9labs/start-core'
import { TuiButton, TuiCell, TuiIcon, TuiTitle } from '@taiga-ui/core'
import { TuiBadge, TuiSwitch } from '@taiga-ui/kit'
import { PatchDB } from 'patch-db-client'
import { firstValueFrom } from 'rxjs'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { OSService } from 'src/app/services/os.service'
import { DataModel } from 'src/app/services/patch-db/data-model'
import { TitleDirective } from 'src/app/services/title.service'
import { BackupService } from '../system/routes/backups/backup.service'
import SystemBackupComponent from '../system/routes/backups/backups.component'
import { BackupProgressComponent } from '../system/routes/backups/progress.component'
import { parseBackupSchedule } from '../system/routes/backups/scheduled.utils'
import AutomaticBackupsComponent from './automatic.component'
import {
  DISABLE_AUTOMATIC_DIALOG,
  DisableAutomaticDecision,
} from './disable-automatic.dialog'
import { BackupHistoryComponent } from './history.component'
import BackupLocationsComponent from './locations.component'

type BackupPanel = 'automatic' | 'manual' | 'restore' | 'locations' | 'history'

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

@Component({
  template: `
    <ng-container *title>{{ 'Backups' | i18n }}</ng-container>

    <header class="page-heading">
      <div>
        <h2>
          {{ 'Backups' | i18n }}
          <a
            tuiIconButton
            size="xs"
            docsLink
            path="/start-os/"
            fragment="#backups"
            appearance="icon"
            iconStart="@tui.book-open-text"
            [attr.aria-label]="'Documentation' | i18n"
          ></a>
        </h2>
        <p>
          {{
            'Protect your services automatically, create a manual backup, or restore from an earlier checkpoint.'
              | i18n
          }}
        </p>
      </div>
    </header>

    @if (operationActivity(); as activity) {
      @if (manualRunning()) {
        <section
          class="progress-prominent"
          role="button"
          tabindex="0"
          [attr.aria-label]="'Services' | i18n"
          (click)="goToServices()"
          (keydown.enter)="goToServices()"
          (keydown.space)="$event.preventDefault(); goToServices()"
        >
          <section backupProgress></section>
        </section>
      } @else {
        <button
          type="button"
          class="operation"
          tuiCell
          (click)="goToServices()"
        >
          <tui-icon icon="@tui.loader-circle" />
          <span tuiTitle>
            <b>{{ operationTitle(activity) | i18n }}</b>
            <span tuiSubtitle>
              {{ 'You can leave this page. Progress will continue.' | i18n }}
            </span>
          </span>
          <span tuiBadge appearance="info">{{ 'In progress' | i18n }}</span>
        </button>
      }
    }

    <section
      class="backup-card g-card"
      [class.expanded]="expanded() === 'automatic'"
    >
      <header class="card-heading automatic-heading">
        <button
          type="button"
          class="card-toggle"
          [attr.aria-expanded]="expanded() === 'automatic'"
          (click)="togglePanel('automatic')"
        >
          <tui-icon
            [icon]="
              needsAttention() ? '@tui.triangle-alert' : '@tui.calendar-clock'
            "
          />
          <span tuiTitle>
            <b>
              {{
                (needsAttention()
                  ? 'Automatic backups need attention'
                  : 'Automatic backups'
                ) | i18n
              }}
            </b>
            <span tuiSubtitle>
              {{
                (needsAttention() ? healthDetail() : automaticSummary()) | i18n
              }}
            </span>
          </span>
        </button>

        @if (jobs().length === 1) {
          <div class="card-actions">
            <label class="simple-switch">
              <input
                tuiSwitch
                type="checkbox"
                [showIcons]="false"
                [ngModel]="automaticOn()"
                [disabled]="changingAutomatic"
                (ngModelChange)="setAutomatic($event)"
              />
              <span>{{ (automaticOn() ? 'On' : 'Off') | i18n }}</span>
            </label>
            <button
              tuiButton
              type="button"
              size="s"
              [disabled]="!canRunNow()"
              (click)="runNow()"
            >
              {{ 'Run now' | i18n }}
            </button>
          </div>
        }
        <button
          type="button"
          class="expand-toggle"
          [attr.aria-label]="'Automatic backups' | i18n"
          [attr.aria-expanded]="expanded() === 'automatic'"
          (click)="togglePanel('automatic')"
        >
          <tui-icon
            icon="@tui.chevron-down"
            [class.rotated]="expanded() === 'automatic'"
          />
        </button>
      </header>

      @if (expanded() === 'automatic') {
        <div class="card-body">
          <automatic-backups
            [embedded]="true"
            [mode]="jobs().length ? 'manage' : 'setup'"
            (manageLocations)="openLocations()"
          />
        </div>
      }
    </section>

    <section
      class="backup-card g-card"
      [class.expanded]="expanded() === 'manual'"
    >
      <header class="card-heading">
        <button
          type="button"
          class="card-toggle"
          [attr.aria-expanded]="expanded() === 'manual'"
          (click)="togglePanel('manual')"
        >
          <tui-icon icon="@tui.copy-plus" />
          <span tuiTitle>
            <b>{{ 'Create a manual backup' | i18n }}</b>
            <span tuiSubtitle>{{ 'Run a one-time backup now' | i18n }}</span>
          </span>
          <tui-icon
            icon="@tui.chevron-down"
            [class.rotated]="expanded() === 'manual'"
          />
        </button>
      </header>
      @if (expanded() === 'manual') {
        <div class="card-body">
          <system-backup
            mode="create"
            [embedded]="true"
            [operationActive]="progressActive()"
            (manageLocations)="openLocations()"
          />
        </div>
      }
    </section>

    <section
      class="backup-card g-card"
      [class.expanded]="expanded() === 'restore'"
    >
      <header class="card-heading">
        <button
          type="button"
          class="card-toggle"
          [attr.aria-expanded]="expanded() === 'restore'"
          (click)="togglePanel('restore')"
        >
          <tui-icon icon="@tui.database-backup" />
          <span tuiTitle>
            <b>{{ 'Restore from a backup' | i18n }}</b>
            <span tuiSubtitle>
              {{ 'Choose a manual or automatic checkpoint' | i18n }}
            </span>
          </span>
          <tui-icon
            icon="@tui.chevron-down"
            [class.rotated]="expanded() === 'restore'"
          />
        </button>
      </header>
      @if (expanded() === 'restore') {
        <div class="card-body">
          <system-backup
            mode="restore"
            [embedded]="true"
            [operationActive]="progressActive()"
            (manageLocations)="openLocations()"
          />
        </div>
      }
    </section>

    <section
      class="backup-card g-card"
      [class.expanded]="expanded() === 'locations'"
    >
      <header class="card-heading">
        <button
          type="button"
          class="card-toggle"
          [attr.aria-expanded]="expanded() === 'locations'"
          (click)="togglePanel('locations')"
        >
          <tui-icon icon="@tui.hard-drive" />
          <span tuiTitle>
            <b>{{ 'Manage backup locations' | i18n }}</b>
            <span tuiSubtitle>
              {{ 'Add or repair a physical drive or network folder' | i18n }}
            </span>
          </span>
          <tui-icon
            icon="@tui.chevron-down"
            [class.rotated]="expanded() === 'locations'"
          />
        </button>
      </header>
      @if (expanded() === 'locations') {
        <div class="card-body">
          <backup-locations [embedded]="true" />
        </div>
      }
    </section>

    <section
      class="backup-card g-card"
      [class.expanded]="expanded() === 'history'"
    >
      <header class="card-heading">
        <button
          type="button"
          class="card-toggle"
          [attr.aria-expanded]="expanded() === 'history'"
          (click)="togglePanel('history')"
        >
          <tui-icon icon="@tui.history" />
          <span tuiTitle>
            <b>{{ 'Backup history' | i18n }}</b>
            <span tuiSubtitle>
              {{ activities().length }} {{ 'All activity' | i18n }}
            </span>
          </span>
          <tui-icon
            icon="@tui.chevron-down"
            [class.rotated]="expanded() === 'history'"
          />
        </button>
      </header>
      @if (expanded() === 'history') {
        <div class="card-body">
          <backup-history />
        </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: grid;
      gap: 0.75rem;
      width: 100%;
      min-width: 0;
      max-width: 64rem;
      margin-inline: auto;
    }

    h2,
    p {
      margin: 0;
    }

    h2 {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .page-heading p,
    [tuiSubtitle] {
      display: block;
      margin-top: 0.25rem;
      color: var(--tui-text-secondary);
    }

    .backup-card {
      padding: 0;
      overflow: hidden;
      container: card / inline-size;
    }

    .card-heading {
      position: static;
      display: flex;
      align-items: center;
      min-height: 4.5rem;
      height: auto;
      padding: 0;
      background: transparent;
    }

    .card-toggle {
      display: flex;
      flex: 1;
      align-items: center;
      gap: 0.75rem;
      min-width: 0;
      min-height: 4.5rem;
      padding: 1rem 1.25rem;
      color: inherit;
      font: inherit;
      text-align: left;
      background: transparent;
      border: 0;
      cursor: pointer;
    }

    .card-toggle:disabled {
      cursor: default;
      opacity: var(--tui-disabled-opacity);
    }

    .card-toggle [tuiTitle] {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .card-toggle > tui-icon:last-child {
      transition: transform var(--tui-duration, 0.2s);
    }

    .rotated {
      transform: rotate(180deg);
    }

    .card-actions,
    .simple-switch {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .card-actions {
      flex-wrap: wrap;
      justify-content: flex-end;
      padding: 0.75rem 1.25rem 0.75rem 0;
    }

    .simple-switch {
      width: fit-content;
      white-space: normal;
    }

    .automatic-heading {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
    }

    .expand-toggle {
      display: grid;
      place-items: center;
      align-self: stretch;
      width: 3.5rem;
      padding: 0;
      color: inherit;
      background: transparent;
      border: 0;
      cursor: pointer;
    }

    .card-body {
      display: grid;
      gap: 1rem;
      min-width: 0;
      padding: 1.25rem;
      border-top: 1px solid var(--tui-border-normal);
    }

    .automatic-heading + .card-body {
      border-top: 0;
    }

    .operation,
    .attention {
      gap: 0.75rem;
      min-width: 0;
    }

    .operation {
      position: static;
      z-index: 1;
      width: 100%;
      color: inherit;
      font: inherit;
      background: color-mix(in hsl, var(--start9-base-1) 50%, transparent);
      border: 1px solid var(--tui-border-normal);
      border-radius: var(--tui-radius-l);
      box-sizing: border-box;
      cursor: pointer;
    }

    .operation > tui-icon {
      color: var(--tui-text-action);
      animation: backup-progress-spin 1.5s linear infinite;
    }

    .operation [tuiTitle],
    .attention [tuiTitle] {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .progress-prominent {
      position: static;
      z-index: 1;
      display: block;
      width: 100%;
      padding: 0.75rem;
      color: inherit;
      font: inherit;
      text-align: left;
      background: color-mix(in hsl, var(--start9-base-1) 50%, transparent);
      border: 1px solid var(--tui-border-normal);
      border-radius: var(--tui-radius-l);
      box-sizing: border-box;
      cursor: pointer;
    }

    .operation:hover,
    .progress-prominent:hover {
      border-color: var(--tui-border-hover);
    }

    @keyframes backup-progress-spin {
      to {
        transform: rotate(1turn);
      }
    }

    @container card (max-width: 44rem) {
      .card-heading {
        align-items: stretch;
        flex-direction: column;
      }

      .card-actions {
        justify-content: flex-start;
        padding: 0 1.25rem 1rem;
      }

      .automatic-heading {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
      }

      .automatic-heading .card-actions {
        grid-column: 1 / -1;
        grid-row: 2;
      }

      .automatic-heading .expand-toggle {
        grid-column: 2;
        grid-row: 1;
      }
    }

    @media (max-width: 30rem) {
      .card-toggle {
        align-items: flex-start;
      }

      .card-actions {
        align-items: flex-start;
        flex-direction: column;
      }

      .card-actions > button {
        width: 100%;
      }

      .card-body {
        padding: 1rem;
      }

      .operation {
        align-items: stretch;
        flex-direction: column;
      }

      .operation > tui-icon,
      .operation > [tuiBadge] {
        align-self: flex-start;
      }
    }
  `,
  host: { class: 'backup-page' },
  imports: [
    FormsModule,
    TuiBadge,
    TuiButton,
    TuiCell,
    TuiIcon,
    TuiSwitch,
    TuiTitle,
    TitleDirective,
    AutomaticBackupsComponent,
    SystemBackupComponent,
    BackupLocationsComponent,
    BackupHistoryComponent,
    BackupProgressComponent,
    DocsLinkDirective,
    i18nPipe,
  ],
})
export default class BackupsComponent implements OnInit {
  private readonly api = inject(ApiService)
  private readonly dialogs = inject(DialogService)
  private readonly errors = inject(ErrorService)
  private readonly backupService = inject(BackupService)
  private readonly os = inject(OSService)
  private readonly router = inject(Router)
  private readonly state = toSignal(
    inject<PatchDB<DataModel>>(PatchDB).watch$('scheduledBackups'),
  )

  readonly expanded = signal<BackupPanel | null>(null)
  readonly manualRunning = toSignal(this.os.backingUp$, { initialValue: false })
  changingAutomatic = false

  readonly jobs = computed(() =>
    Object.values(this.state()?.jobs || {}).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    ),
  )
  readonly primary = computed(() => this.jobs()[0])
  readonly histories = computed(() =>
    Object.values(this.state()?.histories || {}),
  )
  readonly activities = computed(() =>
    Object.values(this.state()?.activities || {}).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    ),
  )
  readonly operationActivity = computed(() => {
    const latest = this.activities()[0]
    return latest?.state === 'running' ? latest : null
  })
  readonly progressActive = computed(() => !!this.operationActivity())
  readonly automaticOn = computed(() =>
    this.jobs().some(job => job.enabled && !job.pause),
  )
  readonly needsAttention = computed(() =>
    this.jobs().some(
      job =>
        (!!job.pause && job.pause.reason !== 'user') ||
        job.status.lastResult === 'failed' ||
        job.status.lastResult === 'partiallyFailed',
    ),
  )

  ngOnInit() {
    void this.backupService.getBackupTargets()
  }

  togglePanel(panel: BackupPanel) {
    this.expanded.update(current => (current === panel ? null : panel))
  }

  openLocations() {
    this.expanded.set('locations')
  }

  goToServices() {
    void this.router.navigate(['/services'])
  }

  automaticSummary(): string {
    const jobs = this.jobs()
    if (!jobs.length) return 'Automatic backups are not set up yet.'
    if (jobs.length > 1) {
      const summary = `${jobs.length} schedules`
      return this.automaticOn() ? summary : `Off · ${summary}`
    }
    const primary = jobs[0]!
    const schedule = parseBackupSchedule(primary.schedule)
    const time = `${String(schedule.hour).padStart(2, '0')}:${String(
      schedule.minute,
    ).padStart(2, '0')}`
    const timing =
      schedule.frequency === 'hourly'
        ? `Hourly at minute ${String(schedule.minute).padStart(2, '0')}`
        : schedule.frequency === 'weekly'
          ? `${WEEKDAYS[schedule.weekday] || 'Sunday'} at ${time}`
          : `Daily at ${time}`
    const state = this.automaticOn() ? timing : `Off · ${timing}`
    return state
  }

  healthDetail(): string {
    const job = this.jobs().find(
      item =>
        (!!item.pause && item.pause.reason !== 'user') ||
        item.status.lastResult === 'failed' ||
        item.status.lastResult === 'partiallyFailed',
    )
    if (job?.pause?.reason === 'reauthenticationRequired') {
      return 'The backup location needs your password again.'
    }
    if (job?.pause?.reason === 'targetIdentityMismatch') {
      return 'The connected backup location is not the expected location.'
    }
    if (job?.pause?.reason === 'targetUnavailable') {
      return 'StartOS cannot connect to the backup location.'
    }
    return 'The latest automatic backup did not finish successfully.'
  }

  canRunNow(): boolean {
    const primary = this.primary()
    return (
      !!primary && primary.enabled && !primary.pause && !this.progressActive()
    )
  }

  operationTitle(activity: T.BackupActivity): string {
    if (activity.kind === 'restore') return 'Restoring services'
    if (activity.kind === 'manual') return 'Creating manual backup'
    return 'Creating automatic backup'
  }

  async runNow() {
    const job = this.primary()
    if (!job) return
    try {
      await this.api.runScheduledBackupJob({ id: job.id })
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    }
  }

  async setAutomatic(enabled: boolean) {
    if (enabled === this.automaticOn()) return
    const snapshots = this.histories().flatMap(history =>
      history.snapshots.map(snapshot => ({ history, snapshot })),
    )
    let deleteCheckpoints = false

    if (!enabled) {
      const bytes = snapshots.reduce(
        (sum, item) =>
          sum + (item.snapshot.physicalSize ?? item.snapshot.logicalSize),
        0,
      )
      const decision = await firstValueFrom(
        this.dialogs.openComponent<DisableAutomaticDecision | null>(
          DISABLE_AUTOMATIC_DIALOG,
          {
            label: 'Turn off automatic backups?',
            size: 's',
            data: {
              checkpointCount: snapshots.length,
              reclaimable: this.bytes(bytes),
            },
          },
        ),
        { defaultValue: null },
      )
      if (!decision) return
      deleteCheckpoints = decision.deleteCheckpoints
    }

    this.changingAutomatic = true
    try {
      await Promise.all(
        this.jobs().map(job =>
          this.api.setScheduledBackupJobEnabled({ id: job.id, enabled }),
        ),
      )
      if (!enabled && deleteCheckpoints) {
        for (const history of this.histories()) {
          const snapshotIds = history.snapshots.map(snapshot => snapshot.id)
          if (snapshotIds.length) {
            await this.api.deleteArchivedBackupSnapshots({
              targetId: history.targetId,
              packageId: history.packageId,
              snapshotIds,
            })
          }
        }
        for (const job of this.jobs()) {
          await this.api.deleteScheduledBackupJob({ id: job.id })
        }
      }
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    } finally {
      this.changingAutomatic = false
    }
  }

  private bytes(value: number): string {
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
