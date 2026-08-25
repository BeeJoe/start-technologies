import { DatePipe, KeyValuePipe } from '@angular/common'
import { Component, inject } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { DialogService, i18nPipe, TaskService } from '@start9labs/shared'
import { TuiButton, TuiInput, TuiTitle } from '@taiga-ui/core'
import { injectContext, PolymorpheusComponent } from '@taiga-ui/polymorpheus'
import { TableComponent } from 'src/app/routes/portal/components/table.component'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { BackupContext } from './backup.types'
import { RECOVER } from './recover.component'

@Component({
  template: `
    @if (!serverId) {
      <table [appTable]="['Hostname', 'StartOS Version', 'Created', null]">
        @for (server of target.entry.startOs | keyvalue; track server.key) {
          <tr>
            <td class="name">{{ server.value.hostname }}.local</td>
            <td>{{ server.value.version }}</td>
            <td>{{ server.value.timestamp | date: 'medium' }}</td>
            <td>
              <button tuiButton size="s" (click)="serverId = server.key">
                {{ 'Select' | i18n }}
              </button>
            </td>
          </tr>
        }
      </table>
    } @else {
      <section class="unlock-flow">
        <span tuiTitle>
          <b>{{ 'Master Password' | i18n }}</b>
          <span tuiSubtitle>
            {{ selectedServerName() }} ·
            {{
              'Enter the master password that was used to encrypt this backup.'
                | i18n
            }}
          </span>
        </span>
        <tui-textfield>
          <label tuiLabel>{{ 'Master Password' | i18n }}</label>
          <input
            tuiInput
            required
            autocomplete="current-password"
            [type]="passwordMasked ? 'password' : 'text'"
            [(ngModel)]="password"
            (keyup.enter)="decrypt()"
          />
          <button
            tuiIconButton
            type="button"
            size="xs"
            appearance="icon"
            [iconStart]="passwordMasked ? '@tui.eye' : '@tui.eye-off'"
            (click)="passwordMasked = !passwordMasked"
          >
            {{ (passwordMasked ? 'Show password' : 'Hide password') | i18n }}
          </button>
        </tui-textfield>
        <footer class="g-buttons">
          @if (servers.length > 1) {
            <button
              tuiButton
              type="button"
              appearance="flat"
              (click)="serverId = ''"
            >
              {{ 'Back' | i18n }}
            </button>
          }
          <button tuiButton [disabled]="!password" (click)="decrypt()">
            {{ 'Continue' | i18n }}
          </button>
        </footer>
      </section>
    }
  `,
  styles: `
    td:last-child {
      text-align: end;
    }

    .unlock-flow {
      display: grid;
      gap: 1rem;
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
  imports: [
    DatePipe,
    FormsModule,
    KeyValuePipe,
    TuiButton,
    TuiInput,
    TuiTitle,
    TableComponent,
    i18nPipe,
  ],
})
export class BackupRestoreComponent {
  private readonly dialog = inject(DialogService)
  private readonly tasks = inject(TaskService)
  private readonly api = inject(ApiService)
  private readonly context = injectContext<BackupContext>()
  private readonly i18n = inject(i18nPipe)

  protected readonly target = this.context.data
  protected readonly servers = Object.entries(this.target.entry.startOs)
  protected serverId = this.servers.length === 1 ? this.servers[0]![0] : ''
  protected password = ''
  protected passwordMasked = true

  protected selectedServerName(): string {
    const server = this.target.entry.startOs[this.serverId]
    return server ? `${server.hostname}.local` : this.serverId
  }

  protected async decrypt() {
    if (!this.serverId || !this.password) return
    await this.tasks.run(async () => {
      const params = {
        targetId: this.target.id,
        serverId: this.serverId,
        password: this.password,
      }
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
        throw new Error(
          this.i18n.transform('No restorable checkpoints were found'),
        )
      }

      const data = {
        targetId: this.target.id,
        serverId: this.serverId,
        backupInfo,
        scheduledHistories,
        password: this.password,
      }

      this.context.$implicit.complete()
      this.dialog
        .openComponent(RECOVER, { label: 'Select services', data })
        .subscribe()
    }, 'Decrypting drive')
  }
}

export const BACKUP_RESTORE = new PolymorpheusComponent(BackupRestoreComponent)
