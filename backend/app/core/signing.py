"""Short-lived HMAC signatures for browser-navigation URLs that cannot carry a bearer token
(HTML report/email previews, OAuth kickoff). Generalises the pattern already used by
aspire_attachments._sign: a `scope` string binds the signature to the exact resource, so a
token minted for one customer/report can't open another. Secret = SECRET_KEY, which the app
refuses to start on its default — so an unsigned deploy can't mint valid tokens.

Usage:
    url = f"/customer/{cid}/email-preview?{signed_query(f'cust-email:{cid}:')}"   # mint
    if actor is None and not valid_signature(f'cust-email:{cid}:', exp, sig): 401  # verify
"""
import hashlib
import hmac
import time
from typing import Optional

from app.core.config import settings

_DEFAULT_TTL = 12 * 3600  # 12h — long enough for an emailed link, short enough to expire


def _secret() -> bytes:
    return (settings.SECRET_KEY or "dev-unsigned").encode()


def sign(scope: str, exp: int) -> str:
    return hmac.new(_secret(), f"{scope}:{exp}".encode(), hashlib.sha256).hexdigest()[:32]


def signed_query(scope: str, ttl: int = _DEFAULT_TTL) -> str:
    """`exp=…&sig=…` query string to append to a URL for `scope`."""
    exp = int(time.time()) + ttl
    return f"exp={exp}&sig={sign(scope, exp)}"


def valid_signature(scope: str, exp: Optional[int], sig: Optional[str]) -> bool:
    """True when `sig` is the unexpired signature for `scope`."""
    try:
        return bool(sig) and exp is not None and exp > time.time() and hmac.compare_digest(sig, sign(scope, exp))
    except Exception:
        return False
