import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
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

test('serializes hourly, daily, and weekly controls as five-field cron', () => {
  assert.equal(
    serializeBackupSchedule({
      frequency: 'hourly',
      minute: 15,
      hour: 9,
      weekday: 2,
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
      timezone: 'America/Chicago',
    }).cron,
    '30 4 * * 1',
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
})

test('retention summary translates the sentence as well as its units', () => {
  const summaryStart = automaticComponent.indexOf('retentionSummary(): string')
  const summaryEnd = automaticComponent.indexOf(
    'retentionPeriod()',
    summaryStart,
  )
  const summary = automaticComponent.slice(summaryStart, summaryEnd)

  assert.match(summary, /this\.i18n\.transform\('Keep one backup every'\)/)
  assert.match(summary, /this\.i18n\.transform\('for'\)/)
})

test('primary and advanced job summaries use localized labels', () => {
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

test('advanced schedules reuse the default job layout for an alternate job', () => {
  assert.match(
    automaticComponent,
    /scheduledBackups[\s\S]{0,120}\[primaryJobId\]="job\.id"/,
  )
  assert.match(
    automaticComponent,
    /<span tuiBadge>\{\{ advancedJobs\(\)\.length \}\}/,
  )
  assert.match(
    advancedComponent,
    /readonly primaryJobId = input\.required<string>\(\)/,
  )
  assert.match(
    advancedComponent,
    /class="job-selector"[\s\S]{0,800}tuiSelect[\s\S]{0,200}\(ngModelChange\)="selectJob\(\$event\)"/,
  )
  assert.doesNotMatch(advancedComponent, /class="g-table jobs"/)
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
  assert.match(services, /\[\(ngModel\)\]="form\.includeFuture"/)
  assert.match(services, /Automatically include future services/)

  const retentionStart = servicesEnd
  const retentionEnd = advancedComponent.indexOf('</form>', retentionStart)
  const retention = advancedComponent.slice(retentionStart, retentionEnd)
  assert.match(
    advancedComponent,
    /retentionIntervals:[\s\S]{0,160}\['hour', 'day', 'week', 'month', 'custom'\]/,
  )
  assert.match(retention, /tuiSelect[\s\S]{0,300}retentionIntervals/)

  assert.ok(
    advancedComponent.indexOf('Create the first backup now') <
      advancedComponent.indexOf('[(ngModel)]="form.password"'),
  )
  assert.match(
    advancedComponent,
    /<form class="editor panel" \(ngSubmit\)="save\(form\)"/,
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
    /if \(form\.firstBackupNow\)[\s\S]{0,120}runScheduledBackupJob\(\{ id: created\.id \}\)/,
  )
})

test('every inline master-password field has a visibility toggle', () => {
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
})
