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
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/automatic.ts'
const historyFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/history.ts'
const deleteScheduleDialogFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/delete-schedule.ts'
const progressFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/progress.component.ts'
const locationFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/location-picker.ts'
const locationsFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/locations.ts'
const routesFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/backups.routes.ts'
const manualFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/backup.component.ts'
const recoverFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/recover.component.ts'
const advancedFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/scheduled.ts'
const scheduledUtilsFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/routes/backups/scheduled-utils.ts'
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
const globalStylesFile = 'projects/start-os/web/ui/src/styles.scss'
const systemFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/system.component.ts'
const phone = '(max-width: 30rem)'
const narrowCard = 'card (max-width: 30rem)'
const home = componentStyles(homeFile)
const editor = componentStyles(editorFile)
const history = componentStyles(historyFile)
const deleteScheduleDialog = componentStyles(deleteScheduleDialogFile)
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
assertRule(home, homeFile, '.automatic-heading.single-job', {
  'grid-template-columns': 'minmax(0, 1fr) repeat(2, auto)',
})
assertRule(home, homeFile, '.single-job .card-actions', {
  'flex-wrap': 'nowrap',
  'padding-inline-end': '1.25rem',
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
assertContainerRule(
  home,
  homeFile,
  '.automatic-heading.single-job .card-actions',
  {
    'grid-column': '3',
    'grid-row': '1',
    'justify-content': 'flex-end',
    'align-self': 'start',
  },
  'card (max-width: 44rem)',
)
assertContainerRule(
  home,
  homeFile,
  '.automatic-heading.single-job .card-toggle b',
  { 'white-space': 'normal' },
  'card (max-width: 44rem)',
)
assertNotSource(homeFile, [/@container card \(max-width: 34rem\)/])
assertRule(
  home,
  homeFile,
  '.automatic-heading.single-job .card-toggle',
  { gap: '0.5rem', 'padding-inline': '0.75rem' },
  phone,
)
assertRule(
  home,
  homeFile,
  '.single-job .card-actions',
  {
    display: 'grid',
    'grid-template-columns': 'auto auto',
    'align-items': 'center',
    'row-gap': '0.5rem',
    'padding-inline-end': '0.75rem',
  },
  phone,
)
assertRule(
  home,
  homeFile,
  '.single-job .card-actions > [tuiBadge]',
  {
    'grid-column': '1 / -1',
    'grid-row': '2',
    'justify-self': 'end',
  },
  phone,
)
assertRule(
  home,
  homeFile,
  '.single-job .simple-switch',
  { 'grid-column': '1', 'grid-row': '1' },
  phone,
)
assertRule(
  home,
  homeFile,
  '.single-job .card-actions > button',
  { 'grid-column': '2', 'grid-row': '1' },
  phone,
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
assertSource(globalStylesFile, [
  /\.services-accordion > button\s*\{[\s\S]{0,240}height:\s*auto[\s\S]{0,160}min-height:\s*3\.5rem[\s\S]{0,200}white-space:\s*normal/,
  /\.services-accordion > button \[tuiTitle\][\s\S]{0,320}display:\s*block[\s\S]{0,200}flex:\s*1[\s\S]{0,200}width:\s*auto[\s\S]{0,240}color:\s*var\(--tui-text-primary\)[\s\S]{0,120}visibility:\s*visible/,
  /\.services-accordion > button \[tuiSubtitle\][\s\S]{0,240}display:\s*block[\s\S]{0,160}white-space:\s*normal[\s\S]{0,160}overflow:\s*visible/,
])
assertRule(advanced, advancedFile, '.capacity-summary', {
  width: '100%',
  'min-width': '0',
})
assertRule(advanced, advancedFile, '.capacity-details div', {
  'grid-template-columns': 'minmax(10rem, 1fr) auto',
})
assertRule(
  advanced,
  advancedFile,
  '.capacity-details div',
  { 'grid-template-columns': '1fr' },
  phone,
)
assertRule(
  advanced,
  advancedFile,
  '.capacity-summary',
  { 'flex-wrap': 'wrap' },
  phone,
)
assertRule(
  advanced,
  advancedFile,
  '.capacity-summary .more-info',
  { 'flex-basis': '100%', 'text-align': 'right' },
  phone,
)
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
    display: 'flex',
    flex: '0 1 auto',
    'flex-wrap': 'wrap',
    'justify-content': 'flex-end',
    'min-width': '0',
    'max-width': '100%',
    'margin-inline-start': 'auto',
    'overflow-wrap': 'normal',
    'white-space': 'normal',
    'word-break': 'normal',
  },
  phone,
)
assertRule(
  location,
  locationFile,
  '.manual-or-restore > [tuiTitle] .target-detail',
  { 'white-space': 'nowrap', 'word-break': 'normal' },
  phone,
)
assertRule(
  location,
  locationFile,
  '.manual-or-restore > [tuiTitle] .target-reason',
  {
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
  { 'grid-column': '2', 'text-align': 'right' },
)
assertRule(editor, editorFile, '.embedded-panel', {
  padding: '0',
  border: '0',
  'box-shadow': 'none',
  background: 'transparent',
})
assertNotSource(editorFile, [
  /\.retention-rule input\s*\{[\s\S]{0,320}padding:\s*0 1rem/,
])
assertRule(editor, editorFile, '.first-backup', {
  'justify-content': 'flex-start',
})
assertRule(deleteScheduleDialog, deleteScheduleDialogFile, '.actions', {
  'flex-wrap': 'wrap',
  'justify-content': 'flex-end',
})
assertSource(deleteScheduleDialogFile, [
  /tasks\.run\([\s\S]*Deleting schedule and related backups…/,
  /deleteArchivedBackupSnapshotsBulk\(\{[\s\S]*snapshots: unreferenced\.map/,
])
assertNotSource(deleteScheduleDialogFile, [
  /for \(const history of unreferenced\)[\s\S]*deleteArchivedBackupSnapshots/,
])
assertRule(
  history,
  historyFile,
  '.activity > button',
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
  '.bulk-controls tui-textfield',
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
assertRule(
  advanced,
  advancedFile,
  '.retention-rule',
  { 'grid-template-columns': '1fr' },
  phone,
)
assertRule(
  advanced,
  advancedFile,
  '.schedule-job',
  {
    display: 'grid',
    'grid-template-columns': 'auto minmax(0, 1fr) auto',
    'padding-inline': '0.75rem',
    'box-sizing': 'border-box',
  },
  phone,
)
assertRule(
  advanced,
  advancedFile,
  '.job-list-actions',
  {
    'grid-column': '3',
    'grid-row': '1',
    'align-self': 'start',
    'justify-self': 'end',
    'flex-wrap': 'nowrap',
  },
  phone,
)
assertRule(
  advanced,
  advancedFile,
  '.job-switch',
  {
    width: 'fit-content',
  },
  phone,
)

for (const [sheet, file] of [
  [editor, editorFile],
  [advanced, advancedFile],
]) {
  assertRule(
    sheet,
    file,
    '.retention-heading .retention-toggle-label',
    { display: 'none' },
    phone,
  )
  assertSource(file, [
    /\[attr\.aria-label\]="'Keep additional versions' \| i18n"/,
  ])
}
assertSource(editorFile, [
  /class="setting-row retention-heading"[\s\S]{0,180}'Version history'/,
])
assertNotSource(historyFile, [
  /\.history-toolbar\s+tui-textfield\s*\{[^}]*display:\s*grid/,
])
assertSource(advancedFile, [
  /@let selection = jobSelectionSummary\(job\);[\s\S]{0,420}serviceCountLabel\(selection\.serviceCount\)[\s\S]{0,220}!selection\.includeFuture[\s\S]{0,120}['"]Future services not included['"][\s\S]{0,220}!selection\.includesSystem[\s\S]{0,120}['"]No System data['"]/,
  /form\.packageIds = \[SYSTEM_PACKAGE_ID, review\.packageId\]/,
])
assertRule(advanced, advancedFile, '.retention-heading .inline-switch', {
  flex: '0 0 auto',
  'justify-content': 'flex-start',
  width: 'fit-content',
  'margin-inline-start': 'auto',
})
assertSource(scheduledUtilsFile, [
  /export const SYSTEM_PACKAGE_ID = 'x_system'/,
])
assertSource(deleteScheduleDialogFile, [
  /<label #deleteOption class="delete-option">[\s\S]{0,80}tuiCheckbox[\s\S]{0,80}type="checkbox"[\s\S]{0,80}\[\(ngModel\)\]="deleteCheckpoints"/,
  /\(click\)="confirm\(deleteOption\)"/,
  /class="delete-only"[\s\S]{0,100}'Delete Schedule'/,
  /class="delete-with-backups"[\s\S]{0,120}'Delete Schedule and Backups'/,
  /confirm\(deleteOption: HTMLLabelElement\)[\s\S]{0,160}deleteCheckpoints: deleteOption\.querySelector\('input'\)\?\.checked \?\? false/,
  /const histories = await this\.api\.getScheduledBackupHistories\(\{\}\)/,
  /if \(decision\.deleteCheckpoints\) \{[\s\S]{0,260}refreshScheduledBackupHistories\(\{[\s\S]{0,80}targetId: job\.targetId/,
])
assertNotSource(deleteScheduleDialogFile, [/ChangeDetectorRef/, /signal\(/])
assertRule(
  deleteScheduleDialog,
  deleteScheduleDialogFile,
  '.delete-with-backups',
  {
    display: 'none',
  },
)
assertRule(
  deleteScheduleDialog,
  deleteScheduleDialogFile,
  ':host:has(.delete-option input:checked) .delete-only',
  { display: 'none' },
)
assertRule(
  deleteScheduleDialog,
  deleteScheduleDialogFile,
  ':host:has(.delete-option input:checked) .delete-with-backups',
  { display: 'inline' },
)
assertRule(
  deleteScheduleDialog,
  deleteScheduleDialogFile,
  '.actions > button',
  {
    'max-inline-size': '100%',
    'min-inline-size': '0',
    'block-size': 'auto',
    'white-space': 'normal',
  },
)
for (const selector of ['.delete-only', '.delete-with-backups']) {
  assertRule(deleteScheduleDialog, deleteScheduleDialogFile, selector, {
    'inline-size': '100%',
    'min-inline-size': '0',
    'overflow-wrap': 'anywhere',
    'white-space': 'normal',
  })
}
assertRule(
  deleteScheduleDialog,
  deleteScheduleDialogFile,
  ':host-context(tui-root._mobile) .actions > button',
  { 'inline-size': '100%' },
)
assertRule(
  advanced,
  advancedFile,
  '.schedule-job > [tuiTitle]',
  { display: 'contents' },
  phone,
)
assertRule(
  advanced,
  advancedFile,
  '.schedule-job > [tuiTitle] > [tuiSubtitle]',
  {
    'grid-column': '1 / -1',
    'grid-row': '2',
  },
  phone,
)
assertRule(advanced, advancedFile, '.review .checkbox-row > input', {
  'margin-inline-start': 'auto',
})
assertRule(advanced, advancedFile, '.review .toggle-all', {
  'justify-content': 'flex-end',
})
assertRule(advanced, advancedFile, '.review .toggle-all > input', {
  'margin-inline-start': '0',
})
assertRule(advanced, advancedFile, '.review-job [tuiTitle]', {
  'text-align': 'start',
})
assertSource(advancedFile, [
  /class="retention-heading setting-row"[\s\S]{0,180}'Version history'/,
  /'Add to backup schedule' \| i18n[\s\S]{0,100}packageName\(review\.packageId\)/,
])
assertRule(advanced, advancedFile, '.review .checkbox-row', {
  'inline-size': '100%',
  'max-inline-size': '100%',
  'padding-inline': '0',
  'align-items': 'center',
  'justify-content': 'space-between',
})
assertRule(advanced, advancedFile, '.review .checkbox-row > input', {
  'inset-block-start': '0',
  'margin-inline-start': 'auto',
  transform: 'none',
})
assertSource(advancedFile, [
  /class="checkbox-row toggle-all"[\s\S]{0,220}tuiCheckbox[\s\S]{0,100}size="s"/,
  /@for \(job of jobs\(\); track job\.id\)[\s\S]{0,220}jobName\(job\.id\)[\s\S]{0,220}tuiCheckbox[\s\S]{0,100}size="s"/,
  /Object\.fromEntries\([\s\S]{0,120}jobs\.map\(job => \[[\s\S]{0,100}job\.id,[\s\S]{0,120}jobIncludesService\(job, review\.packageId\)/,
  /allReviewJobsSelected\([\s\S]{0,320}this\.jobs\(\)\.every\(job => decisions\?\.\[job\.id\] === true\)/,
  /setAllReviewJobs\([\s\S]{0,260}this\.jobs\(\)\.map\(job => \[job\.id, checked\]\)/,
  /this\.pendingReview[\s\S]{0,650}this\.jobs\(\)\.map\(job => \[job\.id, false\] as const\)[\s\S]{0,100}\[created\.id, true\] as const/,
])

for (const [sheet, file] of [
  [editor, editorFile],
  [advanced, advancedFile],
]) {
  assertRule(sheet, file, '.toggle-all', {
    width: '100%',
    gap: '0.5rem',
    padding: '0 1rem 1rem',
    'border-bottom': '1px solid var(--tui-border-normal)',
    'box-sizing': 'border-box',
  })
  assertRule(sheet, file, '[tuiBlock] [tuiTitle]', {
    'justify-content': 'flex-start',
    'text-align': 'left',
  })
  assertRule(sheet, file, '.include-future', {
    width: '100%',
    'max-width': '100%',
    'box-sizing': 'border-box',
    'align-items': 'flex-start',
    'padding-inline': '1rem',
  })
}

for (const [sheet, file] of [
  [network, networkFile],
  [physical, physicalFile],
]) {
  assertRule(sheet, file, 'td:first-child:not(.empty-state)', {
    width: '15rem',
  })
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
  [network, networkFile, 'minmax(0, 1fr) auto auto'],
  [physical, physicalFile, 'minmax(0, 1fr) minmax(7rem, 45%)'],
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

for (const file of [networkFile, physicalFile]) {
  assertNotSource(file, [/font-size:\s*0/])
}

for (const file of [manualFile, recoverFile]) {
  assertSource(file, [
    /tuiCheckbox[\s\S]{0,320}['"]Toggle all['"]/,
    /host:\s*\{\s*class:\s*['"]backup-(?:page|settings)['"]|selector:\s*['"]automatic-backups['"]/,
  ])
}
assertSource(manualFile, [
  /class="toggle-all"[\s\S]{0,500}<footer class="g-buttons">[\s\S]{0,240}\(click\)="done\(\)"/,
])

for (const file of [editorFile, advancedFile]) {
  assertSource(file, [
    /class="checkbox-row toggle-all"[\s\S]{0,700}['"]Toggle all services['"]\s*\|\s*i18n/,
  ])
}

assertSource(editorFile, [
  /id: SYSTEM_PACKAGE_ID[\s\S]{0,160}checked: true[\s\S]{0,80}system: true/,
  /allServicesSelected\(\)[\s\S]{0,260}filter\(service => !service\.system\)[\s\S]{0,180}every\(service => service\.checked\)/,
  /setAllServices\(checked: boolean\)[\s\S]{0,220}filter\(service => !service\.system\)[\s\S]{0,140}service\.checked = checked/,
  /retentionNeedsMoreFrequentRuns\(\)[\s\S]{0,260}scheduleNeedsMoreFrequentRuns/,
  /createAutomaticBackup\(\)[\s\S]{0,700}validateScheduledBackupJob/,
  /@if \(bulkScheduleControlVisible\(\)\)[\s\S]{0,220}class="bulk-schedule-control"/,
  /class="bulk-schedule-summary"[\s\S]{0,180}activeJobCount\(\)[\s\S]{0,180}pausedJobCount\(\)/,
  /bulkScheduleControlVisible = computed\([\s\S]{0,300}jobs\(\)\.length > 1[\s\S]{0,180}!this\.scheduled\(\)\?\.isEditorOpen\(\)/,
  /pauseAllJobs\(\)[\s\S]{0,900}openConfirm[\s\S]{0,500}toggleAllJobs\(false\)/,
  /allJobsPaused\(\)[\s\S]{0,240}['"]Resume all['"][\s\S]{0,240}['"]Pause all['"]/,
  /toggleAllJobs\(enabled: boolean\)[\s\S]{0,300}setScheduledBackupJobsEnabled/,
  /toggleAllJobs\(enabled: boolean\)[\s\S]{0,500}setScheduledBackupJobsEnabled[\s\S]{0,180}scheduled\(\)\?\.reload\(\)/,
  /createAutomaticBackup\(\)[\s\S]{0,1400}getScheduledBackupJobs\(\{\}\)[\s\S]{0,500}jobs\.map\(job => \[job\.id, job\.id === created\.id\]\)/,
])
assertRule(editor, editorFile, '.bulk-schedule-control', {
  display: 'flex',
  'align-items': 'center',
  'justify-content': 'space-between',
  'min-width': '0',
})
assertSource(advancedFile, [
  /save\(form: JobEditor\)[\s\S]{0,1800}validateScheduledBackupJob[\s\S]{0,800}confirmJobRetentionChanges/,
  /allPackagesSelected\(form: JobEditor\)[\s\S]{0,360}filter\([\s\S]{0,100}pkg => pkg\.id !== SYSTEM_PACKAGE_ID[\s\S]{0,260}every\(pkg => form\.packageIds\.includes\(pkg\.id\)\)/,
  /setAllPackages\(form: JobEditor, checked: boolean\)[\s\S]{0,180}includesSystem = form\.packageIds\.includes\(SYSTEM_PACKAGE_ID\)[\s\S]{0,360}form\.packageIds = \[[\s\S]{0,140}includesSystem \? \[SYSTEM_PACKAGE_ID\][\s\S]{0,140}checked \? services\.map/,
])

assertSource(homeFile, [
  /docsLink[\s\S]{0,120}path="\/start-os\/"[\s\S]{0,80}fragment="#backups"/,
  /iconStart="@tui\.book-open-text"/,
  /readonly expanded = signal<BackupPanel \| null>\([\s\S]{0,120}reviewPackageId \? 'automatic' : null/,
  /<automatic-backups[\s\S]*\[embedded\]="true"/,
  /<system-backup[\s\S]{0,100}mode="create"[\s\S]{0,100}\[embedded\]="true"/,
  /<system-backup[\s\S]{0,100}mode="restore"[\s\S]{0,100}\[embedded\]="true"/,
  /<backup-locations \[embedded\]="true"/,
  /class="card-actions"[\s\S]{0,900}iconStart="@tui\.ellipsis-vertical"[\s\S]{0,500}['"]Run now['"][\s\S]{0,500}['"]View\/Edit['"]/,
  /<backup-locations[\s\S]*['"]Backup history['"][\s\S]*<backup-history/,
  /class="card-heading automatic-heading"[\s\S]*class="card-actions"[\s\S]*class="expand-toggle"/,
  /parseBackupSchedule\(primary\.schedule\)/,
  /const latest = this\.activities\(\)\[0\][\s\S]{0,100}latest\?\.state === 'running' \? latest : null/,
  /\[showIcons\]="false"/,
  /@if \(operationActivity\(\); as activity\)\s*\{\s*@if \(manualRunning\(\)\)/,
  /\[operationActive\]="progressActive\(\)"/,
  /readonly progressActive = computed\(\s*\(\) => !!this\.operationActivity\(\)/,
  /async togglePanel\(panel: BackupPanel\)[\s\S]{0,500}this\.expanded\.update\(/,
  /addSchedule\(\)[\s\S]{0,120}this\.createScheduleRequest\.update\(/,
  /@if \(needsAttention\(\)\)[\s\S]{0,220}tuiLink[\s\S]{0,180}class="attention-link"[\s\S]{0,180}\(click\)="openHistory\(\)"[\s\S]{0,160}['"]See more['"]\s*\|\s*i18n/,
  /async openHistory\(\)[\s\S]{0,180}confirmDiscardChanges\(\)[\s\S]{0,120}this\.expanded\.set\('history'\)/,
  /#historyCard[\s\S]{0,250}class="backup-card g-card"[\s\S]{0,160}\[class\.expanded\]="expanded\(\) === 'history'"/,
  /openHistory\(\)[\s\S]{0,500}historyCard\(\)\?\.nativeElement\.scrollIntoView/,
  /collapseAutomatic\(runNowJobId: string \| null\)[\s\S]{0,500}progressRequest\.set\([\s\S]{0,200}jobId: runNowJobId/,
  /activity\.id === request\.previousActivityId[\s\S]{0,500}activity\.jobId !== request\.jobId[\s\S]{0,500}progressCard\(\)\?\.nativeElement\.scrollIntoView/,
])
assertRule(home, homeFile, '.attention-link', {
  'align-self': 'center',
  'justify-self': 'start',
  'margin-inline-end': '0.5rem',
  'white-space': 'nowrap',
})
assertRule(
  home,
  homeFile,
  '.automatic-heading .attention-link',
  {
    'grid-column': '1',
    'grid-row': '2',
    'margin-block-start': '-0.75rem',
    'margin-block-end': '0.75rem',
    'margin-inline': '2.75rem 0',
  },
  phone,
)
assertSource(systemFile, [
  /page\.item === 'Backups'[\s\S]{0,180}!activeLink\.isActive \|\| !backupProgressActive\(\)/,
  /readonly backupProgressActive = toSignal\(inject\(OSService\)\.backingUp\$/,
])
assertNotSource(homeFile, [
  /<backup-navigation/,
  /['"]Help['"]\s*\|\s*i18n/,
  /routerLink="manage"/,
  /['"]Dismiss['"]\s*\|\s*i18n/,
  /class="delete-checkpoints"/,
  /class="card-body"[\s\S]{0,500}['"]Run now['"]/,
  /progress-prominent[\s\S]{0,500}--tui-background-accent-2/,
  /\[disabled\]="progressActive\(\)"/,
  /position:\s*sticky/,
  /progress-prominent::before/,
  /@if \(manualRunning\(\)\)[\s\S]{0,450}@else if \(operationActivity\(\); as activity\)/,
  /this\.activities\(\)\.find\(activity => activity\.state === 'running'\)/,
  /DISABLE_AUTOMATIC_DIALOG/,
  /deleteArchivedBackupSnapshots/,
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
  /<section[\s\S]{0,100}scheduledBackups[\s\S]{0,100}mode="manage"[\s\S]{0,100}\[createRequest\]="createRequest\(\)"/,
  /appearance="backup-back"[\s\S]{0,160}routerLink="\/system\/backups"[\s\S]{0,160}Back/,
  /appearance="backup-back"[\s\S]{0,120}\(click\)="previous\(\)"[\s\S]{0,120}Back/,
])
assertNotSource(editorFile, [/\[disabled\]="service\.system"/])
assertSource(locationsFile, [
  /appearance="backup-back"[\s\S]{0,160}routerLink="\/system\/backups"[\s\S]{0,160}Back/,
])
assertSource(manualPageFile, [
  /appearance="backup-back"[\s\S]{0,160}routerLink="\.\."[\s\S]{0,160}Back/,
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
  /\[primaryJobId\]/,
])
assertSource(historyFile, [
  /selector:\s*'backup-history'/,
  /filteredActivities\(\)/,
  /['"]Backup location['"]/,
])
assertNotSource(manualPageFile, [/'Last Backup'/, /<backup-navigation/])
assertSource(locationFile, [
  /readonly manage = output<void>\(\)/,
  /iconStart="@tui\.plus"[\s\S]{0,160}\(click\)="manage\.emit\(\)"[\s\S]{0,160}['"]Add or repair a location['"]/,
  /\[class\.manual-or-restore\]="mode\(\) !== 'automatic'"/,
  /<span tuiTitle>[\s\S]{0,100}<b>\{\{ target\.name \}\}<\/b>[\s\S]{0,160}<span tuiSubtitle>[\s\S]{0,100}target\.detail/,
  /formatCifsLocation\(location\.entry\)/,
  /class="target-detail"[\s\S]{0,120}target\.detail/,
  /class="target-reason"[\s\S]{0,160}target\.reason\s*\|\s*i18n/,
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
  '&:first-child:not(:only-child)',
  {
    'grid-area': '2 / 1 / 3 / -1',
    'justify-self': 'start',
  },
)
assertNestedRule(
  network,
  networkFile,
  ':host-context(tui-root._mobile)',
  'td.free',
  {
    'grid-area': '1 / 2',
    'justify-self': 'end',
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
assertNestedRule(
  physical,
  physicalFile,
  ':host-context(tui-root._mobile)',
  '&:first-child:not(.empty-state)',
  {
    'grid-area': '3 / 1 / 4 / -1',
    'justify-self': 'start',
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
  /\[disabled\]="pkg\.id === systemPackageId"/,
  /if \(packageId === SYSTEM_PACKAGE_ID\) return/,
])
assertSource(advancedFile, [
  /this\.jobs\(\)\.length === 1 && !this\.showSingleJobList[\s\S]{0,100}this\.edit\(this\.jobs\(\)\[0\]\)/,
  /protected jobSelectionSummary\(job: T\.BackupJob\)[\s\S]{0,520}const includesSystem = packageIds\.delete\(SYSTEM_PACKAGE_ID\)[\s\S]{0,180}serviceCount: packageIds\.size[\s\S]{0,120}includeFuture: selection\.includeFuture/,
  /selectedServiceSummary\(form: JobEditor\)[\s\S]{0,260}pkg\.id !== SYSTEM_PACKAGE_ID[\s\S]{0,260}id !== SYSTEM_PACKAGE_ID[\s\S]{0,520}['"]No System data['"]/,
])
assertSource(editorFile, [
  /selectedServiceSummary\(\)[\s\S]{0,220}service => !service\.system[\s\S]{0,180}service => service\.checked[\s\S]{0,520}['"]No System data['"]/,
])
assertSource(scheduledUtilsFile, [
  /const includeSystem = services\.includeSystem !== false/,
  /includeSystem,[\s\S]{0,160}type: 'allExcept'/,
  /installedPackageIds\.filter\(id => !selected\.has\(id\)\)/,
  /scheduleNeedsMoreFrequentRuns[\s\S]{0,700}finestInterval < maximumGapSeconds/,
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
assertNotSource(editorFile, [
  /DISABLE_AUTOMATIC_DIALOG/,
  /deleteArchivedBackupSnapshots/,
])

// Keep the refactored UI connected to the typed live RPC surface.
assertSource(dataModelFile, [/scheduledBackups:\s*T\.ScheduledBackupState/])
for (const file of [homeFile, editorFile, historyFile]) {
  assertSource(file, [/watch\$\('scheduledBackups'\)/])
}
assertSource(liveApiFile, [
  /createScheduledBackupJob[\s\S]{0,220}method:\s*'backup\.job\.create'/,
  /updateScheduledBackupJob[\s\S]{0,220}method:\s*'backup\.job\.update'/,
  /validateScheduledBackupJob[\s\S]{0,220}method:\s*'backup\.job\.validate'/,
  /setScheduledBackupJobEnabled[\s\S]{0,240}method:\s*'backup\.job\.set-enabled'/,
  /setScheduledBackupJobsEnabled[\s\S]{0,240}method:\s*'backup\.job\.set-enabled-bulk'/,
  /runScheduledBackupJob[\s\S]{0,220}method:\s*'backup\.job\.run-now'/,
  /refreshScheduledBackupHistories[\s\S]{0,240}method:\s*'backup\.history\.refresh'/,
  /deleteArchivedBackupSnapshots[\s\S]{0,260}method:\s*'backup\.history\.delete-archived-snapshots'/,
  /restoreBackupSelection[\s\S]{0,260}method:\s*'package\.backup\.restore-selection'/,
])
assertSource(globalStylesFile, [
  /tui-data-list\.backup-menu[\s\S]*min-width:\s*12rem[\s\S]*min-height:\s*3rem/,
  /\[tuiAppearance\]\[data-appearance='backup-back'\][\s\S]*color:\s*#000[\s\S]*background:\s*#fff/,
])

console.log('Backup mobile layout contract passed')
