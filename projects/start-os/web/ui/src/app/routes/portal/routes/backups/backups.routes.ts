import { Routes } from '@angular/router'
import { titleResolver } from 'src/app/utils/title-resolver'

export default [
  {
    path: '',
    title: titleResolver,
    loadComponent: () => import('./backups.component'),
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
] satisfies Routes
