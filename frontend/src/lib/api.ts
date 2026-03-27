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
): Promise<UploadResponse> {
  const form = new FormData();
  form.append('file', file);
  form.append('doc_type', docType);
  form.append('cost_type', costType);
  if (poNumber) form.append('po_number_hint', poNumber);
  if (employee) form.append('employee_name', employee);
  if (notes) form.append('notes', notes);
  return request<UploadResponse>('POST', '/invoices/upload', form, true);
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
  notes?: string;
  active: boolean;
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
