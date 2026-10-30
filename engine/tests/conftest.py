"""Shared fixtures: synthetic zips (built once per session) and a processed library."""

from __future__ import annotations

import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import make_fixtures  # noqa: E402

from drumvault_engine import pipeline, zipio  # noqa: E402
from drumvault_engine.config import Settings  # noqa: E402


@dataclass
class Fixtures:
    dir: Path
    truths: dict[str, make_fixtures.FixtureTruth]

    def zip(self, name: str) -> Path:
        return self.dir / self.truths[name].zip_name


@pytest.fixture(scope="session")
def fixtures(tmp_path_factory) -> Fixtures:
    """Synthetic stem zips. Set DRUMVAULT_FIXTURE_DIR to cache them between runs."""
    cache = os.environ.get("DRUMVAULT_FIXTURE_DIR")
    out = Path(cache) if cache else tmp_path_factory.mktemp("fixtures")
    truths = make_fixtures.build_all(out)
    return Fixtures(out, truths)


@pytest.fixture(scope="session")
def extracted(fixtures, tmp_path_factory):
    """Extracted fixture zips: name -> zipio.Discovery."""
    cache: dict[str, zipio.Discovery] = {}

    def get(name: str) -> zipio.Discovery:
        if name not in cache:
            dest = tmp_path_factory.mktemp(f"x-{name}")
            cache[name] = zipio.extract_zip(fixtures.zip(name), dest)
        return cache[name]
    return get


@dataclass
class Library:
    path: Path
    settings: Settings
    results: dict  # fixture name -> ProcessResult


@pytest.fixture(scope="session")
def library(fixtures, tmp_path_factory) -> Library:
    """All fixtures processed into one library at the default 124 BPM."""
    lib = tmp_path_factory.mktemp("library")
    settings = Settings(library_path=str(lib))
    results = {name: pipeline.process_zip(fixtures.zip(name), settings) for name in fixtures.truths}
    return Library(lib, settings, results)


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(library_path=str(tmp_path / "lib"))


def fixture_names() -> list[str]:
    return list(make_fixtures.BUILDERS)


@pytest.fixture(scope="session")
def scratch():
    with tempfile.TemporaryDirectory(prefix="drumvault-test-") as d:
        yield Path(d)
