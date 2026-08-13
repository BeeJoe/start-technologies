import { CanDeactivateFn, Routes } from '@angular/router'
import { titleResolver } from 'src/app/utils/title-resolver'
import type BackupsComponent from './backups.component'

const confirmBackupExit: CanDeactivateFn<BackupsComponent> = component =>
  component.canDeactivate()

export default [
  {
    path: '',
    title: titleResolver,
    loadComponent: () => import('./backups.component'),
    canDeactivate: [confirmBackupExit],
  },
  {
    path: 'setup',
    redirectTo: '',
    pathMatch: 'full',
  },
  {
    path: 'manage',
    redirectTo: '',
    pathMatch: 'full',
  },
  {
    path: 'manual',
    redirectTo: '',
    pathMatch: 'full',
  },
  {
    path: 'restore',
    redirectTo: '',
    pathMatch: 'full',
  },
  {
    path: 'locations',
    redirectTo: '',
    pathMatch: 'full',
  },
  {
    path: '**',
    redirectTo: '',
  },
] satisfies Routes
