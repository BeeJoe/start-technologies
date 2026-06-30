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

const homeFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/backups.component.ts'
const editorFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/automatic.component.ts'
const locationFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/location-picker.component.ts'
const locationsFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/locations.component.ts'
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
const navigationFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/backups/backup-navigation.component.ts'
const globalStylesFile = 'projects/start-os/web/ui/src/styles.scss'
const systemFile =
  'projects/start-os/web/ui/src/app/routes/portal/routes/system/system.component.ts'
const phone = '(max-width: 30rem)'
const narrowCard = 'card (max-width: 30rem)'
const home = componentStyles(homeFile)
const editor = componentStyles(editorFile)
const location = componentStyles(locationFile)
const manual = componentStyles(manualFile)
const recover = componentStyles(recoverFile)
const advanced = componentStyles(advancedFile)
const network = componentStyles(networkFile)
const physical = componentStyles(physicalFile)
const system = componentStyles(systemFile)

for (const file of [homeFile, editorFile, locationsFile]) {
  assertNestedRoute(file)
}
assertRule(system, systemFile, ':host-context(tui-root._mobile)', {
  'padding-inline': '0.75rem',
})

for (const selector of ['[tuiTitle]', '.status-grid > div']) {
  assertRule(home, homeFile, selector, {
    'min-width': '0',
    'overflow-wrap': 'anywhere',
  })
}
assertRule(home, homeFile, '.automatic > header', {
  position: 'static',
  height: 'auto',
})

for (const selector of ['.page-heading', '.operation']) {
  assertRule(
    home,
    homeFile,
    selector,
    { 'align-items': 'stretch', 'flex-direction': 'column' },
    phone,
  )
}
for (const selector of ['.automatic > header', '.attention', '.empty']) {
  assertContainerRule(
    home,
    homeFile,
    selector,
    { 'align-items': 'stretch', 'flex-direction': 'column' },
    narrowCard,
  )
}
assertContainerRule(
  home,
  homeFile,
  '.automatic > header .toggle',
  { width: 'fit-content', 'justify-content': 'flex-start' },
  narrowCard,
)
assertContainerRule(
  home,
  homeFile,
  '.actions',
  { 'flex-wrap': 'wrap' },
  narrowCard,
)

for (const selector of [
  '[tuiTitle]',
  '.schedule-controls > *',
  '.activity summary > *',
]) {
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
  '.activity summary',
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

for (const [sheet, file, columns] of [
  [network, networkFile, 'minmax(0, 1fr) auto auto'],
  [physical, physicalFile, 'minmax(0, 1fr) auto'],
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

for (const file of [homeFile, editorFile, locationsFile, manualPageFile]) {
  assertSource(file, [/<backup-navigation\s*\/>/])
}

for (const file of [editorFile, manualFile, recoverFile]) {
  assertSource(file, [
    /tuiCheckbox[\s\S]{0,320}['"]Toggle all['"]/,
    /host:\s*\{\s*class:\s*['"]backup-(?:page|settings)['"]|<backup-navigation\s*\/>/,
  ])
}

assertSource(navigationFile, [
  /routerLink="\/system\/backups\/manage"/,
  /routerLink="\/system\/backups\/manual"/,
  /routerLink="\/system\/backups\/restore"/,
  /routerLink="\/system\/backups\/locations"/,
  /overflow-x:\s*auto/,
])
assertSource(globalStylesFile, [
  /\.backup-page,[\s\S]*\.backup-settings[\s\S]*select\s*\{[\s\S]*min-height:\s*3rem[\s\S]*padding:\s*0\.75rem 2\.5rem 0\.75rem 1rem/,
  /tui-data-list\.backup-menu[\s\S]*min-width:\s*12rem[\s\S]*min-height:\s*3rem/,
])

console.log('Backup mobile layout contract passed')
