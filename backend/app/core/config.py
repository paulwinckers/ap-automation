"""App configuration — reads from environment variables."""
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # Microsoft Graph (email intake)
    MS_TENANT_ID:        str = ""
    MS_CLIENT_ID:        str = ""
    MS_CLIENT_SECRET:    str = ""
    MS_AP_INBOX:         str = ""   # e.g. ap@darios.ca
    EMAIL_POLLING:       bool = False  # set True to enable email intake
    EMAIL_PROCESS_SINCE: str = ""     # ISO date e.g. "2026-03-30" — ignore emails before this date

    # Aspire
    ASPIRE_BASE_URL:     str = "https://cloud-api.youraspire.com"
    ASPIRE_TOKEN_URL:    str = ""
    ASPIRE_CLIENT_ID:    str = ""
    ASPIRE_CLIENT_SECRET: str = ""
    ASPIRE_SANDBOX:           bool = False  # AP invoice posting (set True for sandbox testing)
    ASPIRE_DASHBOARD_SANDBOX: bool = False  # Dashboard reads — always False (production data)
    ASPIRE_BRANCH_ID:         int = 0    # Required — integer, find in Aspire Settings → Branches
    ASPIRE_CONSTRUCTION_BRANCH: str = "Construction"  # BranchName for construction division
    ASPIRE_DEFAULT_USER_ID:   int = 7    # Fallback UserID for Issues AssignedTo (Keeland = 7)
    ASPIRE_WEB_URL:           str = "https://cloud.youraspire.com/app"  # Aspire web app base URL
    ASPIRE_COMPANY_CODE:      str = ""   # e.g. DARIO1272 — included in ticket deep-links if set

    # QBO
    QBO_CLIENT_ID:       str = ""
    QBO_CLIENT_SECRET:   str = ""
    QBO_REALM_ID:        str = ""
    QBO_REFRESH_TOKEN:   str = ""
    QBO_SANDBOX:         bool = False
    MASTERCARD_GL:       str = "2240"   # QBO account code for MasterCard liability

    # Anthropic
    ANTHROPIC_API_KEY:   str = ""

    # Cloudflare
    CLOUDFLARE_ACCOUNT_ID: str = ""
    D1_DATABASE_ID:      str = ""
    R2_BUCKET_NAME:      str = "ap-invoices"
    R2_ACCESS_KEY_ID:    str = ""
    R2_SECRET_ACCESS_KEY: str = ""
    CF_ACCESS_TEAM_DOMAIN: str = ""
    CF_ACCOUNT_ID:       str = "cb7841b6dae457461972a8c2cca12896"
    CF_D1_DATABASE_ID:   str = "6e3fa1a4-aa7b-4233-bda8-4a35459b7712"
    CF_API_TOKEN:        str = ""  # set via Railway env var

    # Microsoft Graph (email intake)
    MS_CLIENT_ID:        str = ""
    MS_TENANT_ID:        str = ""
    MS_CLIENT_SECRET:    str = ""
    MS_AP_INBOX:         str = ""   # e.g. ap@darios.ca

    # Fallback forward-to email for job-cost invoices when vendor rule has none set
    AP_FORWARD_EMAIL:    str = ""   # e.g. keeland@darios.ca

    # Auth
    SECRET_KEY:          str = "change-me-in-production"  # set via Railway env var
    TOKEN_EXPIRE_HOURS:  int = 24

    # App
    DEBUG:               bool = False
    LOG_LEVEL:           str = "INFO"

    class Config:
        env_file = ".env"

settings = Settings()
