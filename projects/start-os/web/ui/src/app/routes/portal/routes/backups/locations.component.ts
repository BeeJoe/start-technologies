import { Component, inject, input, OnInit } from '@angular/core'
import { RouterLink } from '@angular/router'
import { i18nPipe } from '@start9labs/shared'
import { TuiButton, TuiNotification, TuiTitle } from '@taiga-ui/core'
import { TitleDirective } from 'src/app/services/title.service'
import { BackupNetworkComponent } from '../system/routes/backups/network.component'
import { BackupPhysicalComponent } from '../system/routes/backups/physical.component'
import { BackupService } from '../system/routes/backups/backup.service'

@Component({
  selector: 'backup-locations',
  template: `
    @if (!embedded()) {
      <ng-container *title>
        <a
          routerLink="/system/backups"
          tuiIconButton
          iconStart="@tui.arrow-left"
        >
          {{ 'Back' | i18n }}
        </a>
        {{ 'Backup locations' | i18n }}
      </ng-container>

      <header class="heading">
        <span tuiTitle>
          <h2>{{ 'Backup locations' | i18n }}</h2>
          <span tuiSubtitle>
            {{
              'Use a physical drive or a shared folder on your local network.'
                | i18n
            }}
          </span>
        </span>
      </header>
    }

    <div tuiNotification appearance="info">
      {{
        'To add a physical location, connect a compatible drive to your Start9 Server, then refresh this page.'
          | i18n
      }}
    </div>

    <section networkFolders></section>
    <section physicalFolders></section>
  `,
  styles: `
    :host {
      display: grid;
      gap: 1rem;
      width: 100%;
      min-width: 0;
      max-width: none;
      margin-inline: auto;
    }

    section {
      width: 100%;
      min-width: 0;
    }

    h2 {
      margin: 0;
    }

    [tuiSubtitle] {
      display: block;
      margin-top: 0.25rem;
    }
  `,
  host: { class: 'backup-page' },
  imports: [
    RouterLink,
    TuiButton,
    TuiNotification,
    TuiTitle,
    TitleDirective,
    BackupNetworkComponent,
    BackupPhysicalComponent,
    i18nPipe,
  ],
})
export default class BackupLocationsComponent implements OnInit {
  readonly embedded = input(false)
  private readonly service = inject(BackupService)

  ngOnInit() {
    void this.service.getBackupTargets()
  }
}
