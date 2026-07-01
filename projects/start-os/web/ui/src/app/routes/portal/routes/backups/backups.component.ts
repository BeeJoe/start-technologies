import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  OnInit,
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
  TuiButton,
  TuiCell,
  TuiCheckbox,
  TuiIcon,
  TuiTitle,
} from '@taiga-ui/core'
import { TuiBadge, TuiSwitch } from '@taiga-ui/kit'
import { PatchDB } from 'patch-db-client'
import { filter, firstValueFrom } from 'rxjs'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { OSService } from 'src/app/services/os.service'
import { DataModel } from 'src/app/services/patch-db/data-model'
import { TitleDirective } from 'src/app/services/title.service'
import { BackupService } from '../system/routes/backups/backup.service'
import SystemBackupComponent from '../system/routes/backups/backups.component'
import { BackupProgressComponent } from '../system/routes/backups/progress.component'
import AutomaticBackupsComponent from './automatic.component'
import BackupLocationsComponent from './locations.component'

type BackupPanel = 'automatic' | 'manual' | 'restore' | 'locations'

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
            href="https://docs.start9.com/start-os/0.4.0.x"
            target="_blank"
            rel="noreferrer"
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

    @if (manualRunning()) {
      <section #progress class="progress-prominent">
        <section backupProgress></section>
      </section>
    } @else if (operationActivity(); as activity) {
      <section #progress class="operation" tuiCell>
        <tui-icon icon="@tui.loader-circle" />
        <span tuiTitle>
          <b>{{ operationTitle(activity) | i18n }}</b>
          <span tuiSubtitle>
            {{ 'You can leave this page. Progress will continue.' | i18n }}
          </span>
        </span>
        <span tuiBadge appearance="info">{{ 'In progress' | i18n }}</span>
      </section>
    }

    <section
      class="backup-card g-card"
      [class.expanded]="expanded() === 'automatic'"
    >
      <header class="card-heading">
        <button
          type="button"
          class="card-toggle"
          [attr.aria-expanded]="expanded() === 'automatic'"
          (click)="togglePanel('automatic')"
        >
          <tui-icon icon="@tui.calendar-clock" />
          <span tuiTitle>
            <b>{{ 'Automatic backups' | i18n }}</b>
            <span tuiSubtitle>{{ automaticSummary() | i18n }}</span>
          </span>
          <tui-icon
            icon="@tui.chevron-down"
            [class.rotated]="expanded() === 'automatic'"
          />
        </button>

        @if (jobs().length) {
          <div class="card-actions">
            <button
              tuiButton
              type="button"
              size="s"
              [disabled]="!canRunNow()"
              (click)="runNow()"
            >
              {{ 'Run now' | i18n }}
            </button>
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
            @if (expanded() === 'automatic') {
              <label class="delete-checkpoints">
                <input
                  tuiCheckbox
                  type="checkbox"
                  [(ngModel)]="deleteWhenDisabled"
                />
                <span>
                  {{
                    'Also permanently delete automatic backup checkpoints'
                      | i18n
                  }}
                </span>
              </label>
            }
          </div>
        }
      </header>

      @if (expanded() === 'automatic') {
        <div class="card-body">
          @if (needsAttention()) {
            <div class="attention" tuiCell>
              <tui-icon icon="@tui.triangle-alert" />
              <span tuiTitle>
                <b>{{ 'Automatic backups need attention' | i18n }}</b>
                <span tuiSubtitle>{{ healthDetail() | i18n }}</span>
              </span>
            </div>
          }
          <automatic-backups
            [embedded]="true"
            [mode]="jobs().length ? 'manage' : 'setup'"
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
          [disabled]="progressActive()"
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
          <system-backup mode="create" [embedded]="true" />
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
          [disabled]="progressActive()"
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
          <system-backup mode="restore" [embedded]="true" />
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
    .simple-switch,
    .delete-checkpoints {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .card-actions {
      flex-wrap: wrap;
      justify-content: flex-end;
      padding: 0.75rem 1.25rem 0.75rem 0;
    }

    .simple-switch,
    .delete-checkpoints {
      width: fit-content;
      white-space: normal;
    }

    .delete-checkpoints {
      max-width: 19rem;
    }

    .card-body {
      display: grid;
      gap: 1rem;
      min-width: 0;
      padding: 1.25rem;
      border-top: 1px solid var(--tui-border-normal);
    }

    .operation,
    .attention {
      gap: 0.75rem;
      min-width: 0;
    }

    .operation {
      position: sticky;
      z-index: 1;
      top: 0.5rem;
      background: var(--tui-background-accent-2);
      border: 2px solid var(--tui-border-focus);
      border-radius: var(--tui-radius-l);
      box-shadow: var(--tui-shadow-medium);
    }

    .operation [tuiTitle],
    .attention [tuiTitle] {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .progress-prominent {
      position: sticky;
      z-index: 1;
      top: 0.5rem;
      padding: 0.25rem;
      background: var(--tui-background-accent-2);
      border: 2px solid var(--tui-border-focus);
      border-radius: var(--tui-radius-l);
      box-shadow: var(--tui-shadow-medium);
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

      .delete-checkpoints {
        max-width: 100%;
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
    TuiCheckbox,
    TuiIcon,
    TuiSwitch,
    TuiTitle,
    TitleDirective,
    AutomaticBackupsComponent,
    SystemBackupComponent,
    BackupLocationsComponent,
    BackupProgressComponent,
    i18nPipe,
  ],
})
export default class BackupsComponent implements OnInit {
  private readonly api = inject(ApiService)
  private readonly dialogs = inject(DialogService)
  private readonly errors = inject(ErrorService)
  private readonly backupService = inject(BackupService)
  private readonly os = inject(OSService)
  private readonly state = toSignal(
    inject<PatchDB<DataModel>>(PatchDB).watch$('scheduledBackups'),
  )

  readonly expanded = signal<BackupPanel | null>(null)
  readonly progress = viewChild<ElementRef<HTMLElement>>('progress')
  readonly manualRunning = toSignal(this.os.backingUp$, { initialValue: false })
  changingAutomatic = false
  deleteWhenDisabled = false

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
  readonly operationActivity = computed(
    () =>
      this.activities().find(activity => activity.state === 'running') || null,
  )
  readonly progressActive = computed(
    () => this.manualRunning() || !!this.operationActivity(),
  )
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

  private readonly scrollToProgress = effect(() => {
    if (!this.progressActive()) return
    setTimeout(() => {
      this.progress()?.nativeElement.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    })
  })

  ngOnInit() {
    void this.backupService.getBackupTargets()
  }

  togglePanel(panel: BackupPanel) {
    this.expanded.update(current => (current === panel ? null : panel))
    if (panel !== 'automatic') this.deleteWhenDisabled = false
  }

  automaticSummary(): string {
    const jobs = this.jobs()
    if (!jobs.length) return 'Automatic backups are not set up yet.'
    const paused = jobs.filter(job => !job.enabled || !!job.pause).length
    if (!this.automaticOn()) {
      return 'Automatic backups are off. Saved settings and checkpoints are kept.'
    }
    if (paused) return `${paused} of ${jobs.length} schedules paused`
    return jobs.length === 1
      ? 'Your services are protected on schedule.'
      : `${jobs.length} schedules are protecting your services.`
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

    if (!enabled) {
      const bytes = snapshots.reduce(
        (sum, item) =>
          sum + (item.snapshot.physicalSize ?? item.snapshot.logicalSize),
        0,
      )
      const confirmed = await firstValueFrom(
        this.dialogs
          .openConfirm({
            label: this.deleteWhenDisabled
              ? 'Turn off and delete automatic checkpoints?'
              : 'Turn off automatic backups?',
            size: 's',
            data: {
              content: this.deleteWhenDisabled
                ? `This will pause every schedule and permanently delete ${snapshots.length} automatic checkpoints, reclaiming about ${this.bytes(bytes)}. Manual checkpoints and any still-shared checkpoints are kept.`
                : 'This pauses every automatic schedule. Your settings and existing checkpoints are kept.',
              yes: this.deleteWhenDisabled ? 'Turn off and delete' : 'Turn off',
              no: 'Cancel',
            },
          })
          .pipe(filter(Boolean)),
        { defaultValue: false },
      )
      if (!confirmed) return
    }

    this.changingAutomatic = true
    try {
      await Promise.all(
        this.jobs().map(job =>
          this.api.setScheduledBackupJobEnabled({ id: job.id, enabled }),
        ),
      )
      if (!enabled && this.deleteWhenDisabled) {
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
      }
      this.deleteWhenDisabled = false
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
