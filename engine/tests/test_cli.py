import json

from drumvault_engine import cli


def test_cli_analyze(fixtures, capsys):
    assert cli.main(["analyze", str(fixtures.zip("night_drive"))]) == 0
    out = capsys.readouterr().out
    assert "Tempo: 122 BPM" in out and "Key:   Fm 4A" in out
    assert "Extras.zip/Ride.wav" in out and "unsupported" in out


def test_cli_analyze_json(fixtures, capsys):
    assert cli.main(["analyze", "--json", str(fixtures.zip("sunrise"))]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["key"]["label"] == "D"
    assert {s["category"] for s in data["stems"]} >= {"kick", "hat", "melodic", "cymbal"}


def test_cli_process_folder(fixtures, tmp_path, capsys):
    # Only the unstretched fixture, via a folder argument.
    folder = tmp_path / "in"
    folder.mkdir()
    (folder / "dg.zip").write_bytes(fixtures.zip("deep_groove").read_bytes())
    lib = tmp_path / "out"
    assert cli.main(["process", str(folder), "--library", str(lib), "--bpm", "124"]) == 0
    out = capsys.readouterr().out
    assert "S0001" in out and "done" in out and "key Am" in out
    assert list((lib / "One-Shots" / "Kicks").glob("OS_Kick_Am_S0001-dg_01.wav"))
    assert cli.main(["process", str(folder), "--library", str(lib)]) == 0
    assert "skipped" in capsys.readouterr().out
