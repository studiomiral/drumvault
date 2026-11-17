# Each part's loudest hit against the kick's in the user's tracks (read-only), for tests/bench/levels.test.ts: loudest 200 ms and 1 s, unweighted mono power. JSON to stdout.
import json, re, sys
from pathlib import Path
import numpy as np
import soundfile as sf
from drumvault_engine.db import LibraryDB
from drumvault_engine import arrangement as arrmod

lib = Path(sys.argv[1])
def loudest(mono, sr, win):
    p = np.square(mono.astype(np.float64)); n = int(win * sr)
    if len(p) <= n: return 10 * np.log10(max(1e-12, p.sum() / n))
    c = np.concatenate([[0.0], np.cumsum(p)]); return 10 * np.log10(max(1e-12, float((c[n:] - c[:-n]).max()) / n))
def group(name, cat):
    p = arrmod.part_of(name, cat)
    if cat == "melodic" and re.search(r"stab|chord|hit", name, re.I): return "stab"
    return {"kick": "kick", "clap": "clap", "crash": "crash", "fills": "fills"}.get(p or "")
rows = []
with LibraryDB(lib) as db:
    for a in db.conn.execute("SELECT * FROM arrangements").fetchall():
        if json.loads(a["levels"] or "{}").get("normalized"): continue
        z = db.get_zip(a["zip_id"])
        kept = lib / ".drumvault" / "originals" / z["source_code"]
        if not (kept / "kept.json").exists(): continue
        files = json.loads((kept / "kept.json").read_text())["files"]
        by = {}
        for s in db.stems_for_zip(z["id"]):
            g = group(s["file_name"], s["category_override"] or s["category"])
            if not g or s["file_name"] not in files: continue
            x, sr = sf.read(str(kept / files[s["file_name"]]), always_2d=True)
            mono = x.mean(axis=1)
            if np.abs(mono).max() < 1e-4: continue
            v = (loudest(mono, sr, 0.2), loudest(mono, sr, 1.0))
            old = by.get(g)
            by[g] = v if not old else (max(old[0], v[0]), max(old[1], v[1]))
        if "kick" in by:
            rows.append({"zip": z["source_code"], **{g: [round(v[0] - by["kick"][0], 1), round(v[1] - by["kick"][1], 1)] for g, v in by.items() if g != "kick"}})
print(json.dumps(rows))
