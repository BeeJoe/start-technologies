import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  backupJobNeedsAttention,
  parseBackupSchedule,
  parseBackupRetentionTier,
  parseBackupServiceSelection,
  retentionIntervalFromSeconds,
  retentionIntervalSeconds,
  retentionPeriodLabel,
  serializeBackupRetentionTier,
  serializeBackupServiceSelection,
  serializeBackupSchedule,
} from '../../../projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/scheduled.utils.ts'

const automaticComponent = readFileSync(
  new URL(
    '../../../projects/start-os/web/ui/src/app/routes/portal/routes/backups/automatic.component.ts',
    import.meta.url,
  ),
  'utf8',
)
const advancedComponent = readFileSync(
  new URL(
    '../../../projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/scheduled.component.ts',
    import.meta.url,
  ),
  'utf8',
)
const backupsComponent = readFileSync(
  new URL(
    '../../../projects/start-os/web/ui/src/app/routes/portal/routes/backups/backups.component.ts',
    import.meta.url,
  ),
  'utf8',
)
const statusComponent = readFileSync(
  new URL(
    '../../../projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/status.component.ts',
    import.meta.url,
  ),
  'utf8',
)
const deleteScheduleDialog = readFileSync(
  new URL(
    '../../../projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/delete-schedule.dialog.ts',
    import.meta.url,
  ),
  'utf8',
)
const serviceTaskComponent = readFileSync(
  new URL(
    '../../../projects/start-os/web/ui/src/app/routes/portal/routes/services/components/task.component.ts',
    import.meta.url,
  ),
  'utf8',
)
const scheduledBackupReview = readFileSync(
  new URL(
    '../../../shared-libs/crates/start-core/src/backup/scheduled/review.rs',
    import.meta.url,
  ),
  'utf8',
)
const serviceControl = readFileSync(
  new URL(
    '../../../shared-libs/crates/start-core/src/control.rs',
    import.meta.url,
  ),
  'utf8',
)
const badgeService = readFileSync(
  new URL(
    '../../../projects/start-os/web/ui/src/app/services/badge.service.ts',
    import.meta.url,
  ),
  'utf8',
)
const backupService = readFileSync(
  new URL(
    '../../../projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/backup.service.ts',
    import.meta.url,
  ),
  'utf8',
)
const scheduledBackupRpc = readFileSync(
  new URL(
    '../../../shared-libs/crates/start-core/src/backup/scheduled/rpc.rs',
    import.meta.url,
  ),
  'utf8',
)
const createBackupJobRpc = scheduledBackupRpc.slice(
  scheduledBackupRpc.indexOf('pub async fn create('),
  scheduledBackupRpc.indexOf(
    '#[derive(Deserialize, Serialize, TS)]',
    scheduledBackupRpc.indexOf('pub async fn create('),
  ),
)

test('serializes hourly through monthly controls as five-field cron', () => {
  assert.equal(
    serializeBackupSchedule({
      frequency: 'hourly',
      minute: 15,
      hour: 9,
      weekday: 2,
      dayOfMonth: 14,
      timezone: 'America/Chicago',
    }).cron,
    '15 * * * *',
  )
  assert.equal(
    serializeBackupSchedule({
      frequency: 'daily',
      minute: 5,
      hour: 23,
      weekday: 2,
      dayOfMonth: 14,
      timezone: 'America/Chicago',
    }).cron,
    '5 23 * * *',
  )
  assert.equal(
    serializeBackupSchedule({
      frequency: 'weekly',
      minute: 30,
      hour: 4,
      weekday: 1,
      dayOfMonth: 14,
      timezone: 'America/Chicago',
    }).cron,
    '30 4 * * 1',
  )
  assert.equal(
    serializeBackupSchedule({
      frequency: 'monthly',
      minute: 45,
      hour: 6,
      weekday: 1,
      dayOfMonth: 14,
      timezone: 'America/Chicago',
    }).cron,
    '45 6 14 * *',
  )
})

test('editing preserves the captured timezone', () => {
  assert.deepEqual(
    parseBackupSchedule({
      cron: '45 6 * * 0',
      timezone: 'Europe/Warsaw',
    }),
    {
      frequency: 'weekly',
      minute: 45,
      hour: 6,
      weekday: 0,
      dayOfMonth: 1,
      timezone: 'Europe/Warsaw',
    },
  )

  assert.deepEqual(
    parseBackupSchedule({
      cron: '15 8 23 * *',
      timezone: 'Europe/Warsaw',
    }),
    {
      frequency: 'monthly',
      minute: 15,
      hour: 8,
      weekday: 0,
      dayOfMonth: 23,
      timezone: 'Europe/Warsaw',
    },
  )
})

test('primary and advanced jobs share future-service selection semantics', () => {
  const installed = ['bitcoind', 'lnd', 'electrs']

  assert.deepEqual(
    parseBackupServiceSelection(
      { type: 'allExcept', excludedPackageIds: ['electrs'] },
      installed,
    ),
    {
      packageIds: ['bitcoind', 'lnd'],
      includeFuture: true,
      preservedSelectedPackageIds: [],
      preservedExcludedPackageIds: [],
    },
  )
  assert.deepEqual(
    parseBackupServiceSelection(
      { type: 'selected', packageIds: ['bitcoind'] },
      installed,
    ),
    {
      packageIds: ['bitcoind'],
      includeFuture: false,
      preservedSelectedPackageIds: [],
      preservedExcludedPackageIds: [],
    },
  )
  assert.deepEqual(
    serializeBackupServiceSelection(
      {
        packageIds: ['bitcoind', 'lnd'],
        includeFuture: true,
        preservedSelectedPackageIds: [],
        preservedExcludedPackageIds: [],
      },
      installed,
    ),
    {
      type: 'allExcept',
      excludedPackageIds: ['electrs'],
    },
  )
  assert.deepEqual(
    serializeBackupServiceSelection(
      {
        packageIds: ['bitcoind'],
        includeFuture: false,
        preservedSelectedPackageIds: [],
        preservedExcludedPackageIds: [],
      },
      installed,
    ),
    {
      type: 'selected',
      packageIds: ['bitcoind'],
    },
  )

  const unavailable = parseBackupServiceSelection(
    {
      type: 'allExcept',
      excludedPackageIds: ['electrs', 'temporarily-uninstalled'],
    },
    installed,
  )
  assert.deepEqual(unavailable, {
    packageIds: ['bitcoind', 'lnd'],
    includeFuture: true,
    preservedSelectedPackageIds: [],
    preservedExcludedPackageIds: ['temporarily-uninstalled'],
  })
  assert.deepEqual(serializeBackupServiceSelection(unavailable, installed), {
    type: 'allExcept',
    excludedPackageIds: ['temporarily-uninstalled', 'electrs'],
  })

  const unavailableSelected = parseBackupServiceSelection(
    {
      type: 'selected',
      packageIds: ['bitcoind', 'temporarily-uninstalled'],
    },
    installed,
  )
  assert.deepEqual(unavailableSelected, {
    packageIds: ['bitcoind'],
    includeFuture: false,
    preservedSelectedPackageIds: ['temporarily-uninstalled'],
    preservedExcludedPackageIds: [],
  })
  assert.deepEqual(
    serializeBackupServiceSelection(unavailableSelected, installed),
    {
      type: 'selected',
      packageIds: ['bitcoind', 'temporarily-uninstalled'],
    },
  )
})

test('advanced retention round-trips a nonstandard first tier', () => {
  for (const tier of [
    {
      intervalSeconds: 6 * 60 * 60,
      coverageSeconds: 7 * 24 * 60 * 60,
    },
    {
      intervalSeconds: 30 * 60,
      coverageSeconds: 2 * 60 * 60,
    },
  ]) {
    assert.deepEqual(
      serializeBackupRetentionTier(parseBackupRetentionTier(tier)),
      tier,
    )
  }
})

test('job editing preserves hidden custom tiers until that row changes', () => {
  assert.match(
    advancedComponent,
    /preserved:\s*\{[\s\S]{0,120}tier: structuredClone\(tier\)[\s\S]{0,120}interval,[\s\S]{0,120}duration/,
  )
  assert.match(
    advancedComponent,
    /private serializeRetentionRule[\s\S]{0,500}rule\.preserved[\s\S]{0,300}rule\.interval === rule\.preserved\.interval[\s\S]{0,300}rule\.duration === rule\.preserved\.duration[\s\S]{0,300}structuredClone\(rule\.preserved\.tier\)/,
  )
  assert.match(
    advancedComponent,
    /private defaultPolicy[\s\S]{0,300}this\.serializeRetentionRule\(form\)/,
  )
})

test('version history supports hourly through monthly intervals', () => {
  assert.equal(retentionIntervalSeconds('hour'), 60 * 60)
  assert.equal(retentionIntervalSeconds('day'), 24 * 60 * 60)
  assert.equal(retentionIntervalSeconds('week'), 7 * 24 * 60 * 60)
  assert.equal(retentionIntervalSeconds('month'), 30 * 24 * 60 * 60)

  assert.equal(retentionIntervalFromSeconds(), 'day')
  assert.equal(retentionIntervalFromSeconds(60 * 60), 'hour')
  assert.equal(retentionIntervalFromSeconds(24 * 60 * 60), 'day')
  assert.equal(retentionIntervalFromSeconds(7 * 24 * 60 * 60), 'week')
  assert.equal(retentionIntervalFromSeconds(30 * 24 * 60 * 60), 'month')
})

test('version-history toggles follow their labels on desktop', () => {
  for (const component of [automaticComponent, advancedComponent]) {
    const headingClass = component.indexOf('retention-heading')
    const headingStart = component.lastIndexOf('<div', headingClass)
    const headingEnd = component.indexOf('</div>', headingStart)
    const heading = component.slice(headingStart, headingEnd)

    assert.ok(headingStart >= 0)
    assert.ok(
      heading.indexOf('Keep additional versions') <
        heading.indexOf('tuiSwitch'),
    )
  }
})

test('version history names the selected period and pluralizes it', () => {
  assert.equal(retentionPeriodLabel('hour', 1), 'hour')
  assert.equal(retentionPeriodLabel('hour', 2), 'hours')
  assert.equal(retentionPeriodLabel('day', 2), 'days')
  assert.equal(retentionPeriodLabel('week', 2), 'weeks')
  assert.equal(retentionPeriodLabel('month', 2), 'months')
})

test('automatic setup places its toggleable password after the first-run choice and submits on Enter', () => {
  const reviewStart = automaticComponent.indexOf('@if (step() === 3)')
  const reviewEnd = automaticComponent.indexOf(
    '<footer class="wizard-actions">',
    reviewStart,
  )
  const review = automaticComponent.slice(reviewStart, reviewEnd)

  assert.ok(
    review.indexOf('Create the first backup now') <
      review.indexOf('[(ngModel)]="editor.password"'),
  )
  assert.match(review, /\(keyup\.enter\)="createAutomaticBackup\(\)"/)
  assert.match(review, /<tui-icon tuiPassword \/>/)
  assert.match(
    automaticComponent,
    /async createAutomaticBackup\(\)\s*\{\s*if \(!this\.canSaveSetup\(\) \|\| this\.saving\(\)\) return/,
  )
  assert.match(
    automaticComponent,
    /createScheduledBackupJob\(\{[\s\S]{0,500}runNow: this\.editor\.firstBackupNow/,
  )
  assert.match(
    automaticComponent,
    /const created = await this\.api\.createScheduledBackupJob/,
  )
  assert.match(
    automaticComponent,
    /this\.backupService\.showQueuedNotification\(created\)/,
  )
  assert.doesNotMatch(automaticComponent, /wasBlocked/)
})

test('retention summary translates the sentence as well as its units', () => {
  const summaryStart = automaticComponent.indexOf('retentionSummary(): string')
  const summaryEnd = automaticComponent.indexOf(
    'selectedServiceSummary()',
    summaryStart,
  )
  const summary = automaticComponent.slice(summaryStart, summaryEnd)

  assert.match(summary, /this\.i18n\.transform\('Keep one backup every'\)/)
  assert.match(summary, /this\.i18n\.transform\('for'\)/)
  const advancedSummary = advancedComponent.slice(
    advancedComponent.indexOf('retentionSummary(form: JobEditor)'),
    advancedComponent.indexOf(
      'retentionPeriod(form: JobEditor)',
      advancedComponent.indexOf('retentionSummary(form: JobEditor)'),
    ),
  )
  assert.match(
    advancedSummary,
    /\[form, \.\.\.form\.additionalTiers\][\s\S]{0,120}\.map\(/,
  )
})

test('first-time setup shares the collapsed service and repeatable version-history controls', () => {
  const servicesStart = automaticComponent.indexOf(
    "<b>{{ 'Services' | i18n }}</b>",
  )
  const servicesEnd = automaticComponent.indexOf(
    "<b>{{ 'Version history' | i18n }}</b>",
    servicesStart,
  )
  const services = automaticComponent.slice(servicesStart, servicesEnd)

  assert.doesNotMatch(services, /Select services|>\s*Done\s*</)
  assert.match(
    automaticComponent,
    /<tui-accordion class="services-accordion">[\s\S]{0,160}\[tuiAccordion\]="showServices\(\)"/,
  )
  assert.match(services, /<tui-expand>/)
  assert.doesNotMatch(services, /section-toggle|@tui\.chevron-down/)
  assert.match(services, /tuiCheckbox[\s\S]{0,180}allServicesSelected/)
  assert.match(services, /tuiCheckbox[\s\S]{0,180}editor\.includeFuture/)
  assert.match(services, /tuiCheckbox[\s\S]{0,180}service\.checked/)
  assert.ok(
    services.indexOf('Automatically include future services') <
      services.indexOf('Toggle all'),
  )
  assert.ok(services.indexOf('Toggle all') < services.indexOf('tuiGroup'))

  const versionHistory = automaticComponent.slice(
    servicesEnd,
    automaticComponent.indexOf('@if (step() === 3)', servicesEnd),
  )
  assert.match(versionHistory, /retentionRules\(\)/)
  assert.match(versionHistory, /class="duration-field"/)
  assert.match(versionHistory, /iconStart="@tui\.plus"/)
  assert.match(
    automaticComponent,
    /additionalRules: AutomaticRetentionRule\[\]/,
  )
})

test('setup and job-editor summaries use localized labels', () => {
  for (const component of [automaticComponent, advancedComponent]) {
    const classStart = component.indexOf('export')
    const scheduleStart = component.indexOf('scheduleSummary(', classStart)
    const serviceStart = component.indexOf(
      'selectedServiceSummary(',
      scheduleStart,
    )
    const retentionStart = component.indexOf('retentionSummary(', serviceStart)
    const schedule = component.slice(scheduleStart, serviceStart)
    const services = component.slice(serviceStart, retentionStart)

    assert.match(schedule, /this\.i18n\.transform\('Hourly'\)/)
    assert.match(schedule, /this\.i18n\.transform\('Daily'\)/)
    assert.match(services, /this\.i18n\.transform\('Services'\)/)
  }
})

test('all backup schedules share one selected-job editor', () => {
  assert.match(automaticComponent, /scheduledBackups[\s\S]{0,80}mode="manage"/)
  assert.doesNotMatch(advancedComponent, /primaryJobId/)
  assert.match(
    advancedComponent,
    /readonly mode = input\.required<'manage' \| 'restore'>\(\)/,
  )
  assert.match(advancedComponent, /Add schedule/)
  assert.match(advancedComponent, /View all schedules/)
  assert.match(
    advancedComponent,
    /class="schedule-list"[\s\S]{0,1200}@for \(job of jobs\(\); track job\.id\)/,
  )
  assert.match(advancedComponent, /\(click\)="edit\(job\)"/)
  assert.match(advancedComponent, /View\/Edit/)
  assert.match(
    advancedComponent,
    /iconStart="@tui\.plus"[\s\S]{0,160}\(click\)="create\(\)"/,
  )
  assert.doesNotMatch(advancedComponent, /Advanced schedules/)
  assert.doesNotMatch(
    advancedComponent,
    /job\.id === primaryJobId\(\)[\s\S]{0,500}\(click\)="deleteJob\(job\)"/,
  )
  assert.doesNotMatch(advancedComponent, /name="scope"/)

  const servicesStart = advancedComponent.indexOf(
    "<b>{{ 'Services' | i18n }}</b>",
  )
  const servicesEnd = advancedComponent.indexOf(
    "<b>{{ 'Version history' | i18n }}</b>",
    servicesStart,
  )
  const services = advancedComponent.slice(servicesStart, servicesEnd)
  assert.match(services, /tuiGroup/)
  assert.match(services, /tuiBlock="m"/)
  assert.doesNotMatch(services, /Select services|>\s*Done\s*</)
  assert.match(
    advancedComponent,
    /<tui-accordion class="services-accordion">[\s\S]{0,160}\[tuiAccordion\]="showServices\(\)"/,
  )
  assert.match(services, /<tui-expand>/)
  assert.doesNotMatch(services, /section-toggle|@tui\.chevron-down/)
  assert.match(services, /\[\(ngModel\)\]="form\.includeFuture"/)
  assert.match(services, /tuiCheckbox[\s\S]{0,220}form\.includeFuture/)
  assert.match(services, /tuiCheckbox[\s\S]{0,360}togglePackage/)
  assert.match(services, /Automatically include future services/)
  assert.ok(
    services.indexOf('Automatically include future services') <
      services.indexOf('Toggle all'),
  )
  assert.ok(services.indexOf('Toggle all') < services.indexOf('tuiGroup'))

  const retentionStart = servicesEnd
  const retentionEnd = advancedComponent.indexOf('</form>', retentionStart)
  const retention = advancedComponent.slice(retentionStart, retentionEnd)
  assert.match(
    advancedComponent,
    /retentionIntervals:[\s\S]{0,160}\['hour', 'day', 'week', 'month'\]/,
  )
  assert.match(advancedComponent, /tuiSelect[\s\S]{0,1200}retentionIntervals/)
  assert.match(retention, /iconStart="@tui\.plus"/)
  assert.doesNotMatch(
    retention,
    /<button tuiOption \[value\]="interval">[\s\S]{0,120}Custom/,
  )
  assert.doesNotMatch(retention, /Per-service retention overrides/)
  assert.doesNotMatch(retention, /Retention tiers|Add tier|Custom tiers/)

  assert.ok(
    advancedComponent.indexOf('Create the first backup now') <
      advancedComponent.indexOf('[(ngModel)]="form.password"'),
  )
  assert.match(
    advancedComponent,
    /<form class="editor panel" \(ngSubmit\)="save\(form\)"/,
  )
  assert.match(
    advancedComponent,
    /class="editor-heading"[\s\S]{0,240}\{\{ form\.name/,
  )
  assert.match(
    advancedComponent,
    /isDefaultJob\(form\)[\s\S]{0,120}Edit automatic schedule/,
  )
  assert.doesNotMatch(advancedComponent, /\(keyup\.enter\)="save\(form\)"/)
  assert.match(
    advancedComponent,
    /async save\(form: JobEditor\)\s*\{\s*if \(this\.saving\(\) \|\| !this\.canSave\(form\)\) return/,
  )
  assert.match(
    advancedComponent,
    /\[disabled\]="saving\(\) \|\| !canSave\(form\)"/,
  )
  assert.match(
    advancedComponent,
    /createScheduledBackupJob\(\{[\s\S]{0,500}runNow: form\.firstBackupNow/,
  )
  assert.match(
    advancedComponent,
    /const created = await this\.api\.createScheduledBackupJob/,
  )
  assert.match(
    advancedComponent,
    /this\.backupService\.showQueuedNotification\(created\)/,
  )
  assert.doesNotMatch(advancedComponent, /wasBlocked/)
  assert.match(
    backupService,
    /showQueuedNotification\(job: T\.BackupJob\)[\s\S]{0,100}if \(!job\.status\.runRequested\) return[\s\S]{0,500}The first backup is queued and will start automatically when no backup or restore is in progress\./,
  )
  assert.match(
    createBackupJobRpc,
    /if job\.status\.run_requested[\s\S]{0,160}scheduler::dispatch_due_jobs\(&ctx\)[\s\S]{0,300}as_idx\(&id\)/,
  )
  assert.match(advancedComponent, /#jobNameInput[\s\S]{0,120}name="name"/)
  assert.match(
    advancedComponent,
    /create\(\)[\s\S]{0,1500}afterNextRender\(\(\) => this\.jobNameInput\(\)\?\.nativeElement\.focus\(\)/,
  )
  assert.match(
    advancedComponent,
    /async save\(form: JobEditor\)[\s\S]{0,1900}this\.selectedJobId\.set\(''\)[\s\S]{0,180}this\.editor\.set\(null\)[\s\S]{0,180}this\.showSingleJobList = true[\s\S]{0,180}await this\.reload\(\)/,
  )
  assert.match(
    advancedComponent,
    /this\.jobs\(\)\.length === 1 && !this\.showSingleJobList/,
  )
})

test('multiple automatic jobs expand as a list before an individual editor', () => {
  assert.match(
    advancedComponent,
    /jobs\(\)\.length > 1[\s\S]{0,1200}class="schedule-list"/,
  )
  assert.match(
    advancedComponent,
    /class="schedule-job"[\s\S]{0,1800}tuiSwitch[\s\S]{0,900}iconStart="@tui\.ellipsis-vertical"[\s\S]{0,600}Run now[\s\S]{0,600}View\/Edit/,
  )
  assert.match(
    advancedComponent,
    /@if \(jobs\(\)\.length > 1 && editor\(\)\)[\s\S]{0,800}View all schedules/,
  )
  assert.match(
    backupsComponent,
    /jobs\(\)\.length === 1[\s\S]{0,500}simple-switch/,
  )
  const automaticHeading = backupsComponent.slice(
    backupsComponent.lastIndexOf(
      '<header',
      backupsComponent.indexOf('class="card-heading automatic-heading"'),
    ),
    backupsComponent.indexOf(
      '</header>',
      backupsComponent.indexOf('class="card-heading automatic-heading"'),
    ),
  )
  assert.match(
    automaticHeading,
    /jobs\(\)\.length === 1[\s\S]{0,900}iconStart="@tui\.ellipsis-vertical"[\s\S]{0,500}Run now[\s\S]{0,500}View\/Edit/,
  )
  assert.match(
    automaticHeading,
    /@if \(!primary\(\)\?\.enabled\)[\s\S]{0,100}Paused[\s\S]{0,1400}Add schedule/,
  )
  assert.match(
    automaticHeading,
    /tuiAppearance="flat-destructive"[\s\S]{0,100}deleteSchedule\(\)/,
  )
  assert.match(
    automaticHeading,
    /@if \(jobs\(\)\.length !== 1\)[\s\S]{0,400}expand-toggle/,
  )
  assert.match(
    backupsComponent,
    /\[createRequest\]="createScheduleRequest\(\)"/,
  )
  assert.match(
    advancedComponent,
    /readonly createRequest = input\(0\)[\s\S]{0,6000}this\.create\(\)/,
  )
  assert.match(
    backupsComponent,
    /openAutomaticEditor\(\)[\s\S]{0,120}expanded\.set\('automatic'\)/,
  )
  assert.doesNotMatch(
    automaticHeading,
    /<button\s+tuiButton[\s\S]{0,180}Run now/,
  )
  const toolbar = advancedComponent.slice(
    advancedComponent.indexOf('<div class="jobs-toolbar">'),
    advancedComponent.indexOf(
      '</div>',
      advancedComponent.indexOf('<div class="jobs-toolbar">'),
    ),
  )
  assert.doesNotMatch(toolbar, /Automatic backups/)
  assert.ok(
    advancedComponent.indexOf('class="schedule-list"') <
      advancedComponent.indexOf('<div class="jobs-toolbar">'),
  )
  assert.match(
    advancedComponent,
    /viewAllJobs\(\)[\s\S]{0,120}warnUnsavedChanges\(\)/,
  )
  assert.match(
    advancedComponent,
    /warnUnsavedChanges\(\)[\s\S]{0,500}Changes were not saved/,
  )
  assert.doesNotMatch(
    advancedComponent,
    /\.schedule-browser\s*\{[\s\S]{0,160}border:/,
  )
})

test('new services get a dismissible recommended backup task without blocking start', () => {
  assert.match(scheduledBackupReview, /BACKUP_REVIEW_ACTION_ID/)
  assert.match(scheduledBackupReview, /TaskSeverity::Important/)
  assert.match(
    scheduledBackupReview,
    /included_by_future_policy[\s\S]{0,1800}if included_by_future_policy[\s\S]{0,80}return Ok\(\(\)\)/,
  )
  assert.doesNotMatch(scheduledBackupReview, /NotificationLevel|notify\(/)
  assert.doesNotMatch(serviceControl, /ensure_review_resolved/)
  assert.match(serviceTaskComponent, /Add to backup schedule/)
  assert.match(
    serviceTaskComponent,
    /if \(this\.backupReview\(\)\)[\s\S]{0,2600}queryParams: \{ addService: task\.packageId \}/,
  )
  assert.match(
    serviceTaskComponent,
    /getNewServiceBackupReviews[\s\S]{0,800}resolveNewServiceBackupReview/,
  )
  assert.match(
    advancedComponent,
    /visibleReviews\(\)[\s\S]{0,900}Toggle all[\s\S]{0,1500}Save backup schedules/,
  )
  assert.match(
    advancedComponent,
    /jobs\(\)\.length > 1 && !editor\(\) \? visibleReviews\(\) : \[\]/,
  )
  assert.match(
    serviceTaskComponent,
    /getScheduledBackupJobs[\s\S]{0,1800}jobs\.length === 1/,
  )
  assert.match(
    serviceTaskComponent,
    /Add to current schedule[\s\S]{0,500}Create a new schedule/,
  )
  assert.match(
    serviceTaskComponent,
    /decision === 'add'[\s\S]{0,900}resolveNewServiceBackupReview/,
  )
  assert.match(
    serviceTaskComponent,
    /decision === 'create'[\s\S]{0,500}createSchedule: true/,
  )
  assert.match(
    advancedComponent,
    /visibleReviews\(\)[\s\S]{0,1800}Add new schedule/,
  )
  assert.match(
    advancedComponent,
    /createForReview\(review[\s\S]{0,500}packageIds = \[review\.packageId\]/,
  )
})

test('collapsed automatic card surfaces attention without leaking one schedule into a multi-job summary', () => {
  const heading = backupsComponent.slice(
    backupsComponent.lastIndexOf(
      '<header',
      backupsComponent.indexOf('class="card-heading automatic-heading"'),
    ),
    backupsComponent.indexOf(
      '</header>',
      backupsComponent.indexOf('class="card-heading automatic-heading"'),
    ),
  )
  const body = backupsComponent.slice(
    backupsComponent.indexOf('<div class="card-body">'),
    backupsComponent.indexOf('</automatic-backups>'),
  )

  assert.match(
    heading,
    /needsAttention\(\)[\s\S]{0,260}Automatic backups need attention/,
  )
  assert.doesNotMatch(body, /Automatic backups need attention/)
  assert.match(
    backupsComponent,
    /if \(jobs\.length > 1\)[\s\S]{0,220}\$\{jobs\.length\} schedules/,
  )

  assert.equal(
    backupJobNeedsAttention({
      enabled: true,
      pause: null,
      status: { lastResult: 'failed' },
    }),
    true,
  )
  assert.equal(
    backupJobNeedsAttention({
      enabled: true,
      pause: null,
      status: { lastResult: 'succeeded' },
    }),
    false,
  )
  assert.equal(
    backupJobNeedsAttention({
      enabled: false,
      pause: { reason: 'user' },
      status: { lastResult: 'failed' },
    }),
    false,
  )
  assert.match(
    backupsComponent,
    /this\.jobs\(\)\.some\(backupJobNeedsAttention\)/,
  )
})

test('backup activity does not create a red system navigation badge', () => {
  assert.match(badgeService, /private readonly system\$ = this\.general\$/)
  assert.doesNotMatch(
    badgeService,
    /private readonly system\$ = combineLatest\(\[this\.general\$, this\.backups\$\]\)/,
  )
})

test('schedule list uses schedule terminology and styled menu actions', () => {
  const list = advancedComponent.slice(
    advancedComponent.indexOf('class="schedule-list"'),
    advancedComponent.indexOf(
      '</section>',
      advancedComponent.indexOf('class="schedule-list"'),
    ),
  )
  const selected = advancedComponent.slice(
    advancedComponent.indexOf('class="selected-job"'),
    advancedComponent.indexOf(
      '</div>',
      advancedComponent.indexOf('class="selected-job"'),
    ),
  )
  const footer = advancedComponent.slice(
    advancedComponent.indexOf('<footer class="editor-actions">'),
    advancedComponent.indexOf(
      '</footer>',
      advancedComponent.indexOf('<footer class="editor-actions">'),
    ),
  )

  assert.match(list, /jobServiceCount\(job\)[\s\S]{0,120}'Services'/)
  assert.match(footer, /\(click\)="deleteJob\(job\)"/)
  assert.doesNotMatch(footer, /job\.id !== primaryJobId\(\)/)
  assert.doesNotMatch(selected, /deleteJob\(job\)/)
  assert.match(footer, /appearance="primary-destructive"/)
  assert.match(footer, /deleteJob\(job\)/)
  assert.match(footer, /Delete schedule/)
  assert.match(list, /tuiAppearance="flat"[\s\S]{0,120}runNow\(job\)/)
  assert.match(
    list,
    /tuiAppearance="flat-destructive"[\s\S]{0,120}deleteJob\(job\)/,
  )
  assert.match(advancedComponent, /View all schedules/)
  assert.match(advancedComponent, /Schedule name/)
  assert.doesNotMatch(advancedComponent, /View all jobs|Job name/)
  assert.match(deleteScheduleDialog, /Delete backup schedule\?/)
  assert.match(
    deleteScheduleDialog,
    /protected readonly deleteCheckpoints = signal\(false\)/,
  )
  assert.match(deleteScheduleDialog, /Delete related backups/)
  assert.match(deleteScheduleDialog, /\[\(ngModel\)\]="deleteCheckpoints"/)
  assert.match(
    deleteScheduleDialog,
    /deleteCheckpoints\(\)[\s\S]{0,120}Delete Schedule and Backups[\s\S]{0,120}Delete Schedule/,
  )
  assert.doesNotMatch(deleteScheduleDialog, /deleteAction/)
  assert.doesNotMatch(
    deleteScheduleDialog,
    /@if \(context\.data\.checkpointCount\)/,
  )
})

test('the first schedule keeps its default name hidden until another schedule exists', () => {
  assert.match(automaticComponent, /name: 'Default'/)
  assert.match(
    advancedComponent,
    /jobs\.sort\(\(a, b\) => a\.createdAt\.localeCompare\(b\.createdAt\)\)/,
  )
  assert.match(
    advancedComponent,
    /normalizeDefaultScheduleName\(\)[\s\S]{0,1200}name: 'Default'/,
  )
  assert.match(
    advancedComponent,
    /@if \(!isDefaultJob\(form\)\)[\s\S]{0,500}Schedule name/,
  )
  assert.match(
    advancedComponent,
    /isDefaultJob\(form\)[\s\S]{0,160}Edit automatic schedule/,
  )
  assert.match(
    advancedComponent,
    /isDefaultJob\(form: JobEditor\)[\s\S]{0,240}form\.id === this\.jobs\(\)\[0\]\?\.id/,
  )
  assert.match(
    automaticComponent,
    /createAutomaticBackup\(\)[\s\S]{0,1800}this\.embedded\(\)[\s\S]{0,120}this\.collapseRequested\.emit\(\)/,
  )
  assert.match(
    advancedComponent,
    /async save\(form: JobEditor\)[\s\S]{0,3000}this\.editor\.set\(null\)[\s\S]{0,240}this\.collapseRequested\.emit\(\)[\s\S]{0,240}await this\.reload\(\)/,
  )
})

test('capacity and storage warnings use clear user-facing wording', () => {
  assert.doesNotMatch(automaticComponent, /Available space unknown/)
  assert.doesNotMatch(automaticComponent, /capacityAvailableLabel/)
  assert.match(
    automaticComponent,
    /const available = this\.capacityAvailable\(\)[\s\S]{0,240}available === null/,
  )
  for (const component of [automaticComponent, advancedComponent]) {
    assert.match(component, /Every retained version is a full copy/)
    assert.match(component, /I understand the full-copy storage impact/)
  }
  assert.match(advancedComponent, /especially on network storage/)
  assert.doesNotMatch(advancedComponent, /especially on CIFS/)
})

test('canceling a job edit returns to the appropriate collapsed view', () => {
  assert.match(
    advancedComponent,
    /class="editor-heading"[\s\S]{0,1200}\(click\)="cancelEditor\(\)"[\s\S]{0,120}Cancel/,
  )
  assert.match(
    advancedComponent,
    /readonly collapseRequested = output<void>\(\)/,
  )
  assert.match(
    advancedComponent,
    /cancelEditor\(\)[\s\S]{0,120}warnUnsavedChanges\(\)[\s\S]{0,240}editor\.set\(null\)[\s\S]{0,180}collapseRequested\.emit\(\)/,
  )
  assert.match(
    automaticComponent,
    /\(collapseRequested\)="collapseRequested\.emit\(\)"/,
  )
  assert.match(
    backupsComponent,
    /\(collapseRequested\)="expanded\.set\(null\)"/,
  )
})

test('all unsaved schedule exit paths warn before discarding edits', () => {
  assert.match(
    advancedComponent,
    /hasUnsavedChanges\(\)[\s\S]{0,500}editorSnapshot\(form\) !== this\.editorBaseline/,
  )
  assert.match(
    advancedComponent,
    /warnUnsavedChanges\(\)[\s\S]{0,500}Changes were not saved/,
  )
  assert.match(
    advancedComponent,
    /\(window:beforeunload\)[\s\S]{0,120}confirmBrowserExit/,
  )
  assert.match(
    advancedComponent,
    /confirmBrowserExit\(event: BeforeUnloadEvent\)[\s\S]{0,260}hasUnsavedChanges\(\)[\s\S]{0,180}event\.preventDefault\(\)/,
  )
  assert.match(
    advancedComponent,
    /onDestroy\([\s\S]{0,160}warnUnsavedChanges\(\)/,
  )
})

test('backup Back buttons use the shared high-contrast appearance', () => {
  for (const component of [automaticComponent]) {
    assert.match(component, /appearance="backup-back"[\s\S]{0,180}Back/)
  }
})

test('service summary includes its count and future-service policy', () => {
  assert.match(
    advancedComponent,
    /selectedServiceSummary\(form: JobEditor\)[\s\S]{0,500}Future services included[\s\S]{0,200}Future services not included/,
  )
  assert.match(
    automaticComponent,
    /selectedServiceSummary\(\): string[\s\S]{0,500}Future services included[\s\S]{0,200}Future services not included/,
  )
})

test('capacity estimates collapse details beneath each service', () => {
  const capacity = advancedComponent.slice(
    advancedComponent.indexOf("{{ 'Capacity estimates' | i18n }}"),
    advancedComponent.indexOf(
      '@if (projectedCount(form) > 1)',
      advancedComponent.indexOf("{{ 'Capacity estimates' | i18n }}"),
    ),
  )

  assert.match(capacity, /class="capacity-service"/)
  assert.match(capacity, /class="capacity-summary"/)
  assert.match(capacity, /Maximum required space/)
  assert.match(capacity, /More Info/)
  assert.match(capacity, /<tui-expand>/)
  for (const label of [
    'Live data estimate',
    'Checkpoints',
    'Automatic storage',
    'Next-run staging',
  ]) {
    assert.match(capacity, new RegExp(label))
  }
  for (const label of [
    'Manual checkpoint',
    'Archived storage',
    'Last changed bytes',
    'Projected peak',
  ]) {
    assert.doesNotMatch(capacity, new RegExp(label))
  }
  assert.doesNotMatch(capacity, /<table|<thead|<th>/)
})

test('saving an edited schedule can queue a run immediately', () => {
  assert.match(
    advancedComponent,
    /name="firstBackupNow"[\s\S]{0,220}form\.firstBackupNow/,
  )
  assert.match(
    advancedComponent,
    /form\.id[\s\S]{0,180}Run now[\s\S]{0,260}Create the first backup now/,
  )
  assert.match(
    advancedComponent,
    /updateScheduledBackupJob\([\s\S]{0,800}form\.firstBackupNow[\s\S]{0,180}runScheduledBackupJob/,
  )
})

test('deleting a schedule returns to the list or collapses the last schedule', () => {
  assert.match(
    advancedComponent,
    /deleteJob\(job: T\.BackupJob\)[\s\S]{0,600}showSingleJobList = true[\s\S]{0,500}jobs\(\)\.length <= 1[\s\S]{0,180}collapseRequested\.emit\(\)/,
  )
})

test('turning off automatic backups directly pauses schedules without a delete dialog', () => {
  for (const component of [automaticComponent, backupsComponent]) {
    assert.doesNotMatch(component, /DISABLE_AUTOMATIC_DIALOG/)
    assert.doesNotMatch(component, /deleteArchivedBackupSnapshots/)
  }
  assert.match(
    automaticComponent,
    /async toggleMain\(enabled: boolean\)[\s\S]{0,240}toggleAllJobs\(enabled\)/,
  )
  assert.match(
    backupsComponent,
    /async setAutomatic\(enabled: boolean\)[\s\S]{0,500}setScheduledBackupJobEnabled/,
  )
})

test('automatic job switches are icon-only and remain accessible', () => {
  assert.doesNotMatch(
    advancedComponent,
    /job\.enabled && !job\.pause \? 'On' : 'Off'/,
  )
  assert.doesNotMatch(backupsComponent, /automaticOn\(\) \? 'On' : 'Off'/)
  assert.match(advancedComponent, /\[attr\.aria-label\]="job\.name"/)
  assert.match(
    backupsComponent,
    /\[attr\.aria-label\]="'Automatic backups' \| i18n"/,
  )
})

test('main schedule editors expose monthly frequency and day-of-month controls', () => {
  for (const component of [automaticComponent, advancedComponent]) {
    assert.match(component, /monthly/)
    assert.match(component, /dayOfMonth/)
    assert.match(component, /Day of month/)
    assert.match(component, /Monthly/)
  }
  assert.match(
    advancedComponent,
    /frequencies: BackupScheduleFrequency\[\] = \[[\s\S]{0,100}'monthly'/,
  )
})

test('schedule and version-history frequencies are required and every retention row is removable', () => {
  for (const component of [automaticComponent, advancedComponent]) {
    assert.match(
      component,
      /(?:name="frequency"[\s\S]{0,120}required|required[\s\S]{0,120}name="frequency")/,
    )
  }

  const retentionStart = advancedComponent.indexOf(
    "<b>{{ 'Version history' | i18n }}</b>",
  )
  const retentionEnd = advancedComponent.indexOf('</form>', retentionStart)
  const retention = advancedComponent.slice(retentionStart, retentionEnd)
  assert.match(
    advancedComponent,
    /\[name\]="prefix \+ '-interval'"[\s\S]{0,120}required/,
  )
  assert.match(retention, /index: 0,[\s\S]{0,80}owner: form/)
  assert.match(advancedComponent, /removeRetentionRule\(owner, index\)/)
  assert.match(
    advancedComponent,
    /removeRetentionRule\(form: JobEditor, index: number\)[\s\S]{0,700}form\.keepAdditional = false/,
  )
  assert.match(advancedComponent, /class="retention-heading setting-row"/)
  assert.match(retention, /class="add-retention-rule"/)
})

test('backup settings use primary action buttons and status text can wrap', () => {
  for (const component of [automaticComponent, advancedComponent]) {
    assert.doesNotMatch(component, /appearance="secondary"/)
  }
  assert.match(statusComponent, /min-height:\s*2rem/)
  assert.match(statusComponent, /height:\s*auto/)
  assert.match(statusComponent, /overflow-wrap:\s*anywhere/)
})

test('hour and minute controls cannot be cleared to null', () => {
  for (const component of [automaticComponent, advancedComponent]) {
    for (const field of ['hour', 'minute']) {
      const controls = [
        ...component.matchAll(
          new RegExp(
            `<(?:input|select)[\\s\\S]{0,180}(?:name="${field}"|\\[\\(ngModel\\)\\]="(?:editor|form)\\.${field}")[\\s\\S]{0,180}>`,
            'g',
          ),
        ),
      ]
      assert.ok(controls.length > 0, `${field} control is present`)
      for (const [control] of controls) {
        assert.match(control, /tuiSelect|<select/)
        assert.doesNotMatch(control, /type="number"|tuiInputNumber/)
      }
    }
  }

  assert.match(
    advancedComponent,
    /name="hour"[\s\S]{0,100}\[\(ngModel\)\]="form\.hour"/,
  )
  assert.match(
    advancedComponent,
    /name="minute"[\s\S]{0,100}\[\(ngModel\)\]="form\.minute"/,
  )
  assert.match(advancedComponent, /\[tuiTextfieldCleaner\]="false"/)
})

test('each visible master-password workflow has one visibility toggle', () => {
  const automaticPasswords = automaticComponent.match(/type="password"/g) ?? []
  const automaticToggles =
    automaticComponent.match(/<tui-icon tuiPassword \/>/g) ?? []
  const advancedPasswords = advancedComponent.match(/type="password"/g) ?? []
  const advancedToggles =
    advancedComponent.match(/<tui-icon tuiPassword \/>/g) ?? []

  assert.ok(automaticPasswords.length > 0)
  assert.ok(advancedPasswords.length > 0)
  assert.equal(automaticPasswords.length, automaticToggles.length)
  assert.equal(advancedPasswords.length, advancedToggles.length)
  assert.match(
    advancedComponent,
    /beginReassign\(job: T\.BackupJob\)[\s\S]{0,160}this\.editor\.set\(null\)/,
  )
})
