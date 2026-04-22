/**
 * API client — connects the frontend to the FastAPI backend.
 * Base URL reads from VITE_API_URL env var, defaults to localhost for dev.
 */

const BASE = import.meta.env.VITE_API_URL || 'https://ap-automation-production.up.railway.app';

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  isForm = false,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (!isForm) headers['Content-Type'] = 'application/json';

  const token = localStorage.getItem('ap_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: isForm
      ? (body as FormData)
      : body
      ? JSON.stringify(body)
      : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface AuthUser { id: number; email: string; name: string; role: string; }

export async function login(email: string, password: string): Promise<AuthUser> {
  const form = new URLSearchParams({ username: email, password });
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) throw new Error('Invalid email or password');
  const data = await res.json();
  localStorage.setItem('ap_token', data.access_token);
  localStorage.setItem('ap_user', JSON.stringify({ name: data.name, email: data.email, role: data.role }));
  return data;
}

export async function getMe(): Promise<AuthUser> {
  return request<AuthUser>('GET', '/auth/me');
}

export function logout() {
  localStorage.removeItem('ap_token');
  localStorage.removeItem('ap_user');
  window.location.href = '/login';
}

export function currentUser(): AuthUser | null {
  try { return JSON.parse(localStorage.getItem('ap_user') || ''); } catch { return null; }
}

// ── Invoice endpoints ─────────────────────────────────────────────────────────

export interface UploadResponse {
  invoice_id: number;
  vendor: string;
  total: number;
  outcome: string;
  message: string;
}

export interface POValidationResult {
  valid: boolean;
  job_name?: string;
  job_address?: string;
  error?: string;
}

export async function uploadInvoice(
  file: File,
  docType: string,
  costType: string,
  poNumber?: string,
  employee?: string,
  notes?: string,
  glAccount?: string,
  isReturn?: boolean,
): Promise<UploadResponse> {
  const form = new FormData();
  form.append('file', file);
  form.append('doc_type', docType);
  form.append('cost_type', costType);
  if (poNumber)  form.append('po_number_hint', poNumber);
  if (employee)  form.append('employee_name', employee);
  if (notes)     form.append('notes', notes);
  if (glAccount) form.append('gl_account', glAccount);
  if (isReturn)  form.append('is_return', 'true');
  return request<UploadResponse>('POST', '/invoices/upload', form, true);
}

export interface QuickExtractResult {
  success: boolean;
  vendor_name?: string;
  invoice_number?: string;
  total_amount?: number;
  po_number?: string;
  error?: string;
}

export async function quickExtract(file: File): Promise<QuickExtractResult> {
  const form = new FormData();
  form.append('file', file);
  try {
    return await request<QuickExtractResult>('POST', '/invoices/quick-extract', form, true);
  } catch {
    return { success: false };
  }
}

export interface GLLookupResult {
  found: boolean;
  gl_account: string | null;
  gl_name: string | null;
}

export async function lookupVendorGL(vendorName: string): Promise<GLLookupResult> {
  try {
    return await request<GLLookupResult>(
      'GET',
      `/vendors/gl-lookup?vendor_name=${encodeURIComponent(vendorName)}`,
    );
  } catch {
    return { found: false, gl_account: null, gl_name: null };
  }
}

export interface GLSuggestResult {
  gl_account: string;
  gl_name: string;
  confidence: 'high' | 'medium' | 'low';
}

export async function suggestGL(description: string, vendorName?: string): Promise<GLSuggestResult> {
  return request<GLSuggestResult>('POST', '/invoices/suggest-gl', {
    description,
    vendor_name: vendorName,
  });
}

export async function validatePO(poNumber: string): Promise<POValidationResult> {
  try {
    const res = await request<{ valid: boolean; job?: Record<string, unknown>; error?: string }>(
      'GET',
      `/invoices/validate-po?po_number=${encodeURIComponent(poNumber)}`,
    );
    return {
      valid: res.valid,
      job_name: res.job?.OpportunityName as string | undefined,
      job_address: res.job?.BillingAddressLine1 as string | undefined,
      error: res.error,
    };
  } catch (e: unknown) {
    return { valid: false, error: (e as Error).message };
  }
}

export async function getInvoiceCounts() {
  return request<Record<string, number>>('GET', '/invoices/counts');
}

export async function listInvoices(status?: string, destination?: string) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (destination) params.set('destination', destination);
  return request<{ invoices: unknown[]; count: number }>('GET', `/invoices/?${params}`);
}

export async function applyPOOverride(invoiceId: number, poNumber: string, reviewedBy: string) {
  return request('POST', `/invoices/${invoiceId}/override`, { po_number: poNumber, reviewed_by: reviewedBy });
}

export async function markAsOverhead(invoiceId: number, glAccount?: string, reviewedBy = 'ap_user') {
  return request('POST', `/invoices/${invoiceId}/overhead`, { gl_account: glAccount, reviewed_by: reviewedBy });
}

// ── Vendor endpoints ──────────────────────────────────────────────────────────

export interface VendorRule {
  id: number;
  vendor_name: string;
  type: 'job_cost' | 'overhead' | 'mixed';
  default_gl_account?: string;
  default_gl_name?: string;
  forward_to?: string;
  vendor_id_aspire?: string;
  vendor_id_qbo?: string;
  notes?: string;
  is_employee?: boolean;
  active: boolean;
  aspire_post?: boolean;
}

export async function lookupGLName(account: string): Promise<{ found: boolean; gl_name: string | null }> {
  try {
    return await request('GET', `/vendors/gl-name?account=${encodeURIComponent(account)}`);
  } catch {
    return { found: false, gl_name: null };
  }
}

export async function listEmployees(): Promise<string[]> {
  const res = await request<{ employees: string[] }>('GET', '/vendors/employees');
  return res.employees;
}

export async function listVendors(): Promise<{ vendors: VendorRule[]; count: number }> {
  return request('GET', '/vendors/');
}

export async function createVendor(data: Omit<VendorRule, 'id' | 'active'>) {
  return request('POST', '/vendors/', data);
}

export async function updateVendor(id: number, data: Partial<VendorRule>) {
  return request('PUT', `/vendors/${id}`, data);
}

export async function deactivateVendor(id: number) {
  return request('DELETE', `/vendors/${id}`);
}

// ── Construction Dashboard ─────────────────────────────────────────────────────

export interface WorkTicket {
  WorkTicketID: number;
  OpportunityID: number;
  WorkTicketTitle: string | null;
  WorkTicketStatusName: string | null;
  WorkTicketType: string | null;
  EstimatedLaborHours: number | null;
  ActualLaborHours: number | null;
  BudgetedLaborCost: number | null;
  ActualLaborCost: number | null;
  BudgetedCost: number | null;
  ActualCost: number | null;
  CompleteDate: string | null;
  ScheduledDate: string | null;
}

export interface ConstructionJob {
  OpportunityID: number;
  OpportunityName: string | null;
  OpportunityNumber: number | null;
  OpportunityStatusName: string | null;
  JobStatusName: string | null;
  WonDollars: number | null;
  ActualEarnedRevenue: number | null;
  ActualGrossMarginDollars: number | null;
  ActualGrossMarginPercent: number | null;
  EstimatedDollars: number | null;
  EstimatedGrossMarginDollars: number | null;
  EstimatedGrossMarginPercent: number | null;
  ActualCostDollars: number | null;
  EstimatedLaborHours: number | null;
  ActualLaborHours: number | null;
  PercentComplete: number | null;
  StartDate: string | null;
  EndDate: string | null;
  CompleteDate: string | null;
  WonDate: string | null;
  SalesRepContactName: string | null;
  OperationsManagerContactName: string | null;
  PropertyName: string | null;
  BranchName: string | null;
  // Set when change orders have been rolled up into this parent row
  change_order_count?: number;
  change_order_total?: number;
}

export interface DivisionTotals {
  won_dollars: number;
  actual_earned_revenue: number;
  actual_gross_margin: number;
  estimated_revenue: number;
  estimated_gross_margin: number;
  job_count: number;
}

export interface ConstructionDashboardData {
  year: number;
  targets: { revenue: number; margin: number };
  completed: DivisionTotals;
  in_production: DivisionTotals;
  in_queue: DivisionTotals;
  in_progress: DivisionTotals;       // legacy
  completed_jobs: ConstructionJob[];
  in_production_jobs: ConstructionJob[];
  in_queue_jobs: ConstructionJob[];
  jobs: ConstructionJob[];           // legacy flat list
}

export async function getConstructionDashboard(year = 2026): Promise<ConstructionDashboardData> {
  return request('GET', `/dashboard/construction?year=${year}`);
}

export async function getJobTickets(opportunityId: number): Promise<{ opportunity_id: number; tickets: WorkTicket[] }> {
  return request('GET', `/dashboard/construction/${opportunityId}/tickets`);
}

// ── Aspire Field Operations ───────────────────────────────────────────────────

export interface FieldOpportunity {
  OpportunityID: number;
  OpportunityName: string | null;
  OpportunityNumber: number | null;
  OpportunityStatusName: string | null;
  JobStatusName: string | null;
  PropertyName: string | null;
  PropertyID: number | null;
  BillingContactID: number | null;
  DivisionName: string | null;
  StartDate: string | null;
  EndDate: string | null;
}

export interface FieldWorkTicket {
  WorkTicketID: number;
  OpportunityID: number;
  WorkTicketTitle: string | null;
  WorkTicketStatusName: string | null;
  WorkTicketType: string | null;
  ScheduledDate: string | null;
  CompleteDate: string | null;
  ActualLaborHours: number | null;
}

export interface ScheduledWorkTicket {
  WorkTicketID: number;
  WorkTicketTitle: string | null;
  OpportunityID: number;
  OpportunityName: string | null;
  PropertyName: string | null;
  PropertyAddress: string | null;
  ServiceName: string | null;
  WorkTicketStatusName: string | null;
  WorkTicketType: string | null;
  ScheduledDate: string | null;
  CompleteDate: string | null;
  ActualLaborHours: number | null;
  EstimatedLaborHours: number | null;
  _RouteName: string | null;
  ProductionNote?: string | null;
  Notes?: string | null;
}

export interface TicketRoute {
  route_name: string;
  ticket_count: number;
  tickets: ScheduledWorkTicket[];
  crew_leader_name?: string | null;
  assigned_crew?: string[];   // populated client-side from crew assignments
}

export type TicketRange = 'past' | 'today' | 'upcoming';

export async function getScheduledTickets(range: TicketRange, workDate?: string): Promise<{ routes: TicketRoute[]; total_tickets: number }> {
  const params = new URLSearchParams({ range });
  if (workDate) params.set('work_date', workDate);
  return request('GET', `/aspire/field/work-tickets/scheduled?${params}`);
}

export interface AspireEmployee {
  ContactID: number;
  UserID?: number;
  FullName: string;
  Email?: string;
}

// ── Field Issue ───────────────────────────────────────────────────────────────

export interface CreateIssueResponse {
  success: boolean;
  issue_id: number | null;
  subject: string;
  property_id: number | null;
  property_name: string | null;
  photos_uploaded: number;
  submitter: string;
}

export interface ActivityCategory { id: number; name: string; }

export async function getIssueCategories(): Promise<ActivityCategory[]> {
  const res = await request<{ categories: ActivityCategory[] }>('GET', '/aspire/field/issue-categories');
  return res.categories;
}

export interface FieldIssuePayload {
  submitterName: string;
  propertyId?: number;
  propertyName?: string;
  subject: string;
  categoryId?: number;
  categoryName?: string;
  assignedToId?: number;
  assignedToName?: string;
  priority?: string;
  dueDate?: string;
  notes: string;
  photos: File[];
}

export async function createFieldIssue(p: FieldIssuePayload): Promise<CreateIssueResponse> {
  const form = new FormData();
  form.append('submitter_name', p.submitterName);
  if (p.propertyId)      form.append('property_id',      String(p.propertyId));
  if (p.propertyName)    form.append('property_name',    p.propertyName);
  form.append('subject', p.subject);
  if (p.categoryId)      form.append('category_id',      String(p.categoryId));
  if (p.categoryName)    form.append('category_name',    p.categoryName);
  if (p.assignedToId)    form.append('assigned_to_id',   String(p.assignedToId));
  if (p.assignedToName)  form.append('assigned_to_name', p.assignedToName);
  if (p.priority)        form.append('priority',         p.priority);
  if (p.dueDate)         form.append('due_date',         p.dueDate);
  form.append('notes', p.notes);
  for (const photo of p.photos) form.append('photos', photo);
  return request<CreateIssueResponse>('POST', '/aspire/field/issue', form, true);
}

export async function getAspireEmployees(): Promise<AspireEmployee[]> {
  try {
    const res = await request<{ employees: AspireEmployee[] }>('GET', '/aspire/field/employees');
    return res.employees;
  } catch { return []; }
}

export async function searchFieldOpportunities(q: string): Promise<{ opportunities: FieldOpportunity[] }> {
  return request('GET', `/aspire/field/opportunities/search?q=${encodeURIComponent(q)}`);
}

export async function getOpportunityWorkTickets(opportunityId: number): Promise<{ opportunity_id: number; tickets: FieldWorkTicket[] }> {
  return request('GET', `/aspire/field/opportunities/${opportunityId}/work-tickets`);
}

export interface CompleteTicketResponse {
  success: boolean;
  ticket_id: number;
  photos_uploaded: number;
  submitter: string;
}

export async function completeWorkTicket(
  ticketId: number,
  submitterName: string,
  comment: string,
  photos: File[],
): Promise<CompleteTicketResponse> {
  const form = new FormData();
  form.append('submitter_name', submitterName);
  form.append('comment', comment);
  for (const photo of photos) {
    form.append('photos', photo);
  }
  return request<CompleteTicketResponse>('POST', `/aspire/field/work-ticket/${ticketId}/complete`, form, true);
}

export interface FieldPropertyResult {
  OpportunityID: number;
  OpportunityName: string | null;
  PropertyName: string | null;
  PropertyID: number | null;
  BillingContactID: number | null;
  DivisionName: string | null;
}

export async function searchFieldProperties(q: string): Promise<{ properties: FieldPropertyResult[] }> {
  return request('GET', `/aspire/field/properties/search?q=${encodeURIComponent(q)}`);
}

export interface AspirePicklistItem {
  id: number;
  name: string;
}

export async function getLeadSources(): Promise<AspirePicklistItem[]> {
  try {
    const res = await request<{ lead_sources: Record<string, unknown>[] }>('GET', '/aspire/field/lead-sources');
    return res.lead_sources.map(s => ({
      id:   (s.LeadSourceID ?? s.Id ?? s.id) as number,
      name: (s.LeadSourceName ?? s.Name ?? s.name ?? '') as string,
    })).filter(s => s.name);
  } catch { return []; }
}

export async function getSalesTypes(): Promise<AspirePicklistItem[]> {
  try {
    const res = await request<{ sales_types: Record<string, unknown>[] }>('GET', '/aspire/field/sales-types');
    return res.sales_types.map(s => ({
      id:   (s.SalesTypeID ?? s.Id ?? s.id) as number,
      name: (s.SalesTypeName ?? s.Name ?? s.name ?? '') as string,
    })).filter(s => s.name);
  } catch { return []; }
}

export interface CreateOpportunityResponse {
  success: boolean;
  opportunity_id: string | number;
  opportunity_number: number | null;
  opportunity_name: string;
  photos_uploaded: number;
  submitter: string;
}

export interface FieldOpportunityPayload {
  submitterName: string;
  opportunityName: string;
  divisionId: number;
  estimatedValue: number;
  notes: string;
  photos: File[];
  propertyId?: number;
  propertyNameFyi?: string;
  dueDate?: string;
  startDate?: string;
  endDate?: string;
  leadSourceId?: number;
  leadSourceName?: string;
  salesTypeId?: number;
  salesTypeName?: string;
  salespersonId?: number;
  salespersonName?: string;
  salespersonEmail?: string;
  opportunityType?: string;
}

// ── Estimating Dashboard ───────────────────────────────────────────────────────

export interface EstimatingOpp {
  id: number;
  opp_number: number | null;
  name: string;
  property: string;
  division: string;
  opp_type: string;
  sales_type: string;
  status: string;
  created_date: string | null;
  due_date: string | null;
  proposed_date: string | null;
  start_date: string | null;
  last_activity_date: string | null;
  estimated_value: number;
  days_old: number;
  days_until_due: number | null;
  turnaround_days: number | null;
  turnaround_limit: number;
  urgency: 'overdue' | 'urgent' | 'soon' | 'ok' | 'no-date';
  alert_level: 'ok' | 'warning' | 'overdue';
  alerts: string[];
  is_tier1: boolean;
}

export interface EstimatingStage {
  stage: string;
  opportunities: EstimatingOpp[];
}

export interface EstimatingSalesperson {
  name: string;
  total: number;
  total_value: number;
  overdue: number;
  alert_overdue: number;
  alert_warning: number;
  stages: EstimatingStage[];
}

export interface EstimatingDashboardData {
  summary: {
    total: number;
    total_value: number;
    overdue: number;
    due_this_week: number;
    tier1_count: number;
    alert_overdue: number;
    alert_warning: number;
    tier1_overdue: number;
  };
  sales_types: string[];
  phases: string[];
  divisions: string[];
  salespeople: EstimatingSalesperson[];
}

export async function sendEstimatingDigest(): Promise<{ ok: boolean; sent: number; recipients: string[] }> {
  return request('POST', '/dashboard/estimating/send-digest');
}

export async function getEstimatingDashboard(): Promise<EstimatingDashboardData> {
  return request<EstimatingDashboardData>('GET', '/dashboard/estimating');
}

// ── Activities Dashboard ──────────────────────────────────────────────────────

export interface Activity {
  id: number;
  number: number | null;
  subject: string;
  activity_type: string;
  status: string;
  priority: string;
  category: string;
  issue_number: number | null;
  issue_url: string | null;
  assigned_to: string[];
  comments: { meta: string; text: string }[];
  property_id: number | null;
  property_name: string;
  due_date: string | null;
  start_date: string | null;
  complete_date: string | null;
  created_date: string | null;
  opportunity_id: number | null;
  work_ticket_id: number | null;
  is_milestone: boolean;
  days_until_due: number | null;
  urgency: 'overdue' | 'urgent' | 'soon' | 'ok' | 'no-date';
}

export interface ActivitiesDashboardData {
  summary: { total: number; overdue: number; due_this_week: number; milestones: number };
  activity_types: string[];
  statuses: string[];
  priorities: string[];
  categories: string[];
  assigned_to_list: string[];
  activities: Activity[];
}

export async function getActivitiesDashboard(showCompleted = false, includeEmails = false): Promise<ActivitiesDashboardData> {
  return request<ActivitiesDashboardData>('GET', `/dashboard/activities?show_completed=${showCompleted}&include_emails=${includeEmails}`);
}

// ── User management (admin only) ─────────────────────────────────────────────

export interface UserRecord {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'staff';
  active: boolean | number;
  created_at: string;
  last_login: string | null;
}

export async function listUsers(): Promise<UserRecord[]> {
  const res = await request<{ users: UserRecord[] }>('GET', '/auth/users');
  return res.users;
}

export async function createUser(data: {
  email: string; name: string; password: string; role: string;
}): Promise<UserRecord> {
  return request('POST', '/auth/users', data);
}

export async function updateUser(id: number, data: {
  name?: string; role?: string; active?: boolean;
}): Promise<UserRecord> {
  return request('PUT', `/auth/users/${id}`, data);
}

export async function resetUserPassword(id: number, password: string): Promise<void> {
  await request('POST', `/auth/users/${id}/reset-password`, { password });
}

// ── Crew Schedule ─────────────────────────────────────────────────────────────

export interface CrewEmployee {
  ContactID: number;
  FullName: string;
  Email?: string;
}

export interface CrewAssignment {
  id: number;
  route_name: string;
  employee_id: number;
  employee_name: string;
}

export async function getCrewEmployees(): Promise<CrewEmployee[]> {
  const res = await request<{ employees: CrewEmployee[] }>('GET', '/crew/employees');
  return res.employees;
}

export async function getCrewAssignments(workDate: string): Promise<Record<string, CrewAssignment[]>> {
  const res = await request<{ assignments: Record<string, CrewAssignment[]> }>(
    'GET', `/crew/assignments?work_date=${workDate}`
  );
  return res.assignments;
}

export async function addCrewAssignment(
  workDate: string, routeName: string, employeeId: number, employeeName: string
): Promise<{ id: number; created: boolean }> {
  return request('POST', '/crew/assignments', {
    work_date: workDate, route_name: routeName,
    employee_id: employeeId, employee_name: employeeName,
  });
}

export async function removeCrewAssignment(assignmentId: number): Promise<void> {
  await request('DELETE', `/crew/assignments/${assignmentId}`);
}

export async function createFieldOpportunity(p: FieldOpportunityPayload): Promise<CreateOpportunityResponse> {
  const form = new FormData();
  form.append('submitter_name', p.submitterName);
  form.append('opportunity_name', p.opportunityName);
  form.append('division_id', String(p.divisionId));
  form.append('estimated_value', String(p.estimatedValue));
  form.append('notes', p.notes);
  if (p.propertyId)      form.append('property_id',      String(p.propertyId));
  if (p.propertyNameFyi) form.append('property_name_fyi', p.propertyNameFyi);
  if (p.dueDate)         form.append('due_date',          p.dueDate);
  if (p.startDate)       form.append('start_date',        p.startDate);
  if (p.endDate)         form.append('end_date',          p.endDate);
  if (p.leadSourceId)    form.append('lead_source_id',    String(p.leadSourceId));
  if (p.leadSourceName)  form.append('lead_source_name',  p.leadSourceName);
  if (p.salesTypeId)      form.append('sales_type_id',      String(p.salesTypeId));
  if (p.salesTypeName)    form.append('sales_type_name',    p.salesTypeName);
  if (p.salespersonId)    form.append('salesperson_id',     String(p.salespersonId));
  if (p.salespersonName)  form.append('salesperson_name',   p.salespersonName);
  if (p.salespersonEmail) form.append('salesperson_email',  p.salespersonEmail);
  if (p.opportunityType)  form.append('opportunity_type',   p.opportunityType);
  for (const photo of p.photos) form.append('photos', photo);
  return request<CreateOpportunityResponse>('POST', '/aspire/field/opportunity', form, true);
}

// ── Purchase Orders ───────────────────────────────────────────────────────────

export interface POVendor {
  vendor_id:   number | null;
  vendor_name: string;
  preferred:   boolean;
}

export interface POJobResult {
  type:              'work_ticket' | 'opportunity';
  opportunity_id:    number | null;
  opportunity_name:  string | null;
  property_name:     string | null;
  work_ticket_id:    number | null;
  work_ticket_num:   number | null;
  work_ticket_title: string | null;
  status:            string | null;
  date:              string | null;
}

export interface POWorkTicket {
  WorkTicketID:         number;
  WorkTicketNumber:     number;
  WorkTicketTitle:      string | null;
  WorkTicketStatusName: string | null;
  ScheduledStartDate:   string | null;
  PropertyName:         string | null;
}

export interface POLineItem {
  description:     string;
  qty:             number;
  unit_cost:       number;
  uom:             string;
  catalog_item_id?: number | null;
}

export interface POResult {
  success:        boolean;
  receipt_id:     number | null;
  receipt_number: number | null;  // display number shown in Aspire UI
  display_number: number | null;  // receipt_number ?? receipt_id
  vendor_name:    string;
  total:          number;
  items:          number;
  requester:      string;
  job_name:       string | null;
}

export interface POUomType { id: number; name: string; }

export async function getPOUomTypes(): Promise<POUomType[]> {
  const r = await request<{ uom_types: POUomType[] }>('GET', '/aspire/field/purchase-order/uom-types');
  return r.uom_types;
}

export async function getPOVendors(q = ''): Promise<{ vendors: POVendor[]; preferred_shown: boolean }> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  return request('GET', `/aspire/field/purchase-order/vendors${qs}`);
}

export async function searchPOJobs(q: string): Promise<{ results: POJobResult[] }> {
  return request('GET', `/aspire/field/purchase-order/jobs/search?q=${encodeURIComponent(q)}`);
}

export async function getPOWorkTickets(opportunityId: number): Promise<{ tickets: POWorkTicket[] }> {
  return request('GET', `/aspire/field/purchase-order/work-tickets/${opportunityId}`);
}

export interface POTicketItem {
  item_id:         number;
  catalog_item_id: number | null;
  name:            string;
  qty:             number;
  unit_cost:       number;
  uom:             string;
}

export async function getWorkTicketMaterials(workTicketId: number): Promise<{ items: POTicketItem[] }> {
  return request('GET', `/aspire/field/purchase-order/work-ticket-items/${workTicketId}`);
}

export interface NewReceipt {
  receipt_id:     number;
  display_number: number;
  vendor_id:      number;
  vendor_name:    string;
  received_date:  string;
  note_snippet:   string;
  total:          number;
}

export async function getNewReceipts(): Promise<NewReceipt[]> {
  const r = await request<{ receipts: NewReceipt[] }>('GET', '/aspire/field/purchase-order/new-receipts');
  return r.receipts;
}

export async function amendPOVendor(p: {
  receiptId:  number;
  vendorId:   number;
  vendorName: string;
}): Promise<{ success: boolean; display_number: number; old_vendor: string; vendor_name: string }> {
  const form = new FormData();
  form.append('receipt_id',  String(p.receiptId));
  form.append('vendor_id',   String(p.vendorId));
  form.append('vendor_name', p.vendorName);
  return request('POST', '/aspire/field/purchase-order/amend-vendor', form, true);
}

export async function createPurchaseOrder(p: {
  requesterName: string;
  vendorId:      number;
  vendorName:    string;
  workTicketId?: number | null;
  opportunityId?: number | null;
  jobName?:      string | null;
  notes?:        string;
  items:         POLineItem[];
}): Promise<POResult> {
  const form = new FormData();
  form.append('requester_name', p.requesterName);
  form.append('vendor_id',      String(p.vendorId));
  form.append('vendor_name',    p.vendorName);
  if (p.workTicketId)  form.append('work_ticket_id',  String(p.workTicketId));
  if (p.opportunityId) form.append('opportunity_id',  String(p.opportunityId));
  if (p.jobName)       form.append('job_name',         p.jobName);
  form.append('notes',      p.notes ?? '');
  form.append('items_json', JSON.stringify(p.items));
  return request<POResult>('POST', '/aspire/field/purchase-order', form, true);
}

// ── Key management ────────────────────────────────────────────────────────────

export interface KeyEntry {
  id:             number;
  name:           string;
  key_type:       'vehicle' | 'property_owner' | 'other';
  description:    string | null;
  property_name:  string | null;
  active:         number;
  created_at:     string;
  current_holder: string | null;
  last_action:    'in' | 'out' | null;
  last_scanned:   string | null;
}

export interface KeyLogEntry {
  id:            number;
  key_id:        number;
  key_name?:     string;
  key_type?:     string;
  employee_name: string;
  action:        'in' | 'out';
  notes:         string | null;
  scanned_at:    string;
}

export async function getKeyEmployees(): Promise<string[]> {
  const r = await request<{ employees: string[] }>('GET', '/keys/employees');
  return r.employees;
}

export async function listKeysPublic(): Promise<KeyEntry[]> {
  const r = await request<{ keys: KeyEntry[] }>('GET', '/keys/list');
  return r.keys;
}

export async function getKey(id: number): Promise<{ key: KeyEntry; checked_out: boolean; log: KeyLogEntry[] }> {
  return request('GET', `/keys/${id}`);
}

export async function scanKey(p: { keyId: number; employeeName: string; action: 'in' | 'out'; notes?: string }): Promise<{ ok: boolean }> {
  const form = new FormData();
  form.append('employee_name', p.employeeName);
  form.append('action', p.action);
  form.append('notes', p.notes ?? '');
  return request('POST', `/keys/${p.keyId}/scan`, form, true);
}

export async function listKeys(): Promise<KeyEntry[]> {
  const r = await request<{ keys: KeyEntry[] }>('GET', '/keys/');
  return r.keys;
}

export async function createKey(p: { name: string; keyType: string; description?: string; propertyName?: string }): Promise<{ ok: boolean; key_id: number }> {
  const form = new FormData();
  form.append('name',          p.name);
  form.append('key_type',      p.keyType);
  form.append('description',   p.description  ?? '');
  form.append('property_name', p.propertyName ?? '');
  return request('POST', '/keys/', form, true);
}

export async function updateKey(id: number, p: { name?: string; keyType?: string; description?: string; propertyName?: string }): Promise<{ ok: boolean }> {
  const form = new FormData();
  if (p.name         != null) form.append('name',          p.name);
  if (p.keyType      != null) form.append('key_type',      p.keyType);
  if (p.description  != null) form.append('description',   p.description);
  if (p.propertyName != null) form.append('property_name', p.propertyName);
  return request('PATCH', `/keys/${id}`, form, true);
}

export async function deactivateKey(id: number): Promise<{ ok: boolean }> {
  return request('DELETE', `/keys/${id}`);
}

export async function getKeyFullLog(limit = 200): Promise<KeyLogEntry[]> {
  const r = await request<{ log: KeyLogEntry[] }>('GET', `/keys/log/all?limit=${limit}`);
  return r.log;
}

export async function searchAspireProperties(q: string): Promise<{ property_id: number; property_name: string; address: string }[]> {
  const r = await request<{ results: { property_id: number; property_name: string; address: string }[] }>('GET', `/keys/properties/search?q=${encodeURIComponent(q)}`);
  return r.results;
}
