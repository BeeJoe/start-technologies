import { Component, inject, Service } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { DialogService, i18nPipe, TaskService } from '@start9labs/shared'
import { T } from '@start9labs/start-core'
import {
  TuiButton,
  TuiCheckbox,
  TuiDialogContext,
  TuiTitle,
} from '@taiga-ui/core'
import { injectContext, PolymorpheusComponent } from '@taiga-ui/polymorpheus'
import { firstValueFrom } from 'rxjs'
import { ApiService } from 'src/app/services/api/embassy-api.service'

export interface DeleteScheduleDialogData {
  checkpointCount: number
  reclaimable: string
}

export interface DeleteScheduleDecision {
  deleteCheckpoints: boolean
}

@Component({
  template: `
    <p>
      {{
        'Snapshots that are no longer referenced will be kept as an archive by default.'
          | i18n
      }}
    </p>

    <label #deleteOption class="delete-option">
      <input tuiCheckbox type="checkbox" [(ngModel)]="deleteCheckpoints" />
      <span tuiTitle>
        <b>{{ 'Delete related backups' | i18n }}</b>
        <span tuiSubtitle>
          {{ context.data.checkpointCount }} {{ 'Checkpoints' | i18n }} ·
          {{ context.data.reclaimable }}
        </span>
      </span>
    </label>

    <footer class="actions">
      <button tuiButton size="s" appearance="primary" (click)="cancel()">
        {{ 'Cancel' | i18n }}
      </button>
      <button
        tuiButton
        size="s"
        appearance="primary-destructive"
        (click)="confirm(deleteOption)"
      >
        <span class="delete-only">{{ 'Delete Schedule' | i18n }}</span>
        <span class="delete-with-backups">
          {{ 'Delete Schedule and Backups' | i18n }}
        </span>
      </button>
    </footer>
  `,
  styles: `
    :host {
      display: grid;
      gap: 1.25rem;
      min-width: 0;
    }

    p {
      margin: 0;
      color: var(--tui-text-secondary);
    }

    .delete-option {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      min-width: 0;
      cursor: pointer;
    }

    [tuiTitle] {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    [tuiSubtitle] {
      display: block;
      margin-top: 0.25rem;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.75rem;
    }

    .actions > button {
      max-inline-size: 100%;
      min-inline-size: 0;
      min-block-size: 2.75rem;
      block-size: auto;
      padding-block: 0.5rem;
      white-space: normal;
    }

    .delete-only,
    .delete-with-backups {
      inline-size: 100%;
      min-inline-size: 0;
      overflow-wrap: anywhere;
      text-align: center;
      white-space: normal;
    }

    :host-context(tui-root._mobile) .actions {
      align-items: stretch;
      flex-direction: column;
    }

    :host-context(tui-root._mobile) .actions > button {
      inline-size: 100%;
    }

    .delete-with-backups,
    :host:has(.delete-option input:checked) .delete-only {
      display: none;
    }

    :host:has(.delete-option input:checked) .delete-with-backups {
      display: inline;
    }
  `,
  imports: [FormsModule, TuiButton, TuiCheckbox, TuiTitle, i18nPipe],
})
export class DeleteScheduleDialog {
  readonly context =
    injectContext<
      TuiDialogContext<DeleteScheduleDecision | null, DeleteScheduleDialogData>
    >()

  protected deleteCheckpoints = false

  cancel() {
    this.context.completeWith(null)
  }

  confirm(deleteOption: HTMLLabelElement) {
    this.context.completeWith({
      deleteCheckpoints: deleteOption.querySelector('input')?.checked ?? false,
    })
  }
}

export const DELETE_SCHEDULE_DIALOG = new PolymorpheusComponent(
  DeleteScheduleDialog,
)

/** Deletes a schedule and optionally removes archives no other schedule uses. */
@Service()
export class DeleteScheduleService {
  private readonly api = inject(ApiService)
  private readonly dialogs = inject(DialogService)
  private readonly i18n = inject(i18nPipe)
  private readonly tasks = inject(TaskService)

  async delete(job: T.BackupJob): Promise<boolean> {
    let histories: T.ServiceTargetHistory[] = []
    const loaded = await this.tasks.run(async () => {
      histories = await this.api.getScheduledBackupHistories({})
    }, 'Loading')
    if (!loaded) return false

    let unreferenced = this.unreferencedHistories(histories, job)
    const checkpointCount = unreferenced.reduce(
      (sum, history) => sum + history.snapshots.length,
      0,
    )
    const reclaimable = unreferenced.reduce(
      (sum, history) => sum + this.historyBytes(history),
      0,
    )
    const decision = await firstValueFrom(
      this.dialogs.openComponent<DeleteScheduleDecision | null>(
        DELETE_SCHEDULE_DIALOG,
        {
          label: this.i18n.transform('Delete backup schedule?'),
          size: 's',
          data: {
            checkpointCount,
            reclaimable: this.bytes(reclaimable),
          },
        },
      ),
      { defaultValue: null },
    )
    if (!decision) return false

    return this.tasks.run(
      async () => {
        if (decision.deleteCheckpoints) {
          const refreshed = await this.api.refreshScheduledBackupHistories({
            targetId: job.targetId,
          })
          unreferenced = this.unreferencedHistories(refreshed, job)
        }
        await this.api.deleteScheduledBackupJob({ id: job.id })
        if (decision.deleteCheckpoints) {
          await this.api.deleteArchivedBackupSnapshotsBulk({
            targetId: job.targetId,
            snapshots: unreferenced.map(history => ({
              packageId: history.packageId,
              snapshotIds: history.snapshots.map(snapshot => snapshot.id),
            })),
          })
        }
      },
      decision.deleteCheckpoints
        ? 'Deleting schedule and related backups…'
        : 'Deleting schedule…',
    )
  }

  private unreferencedHistories(
    histories: T.ServiceTargetHistory[],
    job: T.BackupJob,
  ): T.ServiceTargetHistory[] {
    return histories.filter(
      history =>
        history.snapshots.length > 0 &&
        history.feedingJobs.length === 1 &&
        history.feedingJobs[0] === job.id,
    )
  }

  private historyBytes(history: T.ServiceTargetHistory): number {
    return history.snapshots.reduce(
      (sum, snapshot) => sum + (snapshot.physicalSize ?? snapshot.logicalSize),
      0,
    )
  }

  private bytes(value: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let amount = value
    let unit = 0
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024
      unit++
    }
    return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`
  }
}
