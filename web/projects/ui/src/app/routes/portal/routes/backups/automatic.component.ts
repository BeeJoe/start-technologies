import { DatePipe } from '@angular/common'
import { Component, computed, inject, OnInit, signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { FormsModule } from '@angular/forms'
import { ActivatedRoute, Router, RouterLink } from '@angular/router'
import {
  DialogService,
  ErrorService,
  getErrorMessage,
  i18nPipe,
} from '@start9labs/shared'
import { T } from '@start9labs/start-sdk'
import {
  TuiButton,
  TuiCell,
  TuiCheckbox,
  TuiGroup,
  TuiIcon,
  TuiInput,
  TuiNotification,
  TuiTitle,
} from '@taiga-ui/core'
import {
  TuiBadge,
  TuiBlock,
  TuiNotificationMiddleService,
  TuiSwitch,
} from '@taiga-ui/kit'
import { PatchDB } from 'patch-db-client'
import { filter, firstValueFrom } from 'rxjs'
import { ApiService } from 'src/app/services/api/embassy-api.service'
import { DataModel } from 'src/app/services/patch-db/data-model'
import { TitleDirective } from 'src/app/services/title.service'
import { BackupService } from '../system/routes/backups/backup.service'
import {
  BackupScheduleFrequency,
  parseBackupSchedule,
  serializeBackupSchedule,
} from '../system/routes/backups/scheduled.utils'
import { ScheduledBackupsComponent } from '../system/routes/backups/scheduled.component'
import { BackupLocationPickerComponent } from './location-picker.component'

interface ServiceChoice {
  id: string
  title: string
  icon: string
  checked: boolean
}

interface AutomaticEditor {
  frequency: BackupScheduleFrequency
  minute: number
  hour: number
  weekday: number
  timezone: string
  services: ServiceChoice[]
  includeFuture: boolean
  legacySelection: boolean
  keepAdditional: boolean
  interval: 'day' | 'week' | 'month'
  duration: number
  password: string
  firstBackupNow: boolean
}

type HistoryFilter = 'all' | T.BackupActivityKind

@Component({
  template: `
    <ng-container *title>
      <a routerLink="/system/backups" tuiIconButton iconStart="@tui.arrow-left">
        {{ 'Back' | i18n }}
      </a>
      {{
        (setupMode ? 'Set up automatic backups' : 'Manage automatic backups')
          | i18n
      }}
    </ng-container>

    <header class="page-heading">
      <span tuiTitle>
        <h2>
          {{
            (setupMode
              ? 'Set up automatic backups'
              : 'Manage automatic backups'
            ) | i18n
          }}
        </h2>
        <span tuiSubtitle>
          {{
            (setupMode
              ? 'Choose where and when StartOS protects your services.'
              : 'Change your primary schedule or review backup history'
            ) | i18n
          }}
        </span>
      </span>
    </header>

    @if (loading()) {
      <div class="loading">{{ 'Loading' | i18n }}…</div>
    } @else if (setupMode && jobs().length) {
      <div tuiNotification appearance="info">
        {{ 'Automatic backups are already set up.' | i18n }}
        <a tuiButton size="s" routerLink="/system/backups/manage">
          {{ 'Manage' | i18n }}
        </a>
      </div>
    } @else if (setupMode) {
      <nav class="steps" aria-label="Setup progress">
        @for (item of setupSteps; track item.number) {
          <span [class.active]="step() === item.number">
            <b>{{ item.number }}</b>
            {{ item.label | i18n }}
          </span>
        }
      </nav>

      @if (step() === 1) {
        <section class="g-card panel">
          <header>
            <span tuiTitle>
              <b>{{ 'Choose a backup location' | i18n }}</b>
              <span tuiSubtitle>
                {{
                  'Unavailable locations stay visible so you can repair them.'
                    | i18n
                }}
              </span>
            </span>
          </header>

          <backup-location-picker
            mode="automatic"
            [selectedId]="targetId()"
            (selected)="targetId.set($event.id)"
          />
        </section>
      }

      @if (step() === 2) {
        <section class="g-card panel">
          <header>
            <span tuiTitle>
              <b>{{ 'Schedule and services' | i18n }}</b>
              <span tuiSubtitle>
                {{ scheduleSummary() }}
              </span>
            </span>
          </header>

          <button
            tuiButton
            type="button"
            size="s"
            appearance="secondary"
            (click)="showSchedule.set(!showSchedule())"
          >
            {{ (showSchedule() ? 'Hide schedule' : 'Change schedule') | i18n }}
          </button>

          @if (showSchedule()) {
            <div class="schedule-controls">
              <label>
                <span>{{ 'Frequency' | i18n }}</span>
                <select [(ngModel)]="editor.frequency">
                  <option value="hourly">{{ 'Hourly' | i18n }}</option>
                  <option value="daily">{{ 'Daily' | i18n }}</option>
                  <option value="weekly">{{ 'Weekly' | i18n }}</option>
                </select>
              </label>
              @if (editor.frequency === 'weekly') {
                <label>
                  <span>{{ 'Day of week' | i18n }}</span>
                  <select [(ngModel)]="editor.weekday">
                    @for (day of weekdays; track day.value) {
                      <option [ngValue]="day.value">
                        {{ day.label | i18n }}
                      </option>
                    }
                  </select>
                </label>
              }
              @if (editor.frequency !== 'hourly') {
                <tui-textfield>
                  <label tuiLabel>{{ 'Hour' | i18n }}</label>
                  <input
                    tuiInput
                    type="number"
                    min="0"
                    max="23"
                    [(ngModel)]="editor.hour"
                  />
                </tui-textfield>
              }
              <tui-textfield>
                <label tuiLabel>{{ 'Minute' | i18n }}</label>
                <input
                  tuiInput
                  type="number"
                  min="0"
                  max="59"
                  [(ngModel)]="editor.minute"
                />
              </tui-textfield>
            </div>
          }

          <div class="setting-row">
            <span tuiTitle>
              <b>{{ 'Services' | i18n }}</b>
              <span tuiSubtitle>
                {{
                  'All current and future services are included unless you exclude them.'
                    | i18n
                }}
              </span>
            </span>
            <button
              tuiButton
              type="button"
              size="s"
              appearance="secondary"
              (click)="showServices.set(!showServices())"
            >
              {{ (showServices() ? 'Done' : 'Customize') | i18n }}
            </button>
          </div>

          @if (showServices()) {
            <div tuiGroup orientation="vertical" [collapsed]="true">
              @for (service of editor.services; track service.id) {
                <label tuiBlock="m">
                  <img alt="" [src]="service.icon" />
                  <span tuiTitle>
                    <b>{{ service.title }}</b>
                  </span>
                  <input
                    tuiCheckbox
                    type="checkbox"
                    [(ngModel)]="service.checked"
                  />
                </label>
              }
            </div>
            <button
              tuiButton
              type="button"
              appearance="flat-grayscale"
              (click)="toggleAllServices()"
            >
              {{ 'Toggle all' | i18n }}
            </button>
          }

          <div class="setting-row">
            <span tuiTitle>
              <b>{{ 'Version history' | i18n }}</b>
              <span tuiSubtitle>
                {{
                  (editor.keepAdditional
                    ? retentionSummary()
                    : 'Keep only the latest automatic checkpoint'
                  ) | i18n
                }}
              </span>
            </span>
            <label class="inline-switch">
              <span>{{ 'Keep additional versions' | i18n }}</span>
              <input
                tuiSwitch
                type="checkbox"
                [(ngModel)]="editor.keepAdditional"
              />
            </label>
          </div>

          @if (editor.keepAdditional) {
            <div class="retention-rule">
              <span>{{ 'Keep one backup every' | i18n }}</span>
              <select [(ngModel)]="editor.interval">
                <option value="day">{{ 'Day' | i18n }}</option>
                <option value="week">{{ 'Week' | i18n }}</option>
                <option value="month">{{ 'Month' | i18n }}</option>
              </select>
              <span>{{ 'for' | i18n }}</span>
              <input
                type="number"
                min="1"
                max="365"
                [(ngModel)]="editor.duration"
              />
              <span>{{ 'periods' | i18n }}</span>
            </div>
            <div tuiNotification appearance="warning">
              {{
                'Every retained version is a full copy and each run also needs temporary staging space.'
                  | i18n
              }}
            </div>
          }
        </section>
      }

      @if (step() === 3) {
        <section class="g-card panel review-panel">
          <header>
            <span tuiTitle>
              <b>{{ 'Review automatic backups' | i18n }}</b>
              <span tuiSubtitle>
                {{ 'Confirm the setup with your master password.' | i18n }}
              </span>
            </span>
          </header>

          <dl>
            <div>
              <dt>{{ 'Backup location' | i18n }}</dt>
              <dd>{{ selectedTargetName() }}</dd>
            </div>
            <div>
              <dt>{{ 'Schedule' | i18n }}</dt>
              <dd>{{ scheduleSummary() }}</dd>
            </div>
            <div>
              <dt>{{ 'Services' | i18n }}</dt>
              <dd>{{ selectedServiceSummary() }}</dd>
            </div>
            <div>
              <dt>{{ 'Version history' | i18n }}</dt>
              <dd>
                {{
                  (editor.keepAdditional
                    ? retentionSummary()
                    : 'Latest automatic checkpoint only'
                  ) | i18n
                }}
              </dd>
            </div>
          </dl>

          @if (capacityNeeded() !== null) {
            <div tuiNotification [appearance]="capacityAppearance()">
              {{ 'About' | i18n }} {{ bytes(capacityNeeded()!) }}
              {{ 'needed' | i18n }}; {{ capacityAvailableLabel() }}
              {{ 'available' | i18n }}.
              @if (capacityBlocked()) {
                <span class="block-helper">
                  {{ 'Choose a location with more free space.' | i18n }}
                </span>
              }
            </div>
          }

          <tui-textfield>
            <label tuiLabel>{{ 'Master Password' | i18n }}</label>
            <input
              tuiInput
              type="password"
              autocomplete="off"
              [(ngModel)]="editor.password"
            />
          </tui-textfield>

          <label class="checkbox-row">
            <input
              tuiCheckbox
              type="checkbox"
              [(ngModel)]="editor.firstBackupNow"
            />
            <span tuiTitle>
              <b>{{ 'Create the first backup now' | i18n }}</b>
              <span tuiSubtitle>
                {{ 'Recommended so protection begins immediately.' | i18n }}
              </span>
            </span>
          </label>
        </section>
      }

      <footer class="wizard-actions">
        @if (step() > 1) {
          <button tuiButton appearance="secondary" (click)="previous()">
            {{ 'Back' | i18n }}
          </button>
        }
        <span></span>
        @if (step() < 3) {
          <button tuiButton [disabled]="!canContinue()" (click)="next()">
            {{ 'Continue' | i18n }}
          </button>
        } @else {
          <button
            tuiButton
            [disabled]="!canSaveSetup() || saving()"
            (click)="createAutomaticBackup()"
          >
            {{ 'Turn on automatic backups' | i18n }}
          </button>
        }
      </footer>
    } @else {
      <nav class="tabs">
        <button
          tuiButton
          [appearance]="tab() === 'settings' ? 'primary' : 'secondary'"
          (click)="tab.set('settings')"
        >
          {{ 'Settings' | i18n }}
        </button>
        <button
          tuiButton
          [appearance]="tab() === 'history' ? 'primary' : 'secondary'"
          (click)="tab.set('history')"
        >
          {{ 'History' | i18n }}
        </button>
      </nav>

      @if (tab() === 'settings') {
        <div id="help" tuiNotification appearance="info">
          {{
            'Automatic checkpoints are stored separately from your latest manual checkpoint.'
              | i18n
          }}
        </div>
        @if (primary(); as job) {
          <section class="g-card panel">
            <header>
              <span tuiTitle>
                <b>{{ 'Automatic backups' | i18n }}</b>
                <span tuiSubtitle>
                  {{
                    (job.enabled && !job.pause
                      ? 'Your primary schedule is on.'
                      : 'Automatic backups are off. Settings and checkpoints are kept.'
                    ) | i18n
                  }}
                </span>
              </span>
              <input
                tuiSwitch
                type="checkbox"
                [ngModel]="job.enabled && !job.pause"
                (ngModelChange)="toggleMain($event)"
              />
            </header>

            @if (job.services.type === 'selected' && !editor.includeFuture) {
              <div tuiNotification appearance="info">
                <span tuiTitle>
                  <b>{{ 'Existing service selection preserved' | i18n }}</b>
                  <span tuiSubtitle>
                    {{
                      'This schedule keeps its previous exact selection and will not silently add future services.'
                        | i18n
                    }}
                  </span>
                </span>
                <label class="checkbox-row">
                  <input
                    tuiCheckbox
                    type="checkbox"
                    [(ngModel)]="editor.includeFuture"
                  />
                  <span>
                    {{ 'Automatically include future services' | i18n }}
                  </span>
                </label>
              </div>
            }

            <div class="setting-row">
              <span tuiTitle>
                <b>{{ 'Backup location' | i18n }}</b>
                <span tuiSubtitle>{{ targetName(job.targetId) }}</span>
              </span>
              @if (job.pause && job.pause.reason !== 'user') {
                <button tuiButton size="s" (click)="showAdvanced.set(true)">
                  {{ 'Fix backup' | i18n }}
                </button>
              }
            </div>

            <div class="setting-row vertical">
              <span tuiTitle>
                <b>{{ 'Schedule' | i18n }}</b>
                <span tuiSubtitle>{{ scheduleSummary() }}</span>
              </span>
              <div class="schedule-controls">
                <label>
                  <span>{{ 'Frequency' | i18n }}</span>
                  <select [(ngModel)]="editor.frequency">
                    <option value="hourly">{{ 'Hourly' | i18n }}</option>
                    <option value="daily">{{ 'Daily' | i18n }}</option>
                    <option value="weekly">{{ 'Weekly' | i18n }}</option>
                  </select>
                </label>
                @if (editor.frequency === 'weekly') {
                  <label>
                    <span>{{ 'Day of week' | i18n }}</span>
                    <select [(ngModel)]="editor.weekday">
                      @for (day of weekdays; track day.value) {
                        <option [ngValue]="day.value">
                          {{ day.label | i18n }}
                        </option>
                      }
                    </select>
                  </label>
                }
                @if (editor.frequency !== 'hourly') {
                  <tui-textfield>
                    <label tuiLabel>{{ 'Hour' | i18n }}</label>
                    <input
                      tuiInput
                      type="number"
                      min="0"
                      max="23"
                      [(ngModel)]="editor.hour"
                    />
                  </tui-textfield>
                }
                <tui-textfield>
                  <label tuiLabel>{{ 'Minute' | i18n }}</label>
                  <input
                    tuiInput
                    type="number"
                    min="0"
                    max="59"
                    [(ngModel)]="editor.minute"
                  />
                </tui-textfield>
              </div>
            </div>

            <div class="setting-row vertical">
              <span tuiTitle>
                <b>{{ 'Services' | i18n }}</b>
                <span tuiSubtitle>
                  {{ selectedServiceSummary() }}
                </span>
              </span>
              <div tuiGroup orientation="vertical" [collapsed]="true">
                @for (service of editor.services; track service.id) {
                  <label tuiBlock="m">
                    <img alt="" [src]="service.icon" />
                    <span tuiTitle>
                      <b>{{ service.title }}</b>
                    </span>
                    <input
                      tuiCheckbox
                      type="checkbox"
                      [(ngModel)]="service.checked"
                    />
                  </label>
                }
              </div>
              <button
                tuiButton
                type="button"
                appearance="flat-grayscale"
                (click)="toggleAllServices()"
              >
                {{ 'Toggle all' | i18n }}
              </button>
            </div>

            <div class="setting-row vertical">
              <span tuiTitle>
                <b>{{ 'Version history' | i18n }}</b>
                <span tuiSubtitle>
                  {{
                    (editor.keepAdditional
                      ? retentionSummary()
                      : 'Keep only the latest automatic checkpoint'
                    ) | i18n
                  }}
                </span>
              </span>
              <label class="inline-switch left">
                <input
                  tuiSwitch
                  type="checkbox"
                  [(ngModel)]="editor.keepAdditional"
                />
                <span>{{ 'Keep additional versions' | i18n }}</span>
              </label>
              @if (editor.keepAdditional) {
                <div class="retention-rule">
                  <span>{{ 'Keep one backup every' | i18n }}</span>
                  <select [(ngModel)]="editor.interval">
                    <option value="day">{{ 'Day' | i18n }}</option>
                    <option value="week">{{ 'Week' | i18n }}</option>
                    <option value="month">{{ 'Month' | i18n }}</option>
                  </select>
                  <span>{{ 'for' | i18n }}</span>
                  <input
                    type="number"
                    min="1"
                    max="365"
                    [(ngModel)]="editor.duration"
                  />
                  <span>{{ 'periods' | i18n }}</span>
                </div>
                <p class="helper">
                  {{
                    'Use different version history settings for specific services under Advanced schedules.'
                      | i18n
                  }}
                </p>
              }
            </div>

            <footer class="save-row">
              <button
                tuiButton
                [disabled]="saving()"
                (click)="savePrimary(job)"
              >
                {{ 'Save changes' | i18n }}
              </button>
            </footer>
          </section>

          <section class="danger g-card">
            <span tuiTitle>
              <b>{{ 'Turn off and remove automatic backups' | i18n }}</b>
              <span tuiSubtitle>
                {{
                  'Turning off pauses schedules. Deleting checkpoints is optional and never deletes manual backups.'
                    | i18n
                }}
              </span>
            </span>
            <label class="checkbox-row">
              <input
                tuiCheckbox
                type="checkbox"
                [(ngModel)]="deleteWhenDisabled"
              />
              <span>
                {{
                  'Also permanently delete automatic backup checkpoints' | i18n
                }}
              </span>
            </label>
            <button
              tuiButton
              appearance="flat-destructive"
              [disabled]="!anyJobEnabled()"
              (click)="disableAutomatic()"
            >
              {{ 'Turn off automatic backups' | i18n }}
            </button>
          </section>

          <button
            tuiCell
            class="advanced-link"
            (click)="showAdvanced.set(!showAdvanced())"
          >
            <tui-icon icon="@tui.settings-2" />
            <span tuiTitle>
              <b>{{ 'Advanced schedules' | i18n }}</b>
              <span tuiSubtitle>
                {{
                  'Add another exact time, customize a service, or repair a backup location.'
                    | i18n
                }}
              </span>
            </span>
            <span tuiBadge>{{ jobs().length }}</span>
          </button>

          @if (showAdvanced()) {
            <section scheduledBackups mode="create"></section>
          }
        } @else {
          <div tuiNotification appearance="info">
            {{ 'Automatic backups are not set up yet.' | i18n }}
            <a tuiButton size="s" routerLink="/system/backups/setup">
              {{ 'Set up' | i18n }}
            </a>
          </div>
        }
      } @else {
        <section class="history-toolbar">
          <label>
            <span>{{ 'Show' | i18n }}</span>
            <select [(ngModel)]="historyFilter">
              <option value="all">{{ 'All activity' | i18n }}</option>
              <option value="manual">{{ 'Manual' | i18n }}</option>
              <option value="automatic">{{ 'Automatic' | i18n }}</option>
              <option value="restore">{{ 'Restore' | i18n }}</option>
            </select>
          </label>
        </section>

        <section class="timeline">
          @for (activity of filteredActivities(); track activity.id) {
            <details class="g-card activity">
              <summary>
                <tui-icon [icon]="activityIcon(activity)" />
                <span tuiTitle>
                  <b>{{ activityLabel(activity) | i18n }}</b>
                  <span tuiSubtitle>
                    {{ activity.startedAt | date: 'medium' }} ·
                    {{ activityState(activity) | i18n }}
                  </span>
                </span>
                <span tuiBadge [appearance]="activityAppearance(activity)">
                  {{ activityState(activity) | i18n }}
                </span>
              </summary>
              <div class="activity-details">
                <p>
                  <b>{{ 'Backup location' | i18n }}:</b>
                  {{ targetName(activity.targetId) }}
                </p>
                <p>
                  <b>{{ 'Services' | i18n }}:</b>
                  {{ activity.intendedServices.length }}
                </p>
                @if (activity.error) {
                  <p class="error">{{ activity.error }}</p>
                }
              </div>
            </details>
          } @empty {
            <div tuiNotification appearance="info">
              {{ 'No backup activity yet.' | i18n }}
            </div>
          }
        </section>

        <button
          tuiCell
          class="advanced-link"
          (click)="showCheckpoints.set(!showCheckpoints())"
        >
          <tui-icon icon="@tui.archive" />
          <span tuiTitle>
            <b>{{ 'Manage stored checkpoints' | i18n }}</b>
            <span tuiSubtitle>
              {{ 'View retention details and archived checkpoints.' | i18n }}
            </span>
          </span>
        </button>
        @if (showCheckpoints()) {
          <section scheduledBackups mode="restore"></section>
        }
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: 1rem;
      max-width: 64rem;
      margin-inline: auto;
    }

    h2,
    p {
      margin: 0;
    }

    [tuiSubtitle],
    .helper,
    .block-helper {
      display: block;
      margin-top: 0.25rem;
    }

    [tuiTitle],
    .schedule-controls > *,
    .activity summary > * {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .steps,
    .tabs,
    .wizard-actions,
    .save-row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }

    .steps {
      justify-content: center;
      color: var(--tui-text-secondary);
    }

    .steps span {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.5rem 0.75rem;
    }

    .steps b {
      display: grid;
      place-items: center;
      width: 1.5rem;
      height: 1.5rem;
      border-radius: 50%;
      background: var(--tui-background-neutral-1);
    }

    .steps .active {
      color: var(--tui-text-primary);
    }

    .steps .active b {
      background: var(--tui-background-accent-1);
      color: var(--tui-text-primary-on-accent-1);
    }

    .panel {
      display: grid;
      gap: 1rem;
      padding: 1.25rem;
    }

    .panel > header,
    .setting-row,
    .danger,
    .checkbox-row,
    .inline-switch {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }

    .timeline {
      display: grid;
      gap: 0.5rem;
    }

    .schedule-controls {
      display: grid;
      grid-template-columns: repeat(4, minmax(7rem, 1fr));
      gap: 0.75rem;
      align-items: end;
    }

    label > span:first-child,
    .helper {
      color: var(--tui-text-secondary);
    }

    select,
    .retention-rule input {
      width: 100%;
      min-height: 2.75rem;
      padding: 0.5rem 0.75rem;
      color: var(--tui-text-primary);
      background: var(--tui-background-base);
      border: 1px solid var(--tui-border-normal);
      border-radius: var(--tui-radius-m);
    }

    [tuiGroup] {
      width: 100%;
    }

    [tuiBlock] img {
      width: 2.5rem;
      border-radius: 50%;
    }

    [tuiBlock] [tuiTitle] {
      flex: 1;
    }

    .retention-rule {
      display: grid;
      grid-template-columns: auto minmax(7rem, 1fr) auto 6rem auto;
      gap: 0.5rem;
      align-items: center;
    }

    .inline-switch {
      justify-content: flex-end;
    }

    .inline-switch.left {
      justify-content: flex-start;
    }

    .setting-row.vertical {
      align-items: stretch;
      flex-direction: column;
    }

    dl {
      display: grid;
      gap: 0.75rem;
      margin: 0;
    }

    dl div {
      display: grid;
      grid-template-columns: minmax(10rem, 1fr) 2fr;
      gap: 1rem;
    }

    dt {
      color: var(--tui-text-secondary);
    }

    dd {
      margin: 0;
      font-weight: bold;
    }

    .wizard-actions span {
      flex: 1;
    }

    .tabs {
      justify-content: center;
    }

    .danger {
      align-items: flex-start;
      flex-direction: column;
      padding: 1.25rem;
    }

    .advanced-link {
      text-align: left;
      gap: 0.75rem;
    }

    .advanced-link [tuiTitle] {
      flex: 1;
    }

    .history-toolbar {
      display: flex;
      justify-content: flex-end;
    }

    .activity {
      padding: 0;
      overflow: hidden;
    }

    .activity summary {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem 1.25rem;
      cursor: pointer;
      list-style: none;
    }

    .activity summary [tuiTitle] {
      flex: 1;
    }

    .activity-details {
      padding: 0 1.25rem 1rem 3.25rem;
    }

    .error {
      color: var(--tui-status-negative);
    }

    @media (max-width: 48rem) {
      .steps span {
        font-size: 0;
      }

      .steps b {
        font-size: initial;
      }

      .schedule-controls {
        grid-template-columns: 1fr 1fr;
      }

      .retention-rule {
        grid-template-columns: 1fr;
      }

      dl div {
        grid-template-columns: 1fr;
        gap: 0.2rem;
      }
    }

    @media (max-width: 30rem) {
      .panel > header,
      .setting-row:not(.vertical),
      .activity summary,
      .advanced-link {
        align-items: stretch;
        flex-direction: column;
      }

      .panel > header > :last-child,
      .setting-row:not(.vertical) > button,
      .activity summary > tui-icon,
      .activity summary > [tuiBadge],
      .advanced-link > tui-icon,
      .advanced-link > [tuiBadge] {
        align-self: flex-start;
      }

      .inline-switch {
        width: 100%;
        justify-content: space-between;
      }

      .schedule-controls {
        grid-template-columns: 1fr;
      }

      .wizard-actions {
        flex-wrap: wrap;
      }
    }
  `,
  host: { class: 'g-page' },
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    TuiBadge,
    TuiBlock,
    TuiButton,
    TuiCell,
    TuiCheckbox,
    TuiGroup,
    TuiIcon,
    TuiInput,
    TuiNotification,
    TuiSwitch,
    TuiTitle,
    TitleDirective,
    ScheduledBackupsComponent,
    BackupLocationPickerComponent,
    i18nPipe,
  ],
})
export default class AutomaticBackupsComponent implements OnInit {
  private readonly api = inject(ApiService)
  private readonly backupService = inject(BackupService)
  private readonly dialogs = inject(DialogService)
  private readonly errors = inject(ErrorService)
  private readonly notifications = inject(TuiNotificationMiddleService)
  private readonly router = inject(Router)
  private readonly patch = inject<PatchDB<DataModel>>(PatchDB)
  private readonly packageData = toSignal(this.patch.watch$('packageData'))
  private readonly state = toSignal(this.patch.watch$('scheduledBackups'))

  readonly setupMode =
    inject(ActivatedRoute).snapshot.data['mode'] === ('setup' as const)
  readonly loading = signal(true)
  readonly saving = signal(false)
  readonly step = signal(1)
  readonly tab = signal<'settings' | 'history'>('settings')
  readonly targetId = signal('')
  readonly showSchedule = signal(false)
  readonly showServices = signal(false)
  readonly showAdvanced = signal(false)
  readonly showCheckpoints = signal(false)
  historyFilter: HistoryFilter = 'all'
  deleteWhenDisabled = false

  readonly setupSteps = [
    { number: 1, label: 'Location' as const },
    { number: 2, label: 'Schedule and services' as const },
    { number: 3, label: 'Review' as const },
  ]

  readonly weekdays = [
    { value: 0, label: 'Sunday' as const },
    { value: 1, label: 'Monday' as const },
    { value: 2, label: 'Tuesday' as const },
    { value: 3, label: 'Wednesday' as const },
    { value: 4, label: 'Thursday' as const },
    { value: 5, label: 'Friday' as const },
    { value: 6, label: 'Saturday' as const },
  ]

  readonly jobs = computed(() =>
    Object.values(this.state()?.jobs || {}).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    ),
  )
  readonly primary = computed(() => this.jobs()[0])
  readonly histories = computed(() =>
    Object.values(this.state()?.histories || {}),
  )
  readonly activities = computed(() =>
    Object.values(this.state()?.activities || {}).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    ),
  )

  readonly targets = computed(() => [
    ...this.backupService.cifs().map(target => ({
      id: target.id,
      name: target.entry.path.split('/').pop() || target.entry.path,
      detail: `${target.entry.hostname}${target.entry.path}`,
      icon: '@tui.folder-network',
      available: target.entry.mountable,
      capacity: null as number | null,
      used: null as number | null,
    })),
    ...this.backupService.drives().map(target => ({
      id: target.id,
      name:
        [target.entry.vendor, target.entry.model].filter(Boolean).join(' ') ||
        target.entry.logicalname,
      detail: `${target.entry.logicalname} · ${this.bytes(target.entry.capacity)}`,
      icon: '@tui.hard-drive',
      available: target.entry.capacity > 0,
      capacity: target.entry.capacity,
      used: target.entry.used,
    })),
  ])

  editor: AutomaticEditor = this.defaultEditor()
  readonly estimates = signal<T.BackupServiceCapacityEstimate[]>([])

  async ngOnInit() {
    await this.backupService.getBackupTargets()
    this.targetId.set(this.targets().find(target => target.available)?.id || '')
    const job = this.primary()
    if (job) this.editor = this.editorFor(job)
    this.loading.set(false)
  }

  private defaultEditor(): AutomaticEditor {
    return {
      frequency: 'daily',
      minute: 0,
      hour: 3,
      weekday: 0,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      services: [],
      includeFuture: true,
      legacySelection: false,
      keepAdditional: false,
      interval: 'day',
      duration: 7,
      password: '',
      firstBackupNow: true,
    }
  }

  private serviceChoices(selected?: Set<string>): ServiceChoice[] {
    return Object.entries(this.packageData() || {})
      .flatMap(([id, entry]) => {
        const state = entry.stateInfo
        const manifest =
          state.state === 'installed' || state.state === 'removing'
            ? state.manifest
            : state.installingInfo?.newManifest
        return manifest
          ? [
              {
                id,
                title: manifest.title,
                icon: entry.icon,
                checked: selected ? selected.has(id) : true,
              },
            ]
          : []
      })
      .sort((a, b) => a.title.localeCompare(b.title))
  }

  private editorFor(job: T.BackupJob): AutomaticEditor {
    const schedule = parseBackupSchedule(job.schedule)
    const allIds = new Set(this.serviceChoices().map(service => service.id))
    let selected = allIds
    let legacySelection = false
    let includeFuture = true
    if (job.services.type === 'selected') {
      selected = new Set(job.services.packageIds)
      legacySelection = true
      includeFuture = false
    } else if (job.services.type === 'allExcept') {
      const excludedPackageIds = job.services.excludedPackageIds
      selected = new Set(
        [...allIds].filter(id => !excludedPackageIds.includes(id)),
      )
    }
    const tier = job.defaultRetention.tiers[0]
    const interval = this.intervalFromSeconds(tier?.intervalSeconds)
    return {
      ...this.defaultEditor(),
      ...schedule,
      services: this.serviceChoices(selected),
      legacySelection,
      includeFuture,
      keepAdditional: !!tier,
      interval,
      duration: tier
        ? Math.max(1, Math.round(tier.coverageSeconds / tier.intervalSeconds))
        : 7,
    }
  }

  private ensureServices() {
    if (!this.editor.services.length) {
      this.editor.services = this.serviceChoices()
    }
  }

  canContinue(): boolean {
    if (this.step() === 1) return !!this.targetId()
    if (this.step() === 2) {
      this.ensureServices()
      return this.editor.services.some(service => service.checked)
    }
    return true
  }

  canSaveSetup(): boolean {
    return (
      !!this.editor.password &&
      !this.capacityBlocked() &&
      this.editor.services.some(service => service.checked)
    )
  }

  async next() {
    if (!this.canContinue()) return
    if (this.step() === 1) this.ensureServices()
    if (this.step() === 2) await this.refreshCapacity()
    this.step.update(step => Math.min(3, step + 1))
  }

  previous() {
    this.step.update(step => Math.max(1, step - 1))
  }

  toggleAllServices() {
    this.ensureServices()
    const select = !this.editor.services.some(service => service.checked)
    this.editor.services.forEach(service => (service.checked = select))
  }

  scheduleSummary(): string {
    const time = `${String(this.editor.hour).padStart(2, '0')}:${String(
      this.editor.minute,
    ).padStart(2, '0')}`
    if (this.editor.frequency === 'hourly') {
      return `Hourly at minute ${String(this.editor.minute).padStart(2, '0')}`
    }
    if (this.editor.frequency === 'weekly') {
      return `${this.weekdays[this.editor.weekday]?.label || 'Sunday'} at ${time}`
    }
    return `Daily at ${time}`
  }

  retentionSummary(): string {
    return `Keep one backup every ${this.editor.interval} for ${this.editor.duration} periods`
  }

  selectedServiceSummary(): string {
    const selected = this.editor.services.filter(service => service.checked)
    if (
      selected.length === this.editor.services.length &&
      this.editor.includeFuture
    ) {
      return 'All current and future services'
    }
    return `${selected.length} of ${this.editor.services.length} services`
  }

  selectedTargetName(): string {
    return (
      this.targets().find(target => target.id === this.targetId())?.name || '—'
    )
  }

  private serviceScope(): T.BackupServiceScope {
    const selected = this.editor.services
      .filter(service => service.checked)
      .map(service => service.id)
    if (this.editor.legacySelection && !this.editor.includeFuture) {
      return { type: 'selected', packageIds: selected }
    }
    return {
      type: 'allExcept',
      excludedPackageIds: this.editor.services
        .filter(service => !service.checked)
        .map(service => service.id),
    }
  }

  private policy(): T.RetentionPolicy {
    if (!this.editor.keepAdditional) return { tiers: [] }
    const intervalSeconds = this.intervalSeconds(this.editor.interval)
    return {
      tiers: [
        {
          intervalSeconds,
          coverageSeconds: intervalSeconds * Math.max(1, this.editor.duration),
        },
      ],
    }
  }

  async refreshCapacity() {
    try {
      this.estimates.set(
        await this.api.estimateScheduledBackupCapacity({
          targetId: this.targetId(),
          services: this.serviceScope(),
          defaultRetention: this.policy(),
          retentionOverrides: {},
        }),
      )
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
      this.estimates.set([])
    }
  }

  capacityNeeded(): number | null {
    if (!this.estimates().length) return null
    return this.estimates().reduce(
      (sum, item) => sum + item.conservativePeakExcludingManualBytes,
      0,
    )
  }

  capacityAvailable(): number | null {
    const target = this.targets().find(item => item.id === this.targetId())
    return target?.capacity != null && target.used != null
      ? Math.max(0, target.capacity - target.used)
      : null
  }

  capacityAvailableLabel(): string {
    const available = this.capacityAvailable()
    return available === null ? 'Availability unknown' : this.bytes(available)
  }

  capacityBlocked(): boolean {
    const needed = this.capacityNeeded()
    const available = this.capacityAvailable()
    return needed !== null && available !== null && needed > available
  }

  capacityAppearance(): 'info' | 'negative' {
    return this.capacityBlocked() ? 'negative' : 'info'
  }

  async createAutomaticBackup() {
    if (!this.canSaveSetup()) return
    this.saving.set(true)
    const loader = this.notifications.open('Saving').subscribe()
    try {
      const job = await this.api.createScheduledBackupJob({
        name: 'Automatic backups',
        targetId: this.targetId(),
        services: this.serviceScope(),
        schedule: serializeBackupSchedule(this.editor),
        defaultRetention: this.policy(),
        retentionOverrides: {},
        password: this.editor.password,
        enabled: true,
      })
      if (this.editor.firstBackupNow) {
        await this.api.runScheduledBackupJob({ id: job.id })
      }
      await this.router.navigate(['/system/backups'])
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    } finally {
      loader.unsubscribe()
      this.saving.set(false)
    }
  }

  async savePrimary(job: T.BackupJob) {
    this.saving.set(true)
    const loader = this.notifications.open('Saving').subscribe()
    try {
      await this.api.updateScheduledBackupJob({
        id: job.id,
        name: job.name || 'Automatic backups',
        services: this.serviceScope(),
        schedule: serializeBackupSchedule(this.editor),
        defaultRetention: this.policy(),
        retentionOverrides: job.retentionOverrides,
      })
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    } finally {
      loader.unsubscribe()
      this.saving.set(false)
    }
  }

  async toggleAllJobs(enabled: boolean) {
    try {
      await Promise.all(
        this.jobs().map(job =>
          this.api.setScheduledBackupJobEnabled({ id: job.id, enabled }),
        ),
      )
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    }
  }

  async toggleMain(enabled: boolean) {
    if (enabled) {
      await this.toggleAllJobs(true)
    } else {
      await this.disableAutomatic()
    }
  }

  anyJobEnabled(): boolean {
    return this.jobs().some(job => job.enabled)
  }

  async disableAutomatic() {
    const snapshots = this.histories().flatMap(history =>
      history.snapshots.map(snapshot => ({ history, snapshot })),
    )
    const bytes = snapshots.reduce(
      (sum, item) =>
        sum + (item.snapshot.physicalSize ?? item.snapshot.logicalSize),
      0,
    )
    const confirmed = await firstValueFrom(
      this.dialogs
        .openConfirm({
          label: this.deleteWhenDisabled
            ? 'Turn off and delete automatic checkpoints?'
            : 'Turn off automatic backups?',
          size: 's',
          data: {
            content: this.deleteWhenDisabled
              ? `This will pause every schedule and permanently delete ${snapshots.length} automatic checkpoints, reclaiming about ${this.bytes(bytes)}. Manual checkpoints and any still-shared checkpoints are kept.`
              : 'This pauses every schedule. Settings and existing checkpoints are kept.',
            yes: this.deleteWhenDisabled ? 'Turn off and delete' : 'Turn off',
            no: 'Cancel',
          },
        })
        .pipe(filter(Boolean)),
      { defaultValue: false },
    )
    if (!confirmed) return

    try {
      for (const job of this.jobs()) {
        if (job.enabled) {
          await this.api.setScheduledBackupJobEnabled({
            id: job.id,
            enabled: false,
          })
        }
      }
      if (this.deleteWhenDisabled) {
        for (const history of this.histories()) {
          const ids = history.snapshots.map(snapshot => snapshot.id)
          if (ids.length) {
            await this.api.deleteArchivedBackupSnapshots({
              targetId: history.targetId,
              packageId: history.packageId,
              snapshotIds: ids,
            })
          }
        }
      }
      this.deleteWhenDisabled = false
    } catch (error: any) {
      this.errors.handleError(getErrorMessage(error))
    }
  }

  filteredActivities(): T.BackupActivity[] {
    return this.historyFilter === 'all'
      ? this.activities()
      : this.activities().filter(
          activity => activity.kind === this.historyFilter,
        )
  }

  activityLabel(activity: T.BackupActivity): string {
    if (activity.kind === 'manual') return 'Manual backup'
    if (activity.kind === 'restore') return 'Restore'
    return activity.jobName || 'Automatic backup'
  }

  activityState(activity: T.BackupActivity): string {
    switch (activity.state) {
      case 'succeeded':
        return 'Succeeded'
      case 'partiallyFailed':
        return 'Partially failed'
      case 'failed':
        return 'Failed'
      default:
        return 'In progress'
    }
  }

  activityIcon(activity: T.BackupActivity): string {
    if (activity.kind === 'manual') return '@tui.copy-plus'
    if (activity.kind === 'restore') return '@tui.database-backup'
    return '@tui.calendar-clock'
  }

  activityAppearance(
    activity: T.BackupActivity,
  ): 'positive' | 'warning' | 'negative' | 'neutral' {
    if (activity.state === 'succeeded') return 'positive'
    if (activity.state === 'partiallyFailed') return 'warning'
    if (activity.state === 'failed') return 'negative'
    return 'neutral'
  }

  targetName(id: string): string {
    return this.targets().find(target => target.id === id)?.name || id
  }

  bytes(value: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let amount = value
    let unit = 0
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024
      unit += 1
    }
    return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`
  }

  private intervalSeconds(interval: AutomaticEditor['interval']): number {
    if (interval === 'week') return 7 * 24 * 60 * 60
    if (interval === 'month') return 30 * 24 * 60 * 60
    return 24 * 60 * 60
  }

  private intervalFromSeconds(seconds?: number): AutomaticEditor['interval'] {
    if (!seconds || seconds < 7 * 24 * 60 * 60) return 'day'
    if (seconds < 30 * 24 * 60 * 60) return 'week'
    return 'month'
  }
}
