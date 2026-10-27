"""Filenames and folder routing (SCOPE.md §5.10)."""

from __future__ import annotations

import re
import unicodedata

ONESHOT_FOLDERS = {
    "kick": "Kicks", "snare": "Snares", "clap": "Claps", "hat_closed": "Hats-Closed",
    "hat_open": "Hats-Open", "hat": "Hats-Closed", "ride": "Rides", "cymbal": "Cymbals",
    "shaker": "Shakers", "perc": "Perc",
}
LOOP_FOLDERS = {
    "snare": "Snares-Claps", "clap": "Snares-Claps", "hat": "Hats", "hat_closed": "Hats",
    "hat_open": "Hats", "ride": "Rides", "shaker": "Shakers", "perc": "Perc", "top": "Tops",
    "groove": "Grooves", "drums": "Full-Drums",
}
EVENT_FOLDERS = {
    "fill": "Fills/Drum-Fills", "roll": "Fills/Snare-Rolls", "fx_riser": "FX/Risers",
    "fx_downlifter": "FX/Downlifters", "fx_impact": "FX/Impacts", "fx_sweep": "FX/Sweeps",
    "fx_atmos": "FX/Atmos", "fx": "FX/Other",
}
CATEGORY_LABELS = {
    "kick": "Kick", "snare": "Snare", "clap": "Clap", "hat": "Hat", "hat_closed": "HatClosed",
    "hat_open": "HatOpen", "ride": "Ride", "cymbal": "Cymbal", "shaker": "Shaker",
    "perc": "Perc", "top": "Top", "groove": "Groove", "drums": "Drums", "fill": "Fill",
    "roll": "Roll", "fx_riser": "Riser", "fx_downlifter": "Downlifter", "fx_impact": "Impact",
    "fx_sweep": "Sweep", "fx_atmos": "Atmos", "fx": "FX",
}
SLUG_MAX = 20


def source_code(number: int) -> str:
    return f"S{number:04d}"


def slugify(name: str, max_len: int = SLUG_MAX) -> str:
    """'Deep Groove (Original Mix) Stems.zip' -> 'deep-groove-original'."""
    name = re.sub(r"\.zip$", "", name, flags=re.IGNORECASE)
    name = re.sub(r"\d{2,3}(?:\.\d+)?\s?bpm", " ", name, flags=re.IGNORECASE)  # tempo is in the name already
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if len(slug) > max_len:
        cut = slug[:max_len]
        # Prefer cutting at a word boundary if that keeps most of the length.
        at_boundary = slug[max_len] == "-"
        if not at_boundary and "-" in cut and cut.rfind("-") >= max_len // 2:
            cut = cut[:cut.rfind("-")]
        slug = cut.strip("-")
    return slug or "untitled"


def source_tag(code: str, slug: str) -> str:
    return f"{code}-{slug}"


def format_bpm(bpm: float) -> str:
    return f"{bpm:g}"


def oneshot_rel_path(category: str, key_label: str, tag: str, index: int) -> str:
    folder = ONESHOT_FOLDERS[category]
    return f"One-Shots/{folder}/OS_{CATEGORY_LABELS[category]}_{key_label}_{tag}_{index:02d}.wav"


def loop_rel_path(category: str, bpm: float, key_label: str, tag: str, bars: int, index: int) -> str:
    folder = LOOP_FOLDERS[category]
    return (f"Loops/{folder}/LP_{CATEGORY_LABELS[category]}_{format_bpm(bpm)}_{key_label}_"
            f"{tag}_{bars}bar_{index:02d}.wav")


def event_rel_path(category: str, bpm: float, key_label: str, tag: str, bars: int, index: int) -> str:
    """Fills and rolls get FL_, FX get FX_: `FX/Risers/FX_Riser_124_Am_S0037-deep-groove_8bar_01.wav`."""
    folder = EVENT_FOLDERS[category]
    prefix = "FL" if category in ("fill", "roll") else "FX"
    return (f"{folder}/{prefix}_{CATEGORY_LABELS[category]}_{format_bpm(bpm)}_{key_label}_"
            f"{tag}_{bars}bar_{index:02d}.wav")
