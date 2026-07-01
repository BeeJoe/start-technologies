import { AsyncPipe } from '@angular/common'
import {
  Component,
  computed,
  inject,
  input,
  OnInit,
  output,
} from '@angular/core'
import { ActivatedRoute, RouterLink } from '@angular/router'
import { DialogService, DocsLinkDirective, i18nPipe } from '@start9labs/shared'
import { T } from '@start9labs/start-core'
import { TuiButton, TuiLoader, TuiTitle } from '@taiga-ui/core'
import { TuiHeader } from '@taiga-ui/layout'
import { firstValueFrom } from 'rxjs'
import {
  CifsBackupTarget,
  DiskBackupTarget,
} from 'src/app/services/api/api.types'
import { OSService } from 'src/app/services/os.service'
import { TitleDirective } from 'src/app/services/title.service'
import { BACKUP } from './backup.component'
import { BackupService, MappedBackupTarget } from './backup.service'
import { LEGACY_BACKUP } from './legacy.component'
import { BackupLocationPickerComponent } from '../../../backups/location-picker.component'
import { BackupProgressComponent } from './progress.component'
import { BACKUP_RESTORE } from './restore.component'

@Component({
  selector: 'system-backup',
  template: `
    @if (!embedded()) {
      <ng-container *title>
        <div>
          <a routerLink=".." tuiIconButton iconStart="@tui.arrow-left">
            {{ 'Back' | i18n }}
          </a>
          {{
            type() === 'create'
              ? ('Create a manual backup' | i18n)
              : ('Restore from a backup' | i18n)
          }}
          <a
            tuiIconButton
            size="xs"
            docsLink
            [path]="
              type() === 'create'
                ? '/start-os/backup-create.html'
                : '/start-os/backup-restore.html'
            "
            appearance="icon"
            iconStart="@tui.book-open-text"
          ></a>
        </div>
      </ng-container>

      <header tuiHeader>
        <hgroup tuiTitle>
          <h3>
            {{
              type() === 'create'
                ? ('Create a manual backup' | i18n)
                : ('Restore from a backup' | i18n)
            }}
          </h3>
        </hgroup>
      </header>
    }

    @if (type() === 'create' && (os.backingUp$ | async)) {
      @if (!embedded()) {
        <section backupProgress></section>
      }
    } @else {
      @if (service.loading()) {
        <tui-loader
          textContent="Fetching backups"
          size="l"
          [style.height.rem]="20"
        />
      } @else {
        <backup-location-picker
          [mode]="type() === 'create' ? 'manual' : 'restore'"
          (selected)="onTarget($event)"
          (manage)="manageLocations.emit()"
        />
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

    :host-context(tui-root._mobile) [tuiHeader] {
      display: none;
    }
  `,
  host: { class: 'backup-page' },
  imports: [
    AsyncPipe,
    RouterLink,
    TuiButton,
    TuiLoader,
    TuiHeader,
    TuiTitle,
    TitleDirective,
    BackupLocationPickerComponent,
    BackupProgressComponent,
    i18nPipe,
    DocsLinkDirective,
  ],
})
export default class SystemBackupComponent implements OnInit {
  readonly mode = input<'create' | 'restore'>()
  readonly embedded = input(false)
  readonly manageLocations = output<void>()
  readonly dialog = inject(DialogService)
  private readonly route = inject(ActivatedRoute)
  readonly type = computed(
    () =>
      this.mode() || (this.route.snapshot.data['type'] as 'create' | 'restore'),
  )
  readonly service = inject(BackupService)
  readonly os = inject(OSService)
  ngOnInit() {
    this.service.getBackupTargets()
  }

  async onTarget(
    target: MappedBackupTarget<CifsBackupTarget | DiskBackupTarget>,
  ) {
    if (this.type() === 'create') {
      if (!(await this.confirmLegacy(target.entry.legacyBackup))) return

      this.dialog
        .openComponent(BACKUP, {
          label: 'Select services',
          data: target,
          size: 'm',
        })
        .subscribe()
    } else {
      this.dialog
        .openComponent(BACKUP_RESTORE, {
          label: 'Select server',
          data: target,
          size: 'l',
        })
        .subscribe()
    }
  }

  private confirmLegacy(legacy: T.LegacyBackupInfo | null): Promise<boolean> {
    if (!legacy) return Promise.resolve(true)

    return firstValueFrom(
      this.dialog.openComponent<boolean>(LEGACY_BACKUP, {
        label: 'Important!',
        size: 'm',
        data: { fits: legacy.size <= legacy.available },
      }),
      { defaultValue: false },
    )
  }
}
