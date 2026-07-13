import { DatePipe, KeyValuePipe } from '@angular/common'
import { Component, inject, OnInit } from '@angular/core'
import { DialogService, i18nPipe, TaskService } from '@start9labs/shared'
import { TuiButton } from '@taiga-ui/core'
import { injectContext, PolymorpheusComponent } from '@taiga-ui/polymorpheus'
import { filter, switchMap, take } from 'rxjs'
import { TableComponent } from 'src/app/routes/portal/components/table.component'
import { ApiService } from 'src/app/services/api/embassy-api.service'
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
              <button tuiButton size="s" (click)="onClick(server.key)">
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
  private readonly context = injectContext<BackupContext>()

  readonly target = this.context.data
  readonly servers = Object.entries(this.target.entry.startOs)

  ngOnInit() {
    const server = this.servers[0]
    if (this.servers.length === 1 && server) {
      queueMicrotask(() => this.onClick(server[0]))
    }
  }

  onClick(serverId: string) {
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
      .pipe(
        filter(Boolean),
        switchMap(password => this.decrypt(serverId, password)),
        filter(Boolean), // a password the server rejects leaves the prompt open to retry
        take(1),
      )
      .subscribe()
  }

  private decrypt(serverId: string, password: string) {
    return this.tasks.run(async () => {
      const params = { targetId: this.target.id, serverId, password }
      const [manual, automatic] = await Promise.allSettled([
        this.api.getBackupInfo(params),
        this.api.discoverScheduledBackupHistories(params),
      ])

      if (manual.status === 'rejected' && automatic.status === 'rejected') {
        throw manual.reason
      }

      const backupInfo =
        manual.status === 'fulfilled'
          ? manual.value
          : { version: '', timestamp: null, packageBackups: {} }
      const scheduledHistories =
        automatic.status === 'fulfilled' ? automatic.value : []

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
    }, 'Decrypting drive')
  }
}

export const BACKUP_RESTORE = new PolymorpheusComponent(BackupRestoreComponent)
