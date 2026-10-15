"""Pure logic: storage, password hashing, phone codes (TOTP), schedules, lock decisions and the log.

Nothing in here touches the screen or Windows, so it can be tested anywhere.
"""
import base64
import datetime as dt
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import struct
import tempfile
import time

MAX_FAILS = 5
COOLDOWN_SECONDS = 60
LOG_LIMIT = 2000
THEMES = {
    "Gold": ("#14110a", "#f5c542"),
    "Ember": ("#170b08", "#ff7a45"),
    "Neon": ("#07101a", "#2ee6ff"),
    "Toxic": ("#08130a", "#7dff3a"),
    "Violet": ("#100a1a", "#b57cff"),
}


def default_dir():
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "ScreenLockPC")


def new_config():
    return {
        "password": None,        # {salt, hash, iter}
        "recovery": None,        # same shape, for the emergency code
        "totp": None,            # {secret, last_counter}
        "fails": 0,
        "cooldown_until": 0,
        "lock": {"active": False},
        "skip": {},              # schedule id -> window end timestamp that was unlocked early
        "schedules": [],
        "message": "This computer is locked.",
        "image": None,           # file name of the lock screen picture inside the config folder
        "theme": "Gold",
        "clock24": False,
        "log": [],
    }


class Store:
    def __init__(self, directory=None):
        self.dir = directory or default_dir()
        self.path = os.path.join(self.dir, "config.json")
        self.data = new_config()
        self.load()

    def load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            merged = new_config()
            merged.update(loaded)
            self.data = merged
        except (OSError, ValueError):
            self.data = new_config()

    def save(self):
        os.makedirs(self.dir, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.dir, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=1)
        os.replace(tmp, self.path)

    def log(self, kind, detail="", now=None):
        entries = self.data["log"]
        entries.append({"t": int(now if now is not None else time.time()), "kind": kind, "detail": detail})
        if len(entries) > LOG_LIMIT:
            del entries[: len(entries) - LOG_LIMIT]


# ---------- password ----------

def hash_secret(text, iterations=200_000):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", text.encode("utf-8"), salt, iterations)
    return {"salt": salt.hex(), "hash": digest.hex(), "iter": iterations}


def verify_secret(text, record):
    if not record:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", text.encode("utf-8"), bytes.fromhex(record["salt"]), record["iter"])
    return hmac.compare_digest(digest.hex(), record["hash"])


def make_recovery_code():
    raw = secrets.token_hex(6).upper()
    return "-".join(raw[i:i + 4] for i in range(0, 12, 4))


# ---------- phone codes (TOTP, RFC 6238) ----------

def new_totp_secret():
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _b32decode(secret):
    s = secret.replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def totp_code(secret, counter, digits=6):
    mac = hmac.new(_b32decode(secret), struct.pack(">Q", counter), hashlib.sha1).digest()
    off = mac[-1] & 0x0F
    num = struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF
    return str(num % 10 ** digits).zfill(digits)


def verify_totp(secret, code, now, last_counter=-1, step=30, window=1):
    """Return the matching counter, or None. A counter can only be used once (must beat last_counter)."""
    base = int(now // step)
    for c in range(base - window, base + window + 1):
        if c > last_counter and hmac.compare_digest(totp_code(secret, c), code):
            return c
    return None


def otpauth_uri(secret, account="This PC", issuer="Screen Lock"):
    from urllib.parse import quote
    return (f"otpauth://totp/{quote(issuer)}:{quote(account)}?secret={secret}"
            f"&issuer={quote(issuer)}&algorithm=SHA1&digits=6&period=30")


# ---------- unlocking ----------

def check_secret(store, text, now=None):
    """Try text as password, recovery code or phone code.

    Returns (result, seconds_left). result is one of: password, recovery, code, wrong, cooldown.
    """
    now = time.time() if now is None else now
    d = store.data
    if now < d["cooldown_until"]:
        return "cooldown", math.ceil(d["cooldown_until"] - now)
    text = text.strip()
    result = None
    if text:
        if verify_secret(text, d["password"]):
            result = "password"
        elif verify_secret(text.upper(), d["recovery"]):
            result = "recovery"
        elif d["totp"] and re.fullmatch(r"\d{6}", text.replace(" ", "")):
            counter = verify_totp(d["totp"]["secret"], text.replace(" ", ""), now, d["totp"]["last_counter"])
            if counter is not None:
                d["totp"]["last_counter"] = counter
                result = "code"
    if result:
        d["fails"] = 0
        store.save()
        return result, 0
    d["fails"] += 1
    store.log("wrong_try", "", now)
    if d["fails"] >= MAX_FAILS:
        d["fails"] = 0
        d["cooldown_until"] = now + COOLDOWN_SECONDS
        store.log("cooldown", f"{COOLDOWN_SECONDS}s", now)
        store.save()
        return "cooldown", COOLDOWN_SECONDS
    store.save()
    return "wrong", 0


# ---------- schedules ----------

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _parse_hm(text):
    h, m = text.split(":")
    return dt.time(int(h), int(m))


def valid_schedule(s):
    try:
        return s["days"] and _parse_hm(s["start"]) != _parse_hm(s["end"])
    except (KeyError, ValueError):
        return False


def find_window(schedules, now_dt):
    """Return (schedule, end_datetime) for the first enabled schedule active at now_dt, else None.

    A window that crosses midnight belongs to the day it starts on.
    """
    for s in schedules:
        if not s.get("enabled", True) or not valid_schedule(s):
            continue
        start_t, end_t = _parse_hm(s["start"]), _parse_hm(s["end"])
        overnight = end_t < start_t
        for back in (0, 1):
            day = (now_dt - dt.timedelta(days=back)).date()
            if day.weekday() not in s["days"]:
                continue
            start = dt.datetime.combine(day, start_t)
            end = dt.datetime.combine(day + dt.timedelta(days=1 if overnight else 0), end_t)
            if start <= now_dt < end:
                return s, end
    return None


def desired_lock(store, now=None):
    """What should the screen be doing right now? Returns a dict or None."""
    now = time.time() if now is None else now
    d = store.data
    lk = d["lock"]
    if lk.get("active"):
        until = lk.get("until")
        if until is None or now < until:
            return {"kind": "manual", "until": until, "start": lk.get("start"),
                    "message": lk.get("message") or d["message"]}
        d["lock"] = {"active": False}
        store.log("timer_end", "", now)
        store.save()
    d["skip"] = {k: v for k, v in d["skip"].items() if v > now}
    w = find_window(d["schedules"], dt.datetime.fromtimestamp(now))
    if w:
        s, end = w
        end_ts = end.timestamp()
        if d["skip"].get(s["id"]) != end_ts:
            return {"kind": "schedule", "until": end_ts, "schedule_id": s["id"],
                    "name": s.get("name", "Schedule"), "message": d["message"]}
    return None


def start_manual_lock(store, minutes=None, message=None, now=None):
    now = time.time() if now is None else now
    until = None if not minutes else now + minutes * 60
    store.data["lock"] = {"active": True, "until": until, "start": now, "message": message or ""}
    store.log("lock", "until unlocked" if until is None else f"{minutes} min", now)
    store.save()


def finish_unlock(store, lock, how, now=None):
    """Record a successful unlock. Early unlock of a schedule skips that window only."""
    now = time.time() if now is None else now
    if lock["kind"] == "schedule":
        store.data["skip"][lock["schedule_id"]] = lock["until"]
    else:
        store.data["lock"] = {"active": False}
    store.log("unlock", how, now)
    store.save()


def new_id():
    return secrets.token_hex(4)


def format_remaining(seconds):
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"
