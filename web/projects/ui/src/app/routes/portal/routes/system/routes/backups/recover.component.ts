import { CommonModule } from '@angular/common'
import { Component, inject } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { Router } from '@angular/router'
import {
  DialogService,
  ErrorService,
  i18nKey,
  i18nPipe,
} from '@start9labs/shared'
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
import { filter, firstValueFrom, map, take } from 'rxjs'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { ConfigService } from 'src/app/services/config.service'
import { DataModel } from 'src/app/services/patch-db/data-model'
import { RecoverCheckpoint, RecoverData, RecoverOption } from './backup.types'

@Component({
  template: `
    @if (packageData(); as options) {
      <div class="bulk-controls">
        <button
          tuiButton
          appearance="flat-grayscale"
          (click)="toggleAll(options)"
        >
          {{ 'Toggle all' | i18n }}
        </button>
        <label>
          <span>{{ 'Checkpoint for selected services' | i18n }}</span>
          <select
            [disabled]="!selected(options).length"
            [ngModel]="bulkSelection"
            (ngModelChange)="applyBulk(options, $event)"
          >
            <option value="latest">{{ 'Latest available' | i18n }}</option>
            <option
              value="manual"
              [disabled]="!bulkAvailable(options, 'manual')"
            >
              {{ 'Latest manual' | i18n }}
            </option>
            <option
              value="automatic"
              [disabled]="!bulkAvailable(options, 'automatic')"
            >
              {{ 'Latest automatic' | i18n }}
            </option>
            @for (run of sharedRuns(options); track run.id) {
              <option [value]="'run:' + run.id">
                {{ 'Automatic' | i18n }} — {{ run.timestamp | date: 'medium' }}
              </option>
            }
          </select>
        </label>
      </div>
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
                      (checkpoint.source === 'manual' ? 'Manual' : 'Automatic')
                        | i18n
                    }}
                    @if (checkpoint.jobName) {
                      — {{ checkpoint.jobName }}
                    }
                    — {{ checkpoint.timestamp | date: 'medium' }} —
                    {{ checkpoint.version }}
                    @if (checkpoint.archived) {
                      — {{ 'Archived' | i18n }}
                    }
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
              (ngModelChange)="selectionChanged(options)"
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
    .bulk-controls {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 1rem;
    }

    .bulk-controls label {
      display: grid;
      gap: 0.25rem;
      color: var(--tui-text-secondary);
    }

    .bulk-controls select {
      min-width: 16rem;
      padding: 0.5rem;
      color: var(--tui-text-primary);
      background: var(--tui-background-base);
      border: 1px solid var(--tui-border-normal);
      border-radius: 0.5rem;
    }

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
  private readonly dialog = inject(DialogService)
  private readonly i18n = inject(i18nPipe)
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
                  runId: snapshot.runId,
                  archived: snapshot.archived,
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

  bulkSelection = 'latest'

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

  selected(options: RecoverOption[]): RecoverOption[] {
    return options.filter(option => option.checked)
  }

  toggleAll(options: RecoverOption[]) {
    const eligible = options.filter(
      option => !option.installed && !option.newerOs,
    )
    const select = !eligible.some(option => option.checked)
    eligible.forEach(option => (option.checked = select))
    if (select) this.applyBulk(options, this.bulkSelection)
  }

  selectionChanged(options: RecoverOption[]) {
    const runId = this.bulkSelection.startsWith('run:')
      ? this.bulkSelection.slice(4)
      : null
    const valid =
      this.bulkSelection === 'latest' ||
      (this.bulkSelection === 'manual' &&
        this.bulkAvailable(options, 'manual')) ||
      (this.bulkSelection === 'automatic' &&
        this.bulkAvailable(options, 'automatic')) ||
      (!!runId && this.sharedRuns(options).some(run => run.id === runId))
    if (!valid) this.bulkSelection = 'latest'
    this.applyBulk(options, this.bulkSelection)
  }

  bulkAvailable(
    options: RecoverOption[],
    source: 'manual' | 'automatic',
  ): boolean {
    const selected = this.selected(options)
    return (
      !!selected.length &&
      selected.every(option =>
        option.checkpoints.some(checkpoint =>
          source === 'manual'
            ? checkpoint.source === 'manual'
            : checkpoint.source === 'scheduled',
        ),
      )
    )
  }

  sharedRuns(options: RecoverOption[]): { id: string; timestamp: string }[] {
    const selected = this.selected(options)
    if (!selected.length) return []
    const common = selected
      .slice(1)
      .reduce(
        (ids, option) =>
          new Set(
            [...ids].filter(id =>
              option.checkpoints.some(checkpoint => checkpoint.runId === id),
            ),
          ),
        new Set(
          selected[0]!.checkpoints.flatMap(checkpoint =>
            checkpoint.runId ? [checkpoint.runId] : [],
          ),
        ),
      )
    return [...common]
      .map(id => ({
        id,
        timestamp:
          selected[0]!.checkpoints.find(checkpoint => checkpoint.runId === id)
            ?.timestamp || '',
      }))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  }

  applyBulk(options: RecoverOption[], selection: string) {
    this.bulkSelection = selection
    const runId = selection.startsWith('run:') ? selection.slice(4) : null
    for (const option of this.selected(options)) {
      const checkpoint =
        selection === 'latest'
          ? option.checkpoints[0]
          : selection === 'manual'
            ? option.checkpoints.find(item => item.source === 'manual')
            : selection === 'automatic'
              ? option.checkpoints.find(item => item.source === 'scheduled')
              : option.checkpoints.find(item => item.runId === runId)
      if (checkpoint) option.selectedKey = checkpoint.key
    }
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
    const confirmed = await firstValueFrom(
      this.dialog
        .openConfirm({
          label: this.i18n.transform('Restore selected'),
          size: 's',
          data: {
            content: `${selected.map(option => option.title).join(', ')}. ${this.i18n.transform('You can leave this page. Progress will continue.')}`,
            yes: this.i18n.transform('Restore'),
            no: this.i18n.transform('Cancel'),
          },
        })
        .pipe(filter(Boolean)),
      { defaultValue: false },
    )
    if (!confirmed) return
    const loader = this.loader.open('Initializing').subscribe()

    try {
      await this.api.restoreBackupSelection({
        targetId,
        manualIds: ids,
        snapshots,
        serverId,
        password,
      })

      this.context.$implicit.complete()
      this.router.navigate(['/backups'])
    } catch (e: any) {
      this.errorService.handleError(e)
    } finally {
      loader.unsubscribe()
    }
  }
}

export const RECOVER = new PolymorpheusComponent(BackupsRecoverComponent)
