"""
OAuth for the hosted Darios CX connector (Claude Team custom connector).

Claude signs each person in with their EXISTING Darios portal login (email + password,
checked by the backend's POST /auth/login). The signed-in email becomes the token's
subject, and every tool call forwards it as X-Act-As-User — so "my worklist / my tasks"
resolve to the real rep, and deactivating a user in the portal cuts their Claude access.

Everything is STATELESS (signed with MCP_SIGNING_KEY): registered clients, auth codes,
access + refresh tokens are all self-verifying, so nothing is lost when Railway redeploys
and there is no database here. Rotating MCP_SIGNING_KEY signs everyone out.
"""
import base64
import hashlib
import hmac
import html
import json
import secrets
import time
import zlib
from urllib.parse import urlparse

import httpx
import jwt
from pydantic import AnyUrl
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

SCOPE = "darios"
ACCESS_TTL = 60 * 60              # 1 hour
REFRESH_TTL = 60 * 60 * 24 * 30   # 30 days — re-login monthly
CODE_TTL = 5 * 60
LOGIN_TTL = 15 * 60

# Only Claude's own callbacks (and localhost, for Claude Code / MCP Inspector) may receive
# auth codes — stops a phishing link from harvesting a rep's login to some other site.
_ALLOWED_REDIRECT_HOSTS = {"claude.ai", "claude.com", "localhost", "127.0.0.1"}


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class DariosOAuthProvider:
    def __init__(self, signing_key: str, api: str, public_url: str):
        if len(signing_key) < 32:
            raise ValueError("MCP_SIGNING_KEY must be at least 32 characters")
        self.key = signing_key.encode()
        self.api = api
        self.public_url = public_url.rstrip("/")
        self._used_codes: dict[str, float] = {}   # single instance → in-memory replay guard

    # ── signing helpers ──────────────────────────────────────────────────────────
    def _sign(self, claims: dict, ttl: int) -> str:
        now = int(time.time())
        return jwt.encode({**claims, "iat": now, "exp": now + ttl}, self.key, algorithm="HS256")

    def _verify(self, token: str, typ: str) -> dict | None:
        try:
            claims = jwt.decode(token, self.key, algorithms=["HS256"])
        except jwt.PyJWTError:
            return None
        return claims if claims.get("typ") == typ else None

    def _client_secret(self, client_id: str) -> str:
        return hmac.new(self.key, b"secret:" + client_id.encode(), hashlib.sha256).hexdigest()

    # ── clients (dynamic registration, stateless) ────────────────────────────────
    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        for uri in client_info.redirect_uris or []:
            host = (urlparse(str(uri)).hostname or "").lower()
            if host not in _ALLOWED_REDIRECT_HOSTS and not host.endswith((".claude.ai", ".claude.com")):
                raise RegistrationError("invalid_redirect_uri", f"Redirect host not allowed: {host}")
        if not client_info.scope:
            client_info.scope = SCOPE
        # The client_id IS the signed, compressed client metadata (minus the secret), so
        # get_client can rebuild it after a redeploy. The secret is derived from the id.
        meta = client_info.model_dump(mode="json", exclude={"client_id", "client_secret",
                                                            "client_secret_expires_at"})
        payload = _b64(zlib.compress(json.dumps(meta, separators=(",", ":")).encode()))
        sig = _b64(hmac.new(self.key, payload.encode(), hashlib.sha256).digest()[:16])
        client_info.client_id = f"dc.{payload}.{sig}"
        client_info.client_secret_expires_at = None
        if client_info.client_secret is not None:
            client_info.client_secret = self._client_secret(client_info.client_id)

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        try:
            _, payload, sig = client_id.split(".")
            good = _b64(hmac.new(self.key, payload.encode(), hashlib.sha256).digest()[:16])
            if not hmac.compare_digest(sig, good):
                return None
            meta = json.loads(zlib.decompress(_unb64(payload)))
        except Exception:
            return None
        secret = (self._client_secret(client_id)
                  if meta.get("token_endpoint_auth_method") != "none" else None)
        return OAuthClientInformationFull(**meta, client_id=client_id, client_secret=secret)

    # ── authorize → our login page ───────────────────────────────────────────────
    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        req = self._sign({
            "typ": "login", "client_id": client.client_id,
            "client_name": client.client_name or "Claude",
            "redirect_uri": str(params.redirect_uri),
            "explicit": params.redirect_uri_provided_explicitly,
            "state": params.state, "scopes": params.scopes or [SCOPE],
            "challenge": params.code_challenge, "resource": params.resource,
        }, LOGIN_TTL)
        return f"{self.public_url}/login?req={req}"

    async def login_page(self, request: Request) -> Response:
        """GET shows the Darios sign-in form; POST checks it against the portal."""
        if request.method == "GET":
            req = request.query_params.get("req", "")
            login = self._verify(req, "login")
            if not login:
                return HTMLResponse(_page("This sign-in link has expired. Go back to Claude and "
                                          "try connecting again."), status_code=400)
            return HTMLResponse(_page(form=True, req=req, client=login["client_name"]))

        form = await request.form()
        req = str(form.get("req", ""))
        login = self._verify(req, "login")
        if not login:
            return HTMLResponse(_page("This sign-in link has expired. Go back to Claude and "
                                      "try connecting again."), status_code=400)
        email = str(form.get("email", "")).strip()
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.post(f"{self.api}/auth/login",
                                 data={"username": email, "password": str(form.get("password", ""))})
        except httpx.HTTPError:
            return HTMLResponse(_page(form=True, req=req, client=login["client_name"], email=email,
                                      error="Couldn't reach the Darios portal. Try again in a minute."))
        if r.status_code != 200:
            return HTMLResponse(_page(form=True, req=req, client=login["client_name"], email=email,
                                      error="Invalid email or password."), status_code=401)

        code = self._sign({
            "typ": "code", "jti": secrets.token_urlsafe(24), "sub": r.json()["email"],
            **{k: login[k] for k in ("client_id", "redirect_uri", "explicit", "scopes",
                                     "challenge", "resource")},
        }, CODE_TTL)
        return RedirectResponse(construct_redirect_uri(login["redirect_uri"], code=code,
                                                       state=login["state"]), status_code=302)

    # ── codes + tokens ───────────────────────────────────────────────────────────
    async def load_authorization_code(self, client: OAuthClientInformationFull, authorization_code: str):
        c = self._verify(authorization_code, "code")
        if not c or c["client_id"] != client.client_id or c["jti"] in self._used_codes:
            return None
        return AuthorizationCode(
            code=authorization_code, scopes=c["scopes"], expires_at=c["exp"],
            client_id=c["client_id"], code_challenge=c["challenge"],
            redirect_uri=AnyUrl(c["redirect_uri"]), redirect_uri_provided_explicitly=c["explicit"],
            resource=c.get("resource"), subject=c["sub"],
        )

    async def exchange_authorization_code(self, client, authorization_code: AuthorizationCode) -> OAuthToken:
        now = time.time()
        self._used_codes = {j: t for j, t in self._used_codes.items() if t > now}
        jti = jwt.decode(authorization_code.code, options={"verify_signature": False})["jti"]
        self._used_codes[jti] = now + CODE_TTL
        return self._issue(client.client_id, authorization_code.subject,
                           authorization_code.scopes, authorization_code.resource)

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str):
        c = self._verify(refresh_token, "refresh")
        if not c or c["client_id"] != client.client_id:
            return None
        return RefreshToken(token=refresh_token, client_id=c["client_id"], scopes=c["scopes"],
                            expires_at=c["exp"], resource=c.get("resource"), subject=c["sub"])

    async def exchange_refresh_token(self, client, refresh_token: RefreshToken, scopes: list[str]) -> OAuthToken:
        return self._issue(client.client_id, refresh_token.subject,
                           scopes or refresh_token.scopes, refresh_token.resource)

    async def load_access_token(self, token: str) -> AccessToken | None:
        c = self._verify(token, "access")
        if not c:
            return None
        return AccessToken(token=token, client_id=c["client_id"], scopes=c["scopes"],
                           expires_at=c["exp"], resource=c.get("resource"), subject=c["sub"])

    async def revoke_token(self, token) -> None:
        # Stateless tokens can't be revoked individually; access expires within the hour and
        # deactivating the user in the portal blocks them immediately (act-as rejects inactive).
        return None

    def _issue(self, client_id: str, subject: str | None, scopes: list[str], resource: str | None) -> OAuthToken:
        if not subject:
            raise TokenError("invalid_grant", "Token has no signed-in user")
        base = {"client_id": client_id, "sub": subject, "scopes": scopes, "resource": resource}
        return OAuthToken(
            access_token=self._sign({**base, "typ": "access"}, ACCESS_TTL),
            token_type="Bearer", expires_in=ACCESS_TTL, scope=" ".join(scopes),
            refresh_token=self._sign({**base, "typ": "refresh", "jti": secrets.token_urlsafe(8)}, REFRESH_TTL),
        )


def _page(message: str = "", *, form: bool = False, req: str = "", client: str = "Claude",
          email: str = "", error: str = "") -> str:
    e = html.escape
    body = f"<p>{e(message)}</p>"
    if form:
        body = f"""
  <p class="sub">{e(client)} wants to use your Darios portal account.</p>
  {f'<p class="err">{e(error)}</p>' if error else ''}
  <form method="post" action="/login">
    <input type="hidden" name="req" value="{e(req)}">
    <label>Email<input name="email" type="email" value="{e(email)}" autocomplete="username" required autofocus></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">Sign in</button>
  </form>
  <p class="fine">Use the same login as darios-ap.pages.dev. Claude will act as you.</p>"""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Darios</title>
<style>
 body{{font-family:system-ui,sans-serif;background:#f4f5f2;color:#1d2a1f;margin:0;display:grid;place-items:center;min-height:100vh}}
 main{{background:#fff;padding:28px;border-radius:12px;box-shadow:0 2px 12px #0001;width:min(360px,calc(100vw - 32px));box-sizing:border-box}}
 h1{{font-size:20px;margin:0 0 4px}} .sub{{color:#555;margin:0 0 16px}} .err{{color:#b00020}}
 label{{display:block;font-size:14px;margin:0 0 12px}} input{{display:block;width:100%;box-sizing:border-box;padding:10px;margin-top:4px;border:1px solid #ccc;border-radius:8px;font-size:16px}}
 button{{width:100%;padding:11px;border:0;border-radius:8px;background:#2f6b3a;color:#fff;font-size:16px;cursor:pointer}}
 .fine{{font-size:12px;color:#777;margin:14px 0 0}}
</style></head><body><main><h1>Sign in to Darios</h1>{body}</main></body></html>"""
