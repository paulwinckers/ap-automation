"""App configuration — reads from environment variables."""
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # Microsoft Graph (email intake)
    MS_TENANT_ID:        str = ""
    MS_CLIENT_ID:        str = ""
    MS_CLIENT_SECRET:    str = ""
    MS_AP_INBOX:         str = ""   # e.g. ap@darios.ca
    EMAIL_POLLING:       bool = False  # set True to enable email intake

    # Aspire
    ASPIRE_BASE_URL:     str = "https://cloud-api.youraspire.com"
    ASPIRE_TOKEN_URL:    str = ""
    ASPIRE_CLIENT_ID:    str = ""
    ASPIRE_CLIENT_SECRET: str = ""
    ASPIRE_SANDBOX:      bool = False

    # QBO
    QBO_CLIENT_ID:       str = ""
    QBO_CLIENT_SECRET:   str = ""
    QBO_REALM_ID:        str = ""
    QBO_REFRESH_TOKEN:   str = ""
    QBO_SANDBOX:         bool = False

    # Anthropic
    ANTHROPIC_API_KEY:   str = ""

    # Cloudflare
    CLOUDFLARE_ACCOUNT_ID: str = ""
    D1_DATABASE_ID:      str = ""
    R2_BUCKET_NAME:      str = "ap-invoices"
    CF_ACCESS_TEAM_DOMAIN: str = ""

    # Microsoft Graph (email intake)
    MS_CLIENT_ID:        str = ""
    MS_TENANT_ID:        str = ""
    MS_CLIENT_SECRET:    str = ""
    MS_AP_INBOX:         str = ""   # e.g. ap@darios.ca

    # App
    DEBUG:               bool = False
    LOG_LEVEL:           str = "INFO"

    class Config:
        env_file = ".env"

settings = Settings()
