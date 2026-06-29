import { CommonModule } from '@angular/common'
import { Component, inject } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { Router } from '@angular/router'
import { ErrorService, i18nKey, i18nPipe } from '@start9labs/shared'
import { Version } from '@start9labs/start-sdk'
import { TuiMapperPipe } from '@taiga-ui/cdk'
import {
  TuiButton,
  TuiCheckbox,
  TuiDialogContext,
  TuiGroup,
  TuiTitle,
} from '@taiga-ui/core'
import { TuiBlock, TuiNotificationMiddleService } from '@taiga-ui/kit'
import { injectContext, PolymorpheusComponent } from '@taiga-ui/polymorpheus'
import { PatchDB } from 'patch-db-client'
import { map, take } from 'rxjs'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { ConfigService } from 'src/app/services/config.service'
import { DataModel } from 'src/app/services/patch-db/data-model'
import { RecoverCheckpoint, RecoverData, RecoverOption } from './backup.types'

@Component({
  template: `
    @if (packageData(); as options) {
      <div tuiGroup orientation="vertical" [collapsed]="true">
        @for (option of options; track $index) {
          <label tuiBlock>
            <span tuiTitle>
              <strong>{{ option.title }}</strong>
              <select
                class="checkpoint"
                [disabled]="option.installed || option.newerOs"
                [(ngModel)]="option.selectedKey"
              >
                @for (checkpoint of option.checkpoints; track checkpoint.key) {
                  <option [value]="checkpoint.key">
                    {{
                      (checkpoint.source === 'manual' ? 'Manual' : 'Scheduled')
                        | i18n
                    }}
                    @if (checkpoint.jobName) {
                      — {{ checkpoint.jobName }}
                    }
                    — {{ checkpoint.timestamp | date: 'medium' }} —
                    {{ checkpoint.version }}
                  </option>
                }
              </select>
              @if (option | tuiMapper: toMessage; as message) {
                <span [style.color]="message.color">
                  {{ message.text | i18n }}
                </span>
              }
            </span>
            <input
              type="checkbox"
              tuiCheckbox
              [disabled]="option.installed || option.newerOs"
              [(ngModel)]="option.checked"
            />
          </label>
        }
      </div>

      <footer class="g-buttons">
        <button
          tuiButton
          [disabled]="isDisabled(options)"
          (click)="restore(options)"
        >
          {{ 'Restore selected' | i18n }}
        </button>
      </footer>
    }
  `,
  styles: `
    [tuiGroup] {
      width: 100%;
      margin: 1.5rem 0 0;
    }

    .checkpoint {
      width: 100%;
      margin-top: 0.5rem;
      padding: 0.5rem;
      color: var(--tui-text-primary);
      background: var(--tui-background-base);
      border: 1px solid var(--tui-border-normal);
      border-radius: 0.5rem;
    }
  `,
  imports: [
    CommonModule,
    FormsModule,
    TuiButton,
    TuiGroup,
    TuiMapperPipe,
    TuiCheckbox,
    TuiBlock,
    TuiTitle,
    i18nPipe,
  ],
})
export class BackupsRecoverComponent {
  private readonly config = inject(ConfigService)
  private readonly api = inject(ApiService)
  private readonly loader = inject(TuiNotificationMiddleService)
  private readonly errorService = inject(ErrorService)
  private readonly router = inject(Router)
  private readonly context =
    injectContext<TuiDialogContext<void, RecoverData>>()

  readonly packageData = toSignal(
    inject<PatchDB<DataModel>>(PatchDB)
      .watch$('packageData')
      .pipe(
        take(1),
        map(packageData => {
          const backups = this.context.data.backupInfo.packageBackups
          const scheduled = this.context.data.scheduledHistories
          const ids = new Set([
            ...Object.keys(backups),
            ...scheduled.map(history => history.packageId),
          ])

          return [...ids]
            .map(id => {
              const manual = backups[id]
              const scheduledCheckpoints = scheduled
                .filter(history => history.packageId === id)
                .flatMap(history => history.snapshots)
                .map(snapshot => ({
                  key: `scheduled:${snapshot.id}`,
                  source: 'scheduled' as const,
                  version: snapshot.packageVersion,
                  timestamp: snapshot.completedAt,
                  jobName: snapshot.jobName,
                  snapshotId: snapshot.id,
                }))
              const checkpoints: RecoverCheckpoint[] = [
                ...(manual
                  ? [
                      {
                        key: 'manual',
                        source: 'manual' as const,
                        version: manual.version,
                        timestamp: manual.timestamp,
                      },
                    ]
                  : []),
                ...scheduledCheckpoints,
              ].sort((a, b) => b.timestamp.localeCompare(a.timestamp))
              const state = packageData[id]?.stateInfo
              const title =
                manual?.title ||
                (state?.state === 'installed' || state?.state === 'removing'
                  ? state.manifest.title
                  : state?.installingInfo.newManifest.title) ||
                id
              return {
                id,
                title,
                installed: !!packageData[id],
                checked: false,
                selectedKey: checkpoints[0]?.key || '',
                checkpoints,
                newerOs:
                  !!manual &&
                  Version.parse(manual.osVersion || '').compare(
                    Version.parse(this.config.version),
                  ) === 'greater',
              }
            })
            .sort((a, b) =>
              b.title.toLowerCase() > a.title.toLowerCase() ? -1 : 1,
            )
        }),
      ),
  )

  readonly toMessage = ({
    newerOs,
    installed,
    title,
  }: RecoverOption): { text: i18nKey; color: string } => {
    if (newerOs) {
      return {
        text: 'Unavailable. Backup was made on a newer version of StartOS.',
        color: 'var(--tui-status-negative)',
      }
    }

    if (installed) {
      return {
        text: 'Unavailable. Service is already installed.',
        color: 'var(--tui-status-warning)',
      }
    }

    return {
      text: 'Ready to restore',
      color: 'var(--tui-status-positive)',
    }
  }

  isDisabled(options: RecoverOption[]): boolean {
    return options.every(o => !o.checked)
  }

  async restore(options: RecoverOption[]): Promise<void> {
    const selected = options.filter(({ checked }) => !!checked)
    const ids = selected
      .filter(option => option.selectedKey === 'manual')
      .map(({ id }) => id)
    const snapshots = Object.fromEntries(
      selected.flatMap(option => {
        const checkpoint = option.checkpoints.find(
          checkpoint => checkpoint.key === option.selectedKey,
        )
        return checkpoint?.source === 'scheduled' && checkpoint.snapshotId
          ? [[option.id, checkpoint.snapshotId]]
          : []
      }),
    )
    const { targetId, serverId, password } = this.context.data
    const params = { ids, targetId, password, serverId }
    const loader = this.loader.open('Initializing').subscribe()

    try {
      await Promise.all([
        ids.length ? this.api.restorePackages(params) : Promise.resolve(null),
        Object.keys(snapshots).length
          ? this.api.restoreScheduledBackup({
              targetId,
              snapshots,
              serverId,
              password,
            })
          : Promise.resolve(null),
      ])

      this.context.$implicit.complete()
      this.router.navigate(['services'])
    } catch (e: any) {
      this.errorService.handleError(e)
    } finally {
      loader.unsubscribe()
    }
  }
}

export const RECOVER = new PolymorpheusComponent(BackupsRecoverComponent)
