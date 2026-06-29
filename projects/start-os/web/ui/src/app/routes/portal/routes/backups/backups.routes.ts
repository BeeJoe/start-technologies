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
    title: titleResolver,
    loadComponent: () => import('./automatic.component'),
    data: { mode: 'setup' },
  },
  {
    path: 'manage',
    title: titleResolver,
    loadComponent: () => import('./automatic.component'),
    data: { mode: 'manage' },
  },
  {
    path: 'manual',
    title: titleResolver,
    loadComponent: () => import('../system/routes/backups/backups.component'),
    data: { type: 'create' },
  },
  {
    path: 'restore',
    title: titleResolver,
    loadComponent: () => import('../system/routes/backups/backups.component'),
    data: { type: 'restore' },
  },
  {
    path: 'locations',
    title: titleResolver,
    loadComponent: () => import('./locations.component'),
    data: { type: 'locations' },
  },
] satisfies Routes
