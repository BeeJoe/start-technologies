import { DatePipe, DecimalPipe } from '@angular/common'
import { Component, computed, inject } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { convertBytes, i18nPipe } from '@start9labs/shared'
import { T } from '@start9labs/start-core'
import {
  TuiDataList,
  TuiIcon,
  TuiLabel,
  TuiNotification,
  TuiTitle,
} from '@taiga-ui/core'
import { TuiAccordion, TuiBadge, TuiChevron, TuiSelect } from '@taiga-ui/kit'
import { PatchDB } from 'patch-db-client'
import { DataModel } from 'src/app/services/patch-db/data-model'
import {
  BackupService,
  formatCifsLocation,
} from '../system/routes/backups/backup.service'

type HistoryFilter = 'all' | T.BackupActivityKind

@Component({
  selector: 'backup-history',
  template: `
    <section class="history-toolbar">
      <tui-textfield
        tuiChevron
        [stringify]="stringifyFilter"
        [tuiTextfieldCleaner]="false"
      >
        <label tuiLabel>{{ 'Show' | i18n }}</label>
        <input tuiSelect [(ngModel)]="historyFilter" />
        <tui-data-list *tuiDropdown>
          @for (filter of historyFilters; track filter) {
            <button tuiOption [value]="filter">
              {{ stringifyFilter(filter) }}
            </button>
          }
        </tui-data-list>
      </tui-textfield>
    </section>

    <section class="timeline">
      @for (activity of filteredActivities(); track activity.id) {
        <tui-accordion class="g-card activity">
          <button tuiAccordion>
            <tui-icon [icon]="activityIcon(activity)" />
            <span tuiTitle>
              <b>{{ activityLabel(activity) | i18n }}</b>
              <span tuiSubtitle>
                {{ activity.startedAt | date: 'medium' }} ·
                {{ activityState(activity) | i18n }}
              </span>
            </span>
            <span tuiBadge [appearance]="activityAppearance(activity)">
              {{ activityState(activity) | i18n }}
            </span>
          </button>
          <tui-expand>
            <div class="activity-details">
              <p>
                <b>{{ 'Backup location' | i18n }}:</b>
                {{ targetName(activity.targetId) }}
              </p>
              <p>
                <b>
                  {{
                    (activity.intendedServices.length === 1
                      ? 'Service'
                      : 'Services'
                    ) | i18n
                  }}:
                </b>
                {{ activity.intendedServices.length }}
              </p>
              @if (activity.error) {
                <p class="error">{{ activity.error }}</p>
              }
              @for (
                report of serviceReports(activity);
                track report.packageId
              ) {
                <section class="service-report">
                  <b>{{ packageName(report.packageId) }}</b>
                  @if (report.value.error) {
                    <p class="error">
                      {{ 'Error' | i18n }}: {{ report.value.error }}
                    </p>
                  } @else {
                    <p>
                      {{ 'Completed' | i18n }} ·
                      {{ reportSize(report.value) }} · {{ 'Duration' | i18n }}:
                      {{ report.value.duration_ms / 1000 | number: '1.0-1' }}s
                    </p>
                  }
                  @for (
                    snapshot of snapshotsFor(activity, report.packageId);
                    track snapshot.id
                  ) {
                    <p class="checkpoint">
                      {{ 'Checkpoints' | i18n }}: {{ snapshot.id }} ·
                      {{ 'Version' | i18n }} {{ snapshot.packageVersion }}
                      @if (snapshot.archived) {
                        · {{ 'Archived' | i18n }}
                      }
                    </p>
                  }
                </section>
              }
            </div>
          </tui-expand>
        </tui-accordion>
      } @empty {
        <div tuiNotification appearance="info">
          {{ 'No backup activity yet.' | i18n }}
        </div>
      }
    </section>
  `,
  styles: `
    :host,
    .timeline {
      display: grid;
      gap: 0.75rem;
      width: 100%;
      min-width: 0;
    }

    .history-toolbar {
      display: flex;
      justify-content: flex-end;
    }

    .history-toolbar tui-textfield {
      width: min(100%, 18rem);
      color: var(--tui-text-secondary);
    }

    .activity {
      padding: 0;
      overflow: hidden;
    }

    .activity > button {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem 1.25rem;
      cursor: pointer;
      list-style: none;
    }

    .activity > button > *,
    .activity > button [tuiTitle] {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .activity > button [tuiTitle] {
      flex: 1;
    }

    [tuiSubtitle] {
      display: block;
      margin-top: 0.25rem;
    }

    .activity-details {
      padding: 0 1.25rem 1rem 3.25rem;
    }

    .activity-details p {
      margin: 0.35rem 0;
    }

    .error {
      color: var(--tui-status-negative);
    }

    .service-report {
      display: grid;
      gap: 0.25rem;
      padding-block: 0.75rem;
      border-top: 1px solid var(--tui-border-normal);
    }

    .service-report p {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .checkpoint {
      color: var(--tui-text-secondary);
    }

    /* Timeline cards need a second collapse below the app-wide mobile layout. */
    @media (max-width: 30rem) {
      .history-toolbar tui-textfield {
        width: 100%;
      }

      .activity > button {
        align-items: flex-start;
        flex-direction: column;
      }

      .activity > button > tui-icon,
      .activity > button > [tuiBadge] {
        align-self: flex-start;
      }

      .activity-details {
        padding-inline: 1rem;
      }
    }
  `,
  host: { class: 'backup-settings' },
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    TuiBadge,
    TuiAccordion,
    TuiChevron,
    TuiDataList,
    TuiIcon,
    TuiLabel,
    TuiNotification,
    TuiTitle,
    TuiSelect,
    i18nPipe,
  ],
})
export class BackupHistory {
  private readonly backupService = inject(BackupService)
  private readonly i18n = inject(i18nPipe)
  private readonly state = toSignal(
    inject<PatchDB<DataModel>>(PatchDB).watch$('scheduledBackups'),
  )
  private readonly packageData = toSignal(
    inject<PatchDB<DataModel>>(PatchDB).watch$('packageData'),
  )

  protected historyFilter: HistoryFilter = 'all'
  protected readonly historyFilters: HistoryFilter[] = [
    'all',
    'manual',
    'automatic',
    'restore',
  ]
  protected readonly stringifyFilter = (filter: HistoryFilter) =>
    this.i18n.transform(
      filter === 'all'
        ? 'All activity'
        : filter === 'manual'
          ? 'Manual'
          : filter === 'automatic'
            ? 'Automatic'
            : 'Restore',
    )
  protected readonly activities = computed(() =>
    Object.values(this.state()?.activities || {}).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    ),
  )

  constructor() {
    void this.initialize()
  }

  private initialize() {
    void this.backupService.getBackupTargets()
  }

  filteredActivities(): T.BackupActivity[] {
    return this.historyFilter === 'all'
      ? this.activities()
      : this.activities().filter(
          activity => activity.kind === this.historyFilter,
        )
  }

  activityLabel(activity: T.BackupActivity): string {
    if (activity.kind === 'manual') return 'Manual backup'
    if (activity.kind === 'restore') return 'Restore'
    return activity.jobName || 'Automatic backup'
  }

  activityState(activity: T.BackupActivity): string {
    switch (activity.state) {
      case 'succeeded':
        return 'Succeeded'
      case 'partiallyFailed':
        return 'Partially failed'
      case 'failed':
        return 'Failed'
      default:
        return 'In progress'
    }
  }

  activityIcon(activity: T.BackupActivity): string {
    if (activity.kind === 'manual') return '@tui.copy-plus'
    if (activity.kind === 'restore') return '@tui.database-backup'
    return '@tui.calendar-clock'
  }

  activityAppearance(
    activity: T.BackupActivity,
  ): 'positive' | 'warning' | 'negative' | 'neutral' {
    if (activity.state === 'succeeded') return 'positive'
    if (activity.state === 'partiallyFailed') return 'warning'
    if (activity.state === 'failed') return 'negative'
    return 'neutral'
  }

  serviceReports(activity: T.BackupActivity) {
    return Object.entries(activity.services).map(([packageId, value]) => ({
      packageId,
      value,
    }))
  }

  snapshotsFor(
    activity: T.BackupActivity,
    packageId: string,
  ): T.ServiceSnapshot[] {
    return Object.values(this.state()?.histories || {}).flatMap(history =>
      history.packageId === packageId && history.targetId === activity.targetId
        ? history.snapshots.filter(snapshot => snapshot.runId === activity.id)
        : [],
    )
  }

  reportSize(report: T.PackageBackupReport): string {
    const bytes = report.physical_size ?? report.logical_size
    return bytes === null ? '—' : convertBytes(bytes)
  }

  packageName(id: string): string {
    const state = this.packageData()?.[id]?.stateInfo
    const manifest =
      state?.state === 'installed' || state?.state === 'removing'
        ? state.manifest
        : state?.installingInfo?.newManifest
    return manifest?.title || id
  }

  targetName(id: string): string {
    const cifs = this.backupService.cifs().find(target => target.id === id)
    if (cifs) return formatCifsLocation(cifs.entry)
    const drive = this.backupService.drives().find(target => target.id === id)
    return drive
      ? [drive.entry.vendor, drive.entry.model].filter(Boolean).join(' ') ||
          drive.entry.logicalname
      : id
  }
}
