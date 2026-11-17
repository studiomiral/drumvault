# 8 bars of each of the user's tracks where kick, clap and hats all play full, the drum stems summed (read-only), for tests/bench/bus.test.ts.
import json, sys
from pathlib import Path
import numpy as np
import soundfile as sf
from drumvault_engine.db import LibraryDB
from drumvault_engine import arrangement as arrmod
from drumvault_engine.pipeline import _bar_one_s

lib = Path(sys.argv[1]); out = Path(sys.argv[2]); BARS = 8
drums = {"kick", "clap", "hats", "perc", "top", "ride"}
index = []
with LibraryDB(lib) as db:
    for a in db.conn.execute("SELECT * FROM arrangements").fetchall():
        z = db.get_zip(a["zip_id"])
        if json.loads(a["levels"] or "{}").get("normalized"):
            continue
        parts = json.loads(a["parts"])
        if not all(p in parts for p in ("kick", "clap", "hats")):
            continue
        n = min(len(parts[p]) for p in ("kick", "clap", "hats"))
        at = next((i for i in range(n - BARS) if all(all(parts[p][i + k] == "2" for k in range(BARS)) for p in ("kick", "clap", "hats"))), -1)
        if at < 0:
            continue
        bpm = float(z["bpm_override"] or z["detected_bpm"]); t0 = _bar_one_s(db, z) + at * 240.0 / bpm
        kept = lib / ".drumvault" / "originals" / z["source_code"]
        files = json.loads((kept / "kept.json").read_text())["files"]
        acc = None; sr0 = None
        for s in db.stems_for_zip(z["id"]):
            p = arrmod.part_of(s["file_name"], s["category_override"] or s["category"])
            if p not in drums or s["file_name"] not in files:
                continue
            src = kept / files[s["file_name"]]
            sr = sf.info(str(src)).samplerate
            x, _ = sf.read(str(src), start=int(t0 * sr), frames=int(BARS * 240.0 / bpm * sr), always_2d=True)
            x = x[:, :2] if x.shape[1] > 1 else x.repeat(2, axis=1)
            if acc is None:
                acc = np.zeros_like(x); sr0 = sr
            k = min(len(acc), len(x)); acc[:k] += x[:k]
        if acc is None or t0 < 0:
            continue
        name = f"bus-{z['source_code']}.wav"
        sf.write(str(out / name), acc / max(1.0, np.abs(acc).max()), sr0, subtype="PCM_16")
        index.append({"file": name, "zip": z["source_code"], "bpm": bpm})
(out / "index.json").write_text(json.dumps(index, indent=1))
print(len(index))
