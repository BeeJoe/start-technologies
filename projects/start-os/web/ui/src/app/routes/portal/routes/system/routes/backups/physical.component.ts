import { Component, inject, output } from '@angular/core'
import { ActivatedRoute } from '@angular/router'
import { DialogService, i18nPipe } from '@start9labs/shared'
import { TuiButton } from '@taiga-ui/core'
import { PlaceholderComponent } from 'src/app/routes/portal/components/placeholder.component'
import { TableComponent } from 'src/app/routes/portal/components/table.component'
import { DiskBackupTarget } from 'src/app/services/api/api.types'
import { BackupService, MappedBackupTarget } from './backup.service'
import { BackupLegacyWarningComponent } from './legacy-warning.component'
import { BackupStatusComponent } from './status.component'

@Component({
  selector: '[physicalFolders]',
  template: `
    <header>
      {{ 'Physical Drives' | i18n }}
    </header>

    <table [appTable]="['Status', 'Name', 'Capacity', 'Location', null]">
      @for (target of service.drives(); track $index) {
        <tr
          tabindex="0"
          (click)="select(target)"
          (keydown.enter)="select(target)"
        >
          <td>
            <span [backupStatus]="target.hasAnyBackup" [physical]="true"></span>
          </td>
          <td class="name">{{ driveName(target.entry) }}</td>
          <td>{{ formatCapacity(target.entry.capacity) }}</td>
          <td class="location">{{ target.entry.logicalname }}</td>
          <td (click)="$event.stopPropagation()">
            @if (
              type === 'create' &&
              target.hasAnyBackup &&
              target.entry.legacyBackup
            ) {
              <backup-legacy-warning [id]="target.id" />
            }
          </td>
        </tr>
      } @empty {
        <tr>
          <td class="empty-state" colspan="5">
            <app-placeholder icon="@tui.save-off">
              {{ 'No drives detected' | i18n }}
              <button
                tuiButton
                iconStart="@tui.refresh-cw"
                (click)="service.getBackupTargets()"
              >
                {{ 'Refresh' | i18n }}
              </button>
            </app-placeholder>
          </td>
        </tr>
      }
    </table>
  `,
  styles: `
    @use '@taiga-ui/styles/utils' as taiga;

    tr {
      @include taiga.transition(background);

      @media (taiga.$tui-mouse) {
        &:not(:has(app-placeholder)):hover:not(:has(button:hover)) {
          cursor: pointer;
          background: var(--tui-background-neutral-1-hover);
        }
      }
    }

    :host {
      width: 100%;
      min-width: 0;
    }

    table {
      width: 100%;
      table-layout: fixed;
    }

    td:first-child {
      width: 11rem;
    }

    td:last-child {
      width: 3.5rem;
      white-space: nowrap;
      text-align: right;
    }

    .name {
      justify-self: start;
      text-align: left;
    }

    .location {
      width: 10rem;
      justify-self: end;
      overflow-wrap: anywhere;
      text-align: right;
    }

    :host-context(tui-root._mobile) {
      table {
        table-layout: auto;
      }

      tr {
        grid-template-columns: auto minmax(0, 1fr) minmax(7rem, 45%);
        width: 100%;
        min-width: 0;
        white-space: normal;
      }

      td {
        min-width: 0;
        grid-column: span 2;
        overflow-wrap: anywhere;

        &:first-child:not(.empty-state) {
          font-size: 0;
          width: auto;
          grid-area: 1 / 1 / 3 / 2;
          place-content: center;
          margin: 0 0.5rem;
        }

        &:nth-child(3) {
          grid-area: 2 / 2;
        }

        &:last-child:not(.empty-state) {
          grid-column: 1 / -1;
          width: auto;
        }
      }

      .name {
        color: var(--tui-text-primary);
        font: var(--tui-typography-body-m);
        font-weight: bold;
        grid-area: 1 / 2;
        justify-self: start;
        max-width: 100%;
        text-align: left;
      }

      .location {
        grid-area: 1 / 3 / 3 / 4;
        justify-self: end;
        max-width: 100%;
        text-align: right;
      }

      .empty-state {
        grid-column: 1 / -1;
        justify-self: center;
        width: 100%;
        white-space: normal;
        text-align: center;
      }
    }
  `,
  host: { class: 'g-card' },
  imports: [
    TuiButton,
    PlaceholderComponent,
    BackupStatusComponent,
    BackupLegacyWarningComponent,
    TableComponent,
    i18nPipe,
  ],
})
export class BackupPhysicalComponent {
  private readonly dialog = inject(DialogService)
  protected readonly type = inject(ActivatedRoute).snapshot.data['type']

  private readonly i18n = inject(i18nPipe)

  readonly service = inject(BackupService)
  readonly physicalFolders = output<MappedBackupTarget<DiskBackupTarget>>()

  driveName(entry: DiskBackupTarget): string {
    return (
      [entry.vendor, entry.model].filter(Boolean).join(' ') ||
      this.i18n.transform('Unknown Drive')
    )
  }

  formatCapacity(bytes: number): string {
    const gb = bytes / 1e9
    if (gb >= 1000) {
      return `${(gb / 1000).toFixed(1)} TB`
    }
    return `${gb.toFixed(0)} GB`
  }

  select(target: MappedBackupTarget<DiskBackupTarget>) {
    if (this.type === 'restore' && !target.hasAnyBackup) {
      this.dialog
        .openAlert('Drive partition does not contain a valid backup')
        .subscribe()
    } else {
      this.physicalFolders.emit(target)
    }
  }
}
