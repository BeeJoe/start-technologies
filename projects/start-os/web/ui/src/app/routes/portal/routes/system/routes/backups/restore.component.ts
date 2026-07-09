import { DatePipe, KeyValuePipe } from '@angular/common'
import { Component, inject, OnInit } from '@angular/core'
import {
  DialogService,
  ErrorService,
  i18nPipe,
  StartOSDiskInfo,
  TaskService,
} from '@start9labs/shared'
import { TuiButton } from '@taiga-ui/core'
import { injectContext, PolymorpheusComponent } from '@taiga-ui/polymorpheus'
import { TableComponent } from 'src/app/routes/portal/components/table.component'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { verifyPassword } from 'src/app/utils/verify-password'
import { BackupContext } from './backup.types'
import { RECOVER } from './recover.component'

@Component({
  template: `
    @if (servers.length > 1) {
      <table [appTable]="['Hostname', 'StartOS Version', 'Created', null]">
        @for (server of target.entry.startOs | keyvalue; track $index) {
          <tr>
            <td class="name">{{ server.value.hostname }}.local</td>
            <td>{{ server.value.version }}</td>
            <td>{{ server.value.timestamp | date: 'medium' }}</td>
            <td>
              <button
                tuiButton
                size="s"
                (click)="onClick(server.key, server.value)"
              >
                {{ 'Select' | i18n }}
              </button>
            </td>
          </tr>
        }
      </table>
    } @else {
      <p>{{ 'Loading' | i18n }}…</p>
    }
  `,
  styles: `
    td:last-child {
      text-align: right;
    }

    :host-context(tui-root._mobile) {
      tr {
        grid-template-columns: 1fr auto;
      }

      .name {
        color: var(--tui-text-primary);
        font: var(--tui-typography-body-m);
        font-weight: bold;
      }

      td:last-child {
        grid-area: 1 / 2 / 4 / 2;
        align-self: center;
      }
    }
  `,
  imports: [KeyValuePipe, DatePipe, TuiButton, TableComponent, i18nPipe],
})
export class BackupRestoreComponent implements OnInit {
  private readonly dialog = inject(DialogService)
  private readonly tasks = inject(TaskService)
  private readonly api = inject(ApiService)
  private readonly errorService = inject(ErrorService)
  private readonly context = injectContext<BackupContext>()

  readonly target = this.context.data
  readonly servers = Object.entries(this.target.entry.startOs)

  ngOnInit() {
    const server = this.servers[0]
    if (this.servers.length === 1 && server) {
      queueMicrotask(() => this.onClick(server[0], server[1]))
    }
  }

  onClick(serverId: string, { passwordHash }: StartOSDiskInfo) {
    this.dialog
      .openPrompt<string>({
        label: 'Password required',
        data: {
          message:
            'Enter the master password that was used to encrypt this backup. On the next screen, you will select the individual services you want to restore.',
          label: 'Master Password',
          placeholder: 'Enter master password',
          useMask: true,
        },
      })
      .pipe(verifyPassword(passwordHash, e => this.errorService.handleError(e)))
      .subscribe(password =>
        this.tasks.run(async () => {
          const params = { targetId: this.target.id, serverId, password }
          const [backupInfo, scheduledHistories] = await Promise.all([
            this.api.getBackupInfo(params).catch(() => ({
              version: '',
          timestamp: null,
          packageBackups: {},
        })),
        this.api
          .discoverScheduledBackupHistories({
            targetId: this.target.id,
            serverId,
            password,
          })
              .catch(() => []),
          ])
          if (
            !Object.keys(backupInfo.packageBackups).length &&
        !scheduledHistories.length
      ) {
        throw new Error('No restorable checkpoints were found')
      }
      const data = {
        targetId: this.target.id,
        serverId,
        backupInfo,
        scheduledHistories,
        password,
      }

          this.context.$implicit.complete()
          this.dialog
            .openComponent(RECOVER, { label: 'Select services', data })
            .subscribe()
        }, 'Decrypting drive'),
      )
  }
}

export const BACKUP_RESTORE = new PolymorpheusComponent(BackupRestoreComponent)
