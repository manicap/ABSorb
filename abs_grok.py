#!/usr/bin/env python3
"""
ABS Grok - Local tool for comparing audio recording folders
Optimized for SMB shares, no database, read-only, fast matching.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, Request, HTTPException, Query
from starlette.requests import ClientDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import mimetypes
import struct
from rapidfuzz import fuzz, process
from rapidfuzz.distance import Levenshtein

# ---------------------------------------------------------------------------
# Paths & Config
# ---------------------------------------------------------------------------

APP_DIR = Path(__file__).resolve().parent
CONFIG_FILE = APP_DIR / "config.json"
CACHE_DIR = APP_DIR / "cache"
STATIC_DIR = APP_DIR / "static"

CACHE_DIR.mkdir(exist_ok=True)

DEFAULT_CONFIG = {
    "left_path": "",
    "right_path": "",  # legacy – migrated into libraries[]
    "last_used": None,
    "recent_left": [],
    "recent_right": [],
    "libraries": [],  # [{id, name, path, enabled}]
}

# ---------------------------------------------------------------------------
# Diacritics & Normalization
# ---------------------------------------------------------------------------

DIACRITICS_MAP = str.maketrans({
    "á": "a", "ä": "a", "č": "c", "ď": "d", "é": "e", "ě": "e", "í": "i",
    "ĺ": "l", "ľ": "l", "ň": "n", "ó": "o", "ô": "o", "ö": "o", "ř": "r",
    "š": "s", "ť": "t", "ú": "u", "ů": "u", "ü": "u", "ý": "y", "ž": "z",
    "Á": "A", "Ä": "A", "Č": "C", "Ď": "D", "É": "E", "Ě": "E", "Í": "I",
    "Ĺ": "L", "Ľ": "L", "Ň": "N", "Ó": "O", "Ô": "O", "Ö": "O", "Ř": "R",
    "Š": "S", "Ť": "T", "Ú": "U", "Ů": "U", "Ü": "U", "Ý": "Y", "Ž": "Z",
})

# Common junk patterns to strip
JUNK_PATTERNS = [
    re.compile(r"\b[0-9a-f]{8,}\b", re.I),                    # long hex hashes
    re.compile(r"\b[A-Za-z0-9+/]{20,}={0,2}\b"),              # base64-ish
    re.compile(r"[\(\[\{]\s*\d{4}\s*[\)\]\}]"),               # (2021)
    re.compile(r"\b(19|20)\d{2}\b"),                          # year
    re.compile(r"[\(\[\{]\s*(kopie|copy|final|master|remaster|hq|lq)\s*[\)\]\}]", re.I),
    re.compile(r"[\-–—_]\s*(kopie|copy|final|\d+)\s*$", re.I),
    re.compile(r"\s+[\-–—_]\s*$"),
    re.compile(r"^\s*[\-–—_]\s+"),
]

AUDIO_EXTENSIONS = {
    ".mp3", ".m4a", ".m4b", ".flac", ".ogg", ".opus", ".wav",
    ".aac", ".wma", ".aiff", ".alac", ".mp4"
}


def remove_diacritics(text: str) -> str:
    return text.translate(DIACRITICS_MAP)


def normalize_name(name: str) -> str:
    """Aggressive but careful normalization for matching."""
    if not name:
        return ""
    s = name.strip()
    s = remove_diacritics(s).lower()

    for pat in JUNK_PATTERNS:
        s = pat.sub(" ", s)

    # Unify separators
    s = re.sub(r"[\-–—_]+", " ", s)
    s = re.sub(r"[^\w\s]", " ", s)          # keep only alnum + space
    s = re.sub(r"\s+", " ", s).strip()
    return s


def extract_author_title(raw_name: str) -> Tuple[str, str, str]:
    """
    Try to split into (author, title, interpreter).
    Returns normalized versions.
    """
    name = raw_name.strip()
    author = ""
    title = name
    interpreter = ""

    # Extract trailing parentheses as possible interpreter / year
    paren_match = re.search(r"[\(\[\{]([^\)\]\}]+)[\)\]\}]\s*$", name)
    if paren_match:
        content = paren_match.group(1).strip()
        if not re.fullmatch(r"\d{4}", content):  # not just a year
            interpreter = content
        name = name[:paren_match.start()].strip()

    # Common patterns: "Author - Title" or "Title - Author"
    for sep in [" – ", " — ", " - ", " –", "— ", " -"]:
        if sep in name:
            left, right = [p.strip() for p in name.split(sep, 1)]
            if left and right:
                # Heuristic: if left contains comma → likely "Surname, Name"
                if "," in left or len(left.split()) <= 3:
                    author, title = left, right
                else:
                    # Could be swapped – we keep both possibilities later
                    author, title = left, right
            break

    # "Surname, Name - Title"
    if not author and "," in name:
        parts = name.split(",", 1)
        if len(parts) == 2:
            author = parts[0].strip() + ", " + parts[1].split(" - ")[0].strip()
            rest = parts[1]
            if " - " in rest:
                title = rest.split(" - ", 1)[1].strip()

    return (
        normalize_name(author),
        normalize_name(title),
        normalize_name(interpreter),
    )


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class Recording:
    id: str
    name: str                       # folder name
    path: str
    normalized: str
    author: str
    title: str
    interpreter: str
    audio_files: List[str] = field(default_factory=list)
    formats: List[str] = field(default_factory=list)
    total_size: int = 0
    mtime: float = 0.0
    has_cover: bool = False
    has_json: bool = False
    has_id3: bool = False
    has_m4a: bool = False
    from_json: bool = False
    year: str = ""
    genre: str = ""
    tags: str = ""
    subtitle: str = ""
    library_id: str = ""
    library_name: str = ""
    # Matching result (only for left side)
    status: str = "unknown"         # found | uncertain | not_found
    match_score: float = 0.0
    match_reason: str = ""
    matched_name: str = ""

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        # Human readable size
        d["size_human"] = human_size(self.total_size)
        return d


def human_size(num: int) -> str:
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if abs(num) < 1024.0:
            return f"{num:.1f} {unit}"
        num /= 1024.0
    return f"{num:.1f} PB"


# ---------------------------------------------------------------------------
# Scanner (read-only, one level)
# ---------------------------------------------------------------------------

def scan_folder(root: str, progress_cb=None, cancel_event: Optional[asyncio.Event] = None) -> List[Recording]:
    """
    Scan only immediate subfolders. Extremely light on SMB.
    """
    root_path = Path(root)
    if not root_path.is_dir():
        raise ValueError(f"Path is not a directory: {root}")

    recordings: List[Recording] = []
    entries = []

    try:
        with os.scandir(root) as it:
            for entry in it:
                if entry.is_dir(follow_symlinks=False):
                    entries.append(entry)
    except PermissionError as e:
        raise ValueError(f"Permission denied: {root}") from e
    except OSError as e:
        raise ValueError(f"Cannot read directory: {e}") from e

    total = len(entries)
    for idx, entry in enumerate(entries):
        if cancel_event and cancel_event.is_set():
            break

        try:
            audio_files = []
            formats = set()
            total_size = 0
            has_cover = False
            has_json = False
            has_id3 = False
            has_m4a = False
            mtime = entry.stat(follow_symlinks=False).st_mtime

            COVER_NAMES = {
                "cover.jpg", "cover.jpeg", "cover.png", "cover.webp",
                "folder.jpg", "folder.jpeg", "folder.png",
                "album.jpg", "album.png", "front.jpg", "front.png",
                "artwork.jpg", "artwork.png",
            }

            try:
                with os.scandir(entry.path) as inner:
                    for f in inner:
                        if not f.is_file(follow_symlinks=False):
                            continue
                        name_lower = f.name.lower()
                        ext = Path(f.name).suffix.lower()

                        if ext in AUDIO_EXTENSIONS:
                            audio_files.append(f.name)
                            formats.add(ext.lstrip("."))
                            try:
                                total_size += f.stat(follow_symlinks=False).st_size
                            except OSError:
                                pass
                        elif name_lower in COVER_NAMES or (
                            name_lower.startswith("cover") and ext in {".jpg", ".jpeg", ".png", ".webp"}
                        ):
                            has_cover = True
                        elif ext == ".json":
                            has_json = True
            except (PermissionError, OSError):
                pass

            # Lightweight tag presence checks
            if audio_files:
                for af in audio_files:
                    fpath = Path(entry.path) / af
                    ext = Path(af).suffix.lower()
                    try:
                        if ext in {".mp3", ".mp2"} and not has_id3:
                            with open(fpath, "rb") as fh:
                                if fh.read(3) == b"ID3":
                                    has_id3 = True
                        elif ext in {".m4a", ".m4b", ".mp4"} and not has_m4a:
                            has_m4a = True
                    except OSError:
                        pass

            author, title, interpreter = extract_author_title(entry.name)
            norm = normalize_name(entry.name)

            rec = Recording(
                id=str(uuid.uuid4()),
                name=entry.name,
                path=entry.path,
                normalized=norm,
                author=author,
                title=title or norm,
                interpreter=interpreter,
                audio_files=audio_files,
                formats=sorted(formats),
                total_size=total_size,
                mtime=mtime,
                has_cover=has_cover,
                has_json=has_json,
                has_id3=has_id3,
                has_m4a=has_m4a,
            )
            recordings.append(rec)
        except Exception:
            # Skip problematic folders silently
            continue

        if progress_cb and idx % 20 == 0:
            progress_cb(idx + 1, total)

    if progress_cb:
        progress_cb(total, total)

    return recordings


# ---------------------------------------------------------------------------
# Matching engine
# ---------------------------------------------------------------------------

def build_index(recordings: List[Recording]) -> Dict[str, Any]:
    """Build fast lookup structures from the right-side (Audioknihovna)."""
    exact = {}
    normalized = {}
    by_title = {}
    all_norms = []

    for r in recordings:
        exact[r.name] = r
        if r.normalized:
            normalized.setdefault(r.normalized, []).append(r)
            all_norms.append((r.normalized, r))
        if r.title:
            by_title.setdefault(r.title, []).append(r)

    return {
        "exact": exact,
        "normalized": normalized,
        "by_title": by_title,
        "all_norms": all_norms,
        "recordings": recordings,
    }


# Very common / generic titles that many different works share
GENERIC_TITLES = {
    "povidky", "povidka", "pohadky", "pohadka", "povesti", "povest",
    "pribehy", "pribeh", "novely", "novela", "basne", "basen",
    "vybor", "antologie", "sbirka", "rozhlasova hra", "hra",
    "cteni", "poslech", "audio", "audiokniha",
}


def _author_similarity(a: str, b: str) -> float:
    if not a or not b:
        return -1.0  # unknown
    return float(fuzz.token_set_ratio(a, b))


def _size_compatible(left: Recording, right: Recording) -> bool:
    """Reject obvious size mismatches (e.g. 8 MB vs 40 MB)."""
    ls, rs = left.total_size, right.total_size
    if ls <= 0 or rs <= 0:
        return True  # no info → don't penalize
    ratio = max(ls, rs) / max(min(ls, rs), 1)
    # Allow up to ~2.5× difference (different bitrate/format still OK)
    return ratio <= 2.5


def _is_generic_title(title: str) -> bool:
    if not title:
        return False
    t = title.strip().lower()
    if t in GENERIC_TITLES:
        return True
    # very short titles are also suspicious
    return len(t) <= 6


def _pick_best_candidate(
    left: Recording,
    candidates: List[Recording],
) -> Optional[Tuple[Recording, float, str]]:
    """
    Score candidates using name similarity + author + size.
    Returns (rec, score, reason) or None.
    """
    if not candidates:
        return None

    best = None
    best_score = -1.0
    best_reason = ""

    for rec in candidates:
        name_score = float(fuzz.token_set_ratio(left.normalized or left.name, rec.normalized or rec.name))
        title_score = 0.0
        if left.title and rec.title:
            title_score = float(fuzz.token_set_ratio(left.title, rec.title))

        author_sim = _author_similarity(left.author, rec.author)
        size_ok = _size_compatible(left, rec)
        generic = _is_generic_title(left.title) or _is_generic_title(rec.title)

        # Hard rejects
        if author_sim >= 0 and author_sim < 55 and (generic or title_score >= 85):
            # Same generic title, clearly different author → not a match
            continue
        if not size_ok and (generic or title_score >= 90):
            # Generic title + wildly different size → skip
            continue

        score = name_score
        reason_parts = [f"název {name_score:.0f}%"]

        # Author boost / penalty
        if author_sim >= 85:
            score = min(100.0, score + 8)
            reason_parts.append(f"autor {author_sim:.0f}%")
        elif author_sim >= 0 and author_sim < 55:
            score -= 25
            reason_parts.append(f"jiný autor ({author_sim:.0f}%)")

        # Size penalty
        if not size_ok:
            score -= 20
            reason_parts.append("různá velikost")

        # Generic title without solid author → heavy penalty
        if generic and author_sim < 70:
            score -= 30
            reason_parts.append("obecný titul")

        if score > best_score:
            best_score = score
            best = rec
            best_reason = ", ".join(reason_parts)

    if best is None or best_score < 50:
        return None
    return best, best_score, best_reason


def match_one(left: Recording, index: Dict[str, Any]) -> None:
    """Determine status for one left recording. Mutates left."""
    # 1. Exact folder name
    if left.name in index["exact"]:
        left.status = "found"
        left.match_score = 100.0
        left.match_reason = "Přesná shoda názvu složky"
        left.matched_name = left.name
        return

    # 2. Exact normalized (still verify author/size if we can)
    if left.normalized and left.normalized in index["normalized"]:
        cands = index["normalized"][left.normalized]
        picked = _pick_best_candidate(left, cands)
        if picked:
            rec, score, reason = picked
            if score >= 75:
                left.status = "found"
                left.match_score = max(score, 95.0)
                left.match_reason = f"Shoda po normalizaci ({reason})"
                left.matched_name = rec.name
                return
        # fallback: accept if single exact normalized and size ok
        rec = cands[0]
        if _size_compatible(left, rec) and _author_similarity(left.author, rec.author) != 0:
            asim = _author_similarity(left.author, rec.author)
            if asim < 0 or asim >= 55:
                left.status = "found"
                left.match_score = 99.0
                left.match_reason = "Shoda po normalizaci"
                left.matched_name = rec.name
                return

    # 3. Title exact – only if author compatible (critical for "Povídky" etc.)
    if left.title and left.title in index["by_title"]:
        cands = index["by_title"][left.title]
        picked = _pick_best_candidate(left, cands)
        if picked:
            rec, score, reason = picked
            if score >= 88:
                left.status = "found"
                left.match_score = score
                left.match_reason = f"Shoda titulu ({reason})"
                left.matched_name = rec.name
                return
            if score >= 70:
                left.status = "uncertain"
                left.match_score = score
                left.match_reason = f"Možná shoda titulu ({reason})"
                left.matched_name = rec.name
                return
        # no compatible candidate with this title
        # fall through to fuzzy

    # 4. Fuzzy on normalized name
    if not left.normalized or not index["all_norms"]:
        left.status = "not_found"
        left.match_score = 0.0
        left.match_reason = "Žádná podobnost"
        return

    choices = [n for n, _ in index["all_norms"]]
    results = process.extract(
        left.normalized,
        choices,
        scorer=fuzz.token_set_ratio,
        limit=8,
        score_cutoff=72,
    )

    if not results:
        left.status = "not_found"
        left.match_score = 0.0
        left.match_reason = "Žádná podobnost"
        return

    # Map scores back to recordings
    candidates: List[Recording] = []
    seen = set()
    for name, score, _idx in results:
        for n, r in index["all_norms"]:
            if n == name and r.id not in seen:
                candidates.append(r)
                seen.add(r.id)
                break

    picked = _pick_best_candidate(left, candidates)
    if not picked:
        left.status = "not_found"
        left.match_score = 0.0
        left.match_reason = "Žádná důvěryhodná shoda (autor/velikost)"
        left.matched_name = ""
        return

    rec, score, reason = picked

    if score >= 90:
        left.status = "found"
        left.match_score = float(score)
        left.match_reason = f"Vysoká podobnost ({reason})"
        left.matched_name = rec.name
    elif score >= 75:
        left.status = "uncertain"
        left.match_score = float(score)
        left.match_reason = f"Možná shoda ({reason}) – zkontroluj"
        left.matched_name = rec.name
    else:
        left.status = "not_found"
        left.match_score = float(score)
        left.match_reason = f"Nízká důvěra ({reason})"
        left.matched_name = ""


def match_all(left_list: List[Recording], right_list: List[Recording],
              progress_cb=None, cancel_event: Optional[asyncio.Event] = None) -> None:
    index = build_index(right_list)
    total = len(left_list)
    for i, rec in enumerate(left_list):
        if cancel_event and cancel_event.is_set():
            break
        match_one(rec, index)
        if progress_cb and i % 10 == 0:
            progress_cb(i + 1, total)
    if progress_cb:
        progress_cb(total, total)


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

def cache_key(path: str) -> str:
    import hashlib
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:16]


def load_cache(path: str) -> Optional[List[Dict]]:
    key = cache_key(path)
    cache_file = CACHE_DIR / f"{key}.json"
    if not cache_file.exists():
        return None
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        # Simple validity: check root mtime roughly
        root_mtime = Path(path).stat().st_mtime
        if abs(data.get("root_mtime", 0) - root_mtime) > 2.0:
            return None
        return data.get("items")
    except Exception:
        return None


def save_cache(path: str, items: List[Recording]) -> None:
    key = cache_key(path)
    cache_file = CACHE_DIR / f"{key}.json"
    try:
        root_mtime = Path(path).stat().st_mtime
        payload = {
            "root_mtime": root_mtime,
            "saved_at": time.time(),
            "items": [r.to_dict() for r in items],
        }
        cache_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def recordings_from_cache(items: List[Dict]) -> List[Recording]:
    result = []
    for d in items:
        r = Recording(
            id=d.get("id", str(uuid.uuid4())),
            name=d["name"],
            path=d["path"],
            normalized=d.get("normalized", ""),
            author=d.get("author", ""),
            title=d.get("title", ""),
            interpreter=d.get("interpreter", ""),
            audio_files=d.get("audio_files", []),
            formats=d.get("formats", []),
            total_size=d.get("total_size", 0),
            mtime=d.get("mtime", 0.0),
            has_cover=bool(d.get("has_cover", False)),
            has_json=bool(d.get("has_json", False)),
            has_id3=bool(d.get("has_id3", False)),
            has_m4a=bool(d.get("has_m4a", False)),
            from_json=bool(d.get("from_json", False)),
            year=d.get("year", "") or "",
            genre=d.get("genre", "") or "",
            tags=d.get("tags", "") or "",
            subtitle=d.get("subtitle", "") or "",
            library_id=d.get("library_id", "") or "",
            library_name=d.get("library_name", "") or "",
            status=d.get("status", "unknown"),
            match_score=d.get("match_score", 0.0),
            match_reason=d.get("match_reason", ""),
            matched_name=d.get("matched_name", ""),
        )
        result.append(r)
    return result


# ---------------------------------------------------------------------------
# App state
# ---------------------------------------------------------------------------

class AppState:
    def __init__(self):
        self.config = self.load_config()
        self.left: List[Recording] = []
        self.right: List[Recording] = []
        self.cancel_event = asyncio.Event()
        self.is_running = False
        self.progress = {"phase": "", "current": 0, "total": 0, "message": ""}

    def load_config(self) -> Dict:
        if CONFIG_FILE.exists():
            try:
                return {**DEFAULT_CONFIG, **json.loads(CONFIG_FILE.read_text(encoding="utf-8"))}
            except Exception:
                pass
        return DEFAULT_CONFIG.copy()

    def save_config(self) -> None:
        CONFIG_FILE.write_text(json.dumps(self.config, ensure_ascii=False, indent=2), encoding="utf-8")


state = AppState()

# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------

app = FastAPI(title="ABS Grok", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    html_path = STATIC_DIR / "index.html"
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


@app.get("/api/config")
async def get_config():
    return state.config


@app.post("/api/config")
async def set_config(data: Dict[str, Any]):
    def add_recent(key: str, path: str):
        if not path:
            return
        recent = state.config.get(key, [])
        recent = [p for p in recent if p != path]
        recent.insert(0, path)
        state.config[key] = recent[:12]

    if "left_path" in data:
        path = data["left_path"].strip()
        state.config["left_path"] = path
        add_recent("recent_left", path)
    if "right_path" in data:
        # legacy single path still accepted → ensure library entry
        path = data["right_path"].strip()
        state.config["right_path"] = path
        add_recent("recent_right", path)
        if path:
            libs = state.config.get("libraries") or []
            if not any(l.get("path") == path for l in libs):
                libs.append({
                    "id": str(uuid.uuid4()),
                    "name": Path(path).name or "Audioknihovna",
                    "path": path,
                    "enabled": True,
                })
                state.config["libraries"] = libs
    if "libraries" in data and isinstance(data["libraries"], list):
        norm = []
        for lib in data["libraries"]:
            if not isinstance(lib, dict) or not str(lib.get("path", "")).strip():
                continue
            path = str(lib["path"]).strip()
            norm.append({
                "id": str(lib.get("id") or uuid.uuid4()),
                "name": str(lib.get("name") or Path(path).name or "Knihovna").strip(),
                "path": path,
                "enabled": bool(lib.get("enabled", True)),
            })
            add_recent("recent_right", path)
        state.config["libraries"] = norm
        # keep right_path as first enabled (compat)
        enabled = [l for l in norm if l.get("enabled")]
        state.config["right_path"] = (enabled[0]["path"] if enabled else (norm[0]["path"] if norm else ""))
    state.config["last_used"] = time.time()
    state.save_config()
    return {"ok": True, "config": state.config}


@app.post("/api/clear-cache")
async def clear_cache():
    removed = 0
    for f in CACHE_DIR.glob("*.json"):
        try:
            f.unlink()
            removed += 1
        except Exception:
            pass
    return {"ok": True, "removed": removed}


@app.get("/api/cache-info")
async def cache_info():
    files = list(CACHE_DIR.glob("*.json"))
    return {"count": len(files), "exists": len(files) > 0}


@app.get("/api/status")
async def get_status():
    return {
        "is_running": state.is_running,
        "progress": state.progress,
        "left_count": len(state.left),
        "right_count": len(state.right),
    }


@app.post("/api/cancel")
async def cancel():
    state.cancel_event.set()
    return {"ok": True}


def _is_under_root(file_path: Path, roots: List[str]) -> bool:
    """True if file_path is root or inside any configured root (Windows/SMB safe)."""
    def norm(p: str) -> str:
        s = (p or "").replace("/", "\\")
        while "\\\\" in s:
            s = s.replace("\\\\", "\\")
        return s.rstrip("\\").lower()

    candidates = []
    try:
        candidates.append(norm(str(file_path.resolve())))
    except Exception:
        pass
    candidates.append(norm(str(file_path)))

    for root in roots:
        if not root:
            continue
        root_cands = []
        try:
            root_cands.append(norm(str(Path(root).resolve())))
        except Exception:
            pass
        root_cands.append(norm(root))
        for r in root_cands:
            if not r:
                continue
            for c in candidates:
                if not c:
                    continue
                if c == r or c.startswith(r + "\\") or c.startswith(r + "/"):
                    return True
    return False



def _tag_library(recs: List[Recording], lib_id: str, lib_name: str) -> List[Recording]:
    for r in recs:
        r.library_id = lib_id
        r.library_name = lib_name
    return recs


def _enabled_libraries() -> List[Dict[str, Any]]:
    return [l for l in (state.config.get("libraries") or []) if l.get("enabled") and l.get("path")]


def _all_libraries() -> List[Dict[str, Any]]:
    return [l for l in (state.config.get("libraries") or []) if l.get("path")]

def _allowed_roots() -> List[str]:
    roots = [state.config.get("left_path", "")]
    for lib in state.config.get("libraries") or []:
        if lib.get("path"):
            roots.append(lib["path"])
    if state.config.get("right_path"):
        roots.append(state.config["right_path"])
    return roots


def _media_type_for(path: Path) -> str:
    media_type, _ = mimetypes.guess_type(str(path))
    if media_type:
        return media_type
    return {
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".m4b": "audio/mp4",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
        ".opus": "audio/ogg",
        ".wav": "audio/wav",
        ".aac": "audio/aac",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".json": "application/json",
    }.get(path.suffix.lower(), "application/octet-stream")


def _parse_id3v2(file_path: Path) -> Dict[str, str]:
    """Minimal ID3v2 text-frame reader (no external deps)."""
    tags: Dict[str, str] = {}
    frame_names = {
        "TIT2": "Title",
        "TPE1": "Artist",
        "TPE2": "Album Artist",
        "TALB": "Album",
        "TDRC": "Year",
        "TYER": "Year",
        "TRCK": "Track",
        "TCON": "Genre",
        "COMM": "Comment",
        "TCOM": "Composer",
        "TPOS": "Disc",
        "TBPM": "BPM",
        "TLEN": "Length",
    }
    try:
        with open(file_path, "rb") as f:
            header = f.read(10)
            if len(header) < 10 or header[0:3] != b"ID3":
                return tags
            ver = header[3]
            # size is synchsafe int
            size = (
                (header[6] & 0x7F) << 21
                | (header[7] & 0x7F) << 14
                | (header[8] & 0x7F) << 7
                | (header[9] & 0x7F)
            )
            data = f.read(size)
    except OSError:
        return tags

    i = 0
    # skip extended header if present
    if len(header) >= 6 and (header[5] & 0x40):
        if len(data) >= 4:
            if ver >= 4:
                ext_size = (
                    (data[0] & 0x7F) << 21
                    | (data[1] & 0x7F) << 14
                    | (data[2] & 0x7F) << 7
                    | (data[3] & 0x7F)
                )
            else:
                ext_size = struct.unpack(">I", data[0:4])[0]
            i = ext_size

    while i + 10 <= len(data):
        frame_id = data[i : i + 4]
        if frame_id == b"\x00\x00\x00\x00" or not frame_id.isalnum():
            break
        if ver >= 4:
            frame_size = (
                (data[i + 4] & 0x7F) << 21
                | (data[i + 5] & 0x7F) << 14
                | (data[i + 6] & 0x7F) << 7
                | (data[i + 7] & 0x7F)
            )
        else:
            frame_size = struct.unpack(">I", data[i + 4 : i + 8])[0]
        if frame_size <= 0 or i + 10 + frame_size > len(data):
            break
        body = data[i + 10 : i + 10 + frame_size]
        fid = frame_id.decode("latin-1", errors="ignore")
        if fid in frame_names and len(body) >= 2:
            encoding = body[0]
            raw = body[1:]
            # strip language/descriptor for COMM
            if fid == "COMM" and len(raw) >= 3:
                raw = raw[3:]
                # skip short content description until null
                if encoding in (0, 3):
                    nul = raw.find(b"\x00")
                    if nul >= 0:
                        raw = raw[nul + 1 :]
                elif encoding in (1, 2):
                    nul = raw.find(b"\x00\x00")
                    if nul >= 0:
                        raw = raw[nul + 2 :]
            try:
                if encoding == 0:
                    text = raw.split(b"\x00")[0].decode("latin-1", errors="replace")
                elif encoding == 1:
                    text = raw.split(b"\x00\x00")[0].decode("utf-16", errors="replace")
                elif encoding == 2:
                    text = raw.split(b"\x00\x00")[0].decode("utf-16-be", errors="replace")
                else:
                    text = raw.split(b"\x00")[0].decode("utf-8", errors="replace")
                text = text.strip("\x00").strip()
                if text:
                    tags[frame_names[fid]] = text
            except Exception:
                pass
        i += 10 + frame_size

    return tags




def _parse_m4a_tags(file_path: Path) -> Dict[str, str]:
    """Walk MP4 atoms and extract iTunes/QuickTime text metadata."""
    tags: Dict[str, str] = {}
    key_map = {
        b"\xa9nam": "Title",
        b"\xa9ART": "Artist",
        b"\xa9alb": "Album",
        b"\xa9gen": "Genre",
        b"\xa9day": "Year",
        b"\xa9cmt": "Comment",
        b"\xa9wrt": "Composer",
        b"\xa9too": "Encoder",
        b"\xa9lyr": "Lyrics",
        b"\xa9nrt": "Narrator",
        b"aART": "Album Artist",
        b"trkn": "Track",
        b"disk": "Disc",
        b"desc": "Description",
        b"ldes": "Long Description",
        b"cprt": "Copyright",
        b"----": "Freeform",  # handled specially
    }

    try:
        # Read up to 8 MB – metadata is near the start or in moov
        with open(file_path, "rb") as f:
            data = f.read(8 * 1024 * 1024)
    except OSError:
        return tags

    def read_atom(buf: bytes, offset: int, end: int):
        results = []
        i = offset
        while i + 8 <= end:
            size = int.from_bytes(buf[i : i + 4], "big")
            typ = buf[i + 4 : i + 8]
            header = 8
            if size == 1 and i + 16 <= end:
                size = int.from_bytes(buf[i + 8 : i + 16], "big")
                header = 16
            if size == 0:
                size = end - i
            if size < header or i + size > end:
                break
            results.append((typ, i + header, i + size))
            i += size
        return results

    def extract_data_payload(buf: bytes, start: int, end: int) -> str:
        # Look for nested 'data' atom
        j = start
        while j + 16 <= end:
            size = int.from_bytes(buf[j : j + 4], "big")
            typ = buf[j + 4 : j + 8]
            if size < 16 or j + size > end:
                break
            if typ == b"data":
                # version/type(4) + locale(4) + payload
                payload = buf[j + 16 : j + size]
                # type 1 = UTF-8, 0 = binary
                dtype = int.from_bytes(buf[j + 8 : j + 12], "big")
                if dtype in (0,) and len(payload) >= 2 and typ != b"covr":
                    # might be integer track numbers
                    if len(payload) >= 8:
                        try:
                            return str(int.from_bytes(payload[2:4], "big"))
                        except Exception:
                            pass
                try:
                    text = payload.decode("utf-8", errors="replace").strip("\x00").strip()
                    if text:
                        return text[:800]
                except Exception:
                    pass
                return ""
            j += size
        # fallback: whole body as utf-8
        try:
            return buf[start:end].decode("utf-8", errors="replace").strip("\x00").strip()[:800]
        except Exception:
            return ""

    def walk(buf: bytes, offset: int, end: int, depth: int = 0):
        if depth > 12:
            return
        for typ, st, en in read_atom(buf, offset, end):
            if typ in {b"moov", b"udta", b"meta", b"ilst", b"trak", b"mdia", b"minf", b"stbl"}:
                # meta has 4-byte version/flags after header
                next_st = st + 4 if typ == b"meta" else st
                walk(buf, next_st, en, depth + 1)
            elif typ in key_map and key_map[typ] != "Freeform":
                label = key_map[typ]
                if label == "Cover":
                    continue
                val = extract_data_payload(buf, st, en)
                if val and label not in tags:
                    tags[label] = val
            elif typ == b"----":
                # freeform: mean + name + data
                mean = name = val = ""
                for styp, sst, sen in read_atom(buf, st, en):
                    payload = buf[sst:sen]
                    if styp == b"mean" and len(payload) > 4:
                        mean = payload[4:].decode("utf-8", errors="replace").strip("\x00")
                    elif styp == b"name" and len(payload) > 4:
                        name = payload[4:].decode("utf-8", errors="replace").strip("\x00")
                    elif styp == b"data" and len(payload) > 8:
                        try:
                            val = payload[8:].decode("utf-8", errors="replace").strip("\x00").strip()
                        except Exception:
                            val = ""
                if name and val and name not in tags:
                    tags[name] = val[:800]
            else:
                # still recurse into unknown containers that look large
                if en - st > 16 and depth < 6:
                    walk(buf, st, en, depth + 1)

    walk(data, 0, len(data))
    return tags


def _find_sidecar(folder: Path, kind: str) -> Optional[Path]:
    if not folder.is_dir():
        return None
    COVER_NAMES = {
        "cover.jpg", "cover.jpeg", "cover.png", "cover.webp",
        "folder.jpg", "folder.jpeg", "folder.png",
        "album.jpg", "album.png", "front.jpg", "front.png",
        "artwork.jpg", "artwork.png",
    }
    try:
        files = list(folder.iterdir())
    except OSError:
        return None

    if kind == "cover":
        for f in files:
            if f.is_file() and f.name.lower() in COVER_NAMES:
                return f
        for f in files:
            if f.is_file() and f.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
                if f.name.lower().startswith("cover"):
                    return f
        return None

    if kind == "json":
        # Prefer metadata.json, else first json
        preferred = None
        for f in files:
            if f.is_file() and f.suffix.lower() == ".json":
                if f.name.lower() == "metadata.json":
                    return f
                if preferred is None:
                    preferred = f
        return preferred

    if kind == "id3":
        for f in files:
            if f.is_file() and f.suffix.lower() in {".mp3", ".mp2"}:
                return f
        return None

    if kind == "m4a":
        for f in files:
            if f.is_file() and f.suffix.lower() in {".m4a", ".m4b", ".mp4"}:
                return f
        return None

    return None


@app.get("/api/audio")
async def stream_audio(request: Request, path: str = Query(..., min_length=1)):
    """
    Stream a local audio file with proper HTTP Range support (needed for seeking).
    """
    file_path = Path(path)
    if not file_path.is_file():
        raise HTTPException(404, "Soubor neexistuje")

    if not _is_under_root(file_path, _allowed_roots()):
        raise HTTPException(403, "Soubor není v povolených složkách")

    ext = file_path.suffix.lower()
    if ext not in AUDIO_EXTENSIONS:
        raise HTTPException(400, "Nepodporovaný formát")

    media_type = _media_type_for(file_path)
    file_size = file_path.stat().st_size
    range_header = request.headers.get("range") or request.headers.get("Range")

    def make_headers(content_length: int, extra: Optional[Dict] = None) -> Dict[str, str]:
        h = {
            "Content-Type": media_type,
            "Accept-Ranges": "bytes",
            "Content-Length": str(content_length),
            "Cache-Control": "no-cache",
        }
        if extra:
            h.update(extra)
        return h

    if range_header and range_header.startswith("bytes="):
        rng = range_header.replace("bytes=", "").strip()
        if "," in rng:
            # multiple ranges not supported – return full
            rng = rng.split(",")[0].strip()
        start_s, _, end_s = rng.partition("-")
        try:
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else file_size - 1
        except ValueError:
            start, end = 0, file_size - 1
        if end >= file_size:
            end = file_size - 1
        if start < 0 or start > end:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

        length = end - start + 1

        def iter_range():
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = length
                chunk = 64 * 1024
                while remaining > 0:
                    data = f.read(min(chunk, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(
            iter_range(),
            status_code=206,
            media_type=media_type,
            headers=make_headers(
                length,
                {
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                },
            ),
        )

    # Full file
    def iter_full():
        with open(file_path, "rb") as f:
            while True:
                data = f.read(64 * 1024)
                if not data:
                    break
                yield data

    return StreamingResponse(
        iter_full(),
        status_code=200,
        media_type=media_type,
        headers=make_headers(file_size),
    )


@app.get("/api/sidecar")
async def get_sidecar(
    folder: str = Query(..., min_length=1),
    kind: str = Query(..., pattern="^(id3|json|cover|m4a)$"),
):
    """
    Return sidecar preview for a recording folder.
    kind=id3 → parsed tags JSON
    kind=json → raw JSON text
    kind=cover → image file
    """
    folder_path = Path(folder)
    if not folder_path.is_dir():
        raise HTTPException(404, "Složka neexistuje")
    if not _is_under_root(folder_path, _allowed_roots()):
        raise HTTPException(403, "Složka není v povolených cestách")

    target = _find_sidecar(folder_path, kind)
    if not target or not target.is_file():
        raise HTTPException(404, f"Soubor typu {kind} nenalezen")

    if kind == "cover":
        return FileResponse(
            path=str(target),
            media_type=_media_type_for(target),
            filename=target.name,
        )

    if kind == "json":
        try:
            text = target.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            text = target.read_text(encoding="utf-8", errors="replace")
        # Try pretty-print
        try:
            parsed = json.loads(text)
            text = json.dumps(parsed, ensure_ascii=False, indent=2)
        except Exception:
            pass
        return JSONResponse({
            "filename": target.name,
            "content": text,
        })

    if kind == "m4a":
        tags = _parse_m4a_tags(target)
        return JSONResponse({
            "filename": target.name,
            "tags": tags,
            "has_tags": bool(tags),
        })

    # id3
    tags = _parse_id3v2(target)
    return JSONResponse({
        "filename": target.name,
        "tags": tags,
        "has_tags": bool(tags),
    })



@app.get("/api/scan")
async def scan_side(request: Request, side: str = Query("right", pattern="^(left|right)$")):
    """Scan left path or all (enabled) libraries for the right panel."""
    if state.is_running:
        raise HTTPException(400, "Jiná operace právě běží")

    state.is_running = True
    state.cancel_event = asyncio.Event()

    async def event_generator():
        def send(obj):
            return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

        try:
            loop = asyncio.get_event_loop()

            if side == "left":
                root = (state.config.get("left_path") or "").strip()
                if not root:
                    yield send({"type": "error", "message": "Cesta Nové nahrávky není nastavená"})
                    return
                if not Path(root).is_dir():
                    yield send({"type": "error", "message": f"Složka neexistuje: {root}"})
                    return

                state.progress = {"phase": "left", "current": 0, "total": 0, "message": "Skenuji Nové nahrávky…"}
                yield send({"type": "progress", **state.progress})

                cached = load_cache(root)
                if cached is not None:
                    state.left = recordings_from_cache(cached)
                    state.progress = {
                        "phase": "left", "current": len(state.left), "total": len(state.left),
                        "message": f"Načteno z keše: {len(state.left)} položek",
                    }
                    yield send({"type": "progress", **state.progress})
                else:
                    def cb(cur, tot):
                        state.progress = {
                            "phase": "left", "current": cur, "total": tot,
                            "message": f"Skenuji Nové nahrávky… {cur}/{tot}",
                        }
                    recs = await loop.run_in_executor(
                        None, lambda: scan_folder(root, progress_cb=cb, cancel_event=state.cancel_event)
                    )
                    if state.cancel_event.is_set():
                        yield send({"type": "cancelled"})
                        return
                    save_cache(root, recs)
                    state.left = recs
                    state.progress = {
                        "phase": "left", "current": len(recs), "total": len(recs),
                        "message": f"Nové nahrávky: {len(recs)} položek",
                    }
                    yield send({"type": "progress", **state.progress})
            else:
                # Right panel = all libraries (scan everything; UI filters by enabled)
                libs = _all_libraries()
                if not libs:
                    yield send({"type": "error", "message": "Nemáš přidanou žádnou knihovnu. Otevři Správu knihoven."})
                    return

                all_recs: List[Recording] = []
                for li, lib in enumerate(libs):
                    if state.cancel_event.is_set():
                        yield send({"type": "cancelled"})
                        return
                    root = lib["path"]
                    name = lib.get("name") or Path(root).name
                    if not Path(root).is_dir():
                        yield send({
                            "type": "progress", "phase": "right",
                            "current": li, "total": len(libs),
                            "message": f"Přeskočeno (neexistuje): {name}",
                        })
                        continue

                    state.progress = {
                        "phase": "right", "current": li, "total": len(libs),
                        "message": f"Skenuji knihovnu „{name}“ ({li+1}/{len(libs)})…",
                    }
                    yield send({"type": "progress", **state.progress})

                    cached = load_cache(root)
                    if cached is not None:
                        recs = _tag_library(recordings_from_cache(cached), lib["id"], name)
                    else:
                        def make_cb(lib_name, idx, total_libs):
                            def cb(cur, tot):
                                state.progress = {
                                    "phase": "right",
                                    "current": idx,
                                    "total": total_libs,
                                    "message": f"Skenuji „{lib_name}“… {cur}/{tot}",
                                }
                            return cb
                        recs = await loop.run_in_executor(
                            None,
                            lambda r=root, n=name, i=li, t=len(libs): scan_folder(
                                r, progress_cb=make_cb(n, i, t), cancel_event=state.cancel_event
                            ),
                        )
                        if state.cancel_event.is_set():
                            yield send({"type": "cancelled"})
                            return
                        save_cache(root, recs)
                        recs = _tag_library(recs, lib["id"], name)

                    all_recs.extend(recs)
                    yield send({
                        "type": "progress", "phase": "right",
                        "current": li + 1, "total": len(libs),
                        "message": f"„{name}“: {len(recs)} položek (celkem {len(all_recs)})",
                    })

                state.right = all_recs
                state.progress = {
                    "phase": "right", "current": len(libs), "total": len(libs),
                    "message": f"Audioknihovna: {len(all_recs)} položek v {len(libs)} knihovnách",
                }
                yield send({"type": "progress", **state.progress})

            yield send({
                "type": "done",
                "side": side,
                "left": [r.to_dict() for r in state.left] if side == "left" else None,
                "right": [r.to_dict() for r in state.right] if side == "right" else None,
                "stats": {
                    "left_total": len(state.left),
                    "right_total": len(state.right),
                    "found": sum(1 for r in state.left if r.status == "found"),
                    "uncertain": sum(1 for r in state.left if r.status == "uncertain"),
                    "not_found": sum(1 for r in state.left if r.status == "not_found"),
                },
                "libraries": state.config.get("libraries") or [],
            })
        except (ClientDisconnect, ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass
        except Exception as e:
            try:
                yield send({"type": "error", "message": str(e)})
            except Exception:
                pass
        finally:
            state.is_running = False
            state.progress = {"phase": "", "current": 0, "total": 0, "message": ""}

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.get("/api/compare")
async def compare_stream(request: Request):
    """SSE: scan left + enabled libraries, then match."""
    if state.is_running:
        raise HTTPException(400, "Porovnání již běží")

    left_path = (state.config.get("left_path") or "").strip()
    enabled_libs = _enabled_libraries()

    if not left_path:
        raise HTTPException(400, "Není nastavená cesta Nové nahrávky")
    if not enabled_libs:
        raise HTTPException(400, "Žádná aktivní knihovna. Zapni alespoň jednu v přepínačích vpravo.")
    if not Path(left_path).is_dir():
        raise HTTPException(400, f"Levá cesta neexistuje: {left_path}")

    for lib in enabled_libs:
        if not Path(lib["path"]).is_dir():
            raise HTTPException(400, f"Knihovna „{lib.get('name')}“ neexistuje: {lib['path']}")

    state.cancel_event = asyncio.Event()
    state.is_running = True
    state.left = []
    # keep full right in memory but match only enabled – re-filter after scan

    async def event_generator():
        def send(obj):
            return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

        try:
            loop = asyncio.get_event_loop()

            # --- RIGHT: all libraries (so browser stays complete), match uses enabled ---
            libs = _all_libraries()
            all_right: List[Recording] = []
            for li, lib in enumerate(libs):
                if state.cancel_event.is_set():
                    yield send({"type": "cancelled"})
                    return
                root = lib["path"]
                name = lib.get("name") or Path(root).name
                state.progress = {
                    "phase": "right", "current": li, "total": max(len(libs), 1),
                    "message": f"Skenuji knihovnu „{name}“…",
                }
                yield send({"type": "progress", **state.progress})

                if not Path(root).is_dir():
                    continue
                cached = load_cache(root)
                if cached is not None:
                    recs = _tag_library(recordings_from_cache(cached), lib["id"], name)
                else:
                    def make_cb(n, i, t):
                        def cb(cur, tot):
                            state.progress = {
                                "phase": "right", "current": i, "total": t,
                                "message": f"Skenuji „{n}“… {cur}/{tot}",
                            }
                        return cb
                    recs = await loop.run_in_executor(
                        None,
                        lambda r=root, n=name, i=li, t=len(libs): scan_folder(
                            r, progress_cb=make_cb(n, i, t), cancel_event=state.cancel_event
                        ),
                    )
                    if state.cancel_event.is_set():
                        yield send({"type": "cancelled"})
                        return
                    save_cache(root, recs)
                    recs = _tag_library(recs, lib["id"], name)
                all_right.extend(recs)

            state.right = all_right
            yield send({
                "type": "progress", "phase": "right",
                "current": len(libs), "total": len(libs),
                "message": f"Audioknihovna: {len(all_right)} položek",
            })

            # --- LEFT ---
            state.progress = {"phase": "left", "current": 0, "total": 0, "message": "Skenuji Nové nahrávky…"}
            yield send({"type": "progress", **state.progress})

            cached_left = load_cache(left_path)
            if cached_left is not None:
                state.left = recordings_from_cache(cached_left)
                yield send({
                    "type": "progress", "phase": "left",
                    "current": len(state.left), "total": len(state.left),
                    "message": f"Načteno z keše: {len(state.left)} (Nové nahrávky)",
                })
            else:
                def lcb(cur, tot):
                    state.progress = {
                        "phase": "left", "current": cur, "total": tot,
                        "message": f"Skenuji Nové nahrávky… {cur}/{tot}",
                    }
                left_recs = await loop.run_in_executor(
                    None, lambda: scan_folder(left_path, progress_cb=lcb, cancel_event=state.cancel_event)
                )
                if state.cancel_event.is_set():
                    yield send({"type": "cancelled"})
                    return
                save_cache(left_path, left_recs)
                state.left = left_recs
                yield send({
                    "type": "progress", "phase": "left",
                    "current": len(left_recs), "total": len(left_recs),
                    "message": f"Nové nahrávky: {len(left_recs)} položek",
                })

            # --- MATCH against enabled libraries only ---
            enabled_ids = {l["id"] for l in _enabled_libraries()}
            right_for_match = [r for r in state.right if r.library_id in enabled_ids]
            if not right_for_match:
                # fallback: all right
                right_for_match = state.right

            state.progress = {"phase": "match", "current": 0, "total": len(state.left), "message": "Porovnávám…"}
            yield send({"type": "progress", **state.progress})

            def mcb(cur, tot):
                state.progress = {
                    "phase": "match", "current": cur, "total": tot,
                    "message": f"Porovnávám… {cur}/{tot}",
                }

            await loop.run_in_executor(
                None, lambda: match_all(state.left, right_for_match, progress_cb=mcb, cancel_event=state.cancel_event)
            )

            if state.cancel_event.is_set():
                yield send({"type": "cancelled"})
                return

            yield send({
                "type": "done",
                "left": [r.to_dict() for r in state.left],
                "right": [r.to_dict() for r in state.right],
                "stats": {
                    "left_total": len(state.left),
                    "right_total": len(state.right),
                    "found": sum(1 for r in state.left if r.status == "found"),
                    "uncertain": sum(1 for r in state.left if r.status == "uncertain"),
                    "not_found": sum(1 for r in state.left if r.status == "not_found"),
                },
                "libraries": state.config.get("libraries") or [],
            })
        except (ClientDisconnect, ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass
        except Exception as e:
            try:
                yield send({"type": "error", "message": str(e)})
            except Exception:
                pass
        finally:
            state.is_running = False
            state.cancel_event.set()
            state.progress = {"phase": "", "current": 0, "total": 0, "message": ""}

    return StreamingResponse(event_generator(), media_type="text/event-stream")



def _extract_fields_from_json_obj(obj: Any) -> Dict[str, str]:
    """
    Audiobookshelf metadata.json:
      title, subtitle, authors[], narrators[], series[], genres[], tags[], publishedYear, description
    """
    if not isinstance(obj, dict):
        return {}

    candidates = [obj]
    for wrap in ("metadata", "meta", "book", "info", "data"):
        if isinstance(obj.get(wrap), dict):
            candidates.append(obj[wrap])

    def pick(*keys: str) -> str:
        lower_maps = [{k.lower(): k for k in c.keys()} for c in candidates]
        for key in keys:
            kl = key.lower()
            for c, lm in zip(candidates, lower_maps):
                if kl not in lm:
                    continue
                val = c[lm[kl]]
                if val is None or val is False:
                    continue
                if isinstance(val, list):
                    parts = []
                    for x in val:
                        if isinstance(x, dict):
                            name = x.get("name") or x.get("title") or x.get("series") or ""
                            if name:
                                parts.append(str(name).strip())
                        else:
                            s = str(x).strip()
                            if s:
                                parts.append(s)
                    if parts:
                        return ", ".join(parts)
                else:
                    s = str(val).strip()
                    if s and s.lower() not in {"null", "none"}:
                        return s
        return ""

    def strip_html(s: str) -> str:
        s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
        s = re.sub(r"<[^>]+>", "", s)
        return re.sub(r"\s+", " ", s).strip()

    title = pick("title", "name", "nazev", "název", "bookTitle")
    subtitle = pick("subtitle", "podtitul", "podnazev", "podnázev")
    author = pick("authors", "author", "autor", "autori", "autoři", "artist", "artists")
    narrator = pick("narrators", "narrator", "interpret", "interpreti", "reader", "readers")
    series = pick("series", "seriesName")
    genre = pick("genres", "genre")
    year_raw = pick("publishedYear", "year")
    year = ""
    if year_raw:
        m = re.search(r"\b((?:18|19|20)\d{2})\b", year_raw)
        if m:
            year = m.group(1)
    tags = pick("tags", "tag")
    description = pick("description", "desc", "summary", "anotace")

    out: Dict[str, str] = {}
    if title:
        out["title"] = title
    if subtitle:
        out["subtitle"] = subtitle
    if author:
        out["author"] = author
    if narrator:
        out["narrator"] = narrator
    if series:
        out["series"] = series
    if genre:
        out["genre"] = genre
    if year:
        out["year"] = year
    if tags:
        out["tags"] = tags
    if description:
        out["description"] = strip_html(description)[:500]
    return out


def enrich_folder_from_json(folder: str) -> Dict[str, Any]:
    """Read JSON sidecar in folder and return extracted display fields."""
    folder_path = Path(folder)
    result: Dict[str, Any] = {"path": folder, "ok": False, "from_json": False}
    try:
        if not folder_path.is_dir():
            result["error"] = "not_a_dir"
            return result
    except OSError as e:
        result["error"] = str(e)
        return result

    if not _is_under_root(folder_path, _allowed_roots()):
        fp = str(folder_path).replace("/", "\\").lower()
        allowed = False
        for root in _allowed_roots():
            if not root:
                continue
            r = root.replace("/", "\\").lower().rstrip("\\")
            if fp == r or fp.startswith(r + "\\"):
                allowed = True
                break
        if not allowed:
            result["error"] = "path_not_allowed"
            return result

    target = _find_sidecar(folder_path, "json")
    if not target:
        result["error"] = "no_json"
        return result
    try:
        raw = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raw = target.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        result["error"] = str(e)
        return result

    try:
        obj = json.loads(raw)
    except Exception:
        result["error"] = "invalid_json"
        return result

    fields = _extract_fields_from_json_obj(obj)
    result.update(fields)
    result["ok"] = True
    result["from_json"] = bool(fields)
    result["json_file"] = target.name
    return result


@app.post("/api/enrich")
async def enrich_json(data: Dict[str, Any]):
    """
    Batch-enrich folders from their JSON sidecars.
    Body: { "paths": ["...", "..."] }
    Returns list of {path, author, title, ...}
    Designed for progressive UI updates – keep batches small (20–50).
    """
    paths = data.get("paths") or []
    if not isinstance(paths, list):
        raise HTTPException(400, "paths must be a list")
    # hard limit per request
    paths = [p for p in paths if isinstance(p, str) and p.strip()][:80]

    loop = asyncio.get_event_loop()

    def work():
        return [enrich_folder_from_json(p) for p in paths]

    results = await loop.run_in_executor(None, work)

    # Also update in-memory right/left state if paths match
    by_path = {r.path: r for r in state.right}
    by_path.update({r.path: r for r in state.left})
    for item in results:
        rec = by_path.get(item.get("path"))
        if not rec or not item.get("ok"):
            continue
        if item.get("author"):
            rec.author = item["author"]
        if item.get("title"):
            rec.title = item["title"]
        if item.get("narrator"):
            rec.interpreter = item["narrator"]
        # stash extra display fields on the dict via dynamic attrs
        if item.get("year"):
            rec.year = item["year"]
        if item.get("genre"):
            rec.genre = item["genre"]
        if item.get("tags"):
            rec.tags = item["tags"]
        if item.get("subtitle"):
            rec.subtitle = item["subtitle"]
        rec.from_json = bool(item.get("from_json"))

    return {"items": results}


@app.get("/api/data")
async def get_data():
    """Return current data without re-scanning."""
    return {
        "left": [r.to_dict() for r in state.left],
        "right": [r.to_dict() for r in state.right],
        "stats": {
            "left_total": len(state.left),
            "right_total": len(state.right),
            "found": sum(1 for r in state.left if r.status == "found"),
            "uncertain": sum(1 for r in state.left if r.status == "uncertain"),
            "not_found": sum(1 for r in state.left if r.status == "not_found"),
        }
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    import sys
    import signal
    import asyncio
    import uvicorn

    print("=" * 60)
    print("  ABS Grok")
    print("  Otevři v prohlížeči:  http://127.0.0.1:8765")
    print("  Ukončení: Ctrl+C  (počkej 1–2 s na čisté ukončení)")
    print("=" * 60)

    # Windows ProactorEventLoop often raises ConnectionResetError (10054)
    # when the browser closes a connection (SSE/audio). Harmless but noisy
    # and can make Ctrl+C look "frozen". Swallow these callback errors.
    def _silence_win_disconnect(loop, context):
        exc = context.get("exception")
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        if isinstance(exc, OSError) and getattr(exc, "winerror", None) in (10054, 10053, 10038):
            return
        # default handler for everything else
        loop.default_exception_handler(context)

    try:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.set_exception_handler(_silence_win_disconnect)
    except Exception:
        pass

    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=8765,
        log_level="warning",
        access_log=False,
        timeout_graceful_shutdown=1,
    )
    server = uvicorn.Server(config)

    def _stop(*_args):
        server.should_exit = True
        server.force_exit = True

    signal.signal(signal.SIGINT, _stop)
    if hasattr(signal, "SIGTERM"):
        try:
            signal.signal(signal.SIGTERM, _stop)
        except Exception:
            pass

    try:
        server.run()
    except KeyboardInterrupt:
        pass
    except SystemExit:
        raise
    except Exception as e:
        # Last-resort: ignore disconnect noise during teardown
        if not isinstance(e, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            raise
    finally:
        print("\nABS Grok ukončen.")
        sys.exit(0)


if __name__ == "__main__":
    main()
