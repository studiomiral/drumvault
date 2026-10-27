"""The sidecar over real pipes: only JSON lines on stdout, jobs, events, cancel."""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).resolve().parents[1]


class Engine:
    def __init__(self):
        env = dict(os.environ, PYTHONUNBUFFERED="1")
        self.proc = subprocess.Popen([sys.executable, "-m", "drumvault_engine"], cwd=ENGINE_DIR,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, env=env)
        self.lines: list[dict] = []
        assert self.read()["event"] == "ready"

    def send(self, **msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def read(self) -> dict:
        line = self.proc.stdout.readline()
        assert line, "engine closed stdout"
        obj = json.loads(line)  # every stdout line must be valid JSON
        self.lines.append(obj)
        return obj

    def until(self, pred, timeout=300):
        t0 = time.time()
        while time.time() - t0 < timeout:
            obj = self.read()
            if pred(obj):
                return obj
        raise TimeoutError

    def close(self):
        if self.proc.poll() is None:
            self.send(id="bye", method="shutdown", params={})
            try:
                self.proc.wait(timeout=60)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        rest = self.proc.stdout.read()
        for line in rest.splitlines():
            json.loads(line)
        self.proc.stderr.read()


@pytest.fixture
def engine():
    e = Engine()
    yield e
    e.close()


def test_health_and_errors(engine):
    engine.send(id="1", method="health", params={})
    r = engine.until(lambda o: o.get("id") == "1")
    assert r["result"]["version"] and r["result"]["rubberband"]
    assert r["result"]["key_backend"] in ("essentia", "fallback")

    engine.send(id="2", method="nope", params={})
    assert engine.until(lambda o: o.get("id") == "2")["error"]["code"] == "bad_request"
    engine.proc.stdin.write("{not json\n")
    engine.proc.stdin.flush()
    assert engine.until(lambda o: "error" in o)["error"]["code"] == "parse_error"
    engine.send(id="3", method="reprocess_zip", params={"zip_id": "x"})
    assert engine.until(lambda o: o.get("id") == "3")["error"]["code"] == "bad_params"


def test_process_zip_job(engine, fixtures, tmp_path):
    lib = tmp_path / "lib"
    engine.send(id="p", method="process_zip",
                params={"path": str(fixtures.zip("deep_groove")), "settings": {"library_path": str(lib)}})
    acc = engine.until(lambda o: o.get("id") == "p")["result"]
    job = acc["job_id"]
    done = engine.until(lambda o: o.get("event") == "job_done" and o["job_id"] == job)
    assert done["status"] == "done" and done["zip_id"] == 1
    assert done["counts"]["oneshots"] > 0 and done["counts"]["loops"] > 0
    progress = [o for o in engine.lines if o.get("event") == "progress" and o["job_id"] == job]
    stages = [p["stage"] for p in progress]
    for st in ("extract", "classify", "tempo", "key", "stems", "write", "done"):
        assert st in stages
    assert all(0 <= p["pct"] <= 1 for p in progress)
    assert [p["pct"] for p in progress] == sorted(p["pct"] for p in progress)
    assert any("124.00 BPM" in p["message"] for p in progress)

    # Re-dropping the same zip is skipped.
    engine.send(id="q", method="process_zip",
                params={"path": str(fixtures.zip("deep_groove")), "settings": {"library_path": str(lib)}})
    job2 = engine.until(lambda o: o.get("id") == "q")["result"]["job_id"]
    done2 = engine.until(lambda o: o.get("event") == "job_done" and o["job_id"] == job2)
    assert done2["status"] == "skipped"

    # Delete via RPC.
    engine.send(id="d", method="delete_zip", params={"zip_id": 1, "settings": {"library_path": str(lib)}})
    job3 = engine.until(lambda o: o.get("id") == "d")["result"]["job_id"]
    done3 = engine.until(lambda o: o.get("event") == "job_done" and o["job_id"] == job3)
    assert done3["status"] == "done" and not list(lib.rglob("*.wav"))


def test_cancel_queued_and_running(engine, fixtures, tmp_path):
    lib = str(tmp_path / "lib")
    params = {"path": str(fixtures.zip("sunrise")), "settings": {"library_path": lib}}
    engine.send(id="a", method="process_zip", params=params)
    engine.send(id="b", method="process_zip", params=params)
    ja = engine.until(lambda o: o.get("id") == "a")["result"]["job_id"]
    jb = engine.until(lambda o: o.get("id") == "b")["result"]["job_id"]
    engine.send(id="cb", method="cancel", params={"job_id": jb})
    engine.send(id="ca", method="cancel", params={"job_id": ja})
    done = {}
    while len(done) < 2:
        o = engine.read()
        if o.get("event") == "job_done":
            done[o["job_id"]] = o["status"]
    assert done == {ja: "cancelled", jb: "cancelled"}
    assert not list(Path(lib).rglob("*.wav"))


def test_process_error_reported(engine, tmp_path):
    engine.send(id="e", method="process_zip",
                params={"path": str(tmp_path / "missing.zip"), "settings": {"library_path": str(tmp_path)}})
    job = engine.until(lambda o: o.get("id") == "e")["result"]["job_id"]
    done = engine.until(lambda o: o.get("event") == "job_done" and o["job_id"] == job)
    assert done["status"] == "error" and done["error"]["code"] == "missing_zip"


def test_set_sample_meta(engine, library):
    import sqlite3
    settings = {"library_path": str(library.path)}
    sid = sqlite3.connect(library.path / ".drumvault" / "library.sqlite").execute(
        "SELECT id FROM samples ORDER BY id LIMIT 1").fetchone()[0]
    engine.send(id="m1", method="set_sample_meta",
                params={"sample_id": sid, "favorite": True, "rating": 4, "tags": " punchy ", "settings": settings})
    assert engine.until(lambda o: o.get("id") == "m1")["result"] == {"sample_id": sid}
    row = sqlite3.connect(library.path / ".drumvault" / "library.sqlite").execute(
        "SELECT favorite, rating, tags FROM samples WHERE id = ?", (sid,)).fetchone()
    assert row == (1, 4, "punchy")
    engine.send(id="m2", method="set_sample_meta", params={"sample_id": sid, "rating": 0, "settings": settings})
    engine.until(lambda o: o.get("id") == "m2")
    row = sqlite3.connect(library.path / ".drumvault" / "library.sqlite").execute(
        "SELECT favorite, rating FROM samples WHERE id = ?", (sid,)).fetchone()
    assert row == (1, None)  # rating cleared, favourite untouched
    engine.send(id="m3", method="set_sample_meta", params={"sample_id": 999999, "favorite": True, "settings": settings})
    assert engine.until(lambda o: o.get("id") == "m3")["error"]["code"] == "not_found"
    engine.send(id="m4", method="set_sample_meta", params={"sample_id": sid, "rating": 9, "settings": settings})
    assert engine.until(lambda o: o.get("id") == "m4")["error"]["code"] == "bad_params"


def test_mark_reviewed_survives_reprocessing(engine, fixtures, tmp_path):
    """A needs-review zip marked as reviewed is done, and stays done when reprocessed."""
    import sqlite3

    from drumvault_engine import pipeline
    from drumvault_engine.config import Settings
    from drumvault_engine.schemas import Overrides
    lib = tmp_path / "lib"
    s = Settings(library_path=str(lib))
    r = pipeline.process_zip(fixtures.zip("deep_groove"), s, overrides=Overrides(grid_offset_ms=20.0))
    db = lib / ".drumvault" / "library.sqlite"
    sqlite3.connect(db).execute("UPDATE zips SET status = 'needs_review' WHERE id = ?", (r.zip_id,)).connection.commit()
    engine.send(id="r1", method="mark_reviewed", params={"zip_id": r.zip_id, "settings": {"library_path": str(lib)}})
    assert engine.until(lambda o: o.get("id") == "r1")["result"] == {"zip_id": r.zip_id}
    assert sqlite3.connect(db).execute("SELECT status, reviewed FROM zips").fetchone() == ("done", 1)
    # Force a review flag on reprocess (BPM far beyond the max stretch): still done.
    r2 = pipeline.process_zip(None, Settings(library_path=str(lib), library_bpm=100.0), zip_id=r.zip_id)
    assert r2.status == "done" and any("max stretch" in w for w in r2.warnings)
    engine.send(id="r2", method="mark_reviewed", params={"zip_id": 9999, "settings": {"library_path": str(lib)}})
    assert engine.until(lambda o: o.get("id") == "r2")["error"]["code"] == "not_found"


def test_grid_preview(engine, fixtures, tmp_path):
    """The drum stems summed to one file, with the bar 1 the library was cut on."""
    import soundfile as sf

    from drumvault_engine import pipeline
    from drumvault_engine.config import Settings
    from drumvault_engine.schemas import Overrides
    lib = tmp_path / "lib"
    s = Settings(library_path=str(lib))
    r = pipeline.process_zip(fixtures.zip("deep_groove"), s)
    engine.send(id="g1", method="grid_preview", params={"zip_id": r.zip_id, "settings": {"library_path": str(lib)}})
    g = engine.until(lambda o: o.get("id") == "g1")["result"]
    info = sf.info(g["path"])
    assert info.channels == 1 and info.samplerate == g["sample_rate"] == s.thresholds.grid_preview_sr
    assert abs(info.duration - g["duration_s"]) < 0.01
    assert not g["manual"] and abs(g["bar_one_ms"]) < 1.0 and g["bpm"] > 0
    assert any("kick" in n.lower() for n in g["stems"])
    assert not any(w in n.lower() for n in g["stems"] for w in ("bassline", "chords", "vocal", "fill"))

    pipeline.process_zip(None, s, zip_id=r.zip_id, overrides=Overrides(grid_offset_ms=-7.5))
    g2 = pipeline.grid_preview(s, r.zip_id)
    assert g2.manual and g2.bar_one_ms == -7.5

    engine.send(id="g2", method="grid_preview", params={"zip_id": 9999, "settings": {"library_path": str(lib)}})
    assert engine.until(lambda o: o.get("id") == "g2")["error"]["code"] == "not_found"


def test_deleted_samples_stay_deleted_after_reprocessing(engine, fixtures, tmp_path):
    """Deleting samples removes their files; a re-cut on a moved grid keeps them out and
    keeps favourites on the samples that remain."""
    import sqlite3

    from drumvault_engine import pipeline
    from drumvault_engine.config import Settings
    from drumvault_engine.schemas import Overrides
    lib = tmp_path / "lib"
    s = Settings(library_path=str(lib))
    r = pipeline.process_zip(fixtures.zip("deep_groove"), s)
    db = sqlite3.connect(lib / ".drumvault" / "library.sqlite")
    rows = lambda: db.execute("SELECT id, kind, rel_path, favorite FROM samples ORDER BY id").fetchall()  # noqa: E731
    before = rows()
    loops = [x for x in before if x[1] == "loop"]
    shot = next(x for x in before if x[1] == "oneshot")
    gone, fav = loops[0], loops[1]
    db.execute("UPDATE samples SET favorite = 1 WHERE id = ?", (fav[0],)).connection.commit()

    engine.send(id="d1", method="delete_samples",
                params={"sample_ids": [gone[0], shot[0]], "settings": {"library_path": str(lib)}})
    assert engine.until(lambda o: o.get("id") == "d1")["result"] == {"deleted": 2}
    assert not (lib / gone[2]).exists() and not (lib / shot[2]).exists()
    assert len(rows()) == len(before) - 2

    trash = lib / ".drumvault" / "trash"
    trashed = lambda: sorted(p.name for p in trash.glob("*.wav"))  # noqa: E731
    assert len(trashed()) == 2

    r2 = pipeline.process_zip(None, s, zip_id=r.zip_id, overrides=Overrides(grid_offset_ms=15.0))
    after = rows()
    assert r2.counts.oneshots + r2.counts.loops + r2.counts.events == len(after) == len(before) - 2
    assert sum(x[3] for x in after) == 1
    assert len(trashed()) == 2   # re-cut into the trash, not back into the library

    # Restore both: back in the library with new rows; their names are free again.
    removed = [x[0] for x in db.execute("SELECT id FROM removed_samples ORDER BY id")]
    engine.send(id="d2", method="restore_samples",
                params={"removed_ids": removed, "settings": {"library_path": str(lib)}})
    assert engine.until(lambda o: o.get("id") == "d2")["result"] == {"restored": 2, "pending": 0}
    final = rows()
    assert len(final) == len(before) and not trashed()
    assert len({x[2] for x in final}) == len(final) and all((lib / x[2]).exists() for x in final)
    assert not db.execute("SELECT COUNT(*) FROM removed_samples").fetchone()[0]

    # A deletion without a trashed file (older library) is just forgotten: reprocessing brings it back.
    one = rows()[0]
    pipeline.delete_samples(s, [one[0]])
    rid = db.execute("SELECT id FROM removed_samples").fetchone()[0]
    (trash / f"{rid}.wav").unlink()
    assert pipeline.restore_samples(s, [rid]) == {"restored": 0, "pending": 1}
    pipeline.process_zip(None, s, zip_id=r.zip_id)
    assert len(rows()) == len(before)
