import { Component, inject, output } from '@angular/core'
import { ActivatedRoute } from '@angular/router'
import { DialogService, ErrorService, i18nPipe } from '@start9labs/shared'
import { ISB, T } from '@start9labs/start-core'
import { TuiButton, TuiDataList, TuiDropdown, TuiIcon } from '@taiga-ui/core'
import { TuiNotificationMiddleService } from '@taiga-ui/kit'
import { filter } from 'rxjs'
import { FormComponent } from 'src/app/routes/portal/components/form.component'
import { PlaceholderComponent } from 'src/app/routes/portal/components/placeholder.component'
import { TableComponent } from 'src/app/routes/portal/components/table.component'
import { CifsBackupTarget } from 'src/app/services/api/api.types'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { FormDialogService } from 'src/app/services/form-dialog.service'
import { configBuilderToSpec } from 'src/app/utils/configBuilderToSpec'
import {
  BackupService,
  formatCifsLocation,
  MappedBackupTarget,
} from './backup.service'
import { BackupLegacyWarningComponent } from './legacy-warning.component'
import { BackupStatusComponent } from './status.component'

const ERROR =
  'Ensure (1) target computer is connected to the same LAN as your Start9 Server, (2) target folder is being shared, and (3) hostname, path, and credentials are accurate.'

@Component({
  selector: '[networkFolders]',
  template: `
    <header>
      {{ 'Network Folders' | i18n }}
      <button
        tuiButton
        size="xs"
        iconStart="@tui.plus"
        [style.margin-inline-start]="'auto'"
        (click)="add()"
      >
        {{ 'New' | i18n }}
      </button>
    </header>

    <table [appTable]="['Status', 'Name', 'Location', null]">
      @for (target of service.cifs(); track $index) {
        <tr
          tabindex="0"
          (click)="select(target)"
          (keydown.enter)="select(target)"
        >
          <td>
            @if (target.entry.mountable) {
              <span [backupStatus]="target.hasAnyBackup"></span>
            } @else {
              <span>
                <tui-icon
                  icon="@tui.signal-high"
                  class="g-negative"
                  [style.font-size.rem]="1"
                />
                Unable to connect
              </span>
            }
          </td>
          <td class="name">{{ target.entry.path.split('/').pop() }}</td>
          <td class="location">{{ locationName(target.entry) }}</td>
          <td (click)="$event.stopPropagation()">
            @if (
              type === 'create' &&
              target.entry.mountable &&
              target.hasAnyBackup &&
              target.entry.legacyBackup
            ) {
              <backup-legacy-warning [id]="target.id" />
            }
            <button
              tuiIconButton
              tuiDropdown
              size="s"
              appearance="flat-grayscale"
              iconStart="@tui.ellipsis-vertical"
              [tuiDropdownOpen]="!!opens[$index]"
              (tuiDropdownOpenChange)="opens[$index] = $event"
            >
              {{ 'More' | i18n }}
              <tui-data-list class="backup-menu" *tuiDropdown>
                <button tuiOption (click)="edit(target)">
                  {{ 'Edit' | i18n }}
                </button>
                <button
                  tuiOption
                  class="g-negative"
                  (click)="forget(target, $index)"
                >
                  {{ 'Delete' | i18n }}
                </button>
              </tui-data-list>
            </button>
          </td>
        </tr>
      } @empty {
        <tr class="empty-row">
          <td class="empty-state" colspan="4">
            <app-placeholder icon="@tui.folder-x">
              <span class="empty-label">
                {{ 'No network folders' | i18n }}
              </span>
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

    td:nth-child(2) {
      width: 28%;
    }

    .name {
      justify-self: start;
      text-align: left;
    }

    .location {
      justify-self: start;
      overflow-wrap: anywhere;
      text-align: left;
    }

    .empty-row {
      width: 100%;
    }

    .empty-state {
      text-align: center;
    }

    .empty-state app-placeholder {
      width: 100%;
      margin-inline: auto;
      box-sizing: border-box;
      padding: 0;
      gap: 0.25rem;
    }

    .empty-label {
      display: block;
      width: 100%;
      max-width: 100%;
      min-height: 1.5rem;
      flex-shrink: 0;
      line-height: 1.5rem;
      overflow-wrap: anywhere;
      text-align: center;
    }

    td:last-child {
      width: 3.5rem;
      white-space: nowrap;
      text-align: right;
    }

    span {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    :host-context(tui-root._mobile) {
      table {
        table-layout: auto;
      }

      tr {
        grid-template-columns: auto minmax(0, 1fr) minmax(7rem, 45%) auto;
        width: 100%;
        min-width: 0;
        white-space: normal;
      }

      tr.empty-row {
        grid-template-columns: minmax(0, 1fr);
      }

      td {
        min-width: 0;
        grid-column: span 2;
        overflow-wrap: anywhere;

        &:first-child:not(:only-child) {
          font-size: 0;
          width: auto;
          grid-area: 1 / 1;
          place-content: center;
          margin: 0 0.5rem;
        }

        &:last-child {
          grid-area: 1 / 4;
          align-self: center;
          justify-self: end;
        }
      }

      .name {
        color: var(--tui-text-primary);
        font: var(--tui-typography-body-m);
        font-weight: bold;
        grid-column: 2;
        justify-self: start;
        max-width: 100%;
        text-align: left;
      }

      .location {
        grid-column: 3;
        justify-self: end;
        max-width: 100%;
        text-align: right;
      }

      .empty-row > td.empty-state {
        grid-area: 1 / 1 / auto / -1;
        justify-self: stretch;
        width: auto;
        margin: 0;
        overflow: visible;
        white-space: normal;
        text-align: center;
      }
    }
  `,
  host: { class: 'g-card' },
  imports: [
    TuiButton,
    TuiDataList,
    TuiDropdown,
    TuiIcon,
    PlaceholderComponent,
    BackupStatusComponent,
    BackupLegacyWarningComponent,
    TableComponent,
    i18nPipe,
  ],
})
export class BackupNetworkComponent {
  private readonly dialog = inject(DialogService)
  private readonly formDialog = inject(FormDialogService)
  private readonly api = inject(ApiService)
  private readonly loader = inject(TuiNotificationMiddleService)
  private readonly errorService = inject(ErrorService)
  protected readonly type = inject(ActivatedRoute).snapshot.data['type']
  private readonly i18n = inject(i18nPipe)

  readonly service = inject(BackupService)
  readonly networkFolders = output<MappedBackupTarget<CifsBackupTarget>>()

  opens: Record<number, boolean> = {}

  locationName(target: CifsBackupTarget): string {
    return formatCifsLocation(target)
  }

  select(target: MappedBackupTarget<CifsBackupTarget>) {
    if (!target.entry.mountable) {
      this.dialog.openAlert(ERROR, { label: 'Unable to connect' }).subscribe()
    } else if (this.type === 'restore' && !target.hasAnyBackup) {
      this.dialog
        .openAlert('Network Folder does not contain a valid backup')
        .subscribe()
    } else {
      this.networkFolders.emit(target)
    }
  }

  async add() {
    this.formDialog.open(FormComponent, {
      label: 'New Network Folder',
      data: {
        spec: await configBuilderToSpec(this.cifsSpec()),
        buttons: [
          {
            text: this.i18n.transform('Connect'),
            handler: (value: T.CifsAddParams) => this.addTarget(value),
          },
        ],
      },
    })
  }

  async edit(target: MappedBackupTarget<CifsBackupTarget>) {
    this.formDialog.open(FormComponent, {
      label: 'Update Network Folder',
      data: {
        spec: await configBuilderToSpec(this.cifsSpec()),
        buttons: [
          {
            text: this.i18n.transform('Connect'),
            handler: async (value: T.CifsAddParams) => {
              const loader = this.loader
                .open('Testing connectivity to shared folder')
                .subscribe()

              try {
                const res = await this.api.updateBackupTarget({
                  id: target.id,
                  ...value,
                })

                target.entry = Object.values(res)[0]!
                this.service.cifs.update(cifs => [...cifs])
                return true
              } catch (e: any) {
                this.errorService.handleError(e)
                return false
              } finally {
                loader.unsubscribe()
              }
            },
          },
        ],
        value: { ...target.entry },
      },
    })
  }

  forget({ id }: MappedBackupTarget<CifsBackupTarget>, index: number) {
    this.dialog
      .openConfirm({ label: 'Are you sure?', size: 's' })
      .pipe(filter(Boolean))
      .subscribe(async () => {
        const loader = this.loader.open('Removing').subscribe()

        try {
          await this.api.removeBackupTarget({ id })
          this.service.cifs.update(cifs => cifs.filter((_, i) => i !== index))
        } catch (e: any) {
          this.errorService.handleError(e)
        } finally {
          loader.unsubscribe()
        }
      })
  }

  private async addTarget(v: T.CifsAddParams): Promise<boolean> {
    const loader = this.loader
      .open('Testing connectivity to shared folder')
      .subscribe()

    try {
      const [item] = Object.entries(await this.api.addBackupTarget(v))
      const [id, entry] = item || []

      if (!id || !entry) {
        throw 'Invalid response from server'
      }

      const hasAnyBackup = this.service.hasAnyBackup(entry)
      const added = { id, entry, hasAnyBackup }
      this.service.cifs.update(cifs => [added, ...cifs])
      return true
    } catch (e: any) {
      this.errorService.handleError(e)
      return false
    } finally {
      loader.unsubscribe()
    }
  }

  cifsSpec() {
    return ISB.InputSpec.of({
      hostname: ISB.Value.text({
        name: this.i18n.transform('Hostname')!,
        description: this.i18n.transform(
          'The hostname of your target device on the Local Area Network.',
        ),
        warning: null,
        placeholder: `e.g. 'My Computer' OR 'my-computer.local'`,
        required: true,
        default: null,
        patterns: [],
      }),
      path: ISB.Value.text({
        name: this.i18n.transform('Path')!,
        description: this.i18n.transform(
          'On Windows, this is the fully qualified path to the shared folder, (e.g. /Desktop/my-folder). On Linux and Mac, this is the literal name of the shared folder (e.g. my-shared-folder).',
        ),
        placeholder: 'e.g. my-shared-folder or /Desktop/my-folder',
        required: true,
        default: null,
      }),
      username: ISB.Value.text({
        name: this.i18n.transform('Username')!,
        description: this.i18n.transform(
          'On Linux, this is the samba username you created when sharing the folder. On Mac and Windows, this is the username of the user who is sharing the folder.',
        ),
        required: true,
        default: null,
      }),
      password: ISB.Value.text({
        name: this.i18n.transform('Password')!,
        description: this.i18n.transform(
          'On Linux, this is the samba password you created when sharing the folder. On Mac and Windows, this is the password of the user who is sharing the folder.',
        ),
        required: false,
        default: null,
        masked: true,
      }),
    })
  }
}
