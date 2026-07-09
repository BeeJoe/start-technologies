import { Component, inject } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { verify } from '@start9labs/argon2'
import {
  DialogService,
  ErrorService,
  i18nPipe,
  TaskService,
} from '@start9labs/shared'
import {
  TuiButton,
  TuiCheckbox,
  TuiGroup,
  TuiLoader,
  TuiNotification,
  TuiTitle,
} from '@taiga-ui/core'
import { TuiBlock } from '@taiga-ui/kit'
import { injectContext, PolymorpheusComponent } from '@taiga-ui/polymorpheus'
import { PatchDB } from 'patch-db-client'
import { map, take } from 'rxjs'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { DataModel } from 'src/app/services/patch-db/data-model'
import { getManifest } from 'src/app/utils/get-package-data'
import { getServerInfo } from 'src/app/utils/get-server-info'
import { verifyPassword } from 'src/app/utils/verify-password'
import { BackupService } from './backup.service'
import { BackupContext } from './backup.types'

interface Package {
  id: string
  title: string
  icon: string
  disabled: boolean
  checked: boolean
}

@Component({
  template: `
    <div tuiNotification appearance="warning">
      {{
        'For each selected service, this replaces its previous manual checkpoint. Automatic checkpoints are not changed.'
          | i18n
      }}
    </div>
    <div tuiGroup orientation="vertical" [collapsed]="true">
      @if (pkgs(); as pkgs) {
        @for (pkg of pkgs; track $index) {
          <label tuiBlock="m">
            <input
              type="checkbox"
              tuiCheckbox
              [disabled]="pkg.disabled"
              [(ngModel)]="pkg.checked"
              (ngModelChange)="handleChange()"
            />
            <img alt="" [src]="pkg.icon" />
            <span tuiTitle>{{ pkg.title }}</span>
          </label>
        } @empty {
          {{ 'No services installed' | i18n }}
        }
      } @else {
        <tui-loader />
      }
    </div>
    <footer class="g-buttons">
      <label class="toggle-all">
        <input
          tuiCheckbox
          type="checkbox"
          [ngModel]="allEligibleSelected()"
          (ngModelChange)="setAll($event)"
        />
        <span tuiTitle>
          <b>{{ 'Toggle all' | i18n }}</b>
        </span>
      </label>
      <button tuiButton [disabled]="!hasSelection" (click)="done()">
        {{ 'Done' | i18n }}
      </button>
    </footer>
  `,
  styles: `
    [tuiGroup] {
      width: 100%;
      margin: 1.5rem 0 0;
    }

    [tuiBlock] {
      align-items: center;
    }

    [tuiTitle] {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    img {
      width: 2.5rem;
      border-radius: 100%;
    }

    .toggle-all {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      margin-right: auto;
    }
  `,
  host: { class: 'backup-settings' },
  imports: [
    FormsModule,
    TuiButton,
    TuiGroup,
    TuiLoader,
    TuiNotification,
    TuiBlock,
    TuiCheckbox,
    TuiTitle,
    i18nPipe,
  ],
})
export class BackupsBackupComponent {
  private readonly dialog = inject(DialogService)
  private readonly tasks = inject(TaskService)
  private readonly errorService = inject(ErrorService)
  private readonly api = inject(ApiService)
  private readonly patch = inject<PatchDB<DataModel>>(PatchDB)
  private readonly service = inject(BackupService)
  private readonly i18n = inject(i18nPipe)

  readonly context = injectContext<BackupContext>()

  hasSelection = false
  readonly pkgs = toSignal<readonly Package[] | null>(
    this.patch.watch$('packageData').pipe(
      take(1),
      map(pkgs =>
        Object.values(pkgs)
          .map(pkg => {
            const { id, title } = getManifest(pkg)
            return {
              id,
              title,
              icon: pkg.icon,
              disabled: pkg.stateInfo.state !== 'installed',
              checked: false,
            }
          })
          .sort((a, b) =>
            b.title.toLowerCase() > a.title.toLowerCase() ? -1 : 1,
          ),
      ),
    ),
    { initialValue: null },
  )

  async done() {
    const { passwordHash, id } = await getServerInfo(this.patch)
    const { entry } = this.context.data

    this.dialog
      .openPrompt<string>({
        label: this.i18n.transform('Master password needed'),
        data: {
          message: this.i18n.transform(
            'Enter your master password to encrypt this backup.',
          ),
          label: this.i18n.transform('Master Password'),
          placeholder: this.i18n.transform('Enter master password'),
          useMask: true,
          buttonText: this.i18n.transform('Create a manual backup'),
        },
      })
      .pipe(verifyPassword(passwordHash, e => this.errorService.handleError(e)))
      .subscribe(async password => {
        // first time backup
        if (!this.service.hasThisBackup(entry, id)) {
          this.createBackup(password)
          // existing backup
        } else {
          try {
            verify(entry.startOs[id]?.passwordHash!, password)
            await this.createBackup(password)
          } catch {
            this.oldPassword(password)
          }
        }
      })
  }

  handleChange() {
    this.hasSelection = !!this.pkgs()?.some(p => p.checked)
  }

  allEligibleSelected(): boolean {
    const eligible = this.pkgs()?.filter(pkg => !pkg.disabled) || []
    return !!eligible.length && eligible.every(pkg => pkg.checked)
  }

  setAll(checked: boolean) {
    this.pkgs()?.forEach(pkg => (pkg.checked = checked && !pkg.disabled))
    this.handleChange()
  }

  private async oldPassword(password: string) {
    const { id } = await getServerInfo(this.patch)
    const { passwordHash = '' } = this.context.data.entry.startOs[id] || {}

    this.dialog
      .openPrompt<string>({
        label: 'Original password needed',
        data: {
          message:
            'This backup was created with a different password. Enter the original password that was used to encrypt this backup.',
          label: 'Original Password',
          placeholder: 'Enter original password',
          useMask: true,
          buttonText: 'Create Backup',
        },
      })
      .pipe(verifyPassword(passwordHash, e => this.errorService.handleError(e)))
      .subscribe(oldPassword => this.createBackup(password, oldPassword))
  }

  private async createBackup(
    password: string,
    oldPassword: string | null = null,
  ) {
    const packageIds =
      this.pkgs()
        ?.filter(p => p.checked)
        .map(p => p.id) || []
    const params = {
      targetId: this.context.data.id,
      packageIds,
      oldPassword,
      password,
    }

    this.tasks.run(async () => {
      await this.api.createBackup(params)
      this.context.$implicit.complete()
    }, 'Beginning backup')
  }
}

export const BACKUP = new PolymorpheusComponent(BackupsBackupComponent)
