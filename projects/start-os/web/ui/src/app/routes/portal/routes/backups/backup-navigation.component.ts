import { Component } from '@angular/core'
import { RouterLink, RouterLinkActive } from '@angular/router'
import { i18nPipe } from '@start9labs/shared'
import { TuiButton } from '@taiga-ui/core'

@Component({
  selector: 'backup-navigation',
  template: `
    <nav aria-label="Backup pages">
      <a
        tuiButton
        appearance="secondary"
        size="s"
        routerLink="/system/backups"
        routerLinkActive="active"
        [routerLinkActiveOptions]="{ exact: true }"
      >
        {{ 'Overview' | i18n }}
      </a>
      <a
        tuiButton
        appearance="secondary"
        size="s"
        routerLink="/system/backups/manage"
        routerLinkActive="active"
      >
        {{ 'Automatic' | i18n }}
      </a>
      <a
        tuiButton
        appearance="secondary"
        size="s"
        routerLink="/system/backups/manual"
        routerLinkActive="active"
      >
        {{ 'Manual backup' | i18n }}
      </a>
      <a
        tuiButton
        appearance="secondary"
        size="s"
        routerLink="/system/backups/restore"
        routerLinkActive="active"
      >
        {{ 'Restore' | i18n }}
      </a>
      <a
        tuiButton
        appearance="secondary"
        size="s"
        routerLink="/system/backups/locations"
        routerLinkActive="active"
      >
        {{ 'Locations' | i18n }}
      </a>
    </nav>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
      min-width: 0;
      overflow-x: auto;
      scrollbar-width: thin;
    }

    nav {
      display: flex;
      width: max-content;
      min-width: 100%;
      gap: 0.5rem;
      padding: 0.125rem 0 0.5rem;
    }

    a {
      flex: 0 0 auto;
      text-decoration: none;
    }

    a.active {
      box-shadow: inset 0 0 0 2px var(--tui-border-focus);
    }
  `,
  imports: [RouterLink, RouterLinkActive, TuiButton, i18nPipe],
})
export class BackupNavigationComponent {}
