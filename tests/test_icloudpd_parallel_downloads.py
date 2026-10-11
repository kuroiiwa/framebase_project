"""Offline concurrency tests; no Apple account or real photo library is used."""

import argparse
import base64
import importlib.util
import pathlib
import sys
import time
import tempfile
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event, Lock
from types import SimpleNamespace

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tools/icloudpd/source-review/icloud_photos_downloader-master/src"
sys.path.insert(0, str(SOURCE))
spec = importlib.util.spec_from_file_location("parallel_downloads", ROOT / "server/icloud-providers/parallel-downloads.py")
parallel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parallel)


@pytest.fixture
def tmp_path():
    directory = ROOT / ".test-tmp"
    directory.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="parallel-", dir=directory) as path:
        yield pathlib.Path(path)


@pytest.mark.parametrize("value", [0, 9, -1, "no"])
def test_invalid_thread_count(value):
    with pytest.raises(argparse.ArgumentTypeError):
        parallel.download_threads(value)


def test_bounded_workers_and_main_thread_enumeration():
    lock = Lock()
    active = 0
    peak = 0
    consumed = 0
    progress = []

    def check_batch():
        assert consumed in [3, 6]

    barrier = Barrier(3, action=check_batch)

    def items():
        nonlocal consumed
        for item in range(6):
            consumed += 1
            yield item

    def download(item):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        barrier.wait(timeout=3)
        with lock:
            active -= 1

    assert parallel.run_parallel_downloads(items(), lambda _: True, download, 3, lambda: False, progress.append) == 6
    assert peak == 3
    assert progress == list(range(1, 7))


def test_worker_failure_stops_queue_and_propagates():
    visited = []

    def download(item):
        visited.append(item)
        raise RuntimeError("failed transfer")

    with pytest.raises(RuntimeError, match="failed transfer"):
        parallel.run_parallel_downloads(range(100), lambda _: True, download, 2, lambda: False, lambda _: None)
    assert len(visited) <= 2


def test_cancel_does_not_schedule_more_downloads():
    cancel = Event()
    visited = []

    def download(item):
        visited.append(item)
        cancel.set()

    parallel.run_parallel_downloads(range(100), lambda _: True, download, 1, cancel.is_set, lambda _: None)
    assert visited == [0]


@pytest.mark.parametrize("collision", ["target", "checksum", "dedup", "sidecar"])
def test_shared_final_or_resume_paths_are_serialized(tmp_path, collision):
    version = SimpleNamespace(size=100, checksum=base64.b64encode(b"same").decode())
    second_version = SimpleNamespace(size=100, checksum=base64.b64encode(b"other").decode())
    first = str(tmp_path / "image.jpg")
    second = first if collision == "target" else str(tmp_path / ("image-100.jpg" if collision == "dedup" else "other.jpg"))
    if collision == "sidecar":
        second = str(tmp_path / "image.heic")
    if collision == "checksum":
        second_version = version
    active = 0
    peak = 0
    lock = Lock()
    start = Barrier(2)

    def write(path, selected_version):
        nonlocal active, peak
        start.wait(timeout=3)
        with parallel.download_guard(path, selected_version):
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.02)
            with lock:
                active -= 1

    with ThreadPoolExecutor(2) as pool:
        first_task = pool.submit(write, first, version)
        second_task = pool.submit(write, second, second_version)
        first_task.result(timeout=3)
        second_task.result(timeout=3)
    assert peak == 1
    assert not parallel._paths


def test_independent_files_can_transfer_together(tmp_path):
    barrier = Barrier(2)

    def write(name):
        version = SimpleNamespace(size=100, checksum=base64.b64encode(name.encode()).decode())
        with parallel.download_guard(str(tmp_path / (name + ".jpg")), version):
            barrier.wait(timeout=3)

    with ThreadPoolExecutor(2) as pool:
        tasks = [pool.submit(write, name) for name in ["one", "two"]]
        for task in tasks:
            task.result(timeout=3)


@pytest.mark.parametrize("mode", ["until_found", "delete_after_download", "keep_icloud_recent_days", "auto_delete", "dry_run", "only_print_filenames", "inventory", "target_delete"])
def test_ordered_and_non_download_modes_remain_serial(mode, monkeypatch):
    global_config = SimpleNamespace(threads_num=4, only_print_filenames=False)
    user = SimpleNamespace(until_found=None, delete_after_download=False, keep_icloud_recent_days=None, auto_delete=False, dry_run=False)
    assert parallel.parallel_downloads_enabled(global_config, user, {})
    if mode == "inventory":
        monkeypatch.setenv("FRAMEBASE_INVENTORY_JSON", "1")
    elif mode == "only_print_filenames":
        global_config.only_print_filenames = True
    elif mode != "target_delete":
        setattr(user, mode, 1)
    assert not parallel.parallel_downloads_enabled(global_config, user, {"one": {}} if mode == "target_delete" else {})


def test_stream_retries_and_resume_offset_are_preserved(tmp_path, monkeypatch):
    from icloudpd import download
    from pyicloud_ipd.exceptions import PyiCloudAPIResponseException
    from pyicloud_ipd.version_size import AssetVersionSize
    from threading import RLock
    import logging

    monkeypatch.setattr(download.constants, "WAIT_SECONDS", 0)
    monkeypatch.setattr(download.constants, "MAX_RETRIES", 3)
    offsets = []
    closed = []
    version = SimpleNamespace(size=6, checksum=base64.b64encode(b"checksum").decode(), url="https://example.invalid/media")
    part = tmp_path / (base64.b32encode(b"checksum").decode() + ".part")
    part.write_bytes(b"abc")
    target = tmp_path / "photo.jpg"
    response = SimpleNamespace(ok=True, iter_content=lambda chunk_size: [b"def"], close=lambda: closed.append(True))

    def transfer(session, url, offset):
        offsets.append(offset)
        if len(offsets) == 1:
            raise PyiCloudAPIResponseException("throttled", "ACCESS_DENIED")
        return response

    service = SimpleNamespace(photos=SimpleNamespace(session=SimpleNamespace(_framebase_request_lock=RLock())))
    photo = SimpleNamespace(download=transfer, created=None)
    assert download.download_media(logging.getLogger(__name__), False, service, photo, str(target), version, AssetVersionSize.ORIGINAL, lambda _: "photo.jpg")
    assert offsets == [3, 3]
    assert target.read_bytes() == b"abcdef"
    assert not part.exists()
    assert closed == [True]


def test_session_requests_serialize_cookie_writes_but_not_streams(tmp_path, monkeypatch):
    from requests import Session, Response
    from pyicloud_ipd.session import PyiCloudSession
    service = SimpleNamespace(password_filter=None, http_timeout=1, session_data={}, session_path=str(tmp_path / "session.json"), cookiejar_path="unused")
    session = PyiCloudSession(service)
    session.cookies.save = lambda **kwargs: None
    active = 0
    peak = 0

    def request(*args, **kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        time.sleep(0.02)
        active -= 1
        response = Response()
        response.status_code = 200
        response.headers["Content-Type"] = "image/jpeg"
        return response

    monkeypatch.setattr(Session, "request", request)
    with ThreadPoolExecutor(3) as pool:
        tasks = [pool.submit(session.get, "https://example.invalid/media", stream=True) for _ in range(3)]
        for task in tasks:
            assert task.result(timeout=3).ok
    assert peak == 1


def test_cli_downloads_and_reuses_files_with_two_workers(tmp_path, monkeypatch):
    # Replay upstream fixtures offline through the real CLI and download builder.
    helpers_path = SOURCE.parent / "tests/helpers/__init__.py"
    helper_spec = importlib.util.spec_from_file_location("offline_helpers", helpers_path)
    helpers = importlib.util.module_from_spec(helper_spec)
    helper_spec.loader.exec_module(helpers)
    import shutil
    monkeypatch.setenv("NO_PROXY", "*")
    cookie = tmp_path / "cookie"
    data = tmp_path / "data"
    shutil.copytree(SOURCE.parent / "tests/cookie", cookie)
    (data / "2018/07/30").mkdir(parents=True)
    for name, size in [("IMG_7408.JPG", 1151066), ("IMG_7407.JPG", 656257)]:
        with (data / "2018/07/30" / name).open("wb") as file:
            file.truncate(size)
    params = ["-d", str(data), "--cookie-directory", str(cookie), "--username", "jdoe@gmail.com", "--password", "password1", "--recent", "5", "--skip-live-photos", "--skip-videos", "--threads-num", "2", "--no-progress-bar"]
    cassette = str(SOURCE.parent / "tests/vcr_cassettes/listing_photos.yml")
    first = helpers.run_cassette(cassette, params)
    assert first.exit_code == 0, type(first.exception).__name__
    assert "Downloading with 2 concurrent workers" in first.output
    files = list(data.rglob("*.JPG"))
    assert len(files) == 3
    signatures = {path: (path.stat().st_size, path.stat().st_mtime_ns) for path in files}
    second = helpers.run_cassette(cassette, params)
    assert second.exit_code == 0, type(second.exception).__name__
    assert signatures == {path: (path.stat().st_size, path.stat().st_mtime_ns) for path in files}
    assert not list(data.rglob("*.part"))


def test_failed_parallel_transfer_is_reported_for_retry(tmp_path):
    from icloudpd import download
    from pyicloud_ipd.exceptions import PyiCloudConnectionErrorException
    from pyicloud_ipd.version_size import AssetVersionSize
    import logging
    response = SimpleNamespace(ok=False, close=lambda: None)
    photo = SimpleNamespace(download=lambda *args: response, created=None, item_type=None)
    version = SimpleNamespace(size=6, checksum=base64.b64encode(b"failure").decode(), url="https://example.invalid/media")
    # The failure formatting needs only the original filename for this fixture.
    from unittest.mock import patch
    with patch.object(download, "calculate_version_filename", return_value="photo.jpg"):
        with ThreadPoolExecutor(1, thread_name_prefix="icloudpd-download") as pool:
            future = pool.submit(download.download_media, logging.getLogger(__name__), False, SimpleNamespace(photos=SimpleNamespace(session=None)), photo, str(tmp_path / "photo.jpg"), version, AssetVersionSize.ORIGINAL, lambda _: "photo.jpg")
            with pytest.raises(PyiCloudConnectionErrorException, match="Concurrent file download failed"):
                future.result(timeout=3)


def test_actual_response_streams_overlap(tmp_path, monkeypatch):
    from requests import Session, Response
    from pyicloud_ipd.session import PyiCloudSession
    from pyicloud_ipd.version_size import AssetVersionSize
    from icloudpd import download
    import logging
    barrier = Barrier(2)
    service = SimpleNamespace(password_filter=None, http_timeout=1, session_data={}, session_path=str(tmp_path / "session.json"), cookiejar_path="unused")
    session = PyiCloudSession(service)
    session.cookies.save = lambda **kwargs: None
    service.photos = SimpleNamespace(session=session)

    def request(*args, **kwargs):
        response = Response()
        response.status_code = 200
        response.headers["Content-Type"] = "image/jpeg"

        def stream(chunk_size):
            barrier.wait(timeout=3)
            yield b"photo"

        response.iter_content = stream
        return response

    monkeypatch.setattr(Session, "request", request)
    photo = SimpleNamespace(download=lambda session, url, offset: session.get(url, stream=True), created=None)

    def transfer(name):
        version = SimpleNamespace(size=5, checksum=base64.b64encode(name.encode()).decode(), url="https://example.invalid/" + name)
        with parallel.download_guard(str(tmp_path / (name + ".jpg")), version):
            assert download.download_media(logging.getLogger(__name__), False, service, photo, str(tmp_path / (name + ".jpg")), version, AssetVersionSize.ORIGINAL, lambda _: name + ".jpg")

    parallel.run_parallel_downloads(["one", "two"], lambda _: True, transfer, 2, lambda: False, lambda _: None)
    assert (tmp_path / "one.jpg").read_bytes() == b"photo"
    assert (tmp_path / "two.jpg").read_bytes() == b"photo"
