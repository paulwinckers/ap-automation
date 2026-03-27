# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AP Automation is an invoice routing system for landscaping operations. It ingests vendor invoices (PDF upload, email, or mobile photo), extracts structured data via Claude AI, and routes to either **Aspire** (job cost / PO-linked invoices) or **QuickBooks Online** (overhead invoices).

## Commands

### Backend (Python / FastAPI)
```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload          # Dev server on :8000
```

Docker (production-like):
```bash
docker build -t ap-automation-backend .
docker run -p 8000:8000 --env-file .env ap-automation-backend
```

### Frontend (React / Vite)
```bash
cd frontend
npm install
npm run dev      # Dev server on :5173
npm run build    # Output to dist/
npm run preview  # Serve built dist/
```

### Database (Cloudflare D1 via Wrangler)
```bash
cd infrastructure
npx wrangler d1 create ap-automation-db
npx wrangler d1 execute ap-automation-db --file=schema.sql
```

Local dev uses `backend/local.db` (SQLite file) — no D1 needed locally.

### Deployment
Push to `main` triggers GitHub Actions:
- `.github/workflows/deploy-backend.yml` — Docker build → Cloudflare Container Registry
- `.github/workflows/deploy-frontend.yml` — Vite build → Cloudflare Pages

There is no test suite yet.

## Architecture

### Invoice Lifecycle

```
Intake (email / HTTP upload / mobile photo)
  → Claude Extractor (extractor.py)      # Returns structured JSON from PDF/image
  → D1 Database (status = "pending")
  → Routing Engine (routing.py)
      ├─ job_cost vendor + PO → post to Aspire
      ├─ overhead vendor → post to QBO (with GL account)
      ├─ mixed vendor + PO → Aspire; no PO → QBO
      └─ unknown / missing data → Exception Queue (manual AP review)
```

### Routing Logic (`backend/app/services/routing.py`)
1. Look up `vendor_rules` by vendor name (with fuzzy fallback in `database.py`).
2. Resolve effective PO (rule override or extracted PO).
3. Validate PO snippet against Aspire if Aspire-bound.
4. Post automatically or push to exception queue with a typed reason (`unknown_vendor`, `missing_gl`, `mixed_no_po`, `po_validation_failed`).

### Key Services
| File | Purpose |
|---|---|
| `services/extractor.py` | Claude API call — extracts vendor, PO, amounts, tax lines (GST/HST/PST) from PDF/image |
| `services/routing.py` | Core decision engine |
| `services/aspire.py` | Aspire OAuth2 + OData v4 client |
| `services/qbo.py` | QuickBooks Online API client |
| `services/email_intake.py` | Microsoft Graph email polling (optional; `EMAIL_POLLING` env flag) |
| `services/storage.py` | Cloudflare R2 PDF storage |
| `core/database.py` | Async SQLite / D1 abstraction with fuzzy vendor match fallback |

### API Endpoints (`backend/app/api/`)
- `invoices.py` — upload, queue listing, review/override, retry posting
- `vendors.py` — vendor rule CRUD
- `vendor_import.py` — bulk import
- `validate_po_snippet.py` — lightweight PO lookup (used by mobile "Look up" button)
- `health.py` — health check

### Frontend (`frontend/src/`)
Currently a single-page app with one active route: `/field` → `FieldSubmit.tsx`.

`FieldSubmit.tsx` is a 5-step mobile wizard for field crews:
1. Capture/select receipt photo
2. Compress image (max 1600px) client-side
3. Quick-extract PO via `validate_po_snippet` endpoint (~3s, no DB write)
4. Fill in metadata (doc type, cost type, employee, notes)
5. Submit full invoice for processing

API client is in `lib/api.ts`; base URL is hardcoded to the Railway production backend URL.

### Database Schema (`infrastructure/schema.sql`)
Tables: `vendor_rules`, `invoices`, `invoice_line_items`, `audit_log`

`audit_log` is append-only — all routing decisions and manual overrides are recorded there.

## Environment Variables

Copy `backend/.env.example` to `backend/.env`. Key variables:

| Group | Variables |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| Aspire | `ASPIRE_BASE_URL`, `ASPIRE_TOKEN_URL`, `ASPIRE_CLIENT_ID`, `ASPIRE_CLIENT_SECRET`, `ASPIRE_SANDBOX` |
| QBO | `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REALM_ID`, `QBO_REFRESH_TOKEN`, `QBO_SANDBOX` |
| Cloudflare | `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `R2_BUCKET_NAME`, `CF_ACCESS_TEAM_DOMAIN` |
| Microsoft Graph | `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_AP_INBOX`, `EMAIL_POLLING` |

Cloudflare secrets are set via `npx wrangler secret put <KEY>` for production.

## Notable Details

- **Canadian tax**: Extractor explicitly separates GST, HST, and PST line items.
- **File size limit**: 20MB enforced via FastAPI middleware in `main.py`.
- **CORS**: Currently open (`*`) — intended for Cloudflare Access to handle auth externally.
- **Local SQLite vs D1**: `core/database.py` switches based on presence of a D1 binding; `local.db` is used in local dev automatically.
- **Fuzzy vendor matching**: `database.py` falls back to a fuzzy match when exact vendor name lookup fails.
- **No auth middleware in code**: Authentication is handled by Cloudflare Access at the edge.
