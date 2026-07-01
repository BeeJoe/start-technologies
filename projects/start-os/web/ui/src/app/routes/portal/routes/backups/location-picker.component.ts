import { Component, computed, inject, input, output } from '@angular/core'
import { i18nPipe } from '@start9labs/shared'
import {
  TuiAppearance,
  TuiButton,
  TuiCell,
  TuiIcon,
  TuiTitle,
} from '@taiga-ui/core'
import {
  CifsBackupTarget,
  DiskBackupTarget,
} from 'src/app/services/api/api.types'
import {
  BackupService,
  formatCifsLocation,
  MappedBackupTarget,
} from '../system/routes/backups/backup.service'

type Location = MappedBackupTarget<CifsBackupTarget | DiskBackupTarget>

@Component({
  selector: 'backup-location-picker',
  template: `
    <div class="locations">
      @for (target of targets(); track target.location.id) {
        <button
          tuiCell
          tuiAppearance="outline-grayscale"
          type="button"
          [disabled]="!target.available"
          [class.selected]="selectedId() === target.location.id"
          (click)="selected.emit(target.location)"
        >
          <tui-icon [icon]="target.icon" />
          <span tuiTitle>
            <b>{{ target.name }}</b>
          </span>
          @if (selectedId() === target.location.id) {
            <tui-icon icon="@tui.circle-check" />
          }
          <span class="location-detail" tuiSubtitle>
            {{ target.detail }}
            @if (!target.available) {
              — {{ target.reason | i18n }}
            }
          </span>
        </button>
      } @empty {
        <p>{{ 'No backup locations are available.' | i18n }}</p>
      }
    </div>
    <button
      tuiButton
      type="button"
      appearance="secondary"
      (click)="manage.emit()"
    >
      {{ 'Add or repair a location' | i18n }}
    </button>
  `,
  styles: `
    :host,
    .locations {
      display: grid;
      gap: 0.5rem;
    }

    [tuiCell] {
      width: 100%;
      min-width: 0;
      max-width: 100%;
      gap: 0.75rem;
      overflow: hidden;
      text-align: left;
      box-sizing: border-box;
    }

    [tuiTitle] {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .location-detail {
      flex: 0 1 45%;
      min-width: 0;
      margin-inline-start: auto;
      overflow-wrap: anywhere;
      text-align: right;
    }

    .selected {
      box-shadow: inset 0 0 0 2px var(--tui-border-focus);
    }

    p {
      color: var(--tui-text-secondary);
    }

    @media (max-width: 30rem) {
      [tuiCell] {
        flex-wrap: wrap;
      }

      .location-detail {
        flex-basis: 100%;
        padding-inline-start: 2.25rem;
      }
    }
  `,
  imports: [TuiAppearance, TuiButton, TuiCell, TuiIcon, TuiTitle, i18nPipe],
})
export class BackupLocationPickerComponent {
  private readonly backupService = inject(BackupService)

  readonly mode = input.required<'automatic' | 'manual' | 'restore'>()
  readonly selectedId = input('')
  readonly selected = output<Location>()
  readonly manage = output<void>()

  readonly targets = computed(() => [
    ...this.backupService.cifs().map(location => ({
      location,
      name: location.entry.path.split('/').pop() || location.entry.path,
      detail: formatCifsLocation(location.entry),
      icon: '@tui.folder-network',
      available:
        location.entry.mountable &&
        (this.mode() !== 'restore' || location.hasAnyBackup),
      reason: !location.entry.mountable ? 'Unavailable' : 'No backups found',
    })),
    ...this.backupService.drives().map(location => ({
      location,
      name:
        [location.entry.vendor, location.entry.model]
          .filter(Boolean)
          .join(' ') || location.entry.logicalname,
      detail: `${location.entry.logicalname} · ${this.bytes(location.entry.capacity)}`,
      icon: '@tui.hard-drive',
      available:
        location.entry.capacity > 0 &&
        (this.mode() !== 'restore' || location.hasAnyBackup),
      reason: 'No backups found',
    })),
  ])

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
