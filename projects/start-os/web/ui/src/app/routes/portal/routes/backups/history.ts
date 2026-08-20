import { DatePipe, DecimalPipe } from '@angular/common'
import { Component, computed, inject } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { convertBytes, i18nPipe } from '@start9labs/shared'
import { T } from '@start9labs/start-core'
import {
  TuiDataList,
  TuiIcon,
  TuiInput,
  TuiLabel,
  TuiNotification,
  TuiTitle,
} from '@taiga-ui/core'
import {
  TuiAccordion,
  TuiBadge,
  TuiChevron,
  TuiPagination,
  TuiSelect,
} from '@taiga-ui/kit'
import { PatchDB } from 'patch-db-client'
import { DataModel } from 'src/app/services/patch-db/data-model'
import {
  BackupService,
  formatCifsLocation,
} from '../system/routes/backups/backup.service'

type HistoryFilter = 'all' | T.BackupActivityKind
type StatusFilter = 'all' | T.BackupRunState

@Component({
  selector: 'backup-history',
  template: `
    <section class="history-toolbar">
      <tui-textfield class="history-search">
        <label tuiLabel>{{ 'Search date, status, or service' | i18n }}</label>
        <input tuiInput [ngModel]="query" (ngModelChange)="setQuery($event)" />
      </tui-textfield>
      <tui-textfield
        tuiChevron
        [stringify]="stringifyFilter"
        [tuiTextfieldCleaner]="false"
      >
        <label tuiLabel>{{ 'Show' | i18n }}</label>
        <input
          tuiSelect
          [ngModel]="historyFilter"
          (ngModelChange)="setHistoryFilter($event)"
        />
        <tui-data-list *tuiDropdown>
          @for (filter of historyFilters; track filter) {
            <button tuiOption [value]="filter">
              {{ stringifyFilter(filter) }}
            </button>
          }
        </tui-data-list>
      </tui-textfield>
      <tui-textfield
        tuiChevron
        [stringify]="stringifyStatusFilter"
        [tuiTextfieldCleaner]="false"
      >
        <label tuiLabel>{{ 'Status' | i18n }}</label>
        <input
          tuiSelect
          [ngModel]="statusFilter"
          (ngModelChange)="setStatusFilter($event)"
        />
        <tui-data-list *tuiDropdown>
          @for (status of statusFilters; track status) {
            <button tuiOption [value]="status">
              {{ stringifyStatusFilter(status) }}
            </button>
          }
        </tui-data-list>
      </tui-textfield>
    </section>

    <section class="timeline">
      @for (activity of pagedActivities(); track activity.id) {
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
              @if (
                activity.state === 'partiallyFailed' ||
                activity.state === 'failed'
              ) {
                <div
                  tuiNotification
                  [appearance]="activityAppearance(activity)"
                >
                  {{ failureSummary(activity) | i18n }}
                </div>
              }
              @for (
                report of serviceReports(activity);
                track report.packageId
              ) {
                <section class="service-report">
                  <b>{{ packageName(report.packageId) }}</b>
                  @if (report.value.error) {
                    <p class="error">
                      {{ 'This service did not complete successfully.' | i18n }}
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
              @if (technicalErrors(activity); as errors) {
                @if (errors.length) {
                  <tui-accordion class="technical-details">
                    <button tuiAccordion>
                      {{ 'Technical details' | i18n }}
                    </button>
                    <tui-expand>
                      @for (error of errors; track error.label) {
                        <p>
                          <b>{{ error.label }}:</b>
                          <span class="technical-error">
                            {{ error.detail }}
                          </span>
                        </p>
                      }
                    </tui-expand>
                  </tui-accordion>
                }
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
    @if (pageCount() > 1) {
      <tui-pagination
        [length]="pageCount()"
        [index]="page"
        (indexChange)="page = $event"
      />
    }
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
      display: grid;
      grid-template-columns: minmax(14rem, 1fr) repeat(2, minmax(10rem, 14rem));
      gap: 0.75rem;
    }

    .history-toolbar tui-textfield {
      width: 100%;
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
      min-height: 3.5rem;
      height: auto;
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

    .technical-details {
      margin-block-start: 0.75rem;
    }

    .technical-error {
      display: block;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
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
      .history-toolbar {
        grid-template-columns: 1fr;
      }

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
    TuiInput,
    TuiLabel,
    TuiNotification,
    TuiTitle,
    TuiSelect,
    TuiPagination,
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
  protected statusFilter: StatusFilter = 'all'
  protected query = ''
  protected page = 0
  private readonly pageSize = 20
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
  protected readonly statusFilters: StatusFilter[] = [
    'all',
    'running',
    'succeeded',
    'partiallyFailed',
    'failed',
  ]
  protected readonly stringifyStatusFilter = (status: StatusFilter) =>
    this.i18n.transform(
      status === 'all' ? 'All statuses' : this.activityStateValue(status),
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
    const query = this.query.trim().toLocaleLowerCase()
    return this.activities().filter(activity => {
      const kindMatches =
        this.historyFilter === 'all' || activity.kind === this.historyFilter
      const statusMatches =
        this.statusFilter === 'all' || activity.state === this.statusFilter
      return kindMatches && statusMatches && this.matchesQuery(activity, query)
    })
  }

  pagedActivities(): T.BackupActivity[] {
    const activities = this.filteredActivities()
    const page = Math.min(this.page, Math.max(0, this.pageCount() - 1))
    return activities.slice(page * this.pageSize, (page + 1) * this.pageSize)
  }

  pageCount(): number {
    return Math.ceil(this.filteredActivities().length / this.pageSize)
  }

  setQuery(query: string) {
    this.query = query
    this.page = 0
  }

  setHistoryFilter(filter: HistoryFilter) {
    this.historyFilter = filter
    this.page = 0
  }

  setStatusFilter(filter: StatusFilter) {
    this.statusFilter = filter
    this.page = 0
  }

  activityLabel(activity: T.BackupActivity): string {
    if (activity.kind === 'manual') return 'Manual backup'
    if (activity.kind === 'restore') return 'Restore'
    return activity.jobName || 'Automatic backup'
  }

  activityState(activity: T.BackupActivity): string {
    return this.activityStateValue(activity.state)
  }

  private activityStateValue(state: T.BackupRunState): string {
    switch (state) {
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

  failureSummary(activity: T.BackupActivity): string {
    if (activity.state === 'partiallyFailed') {
      return 'Some services did not complete successfully. Review the affected services and try again.'
    }
    return activity.kind === 'restore'
      ? 'The restore did not complete. Check the password and backup location, then try again.'
      : 'The backup did not complete. Check the password and backup location, then try again.'
  }

  technicalErrors(
    activity: T.BackupActivity,
  ): { label: string; detail: string }[] {
    return [
      ...(activity.error
        ? [{ label: this.i18n.transform('Operation'), detail: activity.error }]
        : []),
      ...this.serviceReports(activity).flatMap(report =>
        report.value.error
          ? [
              {
                label: this.packageName(report.packageId),
                detail: report.value.error,
              },
            ]
          : [],
      ),
    ]
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

  private matchesQuery(activity: T.BackupActivity, query: string): boolean {
    if (!query) return true
    const terms = [
      activity.startedAt,
      new Date(activity.startedAt).toLocaleString(),
      this.activityState(activity),
      this.stringifyFilter(activity.kind),
      this.activityLabel(activity),
      this.targetName(activity.targetId),
      ...activity.intendedServices.flatMap(id => [id, this.packageName(id)]),
    ]
    return terms.some(term => term.toLocaleLowerCase().includes(query))
  }
}
