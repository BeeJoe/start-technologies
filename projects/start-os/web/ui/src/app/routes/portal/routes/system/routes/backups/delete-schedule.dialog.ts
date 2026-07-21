import { Component, inject, Injectable, signal } from '@angular/core'
import { DialogService, i18nPipe } from '@start9labs/shared'
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

    <label class="delete-option">
      <input
        tuiCheckbox
        type="checkbox"
        [checked]="deleteCheckpoints()"
        (change)="setDeleteCheckpoints($event)"
      />
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
        (click)="confirm()"
      >
        {{
          (deleteCheckpoints()
            ? 'Delete Schedule and Backups'
            : 'Delete Schedule'
          ) | i18n
        }}
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
  `,
  imports: [TuiButton, TuiCheckbox, TuiTitle, i18nPipe],
})
export class DeleteScheduleDialog {
  readonly context =
    injectContext<
      TuiDialogContext<DeleteScheduleDecision | null, DeleteScheduleDialogData>
    >()

  protected readonly deleteCheckpoints = signal(false)

  protected setDeleteCheckpoints(event: Event) {
    this.deleteCheckpoints.set(
      (event.currentTarget as HTMLInputElement).checked,
    )
  }

  cancel() {
    this.context.completeWith(null)
  }

  confirm() {
    this.context.completeWith({
      deleteCheckpoints: this.deleteCheckpoints(),
    })
  }
}

export const DELETE_SCHEDULE_DIALOG = new PolymorpheusComponent(
  DeleteScheduleDialog,
)

/** Deletes a schedule and optionally removes archives no other schedule uses. */
@Injectable({ providedIn: 'root' })
export class DeleteScheduleService {
  private readonly api = inject(ApiService)
  private readonly dialogs = inject(DialogService)
  private readonly i18n = inject(i18nPipe)

  async delete(
    job: T.BackupJob,
    histories: T.ServiceTargetHistory[],
  ): Promise<boolean> {
    const unreferenced = histories.filter(
      history =>
        history.snapshots.length > 0 &&
        history.feedingJobs.length === 1 &&
        history.feedingJobs[0] === job.id,
    )
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

    await this.api.deleteScheduledBackupJob({ id: job.id })
    if (decision.deleteCheckpoints) {
      for (const history of unreferenced) {
        await this.api.deleteArchivedBackupSnapshots({
          targetId: history.targetId,
          packageId: history.packageId,
          snapshotIds: history.snapshots.map(snapshot => snapshot.id),
        })
      }
    }
    return true
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
