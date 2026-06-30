import { DatePipe } from '@angular/common'
import { Component, computed, inject, OnInit, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { RouterLink } from '@angular/router'
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
  TuiIcon,
  TuiTitle,
} from '@taiga-ui/core'
import { TuiBadge, TuiSwitch } from '@taiga-ui/kit'
import { PatchDB } from 'patch-db-client'
import { filter, firstValueFrom } from 'rxjs'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { DataModel } from 'src/app/services/patch-db/data-model'
import { TitleDirective } from 'src/app/services/title.service'
import { BackupService } from '../system/routes/backups/backup.service'
import { BackupNavigationComponent } from './backup-navigation.component'

@Component({
  template: `
    <ng-container *title>{{ 'Backups' | i18n }}</ng-container>

    <backup-navigation />

    <header class="page-heading">
      <div>
        <h2>{{ 'Backups' | i18n }}</h2>
        <p>
          {{
            'Protect your services automatically, create a manual backup, or restore from an earlier checkpoint.'
              | i18n
          }}
        </p>
      </div>
      <a
        tuiButton
        appearance="secondary"
        size="s"
        routerLink="manage"
        fragment="help"
      >
        {{ 'Help' | i18n }}
      </a>
    </header>

    @if (operationActivity(); as activity) {
      <section class="operation" tuiCell>
        <tui-icon
          [icon]="
            activity.state === 'running'
              ? '@tui.loader-circle'
              : activity.state === 'succeeded'
                ? '@tui.circle-check'
                : '@tui.triangle-alert'
          "
        />
        <span tuiTitle>
          <b>{{ operationTitle(activity) | i18n }}</b>
          <span tuiSubtitle>
            {{ operationDetail(activity) | i18n }}
          </span>
        </span>
        @if (activity.state === 'running') {
          <a tuiButton appearance="secondary" size="s" routerLink="manage">
            {{ 'View progress' | i18n }}
          </a>
        } @else {
          <button
            tuiButton
            appearance="secondary"
            size="s"
            (click)="dismiss(activity)"
          >
            {{ 'Dismiss' | i18n }}
          </button>
        }
      </section>
    }

    <section class="g-card automatic">
      <header>
        <span tuiTitle>
          <b>{{ 'Automatic backups' | i18n }}</b>
          <span tuiSubtitle>
            {{ automaticSummary() | i18n }}
          </span>
        </span>
        @if (jobs().length) {
          <label class="toggle">
            <input
              tuiSwitch
              type="checkbox"
              [ngModel]="automaticOn()"
              [disabled]="changingAutomatic"
              (ngModelChange)="setAutomatic($event)"
            />
            <span>{{ (automaticOn() ? 'On' : 'Off') | i18n }}</span>
          </label>
        }
      </header>

      @if (jobs().length) {
        <div class="status-grid">
          <div>
            <span class="label">{{ 'Status' | i18n }}</span>
            <span>
              <span tuiBadge [appearance]="healthAppearance()">
                {{ healthLabel() | i18n }}
              </span>
            </span>
          </div>
          <div>
            <span class="label">{{ 'Last successful backup' | i18n }}</span>
            <b>
              {{
                lastSuccessfulAt()
                  ? (lastSuccessfulAt() | date: 'medium')
                  : ('Never' | i18n)
              }}
            </b>
          </div>
          <div>
            <span class="label">{{ 'Next backup' | i18n }}</span>
            <b>
              {{
                nextRun()
                  ? (nextRun() | date: 'medium')
                  : ('Not scheduled' | i18n)
              }}
            </b>
          </div>
          <div>
            <span class="label">{{ 'Backup location' | i18n }}</span>
            <b>{{ targetName(primary()?.targetId) }}</b>
          </div>
        </div>

        @if (needsAttention()) {
          <div class="attention" tuiCell>
            <tui-icon icon="@tui.triangle-alert" />
            <span tuiTitle>
              <b>{{ 'Automatic backups need attention' | i18n }}</b>
              <span tuiSubtitle>{{ healthDetail() | i18n }}</span>
            </span>
            <a tuiButton size="s" routerLink="manage">
              {{ 'Fix backup' | i18n }}
            </a>
          </div>
        }

        <footer class="actions">
          <button tuiButton [disabled]="!canRunNow()" (click)="runNow()">
            {{ 'Run now' | i18n }}
          </button>
          <a tuiButton appearance="secondary" routerLink="manage">
            {{ 'Manage' | i18n }}
          </a>
        </footer>
      } @else {
        <div class="empty">
          <tui-icon icon="@tui.calendar-clock" />
          <span tuiTitle>
            <b>{{ 'Set up automatic backups' | i18n }}</b>
            <span tuiSubtitle>
              {{
                'Back up every current and future service on a schedule.' | i18n
              }}
            </span>
          </span>
          <a tuiButton routerLink="setup">{{ 'Set up' | i18n }}</a>
        </div>
      }
    </section>

    <section class="options">
      <a
        tuiCell
        tuiAppearance="outline-grayscale"
        [routerLink]="runningActivities().length ? null : 'manual'"
        [attr.aria-disabled]="!!runningActivities().length"
      >
        <tui-icon icon="@tui.copy-plus" />
        <span tuiTitle>
          <b>{{ 'Create a manual backup' | i18n }}</b>
          <span tuiSubtitle>
            {{ 'Run a one-time backup now' | i18n }}
          </span>
        </span>
        <tui-icon icon="@tui.chevron-right" />
      </a>

      <a
        tuiCell
        tuiAppearance="outline-grayscale"
        [routerLink]="runningActivities().length ? null : 'restore'"
        [attr.aria-disabled]="!!runningActivities().length"
      >
        <tui-icon icon="@tui.database-backup" />
        <span tuiTitle>
          <b>{{ 'Restore from a backup' | i18n }}</b>
          <span tuiSubtitle>
            {{ 'Choose a manual or automatic checkpoint' | i18n }}
          </span>
        </span>
        <tui-icon icon="@tui.chevron-right" />
      </a>

      <a tuiCell tuiAppearance="outline-grayscale" routerLink="locations">
        <tui-icon icon="@tui.hard-drive" />
        <span tuiTitle>
          <b>{{ 'Manage backup locations' | i18n }}</b>
          <span tuiSubtitle>
            {{ 'Add or repair a physical drive or network folder' | i18n }}
          </span>
        </span>
        <tui-icon icon="@tui.chevron-right" />
      </a>
    </section>
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

    .page-heading,
    .automatic > header,
    .actions,
    .toggle,
    .empty {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }

    h2,
    p {
      margin: 0;
    }

    .page-heading p {
      color: var(--tui-text-secondary);
      margin-top: 0.35rem;
    }

    .automatic {
      padding: 0;
      overflow: hidden;
    }

    .automatic > header {
      position: static;
      height: auto;
      min-height: 3rem;
      padding: 1rem 1.25rem;
    }

    [tuiSubtitle] {
      display: block;
      margin-top: 0.25rem;
    }

    [tuiTitle],
    .status-grid > div {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .toggle {
      width: fit-content;
      justify-content: flex-start;
      white-space: nowrap;
    }

    .status-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1rem;
      padding: 1.25rem;
      border-block: 1px solid var(--tui-border-normal);
    }

    .status-grid > div {
      display: grid;
      gap: 0.3rem;
    }

    .label {
      color: var(--tui-text-secondary);
    }

    .attention,
    .operation,
    .options [tuiCell] {
      gap: 0.75rem;
    }

    .attention {
      margin: 1rem 1.25rem 0;
      background: var(--tui-background-accent-2);
    }

    .operation {
      background: var(--tui-background-neutral-1);
      border: 1px solid var(--tui-border-normal);
      border-radius: var(--tui-radius-l);
    }

    .actions {
      justify-content: flex-start;
      padding: 1.25rem;
    }

    .empty {
      justify-content: flex-start;
      padding: 1.25rem;
      border-top: 1px solid var(--tui-border-normal);
    }

    .empty [tuiTitle] {
      flex: 1;
    }

    .options {
      display: grid;
      gap: 0.5rem;
    }

    .options [tuiCell] {
      text-decoration: none;
    }

    .options [aria-disabled='true'] {
      pointer-events: none;
      opacity: var(--tui-disabled-opacity);
    }

    .options [tuiTitle] {
      flex: 1;
    }

    @media (max-width: 48rem) {
      .page-heading {
        align-items: flex-start;
      }
    }

    @container card (max-width: 40rem) {
      .status-grid {
        grid-template-columns: 1fr;
      }

      .actions > * {
        flex: 1;
      }
    }

    @media (max-width: 30rem) {
      .page-heading,
      .operation {
        align-items: stretch;
        flex-direction: column;
      }

      .page-heading > a,
      .operation > :last-child {
        align-self: flex-start;
      }
    }

    @container card (max-width: 30rem) {
      .automatic > header,
      .attention,
      .empty {
        align-items: stretch;
        flex-direction: column;
      }

      .attention > :last-child,
      .empty > :last-child {
        align-self: flex-start;
      }

      .automatic > header .toggle {
        width: fit-content;
        justify-content: flex-start;
      }

      .actions {
        flex-wrap: wrap;
      }
    }
  `,
  host: { class: 'backup-page' },
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    TuiAppearance,
    TuiBadge,
    TuiButton,
    TuiCell,
    TuiIcon,
    TuiSwitch,
    TuiTitle,
    TitleDirective,
    BackupNavigationComponent,
    i18nPipe,
  ],
})
export default class BackupsComponent implements OnInit {
  private readonly api = inject(ApiService)
  private readonly dialogs = inject(DialogService)
  private readonly errors = inject(ErrorService)
  private readonly backupService = inject(BackupService)
  private readonly state = toSignal(
    inject<PatchDB<DataModel>>(PatchDB).watch$('scheduledBackups'),
  )

  changingAutomatic = false
  private readonly dismissedActivityId = signal(
    localStorage.getItem('dismissed-backup-activity'),
  )

  readonly jobs = computed(() =>
    Object.values(this.state()?.jobs || {}).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    ),
  )
  readonly primary = computed(() => this.jobs()[0])
  readonly activities = computed(() =>
    Object.values(this.state()?.activities || {}).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    ),
  )
  readonly runningActivities = computed(() =>
    this.activities().filter(activity => activity.state === 'running'),
  )
  readonly operationActivity = computed(() => {
    const running = this.runningActivities()[0]
    if (running) return running
    const latest = this.activities()[0]
    return latest?.id !== this.dismissedActivityId() ? latest : null
  })
  readonly lastSuccessful = computed(() =>
    this.activities().find(
      activity =>
        activity.kind === 'automatic' && activity.state === 'succeeded',
    ),
  )
  readonly lastSuccessfulAt = computed(
    () =>
      this.lastSuccessful()?.completedAt ||
      this.jobs()
        .flatMap(job =>
          job.status.lastSucceededAt ? [job.status.lastSucceededAt] : [],
        )
        .sort()
        .at(-1) ||
      null,
  )
  readonly automaticOn = computed(() =>
    this.jobs().some(job => job.enabled && !job.pause),
  )
  readonly nextRun = computed(
    () =>
      this.jobs()
        .flatMap(job => (job.status.nextRunAt ? [job.status.nextRunAt] : []))
        .sort()[0] || null,
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

  healthLabel(): string {
    if (this.needsAttention()) return 'Needs attention'
    if (!this.automaticOn()) return 'Off'
    return 'On'
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

  healthAppearance(): 'positive' | 'warning' | 'neutral' {
    if (this.needsAttention()) return 'warning'
    return this.automaticOn() ? 'positive' : 'neutral'
  }

  canRunNow(): boolean {
    const primary = this.primary()
    return (
      !!primary &&
      primary.enabled &&
      !primary.pause &&
      !this.runningActivities().length
    )
  }

  operationTitle(activity: T.BackupActivity): string {
    if (activity.kind === 'restore') return 'Restoring services'
    if (activity.kind === 'manual') return 'Creating manual backup'
    return 'Creating automatic backup'
  }

  operationDetail(activity: T.BackupActivity): string {
    if (activity.state === 'running') {
      return 'You can leave this page. Progress will continue.'
    }
    return activity.state === 'succeeded' ? 'Completed' : 'Failed'
  }

  dismiss(activity: T.BackupActivity) {
    localStorage.setItem('dismissed-backup-activity', activity.id)
    this.dismissedActivityId.set(activity.id)
  }

  targetName(targetId?: string): string {
    if (!targetId) return '—'
    const cifs = this.backupService
      .cifs()
      .find(target => target.id === targetId)
    if (cifs) return `${cifs.entry.hostname}${cifs.entry.path}`
    const drive = this.backupService
      .drives()
      .find(target => target.id === targetId)
    return drive
      ? [drive.entry.vendor, drive.entry.model].filter(Boolean).join(' ') ||
          drive.entry.logicalname
      : targetId
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
    if (!enabled) {
      const confirmed = await firstValueFrom(
        this.dialogs
          .openConfirm({
            label: 'Turn off automatic backups?',
            size: 's',
            data: {
              content:
                'This pauses every automatic schedule. Your settings and existing checkpoints are kept. You can permanently delete automatic checkpoints from Manage.',
              yes: 'Turn off',
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
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    } finally {
      this.changingAutomatic = false
    }
  }
}
