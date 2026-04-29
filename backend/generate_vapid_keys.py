"""
Generate VAPID key pair for web push notifications.

Run once:
    pip install pywebpush
    python generate_vapid_keys.py

Then add the two env vars to Railway.
"""
import base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


key = ec.generate_private_key(ec.SECP256R1(), default_backend())

# Raw private key — 32 bytes big-endian
priv_bytes = key.private_numbers().private_value.to_bytes(32, "big")

# Uncompressed public key — 0x04 || x || y  (65 bytes)
pub = key.public_key().public_numbers()
pub_bytes = bytes([0x04]) + pub.x.to_bytes(32, "big") + pub.y.to_bytes(32, "big")

print("Add these two variables to Railway > your service > Variables:\n")
print(f"VAPID_PRIVATE_KEY={b64url(priv_bytes)}")
print(f"VAPID_PUBLIC_KEY={b64url(pub_bytes)}")
print("\nKeep VAPID_PRIVATE_KEY secret. VAPID_PUBLIC_KEY is safe to expose.")
