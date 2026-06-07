# AP Automation — Aspire + QBO Invoice Routing

Automated accounts payable routing for landscaping operations.
Receives vendor invoices, extracts data with Claude AI, routes
job cost bills to Aspire and overhead bills to QBO.

## Architecture

- **Frontend**: React (Cloudflare Pages) — exception queue UI
- **Backend**: Python FastAPI (Cloudflare Container) — routing engine
- **Database**: Cloudflare D1 (SQLite) — vendor rules, queue, audit log
- **Storage**: Cloudflare R2 — PDF invoice files
- **Auth**: Cloudflare Access — GitHub OAuth or email OTP
- **AI**: Claude API — invoice data extraction
- **Targets**: Aspire API (job cost), QBO API (overhead)

## Project Structure

```
ap-automation/
├── backend/                  # Python FastAPI app
│   ├── app/
│   │   ├── api/              # Route handlers
│   │   │   ├── invoices.py   # Invoice intake + queue endpoints
│   │   │   ├── vendors.py    # Vendor rules CRUD
│   │   │   └── health.py     # Health check
│   │   ├── core/
│   │   │   ├── config.py     # Settings (env vars)
│   │   │   ├── database.py   # D1 connection
│   │   │   └── auth.py       # Cloudflare Access JWT validation
│   │   ├── services/
│   │   │   ├── routing.py    # Core routing engine
│   │   │   ├── extractor.py  # Claude invoice extraction
│   │   │   ├── aspire.py     # Aspire API client
│   │   │   ├── qbo.py        # QuickBooks Online client
│   │   │   └── storage.py    # R2 PDF storage
│   │   └── models/
│   │       ├── invoice.py    # Invoice data models
│   │       └── vendor.py     # Vendor rule models
│   ├── tests/
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/                 # React app
│   ├── src/
│   │   ├── components/       # Shared UI components
│   │   ├── pages/
│   │   │   ├── Queue.tsx     # Exception queue
│   │   │   ├── Review.tsx    # Invoice review + PO override
│   │   │   └── Vendors.tsx   # Vendor rules table
│   │   ├── hooks/            # API hooks
│   │   └── lib/              # API client, utils
│   └── public/
├── infrastructure/
│   ├── wrangler.toml         # Cloudflare config
│   └── schema.sql            # D1 database schema
└── .github/
    └── workflows/
        ├── deploy-backend.yml
        └── deploy-frontend.yml
```

## Quick Start

### Prerequisites
- Cloudflare account (free tier)
- GitHub account
- Aspire API access (contact AspireCare to enable)
- QBO developer app credentials
- Anthropic API key

### 1. Clone and configure
```bash
git clone https://github.com/YOUR_ORG/ap-automation
cd ap-automation
cp backend/.env.example backend/.env
# Fill in your API keys in backend/.env
```

### 2. Set up Cloudflare D1 database
```bash
cd infrastructure
npx wrangler d1 create ap-automation-db
npx wrangler d1 execute ap-automation-db --file=schema.sql
```

### 3. Run backend locally
```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### 4. Run frontend locally
```bash
cd frontend
npm install
npm run dev
```

### 5. Deploy

**Frontend (Cloudflare Pages) — manual via Wrangler.** Pushing to `main` does *not*
deploy; the GitHub Actions workflows were removed in April 2026. To ship the frontend:

```bash
cd frontend
npm run build                                                      # tsc && vite build → frontend/dist
npx wrangler@latest pages deploy frontend/dist --project-name=darios-ap
```

Requires Cloudflare auth (`wrangler login`, or a `CLOUDFLARE_API_TOKEN` in the environment).

**Backend:** deployed separately (Docker image; production API at the Railway URL hard-coded
in `frontend/src/lib/api.ts`). Confirm the exact backend deploy trigger before relying on it.

## Environment Variables

| Variable | Description |
|---|---|
| `ASPIRE_BASE_URL` | `https://cloud-api.youraspire.com` |
| `ASPIRE_CLIENT_ID` | From AspireCare |
| `ASPIRE_CLIENT_SECRET` | From AspireCare |
| `QBO_CLIENT_ID` | Intuit developer portal |
| `QBO_CLIENT_SECRET` | Intuit developer portal |
| `QBO_REALM_ID` | Your QBO company ID |
| `ANTHROPIC_API_KEY` | From console.anthropic.com |
| `CLOUDFLARE_ACCOUNT_ID` | From Cloudflare dashboard |
| `D1_DATABASE_ID` | Created in step 2 |
| `R2_BUCKET_NAME` | `ap-invoices` |
| `CF_ACCESS_TEAM_DOMAIN` | Your Cloudflare Access domain |
