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
): Promise<UploadResponse> {
  const form = new FormData();
  form.append('file', file);
  form.append('doc_type', docType);
  form.append('cost_type', costType);
  if (poNumber) form.append('po_number_hint', poNumber);
  if (employee) form.append('employee_name', employee);
  if (notes) form.append('notes', notes);
  if (glAccount) form.append('gl_account', glAccount);
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
  PercentComplete: number | null;
  StartDate: string | null;
  EndDate: string | null;
  CompleteDate: string | null;
  WonDate: string | null;
  SalesRepContactName: string | null;
  OperationsManagerContactName: string | null;
  PropertyName: string | null;
  BranchName: string | null;
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
  in_progress: DivisionTotals;
  // legacy totals field removed — use completed + in_progress
  totals?: {
    won_dollars: number;
    actual_earned_revenue: number;
    actual_gross_margin: number;
    estimated_revenue: number;
    estimated_gross_margin: number;
    job_count: number;
  };
  jobs: ConstructionJob[];
}

export async function getConstructionDashboard(year = 2026): Promise<ConstructionDashboardData> {
  return request('GET', `/dashboard/construction?year=${year}`);
}

export async function getJobTickets(opportunityId: number): Promise<{ opportunity_id: number; tickets: WorkTicket[] }> {
  return request('GET', `/dashboard/construction/${opportunityId}/tickets`);
}
