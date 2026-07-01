import { DatePipe } from '@angular/common'
import { Component, computed, inject, OnInit } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { i18nPipe } from '@start9labs/shared'
import { T } from '@start9labs/start-core'
import { TuiIcon, TuiNotification, TuiTitle } from '@taiga-ui/core'
import { TuiBadge } from '@taiga-ui/kit'
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
      <label>
        <span>{{ 'Show' | i18n }}</span>
        <select [(ngModel)]="historyFilter">
          <option value="all">{{ 'All activity' | i18n }}</option>
          <option value="manual">{{ 'Manual' | i18n }}</option>
          <option value="automatic">{{ 'Automatic' | i18n }}</option>
          <option value="restore">{{ 'Restore' | i18n }}</option>
        </select>
      </label>
    </section>

    <section class="timeline">
      @for (activity of filteredActivities(); track activity.id) {
        <details class="g-card activity">
          <summary>
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
          </summary>
          <div class="activity-details">
            <p>
              <b>{{ 'Backup location' | i18n }}:</b>
              {{ targetName(activity.targetId) }}
            </p>
            <p>
              <b>{{ 'Services' | i18n }}:</b>
              {{ activity.intendedServices.length }}
            </p>
            @if (activity.error) {
              <p class="error">{{ activity.error }}</p>
            }
          </div>
        </details>
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

    .history-toolbar label {
      display: grid;
      gap: 0.35rem;
      width: min(100%, 18rem);
      color: var(--tui-text-secondary);
    }

    .activity {
      padding: 0;
      overflow: hidden;
    }

    .activity summary {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem 1.25rem;
      cursor: pointer;
      list-style: none;
    }

    .activity summary > *,
    .activity summary [tuiTitle] {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .activity summary [tuiTitle] {
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

    @media (max-width: 30rem) {
      .history-toolbar label {
        width: 100%;
      }

      .activity summary {
        align-items: flex-start;
        flex-direction: column;
      }

      .activity summary > tui-icon,
      .activity summary > [tuiBadge] {
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
    FormsModule,
    TuiBadge,
    TuiIcon,
    TuiNotification,
    TuiTitle,
    i18nPipe,
  ],
})
export class BackupHistoryComponent implements OnInit {
  private readonly backupService = inject(BackupService)
  private readonly state = toSignal(
    inject<PatchDB<DataModel>>(PatchDB).watch$('scheduledBackups'),
  )

  historyFilter: HistoryFilter = 'all'
  readonly activities = computed(() =>
    Object.values(this.state()?.activities || {}).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    ),
  )

  ngOnInit() {
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
