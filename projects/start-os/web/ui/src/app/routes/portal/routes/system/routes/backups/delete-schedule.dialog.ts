import { Component } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { i18nPipe } from '@start9labs/shared'
import {
  TuiButton,
  TuiCheckbox,
  TuiDialogContext,
  TuiTitle,
} from '@taiga-ui/core'
import { injectContext, PolymorpheusComponent } from '@taiga-ui/polymorpheus'

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
        (click)="confirm()"
      >
        {{ 'Delete' | i18n }}
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
  imports: [FormsModule, TuiButton, TuiCheckbox, TuiTitle, i18nPipe],
})
export class DeleteScheduleDialog {
  readonly context =
    injectContext<
      TuiDialogContext<DeleteScheduleDecision | null, DeleteScheduleDialogData>
    >()

  deleteCheckpoints = false

  cancel() {
    this.context.completeWith(null)
  }

  confirm() {
    this.context.completeWith({
      deleteCheckpoints: this.deleteCheckpoints,
    })
  }
}

export const DELETE_SCHEDULE_DIALOG = new PolymorpheusComponent(
  DeleteScheduleDialog,
)
