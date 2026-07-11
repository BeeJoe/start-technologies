import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import postcss from 'postcss'

const root = path.resolve(import.meta.dirname, '../../..')

function componentStyles(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
  const match = source.match(/styles: `([\s\S]*?)`,\n  (?:host|imports):/)
  if (!match)
    throw new Error(`Unable to read component styles: ${relativePath}`)
  return postcss.parse(match[1], { from: relativePath })
}

function declarations(rule) {
  return Object.fromEntries(
    rule.nodes
      .filter(node => node.type === 'decl')
      .map(node => [node.prop, node.value]),
  )
}

function insideMedia(rule, query) {
  let parent = rule.parent
  while (parent) {
    if (parent.type === 'atrule' && parent.name === 'media') {
      return parent.params === query
    }
    parent = parent.parent
  }
  return false
}

function insideContainer(rule, query) {
  let parent = rule.parent
  while (parent) {
    if (parent.type === 'atrule' && parent.name === 'container') {
      return parent.params === query
    }
    parent = parent.parent
  }
  return false
}

function insideRule(rule, selector) {
  let parent = rule.parent
  while (parent) {
    if (
      parent.type === 'rule' &&
      parent.selectors?.map(value => value.trim()).includes(selector)
    ) {
      return true
    }
    parent = parent.parent
  }
  return false
}

function assertRule(sheet, file, selector, expected, media = null) {
  let matched = false
  sheet.walkRules(rule => {
    const selectors = rule.selectors?.map(value => value.trim()) || []
    if (!selectors.includes(selector)) return
    if (media && !insideMedia(rule, media)) return
    if (!media && insideMedia(rule, '(max-width: 30rem)')) return
    const actual = declarations(rule)
    if (
      Object.entries(expected).every(
        ([property, value]) => actual[property] === value,
      )
    ) {
      matched = true
    }
  })
  if (!matched) {
    const context = media ? ` inside @media ${media}` : ''
    throw new Error(
      `${file}: ${selector}${context} must include ${JSON.stringify(expected)}`,
    )
  }
}

function assertContainerRule(sheet, file, selector, expected, container) {
  let matched = false
  sheet.walkRules(rule => {
    const selectors = rule.selectors?.map(value => value.trim()) || []
    if (!selectors.includes(selector) || !insideContainer(rule, container)) {
      return
    }
    const actual = declarations(rule)
    if (
      Object.entries(expected).every(
        ([property, value]) => actual[property] === value,
      )
    ) {
      matched = true
    }
  })
  if (!matched) {
    throw new Error(
      `${file}: ${selector} inside @container ${container} must include ${JSON.stringify(expected)}`,
    )
  }
}

function assertNestedRule(sheet, file, ancestor, selector, expected) {
  let matched = false
  sheet.walkRules(rule => {
    const selectors = rule.selectors?.map(value => value.trim()) || []
    if (!selectors.includes(selector) || !insideRule(rule, ancestor)) return
    const actual = declarations(rule)
    if (
      Object.entries(expected).every(
        ([property, value]) => actual[property] === value,
      )
    ) {
      matched = true
    }
  })
  if (!matched) {
    throw new Error(
      `${file}: ${selector} inside ${ancestor} must include ${JSON.stringify(expected)}`,
    )
  }
}

function assertNestedRoute(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  if (/host:\s*\{\s*class:\s*['"]g-page['"]\s*\}/.test(source)) {
    throw new Error(
      `${file}: nested System routes must not create another g-page shell`,
    )
  }
}

function assertSource(file, patterns) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  for (const pattern of patterns) {
    if (!pattern.test(source)) {
      throw new Error(`${file}: missing required layout contract ${pattern}`)
    }
  }
}

function assertNotSource(file, patterns) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  for (const pattern of patterns) {
    if (pattern.test(source)) {
      throw new Error(`${file}: forbidden legacy layout contract ${pattern}`)
    }
  }
}

const homeFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/backups.component.ts'
const editorFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/automatic.component.ts'
const historyFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/history.component.ts'
const disableDialogFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/disable-automatic.dialog.ts'
const progressFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/progress.component.ts'
const locationFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/location-picker.component.ts'
const locationsFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/locations.component.ts'
const routesFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/backups.routes.ts'
const manualFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/backup.component.ts'
const recoverFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/recover.component.ts'
const advancedFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/scheduled.component.ts'
const manualPageFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/backups.component.ts'
const networkFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/network.component.ts'
const physicalFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/physical.component.ts'
const backupServiceFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/backup.service.ts'
const liveApiFile =
  'projects/start-os/web/ui/src/app/services/api/embassy-live-api.service.ts'
const osServiceFile = 'projects/start-os/web/ui/src/app/services/os.service.ts'
const dataModelFile =
  'projects/start-os/web/ui/src/app/services/patch-db/data-model.ts'
const backendBackupFile = 'shared-libs/crates/start-core/src/backup/mod.rs'
const backendBackupBulkFile =
  'shared-libs/crates/start-core/src/backup/backup_bulk.rs'
const backendRestoreFile = 'shared-libs/crates/start-core/src/backup/restore.rs'
const backendScheduledRpcFile =
  'shared-libs/crates/start-core/src/backup/scheduled/rpc.rs'
const backendScheduledRunnerFile =
  'shared-libs/crates/start-core/src/backup/scheduled/runner.rs'
const backendScheduledSchedulerFile =
  'shared-libs/crates/start-core/src/backup/scheduled/scheduler.rs'
const globalStylesFile = 'projects/start-os/web/ui/src/styles.scss'
const systemFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/system.component.ts'
const phone = '(max-width: 30rem)'
const narrowCard = 'card (max-width: 30rem)'
const home = componentStyles(homeFile)
const editor = componentStyles(editorFile)
const history = componentStyles(historyFile)
const disableDialog = componentStyles(disableDialogFile)
const progress = componentStyles(progressFile)
const location = componentStyles(locationFile)
const manual = componentStyles(manualFile)
const recover = componentStyles(recoverFile)
const advanced = componentStyles(advancedFile)
const network = componentStyles(networkFile)
const physical = componentStyles(physicalFile)
const system = componentStyles(systemFile)

for (const file of [homeFile, editorFile, historyFile, locationsFile]) {
  assertNestedRoute(file)
}
assertRule(system, systemFile, ':host-context(tui-root._mobile)', {
  'padding-inline': '0.75rem',
})

for (const selector of [
  '.card-toggle [tuiTitle]',
  '.operation [tuiTitle]',
  '.attention [tuiTitle]',
]) {
  assertRule(home, homeFile, selector, {
    'min-width': '0',
    'overflow-wrap': 'anywhere',
  })
}
assertRule(home, homeFile, '.card-heading', {
  position: 'static',
  height: 'auto',
})
assertRule(home, homeFile, '.progress-prominent', {
  position: 'static',
  width: '100%',
  'box-sizing': 'border-box',
  background: 'color-mix(in hsl, var(--start9-base-1) 50%, transparent)',
})
assertRule(home, homeFile, '.operation', {
  position: 'static',
})
assertRule(home, homeFile, '.operation > tui-icon', {
  color: 'var(--tui-text-action)',
})
assertRule(progress, progressFile, '.progress-status', {
  display: 'flex',
  'align-items': 'center',
  gap: '0.5rem',
  'flex-shrink': '0',
  'margin-inline-end': '1rem',
})
assertRule(progress, progressFile, '.overall-loader', {
  color: 'var(--tui-text-action)',
})
assertRule(progress, progressFile, '.progress-row', {
  'grid-template-areas': "'icon title'\n        'icon status'",
  'grid-template-columns': 'auto minmax(0, 1fr)',
  'row-gap': '0.125rem',
})
assertRule(progress, progressFile, '[tuiTitle]', {
  'grid-area': 'title',
  'white-space': 'nowrap',
})
assertRule(progress, progressFile, '.phase-status', {
  'grid-area': 'status',
  'justify-self': 'end',
  'max-width': '100%',
  'white-space': 'nowrap',
})

assertRule(
  home,
  homeFile,
  '.operation',
  { 'align-items': 'stretch', 'flex-direction': 'column' },
  phone,
)
assertRule(
  home,
  homeFile,
  '.card-actions',
  { 'align-items': 'flex-start', 'flex-direction': 'column' },
  phone,
)
for (const selector of ['.card-heading']) {
  assertContainerRule(
    home,
    homeFile,
    selector,
    { 'align-items': 'stretch', 'flex-direction': 'column' },
    'card (max-width: 44rem)',
  )
}
assertContainerRule(
  home,
  homeFile,
  '.card-actions',
  { 'justify-content': 'flex-start' },
  'card (max-width: 44rem)',
)

for (const selector of ['[tuiTitle]', '.schedule-controls > *']) {
  assertRule(editor, editorFile, selector, {
    'min-width': '0',
    'overflow-wrap': 'anywhere',
  })
}
assertRule(editor, editorFile, '.panel > header', {
  position: 'static',
  height: 'auto',
})

for (const selector of [
  '.panel > header',
  '.setting-row:not(.vertical)',
  '.advanced-link',
]) {
  assertRule(
    editor,
    editorFile,
    selector,
    { 'align-items': 'stretch', 'flex-direction': 'column' },
    phone,
  )
}
assertRule(
  editor,
  editorFile,
  '.schedule-controls',
  { 'grid-template-columns': '1fr' },
  phone,
)
assertRule(editor, editorFile, ':host', { width: '100%', 'min-width': '0' })
assertRule(editor, editorFile, '.panel', {
  width: '100%',
  'min-width': '0',
})
assertRule(history, historyFile, ':host', {
  width: '100%',
  'min-width': '0',
})
assertRule(location, locationFile, '.manual-or-restore > [tuiTitle]', {
  display: 'grid',
  'grid-template-columns': 'minmax(0, 1fr) minmax(8rem, 45%)',
  'align-items': 'center',
})
assertRule(location, locationFile, '.locations', {
  width: '100%',
  'max-width': 'none',
  'margin-inline': '0',
  'box-sizing': 'border-box',
})
assertRule(location, locationFile, '.locations', { 'justify-items': 'center' })
assertRule(location, locationFile, ':host', {
  width: '100%',
  'max-width': '48rem',
  'margin-inline': 'auto',
  'box-sizing': 'border-box',
})
assertRule(location, locationFile, ':host', { 'justify-items': 'center' })
for (const selector of ['.location-option', '.manage-location']) {
  assertRule(location, locationFile, selector, {
    width: '100%',
    'max-width': '40rem',
    'margin-inline': '0',
    'justify-self': 'center',
  })
}
assertRule(location, locationFile, '.manage-location', {
  'justify-content': 'flex-start',
})
assertRule(location, locationFile, '.manual-or-restore.location-option', {
  width: '100%',
  'box-sizing': 'border-box',
})
assertRule(
  location,
  locationFile,
  '.location-option',
  { 'justify-self': 'center' },
  phone,
)
assertRule(
  location,
  locationFile,
  '.manage-location',
  { 'justify-self': 'center' },
  phone,
)
assertRule(
  location,
  locationFile,
  '.manual-or-restore > [tuiTitle]',
  {
    display: 'flex',
    'flex-direction': 'row',
    'flex-wrap': 'wrap',
    'column-gap': '0.5rem',
    'row-gap': '0',
    'min-width': '0',
  },
  phone,
)
assertRule(
  location,
  locationFile,
  '.location-option > [tuiTitle] > b',
  {
    display: 'block',
    flex: '1 1 auto',
    'min-width': '0',
    'max-width': '100%',
    'overflow-wrap': 'normal',
    'white-space': 'normal',
    'word-break': 'normal',
  },
  phone,
)
assertRule(
  location,
  locationFile,
  '.manual-or-restore > [tuiTitle] [tuiSubtitle]',
  {
    flex: '0 0 auto',
    'max-width': '100%',
    'margin-inline-start': 'auto',
    'overflow-wrap': 'normal',
    'white-space': 'nowrap',
    'word-break': 'normal',
  },
  phone,
)
assertRule(
  location,
  locationFile,
  '.manual-or-restore > [tuiTitle] [tuiSubtitle]',
  { 'grid-column': '2', 'text-align': 'right' },
)
assertRule(editor, editorFile, '.embedded-panel', {
  padding: '0',
  border: '0',
  'box-shadow': 'none',
  background: 'transparent',
})
assertRule(editor, editorFile, '.retention-rule input', {
  font: 'var(--tui-typography-body-l)',
  'min-height': '3.5rem',
  'background-color': 'var(--tui-background-neutral-1)',
})
assertRule(editor, editorFile, '.first-backup', {
  'justify-content': 'flex-start',
})
assertRule(disableDialog, disableDialogFile, '.actions button', {
  'block-size': 'auto',
  height: 'auto',
  'min-block-size': '2.75rem',
  'min-height': '2.75rem',
  'white-space': 'normal',
})
assertRule(
  disableDialog,
  disableDialogFile,
  '.actions',
  { 'grid-template-columns': 'auto minmax(0, 1fr)' },
  phone,
)
assertRule(
  history,
  historyFile,
  '.activity summary',
  { 'align-items': 'flex-start', 'flex-direction': 'column' },
  phone,
)
assertRule(
  editor,
  editorFile,
  '.wizard-actions',
  { 'flex-wrap': 'wrap' },
  phone,
)
assertRule(
  editor,
  editorFile,
  '.inline-switch',
  { width: 'fit-content', 'justify-content': 'flex-start' },
  phone,
)

for (const [sheet, file] of [
  [location, locationFile],
  [manual, manualFile],
  [recover, recoverFile],
]) {
  assertRule(sheet, file, '[tuiTitle]', {
    'min-width': '0',
    'overflow-wrap': 'anywhere',
  })
}
assertRule(network, networkFile, '.empty-row', {
  width: '100%',
})
assertRule(network, networkFile, '.empty-state app-placeholder', {
  width: '100%',
  'margin-inline': 'auto',
  'box-sizing': 'border-box',
  padding: '0',
  gap: '0.25rem',
})
assertRule(network, networkFile, '.empty-label', {
  display: 'block',
  width: '100%',
  'max-width': '100%',
  'min-height': '1.5rem',
  'flex-shrink': '0',
  'line-height': '1.5rem',
  'overflow-wrap': 'anywhere',
  'text-align': 'center',
})

assertRule(
  recover,
  recoverFile,
  '.bulk-controls',
  { 'align-items': 'stretch', 'flex-direction': 'column' },
  phone,
)
assertRule(
  recover,
  recoverFile,
  '.bulk-controls select',
  { width: '100%', 'min-width': '0' },
  phone,
)
assertRule(
  advanced,
  advancedFile,
  '.heading',
  { 'align-items': 'stretch', 'flex-direction': 'column' },
  phone,
)
for (const selector of ['.tier', '.override']) {
  assertRule(
    advanced,
    advancedFile,
    selector,
    { 'grid-template-columns': '1fr' },
    phone,
  )
}

for (const [sheet, file] of [
  [network, networkFile],
  [physical, physicalFile],
]) {
  assertRule(sheet, file, '.name', {
    'justify-self': 'start',
    'text-align': 'left',
  })
  assertRule(sheet, file, '.location', {
    'justify-self': 'start',
    'text-align': 'left',
  })
}
for (const [sheet, file] of [
  [network, networkFile],
  [physical, physicalFile],
]) {
  assertRule(sheet, file, 'td:first-child:not(.empty-state)', {
    width: '11rem',
  })
}
assertRule(network, networkFile, 'td:last-child:not(.empty-state)', {
  width: '3.5rem',
  'white-space': 'nowrap',
  'text-align': 'right',
})
assertRule(physical, physicalFile, 'td:last-child:not(.empty-state)', {
  width: '3.5rem',
  'white-space': 'nowrap',
  'text-align': 'right',
})
for (const [sheet, file] of [
  [network, networkFile],
  [physical, physicalFile],
]) {
  assertRule(sheet, file, '.empty-state', {
    display: 'table-cell',
    height: '7rem',
    'vertical-align': 'middle',
    'text-align': 'center',
  })
}
assertNestedRule(
  physical,
  physicalFile,
  ':host-context(tui-root._mobile)',
  '.empty-state',
  {
    display: 'grid',
    'grid-column': '1 / -1',
    'justify-self': 'center',
    width: '100%',
    'white-space': 'normal',
    'text-align': 'center',
  },
)
assertNestedRule(
  network,
  networkFile,
  ':host-context(tui-root._mobile)',
  'tr.empty-row',
  {
    'grid-template-columns': 'minmax(0, 1fr)',
  },
)
assertNestedRule(
  network,
  networkFile,
  ':host-context(tui-root._mobile)',
  '.empty-row > td.empty-state',
  {
    display: 'grid',
    'grid-area': '1 / 1 / auto / -1',
    'justify-self': 'stretch',
    width: 'auto',
    margin: '0',
    'white-space': 'normal',
    'text-align': 'center',
  },
)

for (const [sheet, file, columns] of [
  [network, networkFile, 'auto minmax(0, 1fr) auto'],
  [physical, physicalFile, 'auto minmax(0, 1fr) minmax(7rem, 45%)'],
]) {
  assertRule(
    sheet,
    file,
    'tr',
    {
      'grid-template-columns': columns,
      'min-width': '0',
      'white-space': 'normal',
    },
    null,
  )
}

for (const file of [editorFile, manualFile, recoverFile]) {
  assertSource(file, [
    /tuiCheckbox[\s\S]{0,320}['"]Toggle all['"]/,
    /host:\s*\{\s*class:\s*['"]backup-(?:page|settings)['"]|selector:\s*['"]automatic-backups['"]/,
  ])
}

assertSource(homeFile, [
  /docsLink[\s\S]{0,120}path="\/start-os\/"[\s\S]{0,80}fragment="#backups"/,
  /iconStart="@tui\.book-open-text"/,
  /readonly expanded = signal<BackupPanel \| null>\(null\)/,
  /<automatic-backups[\s\S]*\[embedded\]="true"/,
  /<system-backup[\s\S]{0,100}mode="create"[\s\S]{0,100}\[embedded\]="true"/,
  /<system-backup[\s\S]{0,100}mode="restore"[\s\S]{0,100}\[embedded\]="true"/,
  /<backup-locations \[embedded\]="true"/,
  /class="card-body"[\s\S]{0,500}['"]Run now['"]/,
  /<backup-locations[\s\S]*['"]Backup history['"][\s\S]*<backup-history/,
  /class="card-heading automatic-heading"[\s\S]*class="card-actions"[\s\S]*class="expand-toggle"/,
  /parseBackupSchedule\(primary\.schedule\)/,
  /const latest = this\.activities\(\)\[0\][\s\S]{0,100}latest\?\.state === 'running' \? latest : null/,
  /\[showIcons\]="false"/,
  /@if \(operationActivity\(\); as activity\)\s*\{\s*@if \(manualRunning\(\)\)/,
  /\[operationActive\]="progressActive\(\)"/,
  /readonly progressActive = computed\(\s*\(\) => !!this\.operationActivity\(\)/,
])
assertNotSource(homeFile, [
  /<backup-navigation/,
  /['"]Help['"]\s*\|\s*i18n/,
  /routerLink="manage"/,
  /['"]Dismiss['"]\s*\|\s*i18n/,
  /class="delete-checkpoints"/,
  /class="card-actions"[\s\S]{0,500}['"]Run now['"]/,
  /progress-prominent[\s\S]{0,500}--tui-background-accent-2/,
  /\[disabled\]="progressActive\(\)"/,
  /scrollIntoView/,
  /position:\s*sticky/,
  /progress-prominent::before/,
  /@if \(manualRunning\(\)\)[\s\S]{0,450}@else if \(operationActivity\(\); as activity\)/,
  /this\.activities\(\)\.find\(activity => activity\.state === 'running'\)/,
])
assertSource(routesFile, [
  /path: 'manage',[\s\S]{0,80}redirectTo: ''/,
  /path: 'manual',[\s\S]{0,80}redirectTo: ''/,
  /path: 'restore',[\s\S]{0,80}redirectTo: ''/,
  /path: 'locations',[\s\S]{0,80}redirectTo: ''/,
])

assertSource(editorFile, [
  /selector:\s*'automatic-backups'/,
  /readonly embedded = input\(false\)/,
  /initializeEditor = effect\([\s\S]{0,520}this\.editor = this\.editorFor\(job\)/,
])
assertNotSource(editorFile, [
  /<nav class="tabs">/,
  /class="danger g-card"/,
  /<backup-navigation/,
  /showCheckpoints/,
  /history-section/,
  /filteredActivities/,
  /select,\s*\.retention-rule input/,
  /class="g-card panel/,
  /notifications\.open\('Saving'\)/,
])
assertSource(historyFile, [
  /selector:\s*'backup-history'/,
  /filteredActivities\(\)/,
  /['"]Backup location['"]/,
])
assertSource(disableDialogFile, [
  /tuiCheckbox/,
  /['"]Automatic backups will stop\. Manual backups will not be deleted\.['"]/,
  /['"]Delete automatic backups['"]/,
  /deleteCheckpoints:\s*this\.deleteCheckpoints/,
  /['"]Turn off and delete['"]/,
  /['"]Turn off automatic backups['"]/,
])
assertNotSource(disableDialogFile, [
  /['"]Turning off pauses schedules\. Deleting checkpoints is optional and never deletes manual backups\.['"]/,
  /['"]Selecting checkpoint deletion also removes automatic schedules, allowing unused backup locations to be forgotten\.['"]/,
])
assertNotSource(manualPageFile, [/'Last Backup'/, /<backup-navigation/])
assertSource(locationFile, [
  /readonly manage = output<void>\(\)/,
  /iconStart="@tui\.plus"[\s\S]{0,160}\(click\)="manage\.emit\(\)"[\s\S]{0,160}['"]Add or repair a location['"]/,
  /\[class\.manual-or-restore\]="mode\(\) !== 'automatic'"/,
  /<span tuiTitle>[\s\S]{0,100}<b>\{\{ target\.name \}\}<\/b>[\s\S]{0,160}<span tuiSubtitle>[\s\S]{0,100}target\.detail/,
  /formatCifsLocation\(location\.entry\)/,
])
assertNotSource(locationFile, [
  /routerLink="\/system\/backups\/locations"/,
  /class="location-detail"/,
])
assertSource(manualPageFile, [/\(manage\)="manageLocations\.emit\(\)"/])
assertSource(editorFile, [/\(manage\)="manageLocations\.emit\(\)"/])
assertSource(homeFile, [
  /\(manageLocations\)="openLocations\(\)"/,
  /openLocations\(\)[\s\S]{0,100}this\.expanded\.set\('locations'\)/,
])
assertSource(networkFile, [
  /\['Status', 'Name', 'Hostname', 'Path', 'Free', null\]/,
  /class="name"[\s\S]{0,500}class="hostname"[\s\S]{0,180}class="location"[\s\S]{0,180}class="free"/,
  /class="mobile-location-line"[\s\S]{0,220}formatCifsLocation\(target\.entry\)/,
  /class="empty-state"[\s\S]{0,180}class="empty-label"[\s\S]{0,80}['"]No network folders['"]\s*\|\s*i18n/,
  /class="empty-row"/,
])
assertNestedRule(
  network,
  networkFile,
  ':host-context(tui-root._mobile)',
  'td.name',
  {
    width: 'auto',
    'justify-self': 'stretch',
    'max-width': '100%',
    'overflow-wrap': 'normal',
    'text-align': 'left',
    'word-break': 'normal',
  },
)
assertNestedRule(
  network,
  networkFile,
  ':host-context(tui-root._mobile)',
  '.mobile-location-line',
  {
    display: 'flex',
    'flex-wrap': 'wrap',
    width: '100%',
    'box-sizing': 'border-box',
    'overflow-wrap': 'normal',
    'white-space': 'normal',
    'word-break': 'normal',
  },
)
assertNestedRule(
  network,
  networkFile,
  ':host-context(tui-root._mobile)',
  '.mobile-address',
  {
    flex: '0 0 auto',
    'min-width': 'min-content',
    'max-width': '100%',
    'overflow-wrap': 'normal',
    'white-space': 'normal',
    'word-break': 'normal',
  },
)
assertRule(network, networkFile, '.hostname', { display: 'none' })
assertRule(network, networkFile, '.location', { display: 'none' })
assertSource(physicalFile, [
  /\['Status', 'Logicalname', 'Name', 'Capacity', 'Free', null\]/,
  /class="name"[\s\S]{0,180}class="location"/,
  /class="empty-state"/,
  /&:first-child:not\(\.empty-state\)/,
])
assertNestedRule(
  physical,
  physicalFile,
  ':host-context(tui-root._mobile)',
  '.empty-state',
  {
    height: 'auto',
    'min-height': '7rem',
    'place-items': 'center',
    'justify-self': 'center',
    width: '100%',
  },
)
assertSource(manualPageFile, [
  /@if \(busy\(\)\)[\s\S]{0,180}class="backup-busy"[\s\S]{0,120}role="status"[\s\S]{0,180}['"]A backup or restore is already in progress\.['"]\s*\|\s*i18n/,
  /readonly operationActive = input<boolean>\(\)/,
  /this\.operationActive\(\) \?\? this\.progressActive\(\)/,
])
assertNotSource(advancedFile, [
  /showHistory/,
  /class="g-table histories"/,
  /notifications\.open\('Saving'\)/,
  /TuiNotificationMiddleService/,
  /notifications\.open\(/,
])
assertSource(progressFile, [
  /class="progress-status"/,
  /class="overall-loader"/,
])
assertNotSource(progressFile, [/host:\s*\{\s*class:\s*['"]g-card['"]\s*\}/])
assertSource(osServiceFile, [
  /map\(status => isBackupProgressActive\(status\.backupProgress\)\)/,
  /export function isBackupProgressActive/,
  /progress\.phases\.some/,
])
assertNotSource(osServiceFile, [
  /leafProgress\(status\.backupProgress\.overall\)\s*!==\s*true/,
])
assertSource(backupServiceFile, [
  /formatCifsLocation[\s\S]{0,180}target\.hostname[\s\S]{0,80}share/,
])
assertSource(homeFile, [
  /if \(!enabled && deleteCheckpoints\)[\s\S]{0,1200}deleteArchivedBackupSnapshots[\s\S]{0,1200}deleteScheduledBackupJob/,
])
assertSource(editorFile, [
  /if \(decision\.deleteCheckpoints\)[\s\S]{0,1200}deleteArchivedBackupSnapshots[\s\S]{0,1200}deleteScheduledBackupJob/,
])

// Keep the refactored UI connected to the typed live RPC surface and the
// backend handlers that publish its PatchDB state.
assertSource(dataModelFile, [/scheduledBackups:\s*T\.ScheduledBackupState/])
for (const file of [homeFile, editorFile, historyFile]) {
  assertSource(file, [/watch\$\('scheduledBackups'\)/])
}
assertSource(liveApiFile, [
  /createScheduledBackupJob[\s\S]{0,220}method:\s*'backup\.job\.create'/,
  /updateScheduledBackupJob[\s\S]{0,220}method:\s*'backup\.job\.update'/,
  /setScheduledBackupJobEnabled[\s\S]{0,240}method:\s*'backup\.job\.set-enabled'/,
  /runScheduledBackupJob[\s\S]{0,220}method:\s*'backup\.job\.run-now'/,
  /deleteArchivedBackupSnapshots[\s\S]{0,260}method:\s*'backup\.history\.delete-archived-snapshots'/,
  /restoreBackupSelection[\s\S]{0,260}method:\s*'package\.backup\.restore-selection'/,
])
assertSource(backendBackupFile, [
  /subcommand\("job", scheduled::job::<C>\(\)\)/,
  /subcommand\("history", scheduled::history::<C>\(\)\)/,
  /"restore-selection"[\s\S]{0,180}restore_selection_rpc/,
  /fn try_backup_coordinator[\s\S]{0,240}try_lock_owned\(\)[\s\S]{0,200}backup_in_progress_error/,
  /fn backup_coordinator_rejects_a_second_request/,
])
assertSource(backendBackupBulkFile, [
  /try_backup_coordinator\(ctx\.backup_coordinator\.clone\(\)\)\?[\s\S]{0,180}reconcile_interrupted_backup_state\(&ctx\)\.await\?/,
])
assertNotSource(backendBackupBulkFile, [
  /backing_up\.transpose_ref\(\)\.is_some\(\)/,
])
assertSource(backendRestoreFile, [
  /let operation_coordinator =[\s\S]{0,120}try_backup_coordinator\(ctx\.backup_coordinator\.clone\(\)\)\?[\s\S]{0,180}reconcile_interrupted_backup_state\(&ctx\)\.await\?/,
  /spawn_restore_activity\(ctx, activity\.id, tasks, operation_coordinator\)/,
  /operation_coordinator: OwnedMutexGuard<\(\)>[\s\S]{0,120}async move \{[\s\S]{0,100}let _operation_coordinator = operation_coordinator/,
])
assertSource(backendScheduledRpcFile, [
  /"create", from_fn_async\(create\)/,
  /"update", from_fn_async\(update\)/,
  /"set-enabled", from_fn_async\(set_enabled\)/,
  /"run-now"[\s\S]{0,120}from_fn_async\(run_now\)/,
  /"delete-archived-snapshots"[\s\S]{0,120}from_fn_async\(delete_archived_snapshots\)/,
])
assertNotSource(backendScheduledRunnerFile, [
  /notify\([\s\S]{0,350}job\.id\.to_string\(\)/,
  /notify\([\s\S]{0,350}job\.target_id\.to_string\(\)/,
  /notify\([\s\S]{0,350}\btarget_key\s*,?\s*\)/,
])
assertSource(backendScheduledRunnerFile, [
  /let coordinator = crate::backup::try_backup_coordinator\(ctx\.backup_coordinator\.clone\(\)\)\?[\s\S]{0,120}run_job_with_coordinator\(ctx, job_id, trigger, coordinator\)\.await/,
  /fn run_job_with_coordinator[\s\S]{0,240}reconcile_interrupted_backup_state\(&ctx\)\.await\?[\s\S]{0,120}run_job_inner/,
])
assertSource(backendScheduledSchedulerFile, [
  /pub\(crate\) async fn reconcile_interrupted_backup_state/,
  /fn reconcile_if_idle[\s\S]{0,260}try_scheduler_slot\(ctx\.backup_coordinator\.clone\(\)\)[\s\S]{0,180}reconcile_interrupted_backup_state\(ctx\)\.await\?/,
  /\.filter\(\|\(_, activity\)\| activity\.state == BackupRunState::Running\)/,
  /fn older_interrupted_activity_does_not_regress_newer_job_result/,
  /fn running_restore_is_reconciled_after_the_coordinator_is_acquired/,
  /interrupted\.sort_by\(\|left, right\| left\.cmp\(right\)\)/,
  /attempted < activity\.started_at\)[\s\S]{0,300}consecutive_failures[\s\S]{0,180}last_result = Some\(BackupRunState::Failed\)/,
  /assert_eq!\(job\.status\.consecutive_failures, 2\)/,
  /as_backup_progress_mut\(\)[\s\S]{0,80}ser\(&None\)/,
  /fn dispatch_due_jobs[\s\S]{0,600}if !has_due_job[\s\S]{0,220}try_scheduler_slot\(ctx\.backup_coordinator\.clone\(\)\)[\s\S]{0,420}claim_oldest_due_job/,
  /fn oldest_due_job[\s\S]{0,700}\.min_by\([\s\S]{0,240}left_at[\s\S]{0,160}left_id/,
  /fn scheduler_claims_only_the_oldest_due_job/,
  /fn busy_scheduler_slot_leaves_due_jobs_unchanged/,
  /run_job_with_coordinator\([\s\S]{0,160}coordinator[\s\S]{0,80}\.await/,
])
assertNotSource(backendScheduledSchedulerFile, [
  /automatic_only/,
  /reconcile_interrupted_automatic_activities/,
  /let due_jobs =/,
  /due\.push\(/,
])
assertSource(globalStylesFile, [
  /\.backup-page,[\s\S]*\.backup-settings[\s\S]*select\s*\{[\s\S]*appearance:\s*none[\s\S]*min-height:\s*3\.5rem[\s\S]*font:\s*var\(--tui-typography-body-l\)[\s\S]*background-color:\s*var\(--tui-background-neutral-1\)[\s\S]*background-image:/,
  /select:focus-visible[\s\S]*var\(--tui-border-focus\)/,
  /option\s*\{[\s\S]*background:\s*var\(--tui-background-base\)[\s\S]*var\(--tui-typography-body-l\)/,
  /tui-data-list\.backup-menu[\s\S]*min-width:\s*12rem[\s\S]*min-height:\s*3rem/,
])

console.log('Backup mobile layout contract passed')
