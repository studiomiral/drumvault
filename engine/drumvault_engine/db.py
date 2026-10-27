"""SQLite library index (SCOPE.md §5.12). The engine writes, the app reads."""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA_VERSION = 2

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
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_samples_cat ON samples(kind, category);
CREATE INDEX IF NOT EXISTS idx_samples_key ON samples(key_label);
CREATE INDEX IF NOT EXISTS idx_samples_zip ON samples(zip_id);
CREATE INDEX IF NOT EXISTS idx_stems_zip ON stems(zip_id);
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

    def delete_samples(self, zip_id: int, kind: Kinds = None) -> None:
        sql, args = _kind_filter(kind)
        self.conn.execute(f"DELETE FROM samples WHERE zip_id = ?{sql}", (zip_id, *args))

    def user_meta(self, zip_id: int, kind: Kinds = None) -> dict[tuple, dict[str, Any]]:
        """favorite/rating/tags of a zip's samples, keyed for matching after reprocessing."""
        where, args = _kind_filter(kind, "s.kind")
        sql = ("SELECT s.kind, s.bars, s.source_offset_s, s.favorite, s.rating, s.tags, st.file_name "
               f"FROM samples s JOIN stems st ON st.id = s.stem_id WHERE s.zip_id = ?{where}")
        out = {}
        for r in self.conn.execute(sql, (zip_id, *args)):
            if r["favorite"] or r["rating"] is not None or r["tags"]:
                out[match_key(r["file_name"], r["kind"], r["bars"], r["source_offset_s"])] = {
                    "favorite": r["favorite"], "rating": r["rating"], "tags": r["tags"]}
        return out


def _kind_filter(kind: Kinds, column: str = "kind") -> tuple[str, tuple[str, ...]]:
    """SQL condition (with leading AND) for one kind, several kinds or none."""
    if not kind:
        return "", ()
    kinds = (kind,) if isinstance(kind, str) else tuple(kind)
    return f" AND {column} IN ({', '.join('?' for _ in kinds)})", kinds


def match_key(stem_file: str, kind: str, bars: int | None, offset_s: float | None) -> tuple:
    """Stem + length + offset (to 10 ms) identifies "the same" sample across reprocessing."""
    return (stem_file, kind, bars, round(float(offset_s or 0.0), 2))
