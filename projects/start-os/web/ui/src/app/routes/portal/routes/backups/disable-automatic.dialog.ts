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

export interface DisableAutomaticDialogData {
  checkpointCount: number
  reclaimable: string
}

export interface DisableAutomaticDecision {
  deleteCheckpoints: boolean
}

@Component({
  template: `
    <p>
      {{
        'Turning off pauses schedules. Deleting checkpoints is optional and never deletes manual backups.'
          | i18n
      }}
    </p>

    <label class="delete-option">
      <input tuiCheckbox type="checkbox" [(ngModel)]="deleteCheckpoints" />
      <span tuiTitle>
        <b>
          {{ 'Also permanently delete automatic backup checkpoints' | i18n }}
        </b>
        <span tuiSubtitle>
          {{ 'Automatic backup history' | i18n }}:
          {{ context.data.checkpointCount }} · {{ context.data.reclaimable }}
          <br />
          {{
            'Selecting checkpoint deletion also removes automatic schedules, allowing unused backup locations to be forgotten.'
              | i18n
          }}
        </span>
      </span>
    </label>

    <footer class="actions">
      <button tuiButton size="s" appearance="secondary" (click)="cancel()">
        {{ 'Cancel' | i18n }}
      </button>
      <button
        tuiButton
        size="s"
        [appearance]="deleteCheckpoints ? 'primary-destructive' : 'primary'"
        (click)="confirm()"
      >
        {{
          (deleteCheckpoints
            ? 'Turn off and remove automatic backups'
            : 'Pause automatic backups'
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

    footer {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.75rem;
    }

    .actions button {
      block-size: auto;
      height: auto;
      min-block-size: 2.75rem;
      min-height: 2.75rem;
      max-inline-size: 100%;
      padding-inline: 1rem;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    @media (max-width: 30rem) {
      .actions {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: stretch;
        justify-content: stretch;
        gap: 0.5rem;
      }

      .actions button {
        width: 100%;
        min-width: 0;
      }
    }
  `,
  imports: [FormsModule, TuiButton, TuiCheckbox, TuiTitle, i18nPipe],
})
export class DisableAutomaticDialog {
  readonly context =
    injectContext<
      TuiDialogContext<
        DisableAutomaticDecision | null,
        DisableAutomaticDialogData
      >
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

export const DISABLE_AUTOMATIC_DIALOG = new PolymorpheusComponent(
  DisableAutomaticDialog,
)
