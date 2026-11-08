/**
 * The one list of pages. The front door, the field tile page, the office home page and the
 * sidebar all read from here, so they can't drift apart.
 *
 * Office pages carry the access area that opens them (see backend app/api/permissions.py);
 * the sidebar and home page only show what the signed-in person can open.
 */
import { Area } from './api';

export interface FieldLink { path: string; icon: string; label: string; sub: string; top?: boolean; urgent?: boolean; wide?: boolean }
export interface OfficeLink { path: string; icon: string; label: string; sub: string; area?: Area }
export interface OfficeSection { section: string; area?: Area; items: OfficeLink[] }

// Field crew — public, no login. `top` = the four big tiles; the rest sit under "More".
export const FIELD_LINKS: FieldLink[] = [
  { path: '/field/feed',               icon: '💬', label: 'Feed',               sub: 'Every crew chat, newest first', top: true, wide: true },
  { path: '/field',                    icon: '🧾', label: 'Submit Receipt',     sub: 'Invoices, MC & expenses', top: true },
  { path: '/field/work-ticket',        icon: '✅', label: 'My Schedule',        sub: 'Your route & tickets to complete', top: true },
  { path: '/field/purchase-order',     icon: '🛒', label: 'Purchase Order',     sub: 'Create a PO for materials', top: true },
  { path: '/field/incident',           icon: '🚨', label: 'Report Incident',    sub: 'Injury, damage or near miss', top: true, urgent: true },
  { path: '/field/project',            icon: '🏗️', label: 'Projects',           sub: 'Construction hours, updates & check-ins' },
  { path: '/field/maintenance',        icon: '🌿', label: 'Maintenance',        sub: 'Contracts & service history' },
  { path: '/field/contacts',           icon: '📞', label: 'Contacts',           sub: 'Property & client lookup' },
  { path: '/field/keys',               icon: '🔑', label: 'Key Box',            sub: 'Check keys in / out' },
  { path: '/field/safety',             icon: '🦺', label: 'Safety Talk',        sub: 'Record a toolbox talk' },
  { path: '/field/inspection',         icon: '🔍', label: 'Site Inspection',    sub: 'Safety & compliance check' },
  { path: '/field/vehicle-inspection', icon: '🚛', label: 'Vehicle Check',      sub: 'Weekly pre-use vehicle check' },
  { path: '/field/documents',          icon: '📋', label: 'Documents',          sub: 'Policies & procedures' },
];

// Office — grouped by access area, in sidebar order.
export const OFFICE_SECTIONS: OfficeSection[] = [
  {
    section: 'My Work',
    items: [
      { path: '/home',    icon: '🏠', label: 'Home',            sub: 'Your day at a glance' },
      { path: '/my-work', icon: '🎯', label: 'My Action Items', sub: 'Tasks, follow-ups & client emails due' },
    ],
  },
  {
    section: 'Operations', area: 'operations',
    items: [
      { path: '/dashboards/schedule',            icon: '🗺️', label: 'Daily Schedule',        sub: 'Sites visited today by division & lead' },
      { path: '/dashboards/schedule/week',       icon: '📆', label: 'Weekly Schedule',       sub: 'Mon–Fri sites by division & lead' },
      { path: '/dashboards/construction/board',  icon: '📅', label: 'Construction Board',    sub: 'Crew × day board — drag jobs onto the week' },
      { path: '/dashboards/construction/plan',   icon: '🏗️', label: 'Construction Planning', sub: 'Monthly plan, prep, client emails & PHAs' },
      { path: '/dashboards/construction',        icon: '📊', label: 'Construction Dashboard', sub: 'Job progress, hours & site updates' },
      { path: '/ops/issues',                     icon: '💬', label: 'Field Chat',            sub: 'All crew conversations' },
      { path: '/ops/safety-talks',               icon: '🦺', label: 'Safety Talks',          sub: 'Toolbox talk records' },
      { path: '/ops/safety-pha',                 icon: '⚠️', label: 'Hazard Assessments',    sub: 'Project hazard assessments (PHA)' },
      { path: '/ops/safety-inspections',         icon: '🔍', label: 'Site Inspections',      sub: 'Inspections & action items' },
      { path: '/ops/vehicle-inspections',        icon: '🚛', label: 'Vehicle Inspections',   sub: 'Weekly vehicle inspection log' },
      { path: '/ops/documents',                  icon: '🗂️', label: 'Documents Admin',       sub: 'Upload & organise company documents' },
      { path: '/keys/admin',                     icon: '🔑', label: 'Key Box Admin',         sub: 'Manage keys & view log' },
    ],
  },
  {
    section: 'Customers & Sales', area: 'customers',
    items: [
      { path: '/dashboards/customer/360', icon: '👤', label: 'Customer 360',      sub: 'Every job + activity for one customer' },
      { path: '/dashboards/customer',     icon: '🏢', label: 'Customer Report',   sub: 'Weekly service report for a commercial customer' },
      { path: '/dashboards/estimating',   icon: '💼', label: 'Estimating',        sub: 'Open opportunities & pipeline value' },
      { path: '/dashboards/activities',   icon: '📋', label: 'Activity Summary',  sub: 'Open issues & activities from Aspire' },
      { path: '/dashboards/sales',        icon: '📈', label: 'Sales Dashboard',   sub: 'Revenue pipeline, targets & pace' },
      { path: '/sales/log',               icon: '📍', label: 'Log Sales Visit',   sub: 'Notes, photos, follow-ups, coworker tasks' },
    ],
  },
  {
    section: 'HR', area: 'hr',
    items: [
      { path: '/ops/safety-incidents', icon: '🚨', label: 'Incident Reports', sub: 'Safety incident log & sign-off' },
    ],
  },
  {
    section: 'Finance', area: 'finance',
    items: [
      { path: '/ap',                 icon: '💳', label: 'Invoices',        sub: 'AP inbox & invoice processing' },
      { path: '/ap/invoice-summary', icon: '📋', label: 'Invoice Summary', sub: 'Progress report by contract' },
      { path: '/vendors',            icon: '🏢', label: 'Vendors',         sub: 'Vendor rules & settings' },
      { path: '/reconcile',          icon: '🔄', label: 'Reconciliation',  sub: 'Statement vs QBO reconcile' },
    ],
  },
  {
    section: 'Admin', area: 'admin',
    items: [
      { path: '/users',          icon: '👤', label: 'Users',          sub: 'Logins & access' },
      { path: '/settings/email', icon: '✉️', label: 'Email Settings', sub: 'Timing & recipients of automated emails' },
      { path: '/ops/backups',    icon: '💾', label: 'Backups',        sub: 'Database snapshots' },
      { path: '/ops/usage',      icon: '📈', label: 'Usage',          sub: 'Which pages people open, how often' },
    ],
  },
  {
    section: 'Field',
    items: [
      { path: '/crew', icon: '📱', label: 'Field App', sub: 'The crew pages — no login needed' },
    ],
  },
];

/** Sections (and items) the signed-in person can open. */
export function visibleSections(hasArea: (a: Area) => boolean): OfficeSection[] {
  return OFFICE_SECTIONS
    .map(sec => ({ ...sec, items: sec.items.filter(it => !(it.area ?? sec.area) || hasArea((it.area ?? sec.area)!)) }))
    .filter(sec => sec.items.length > 0);
}

/** The menu item that owns the current page: the longest path that matches, so only one lights up. */
export function activePath(pathname: string, paths: string[]): string | null {
  let best: string | null = null;
  for (const p of paths) {
    if ((pathname === p || pathname.startsWith(p + '/')) && (!best || p.length > best.length)) best = p;
  }
  return best;
}
