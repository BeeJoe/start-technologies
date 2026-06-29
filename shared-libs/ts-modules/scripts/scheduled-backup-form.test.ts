import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseBackupSchedule,
  serializeBackupSchedule,
} from '../../../projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/scheduled.utils.ts'

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
