"""SQLite library index (SCOPE.md §5.12). The engine writes, the app reads."""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA_VERSION = 5

# A sample kind ("oneshot" | "loop" | "event"), several of them, or None for all.
Kinds = str | tuple[str, ...] | None

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS zips (
  id INTEGER PRIMARY KEY,
  source_code TEXT UNIQUE,
  file_name TEXT, file_sha1 TEXT UNIQUE, original_path TEXT,
  detected_bpm REAL, bpm_override REAL, bpm_source_stem TEXT,
  phase_samples INTEGER, grid_offset_override_ms REAL, tempo_confidence REAL,
  key_label TEXT, key_camelot TEXT, key_confidence REAL, key_override TEXT,
  status TEXT,
  reviewed INTEGER DEFAULT 0,
  warnings TEXT,
  processed_at TEXT, settings_hash TEXT
);

CREATE TABLE IF NOT EXISTS stems (
  id INTEGER PRIMARY KEY,
  zip_id INTEGER REFERENCES zips(id) ON DELETE CASCADE,
  file_name TEXT, category TEXT, category_override TEXT,
  auto_classified INTEGER, duration_s REAL, sample_rate INTEGER, channels INTEGER,
  used_for TEXT
);

CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY,
  zip_id INTEGER REFERENCES zips(id) ON DELETE CASCADE,
  stem_id INTEGER REFERENCES stems(id) ON DELETE CASCADE,
  kind TEXT,
  category TEXT,
  rel_path TEXT UNIQUE,
  bpm REAL,
  bars INTEGER,
  body_bars INTEGER,
  key_label TEXT, key_camelot TEXT,
  duration_s REAL, sample_rate INTEGER, channels INTEGER,
  peak_db REAL, gain_applied_db REAL,
  source_offset_s REAL,
  fingerprint BLOB,
  favorite INTEGER DEFAULT 0, rating INTEGER, tags TEXT,
  shift_beats INTEGER DEFAULT 0,    -- loops/events: sound rotated this many beats later (v5)
  created_at TEXT
);

-- Samples deleted from the library (schema v3): reprocessing the zip doesn't bring them back.
-- Their files wait in .drumvault/trash/<id>.wav (+ .json peaks) so they can be restored (v4).
CREATE TABLE IF NOT EXISTS removed_samples (
  id INTEGER PRIMARY KEY,
  zip_id INTEGER REFERENCES zips(id) ON DELETE CASCADE,
  stem_file TEXT, kind TEXT, bars INTEGER, source_offset_s REAL,
  sample TEXT,                      -- the sample row (JSON) to restore
  fingerprint BLOB,
  removed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_samples_cat ON samples(kind, category);
CREATE INDEX IF NOT EXISTS idx_samples_key ON samples(key_label);
CREATE INDEX IF NOT EXISTS idx_samples_zip ON samples(zip_id);
CREATE INDEX IF NOT EXISTS idx_stems_zip ON stems(zip_id);
CREATE INDEX IF NOT EXISTS idx_removed_zip ON removed_samples(zip_id);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def library_dir(library: Path | str) -> Path:
    return Path(library) / ".drumvault"


def db_path(library: Path | str) -> Path:
    return library_dir(library) / "library.sqlite"


class LibraryDB:
    def __init__(self, library: Path | str):
        self.library = Path(library)
        path = db_path(self.library)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
                          (str(SCHEMA_VERSION),))

    def _migrate(self) -> None:
        """Columns added after a library was created (CREATE TABLE IF NOT EXISTS keeps old tables)."""
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(samples)")}
        if "body_bars" not in cols:  # v2: event body length (filled on the next reprocess)
            self.conn.execute("ALTER TABLE samples ADD COLUMN body_bars INTEGER")
        if "shift_beats" not in cols:  # v5: "Move sound" in the Library
            self.conn.execute("ALTER TABLE samples ADD COLUMN shift_beats INTEGER DEFAULT 0")
        removed_cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(removed_samples)")}
        for col, typ in (("sample", "TEXT"), ("fingerprint", "BLOB"), ("removed_at", "TEXT")):
            if col not in removed_cols:  # v4: restorable deleted samples
                self.conn.execute(f"ALTER TABLE removed_samples ADD COLUMN {col} {typ}")
        zip_cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(zips)")}
        if "reviewed" not in zip_cols:  # v2: "Mark as reviewed" survives reprocessing
            self.conn.execute("ALTER TABLE zips ADD COLUMN reviewed INTEGER DEFAULT 0")

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "LibraryDB":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            else:
                self.conn.execute("COMMIT")

    # ---- helpers -----------------------------------------------------------
    def _insert(self, table: str, fields: dict[str, Any]) -> int:
        cols = ", ".join(fields)
        qs = ", ".join("?" for _ in fields)
        cur = self.conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({qs})", list(fields.values()))
        return int(cur.lastrowid)

    def _update(self, table: str, row_id: int, fields: dict[str, Any]) -> None:
        if not fields:
            return
        sets = ", ".join(f"{k} = ?" for k in fields)
        self.conn.execute(f"UPDATE {table} SET {sets} WHERE id = ?", [*fields.values(), row_id])

    # ---- zips --------------------------------------------------------------
    def find_zip_by_sha1(self, sha1: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM zips WHERE file_sha1 = ?", (sha1,)).fetchone()

    def get_zip(self, zip_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM zips WHERE id = ?", (zip_id,)).fetchone()

    def list_zips(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM zips ORDER BY id").fetchall()

    def next_source_number(self) -> int:
        row = self.conn.execute(
            "SELECT MAX(CAST(SUBSTR(source_code, 2) AS INTEGER)) FROM zips").fetchone()
        return int(row[0] or 0) + 1

    def insert_zip(self, **fields: Any) -> int:
        with self._lock:
            return self._insert("zips", fields)

    def update_zip(self, zip_id: int, **fields: Any) -> None:
        if "warnings" in fields and not isinstance(fields["warnings"], (str, type(None))):
            fields["warnings"] = json.dumps(fields["warnings"])
        with self._lock:
            self._update("zips", zip_id, fields)

    def mark_reviewed(self, zip_id: int) -> bool:
        """The user checked a needs-review zip: it counts as done, now and after reprocessing."""
        with self._lock:
            if self.get_zip(zip_id) is None:
                return False
            self.conn.execute("UPDATE zips SET reviewed = 1, status = CASE WHEN status = 'needs_review' "
                              "THEN 'done' ELSE status END WHERE id = ?", (zip_id,))
        return True

    def delete_zip_rows(self, zip_id: int) -> None:
        with self._lock:
            self.conn.execute("DELETE FROM zips WHERE id = ?", (zip_id,))

    # ---- stems -------------------------------------------------------------
    def stems_for_zip(self, zip_id: int) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM stems WHERE zip_id = ? ORDER BY id", (zip_id,)).fetchall()

    def insert_stem(self, **fields: Any) -> int:
        if "used_for" in fields and not isinstance(fields["used_for"], str):
            fields["used_for"] = json.dumps(fields["used_for"])
        return self._insert("stems", fields)

    def update_stem(self, stem_id: int, **fields: Any) -> None:
        if "used_for" in fields and not isinstance(fields["used_for"], str):
            fields["used_for"] = json.dumps(fields["used_for"])
        self._update("stems", stem_id, fields)

    def delete_stems(self, zip_id: int) -> None:
        self.conn.execute("DELETE FROM stems WHERE zip_id = ?", (zip_id,))

    # ---- samples -----------------------------------------------------------
    def samples_for_zip(self, zip_id: int, kind: Kinds = None) -> list[sqlite3.Row]:
        sql, args = _kind_filter(kind)
        return self.conn.execute(f"SELECT * FROM samples WHERE zip_id = ?{sql} ORDER BY id",
                                 (zip_id, *args)).fetchall()

    def all_samples(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM samples ORDER BY id").fetchall()

    def insert_sample(self, **fields: Any) -> int:
        return self._insert("samples", fields)

    def set_sample_meta(self, sample_id: int, favorite: bool | None = None, rating: int | None = None,
                        tags: str | None = None) -> bool:
        fields: dict[str, Any] = {}
        if favorite is not None:
            fields["favorite"] = int(favorite)
        if rating is not None:
            fields["rating"] = rating or None
        if tags is not None:
            fields["tags"] = tags.strip() or None
        with self._lock:
            if self.conn.execute("SELECT 1 FROM samples WHERE id = ?", (sample_id,)).fetchone() is None:
                return False
            self._update("samples", sample_id, fields)
        return True

    def get_sample(self, sample_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM samples WHERE id = ?", (sample_id,)).fetchone()

    def sample_by_path(self, rel_path: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM samples WHERE rel_path = ?", (rel_path,)).fetchone()

    def set_shift(self, sample_id: int, shift_beats: int) -> None:
        with self._lock:
            self._update("samples", sample_id, {"shift_beats": shift_beats})

    def delete_samples(self, zip_id: int, kind: Kinds = None) -> None:
        sql, args = _kind_filter(kind)
        self.conn.execute(f"DELETE FROM samples WHERE zip_id = ?{sql}", (zip_id, *args))

    def user_meta(self, zip_id: int, kind: Kinds = None) -> list[MatchEntry]:
        """favorite/rating/tags of a zip's samples, for matching after reprocessing."""
        where, args = _kind_filter(kind, "s.kind")
        sql = ("SELECT s.kind, s.bars, s.source_offset_s, s.favorite, s.rating, s.tags, s.shift_beats, st.file_name "
               f"FROM samples s JOIN stems st ON st.id = s.stem_id WHERE s.zip_id = ?{where}")
        return [(r["file_name"], r["kind"], r["bars"], r["source_offset_s"] or 0.0,
                 {"favorite": r["favorite"], "rating": r["rating"], "tags": r["tags"], "shift_beats": r["shift_beats"]})
                for r in self.conn.execute(sql, (zip_id, *args))
                if r["favorite"] or r["rating"] is not None or r["tags"] or r["shift_beats"]]

    def remove_samples(self, sample_ids: list[int]) -> list[tuple[sqlite3.Row, int]]:
        """Move samples from the index to `removed_samples`, so reprocessing doesn't bring them
        back. Returns (deleted row, removed id) pairs; moving the files is the caller's job."""
        if not sample_ids:
            return []
        qs = ", ".join("?" for _ in sample_ids)
        out = []
        with self.transaction():
            rows = self.conn.execute(
                "SELECT s.*, st.file_name AS stem_file FROM samples s LEFT JOIN stems st ON st.id = s.stem_id "
                f"WHERE s.id IN ({qs})", sample_ids).fetchall()
            for r in rows:
                rid = self._insert("removed_samples", dict(
                    zip_id=r["zip_id"], stem_file=r["stem_file"], kind=r["kind"], bars=r["bars"],
                    source_offset_s=r["source_offset_s"], sample=json.dumps(_restorable(r)),
                    fingerprint=r["fingerprint"], removed_at=now_iso()))
                out.append((r, rid))
            self.conn.execute(f"DELETE FROM samples WHERE id IN ({qs})", sample_ids)
        return out

    def removed_for_zip(self, zip_id: int, kind: Kinds = None) -> list[MatchEntry]:
        """Match entries whose value is the removed_samples id."""
        where, args = _kind_filter(kind)
        return [(r["stem_file"], r["kind"], r["bars"], r["source_offset_s"] or 0.0, r["id"])
                for r in self.conn.execute(f"SELECT * FROM removed_samples WHERE zip_id = ?{where}", (zip_id, *args))]

    def get_removed(self, removed_ids: list[int]) -> list[sqlite3.Row]:
        qs = ", ".join("?" for _ in removed_ids)
        return self.conn.execute(f"SELECT * FROM removed_samples WHERE id IN ({qs}) ORDER BY id", removed_ids).fetchall()

    def update_removed(self, removed_id: int, sample: dict[str, Any], fingerprint: bytes) -> None:
        """A reprocess re-cut a deleted sample (into the trash): keep what a restore puts back current."""
        self._update("removed_samples", removed_id, dict(sample=json.dumps(sample), fingerprint=fingerprint))

    def removed_ids_for_zip(self, zip_id: int) -> list[int]:
        return [r["id"] for r in self.conn.execute("SELECT id FROM removed_samples WHERE zip_id = ?", (zip_id,))]

    def delete_removed(self, removed_id: int) -> None:
        self.conn.execute("DELETE FROM removed_samples WHERE id = ?", (removed_id,))

    def rel_path_taken(self, rel_path: str) -> bool:
        return self.conn.execute("SELECT 1 FROM samples WHERE rel_path = ?", (rel_path,)).fetchone() is not None


def _kind_filter(kind: Kinds, column: str = "kind") -> tuple[str, tuple[str, ...]]:
    """SQL condition (with leading AND) for one kind, several kinds or none."""
    if not kind:
        return "", ()
    kinds = (kind,) if isinstance(kind, str) else tuple(kind)
    return f" AND {column} IN ({', '.join('?' for _ in kinds)})", kinds


# Sample columns kept for a restore (ids, the stem link and the fingerprint are handled apart).
RESTORE_COLUMNS = ("kind", "category", "rel_path", "bpm", "bars", "body_bars", "key_label", "key_camelot",
                   "duration_s", "sample_rate", "channels", "peak_db", "gain_applied_db", "source_offset_s",
                   "favorite", "rating", "tags", "shift_beats", "created_at")


def _restorable(row: sqlite3.Row) -> dict[str, Any]:
    keys = row.keys()
    return {k: row[k] for k in RESTORE_COLUMNS if k in keys}


# (stem file, kind, bars, source offset in seconds, value)
MatchEntry = tuple[str, str, "int | None", float, Any]


class SampleMatcher:
    """Finds "the same" sample after reprocessing: same stem, kind and length, and the nearest
    start within a tolerance (loops and events move when bar 1 changes; one-shots don't)."""

    def __init__(self, entries: list[MatchEntry], oneshot_tol_s: float, loop_tol_s: float):
        self._by: dict[tuple, list[tuple[float, Any]]] = {}
        for stem, kind, bars, offset, value in entries:
            self._by.setdefault((stem, kind, bars), []).append((float(offset), value))
        self._tol = {"oneshot": oneshot_tol_s}
        self._loop_tol = loop_tol_s

    def find(self, stem_file: str, kind: str, bars: int | None, offset_s: float) -> Any:
        tol = self._tol.get(kind, self._loop_tol)
        best = min(self._by.get((stem_file, kind, bars), []), key=lambda e: abs(e[0] - offset_s), default=None)
        return best[1] if best is not None and abs(best[0] - offset_s) <= tol + 1e-9 else None
