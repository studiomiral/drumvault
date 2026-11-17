# 8 full bars of each drum and bass stem of the user's tracks (read-only), for tests/bench/dynamics.test.ts.
import json, sys
from pathlib import Path
import soundfile as sf
from drumvault_engine.db import LibraryDB
from drumvault_engine import arrangement as arrmod
from drumvault_engine.pipeline import _bar_one_s

lib = Path(sys.argv[1]); out = Path(sys.argv[2]); BARS = 8
want = {"clap", "hats", "perc", "top", "ride", "kick", "bass"}
index = []
with LibraryDB(lib) as db:
    for a in db.conn.execute("SELECT a.*, z.source_code FROM arrangements a JOIN zips z ON z.id = a.zip_id").fetchall():
        z = db.get_zip(a["zip_id"])
        levels = json.loads(a["levels"] or "{}")
        if levels.get("normalized"):
            continue
        parts = json.loads(a["parts"]); bpm = float(z["bpm_override"] or z["detected_bpm"]); bar = 240.0 / bpm
        b1 = _bar_one_s(db, z)
        kept = lib / ".drumvault" / "originals" / z["source_code"]
        files = json.loads((kept / "kept.json").read_text())["files"] if (kept / "kept.json").exists() else {}
        for s in db.stems_for_zip(z["id"]):
            cat = s["category_override"] or s["category"]
            p = arrmod.part_of(s["file_name"], cat)
            if p not in want or p not in parts or s["file_name"] not in files:
                continue
            st = parts[p]; at = st.find("2" * BARS)
            if at < 0:
                continue
            src = kept / files[s["file_name"]]
            info = sf.info(str(src)); t0 = b1 + at * bar
            if t0 < 0:
                continue
            x, sr = sf.read(str(src), start=int(t0 * info.samplerate), frames=int(BARS * bar * info.samplerate), always_2d=True)
            if x.shape[0] < 1000 or abs(x).max() < 1e-4:
                continue
            name = f"{z['source_code']}-{p}-{len(index)}.wav"
            sf.write(str(out / name), x[:, :2] if x.shape[1] > 1 else x.repeat(2, axis=1), sr, subtype="PCM_16")
            index.append({"file": name, "part": p, "zip": z["source_code"], "stem": s["file_name"], "bpm": bpm, "kpart": levels.get("parts", {}).get(p)})
(out / "index.json").write_text(json.dumps(index, indent=1))
print(len(index), {p: sum(1 for i in index if i["part"] == p) for p in want})
