"""
Auth API — simple email/password login with JWT tokens.

POST /auth/login        — email + password → token
GET  /auth/me           — validate token, return current user
POST /auth/setup        — create first admin (only if no users exist)
GET  /auth/users        — list all users (admin only)
POST /auth/users        — create a user (admin only)
PUT  /auth/users/{id}   — update user name/role/active (admin only)
POST /auth/users/{id}/reset-password  — set new password (admin only)
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel

from app.core.config import settings
from app.core.database import Database

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)

ALGORITHM = "HS256"

# ── Shared DB instance ────────────────────────────────────────────────────────
_db = Database()

async def get_db() -> Database:
    if _db._db is None:
        await _db.connect()
    return _db


# ── Token helpers ─────────────────────────────────────────────────────────────

def _make_token(user_id: int, email: str, role: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=settings.TOKEN_EXPIRE_HOURS)
    return jwt.encode(
        {"sub": str(user_id), "email": email, "role": role, "exp": expire},
        settings.SECRET_KEY,
        algorithm=ALGORITHM,
    )


async def _get_current_user(
    token: Optional[str] = Depends(oauth2_scheme),
    db: Database = Depends(get_db),
) -> dict:
    """Dependency — validates JWT and returns the user row."""
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    rows = await db._q("SELECT * FROM users WHERE id = ? AND active = 1", [user_id])
    if not rows:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return rows[0]


async def _require_admin(user: dict = Depends(_get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


# ── Pydantic models ───────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    email:    str
    name:     str
    password: str
    role:     str = "staff"

class UserUpdate(BaseModel):
    name:   Optional[str] = None
    role:   Optional[str] = None
    active: Optional[bool] = None

class PasswordReset(BaseModel):
    password: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/login")
async def login(
    form: OAuth2PasswordRequestForm = Depends(),
    db: Database = Depends(get_db),
):
    """Email + password → JWT access token."""
    rows = await db._q(
        "SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND active = 1",
        [form.username],
    )
    if not rows or not pwd_ctx.verify(form.password, rows[0]["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")

    user = rows[0]
    await db._x(
        "UPDATE users SET last_login = ? WHERE id = ?",
        [datetime.now(timezone.utc).isoformat(), user["id"]],
    )
    token = _make_token(user["id"], user["email"], user["role"])
    logger.info(f"Login: {user['email']} (role={user['role']})")
    return {
        "access_token": token,
        "token_type":   "bearer",
        "name":         user["name"],
        "email":        user["email"],
        "role":         user["role"],
    }


@router.get("/me")
async def me(user: dict = Depends(_get_current_user)):
    """Return current user info (validates token)."""
    return {
        "id":    user["id"],
        "email": user["email"],
        "name":  user["name"],
        "role":  user["role"],
    }


@router.post("/setup")
async def setup_first_admin(body: UserCreate, db: Database = Depends(get_db)):
    """
    Create the first admin user. Only works when no users exist yet.
    Call this once after deployment to bootstrap the account.
    """
    existing = await db._q("SELECT id FROM users LIMIT 1")
    if existing:
        raise HTTPException(status_code=403, detail="Setup already complete — use admin panel to add users")

    pw_hash = pwd_ctx.hash(body.password)
    uid = await db._x(
        "INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)",
        [body.email.lower(), body.name, pw_hash, "admin"],
    )
    token = _make_token(uid, body.email.lower(), "admin")
    logger.info(f"First admin created: {body.email}")
    return {"access_token": token, "token_type": "bearer", "name": body.name, "role": "admin"}


@router.get("/users")
async def list_users(
    _: dict = Depends(_require_admin),
    db: Database = Depends(get_db),
):
    """List all users (admin only)."""
    rows = await db._q("SELECT id, email, name, role, active, created_at, last_login FROM users ORDER BY name")
    return {"users": rows}


@router.post("/users")
async def create_user(
    body: UserCreate,
    _: dict = Depends(_require_admin),
    db: Database = Depends(get_db),
):
    """Create a new user (admin only)."""
    existing = await db._q("SELECT id FROM users WHERE LOWER(email) = LOWER(?)", [body.email])
    if existing:
        raise HTTPException(status_code=409, detail="Email already exists")

    if body.role not in ("admin", "staff"):
        raise HTTPException(status_code=400, detail="Role must be admin or staff")

    pw_hash = pwd_ctx.hash(body.password)
    uid = await db._x(
        "INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)",
        [body.email.lower(), body.name, pw_hash, body.role],
    )
    logger.info(f"User created: {body.email} (role={body.role})")
    return {"id": uid, "email": body.email, "name": body.name, "role": body.role}


@router.put("/users/{user_id}")
async def update_user(
    user_id: int,
    body: UserUpdate,
    _: dict = Depends(_require_admin),
    db: Database = Depends(get_db),
):
    """Update name, role, or active status (admin only)."""
    rows = await db._q("SELECT * FROM users WHERE id = ?", [user_id])
    if not rows:
        raise HTTPException(status_code=404, detail="User not found")

    u = rows[0]
    new_name   = body.name   if body.name   is not None else u["name"]
    new_role   = body.role   if body.role   is not None else u["role"]
    new_active = int(body.active) if body.active is not None else u["active"]

    if new_role not in ("admin", "staff"):
        raise HTTPException(status_code=400, detail="Role must be admin or staff")

    await db._x(
        "UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?",
        [new_name, new_role, new_active, user_id],
    )
    return {"id": user_id, "name": new_name, "role": new_role, "active": bool(new_active)}


@router.post("/users/{user_id}/reset-password")
async def reset_password(
    user_id: int,
    body: PasswordReset,
    _: dict = Depends(_require_admin),
    db: Database = Depends(get_db),
):
    """Set a new password for any user (admin only)."""
    rows = await db._q("SELECT id FROM users WHERE id = ?", [user_id])
    if not rows:
        raise HTTPException(status_code=404, detail="User not found")

    pw_hash = pwd_ctx.hash(body.password)
    await db._x("UPDATE users SET password_hash = ? WHERE id = ?", [pw_hash, user_id])
    return {"reset": True}
