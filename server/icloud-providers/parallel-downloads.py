"""Bounded download workers and locks for the FrameBase icloudpd build."""

import argparse
import base64
import os
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import contextmanager
from threading import Lock, RLock


def download_threads(value):
    try:
        count = int(value)
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError("threads-num must be an integer from 1 to 8") from error
    if not 1 <= count <= 8:
        raise argparse.ArgumentTypeError("threads-num must be between 1 and 8")
    return count


def parallel_downloads_enabled(global_config, user_config, delete_assets):
    return (
        global_config.threads_num > 1
        and not global_config.only_print_filenames
        and os.environ.get("FRAMEBASE_INVENTORY_JSON") != "1"
        and not delete_assets
        and not user_config.auto_delete
        and not user_config.delete_after_download
        and user_config.keep_icloud_recent_days is None
        and user_config.until_found is None
        and not user_config.dry_run
    )


def run_parallel_downloads(items, accept, download, workers, cancelled, completed):
    """Enumerate/filter on the caller; bound pending work and propagate failures."""
    executor = ThreadPoolExecutor(max_workers=download_threads(workers), thread_name_prefix="icloudpd-download")
    pending = set()
    iterator = iter(items)
    exhausted = False
    count = 0
    try:
        while not exhausted or pending:
            while not exhausted and len(pending) < workers and not cancelled():
                try:
                    item = next(iterator)
                except StopIteration:
                    exhausted = True
                    break
                if cancelled():
                    break
                if accept(item):
                    pending.add(executor.submit(download, item))
                else:
                    count += 1
                    completed(count)
            if cancelled():
                break
            if not pending:
                continue
            done, pending = wait(pending, timeout=0.1, return_when=FIRST_COMPLETED)
            for future in done:
                future.result()
                count += 1
                completed(count)
        return count
    finally:
        for future in pending:
            future.cancel()
        # Active downloads finish/close their streams before their session is reused.
        executor.shutdown(wait=True, cancel_futures=True)


_paths = {}
_registry_lock = Lock()


def close_download_response(response):
    # A synthetic/non-streaming requests.Response may not own a raw stream.
    if getattr(response, "raw", True) is not None:
        response.close()


@contextmanager
def download_guard(path, version):
    """Protect final, legacy, deduplicated and checksum-based resume paths."""
    checksum = base64.b32encode(base64.b64decode(version.checksum)).decode()
    stem, extension = os.path.splitext(path)
    paths = sorted({os.path.normcase(os.path.abspath(key)) for key in (
        path, stem + "-original" + extension, stem + ".xmp",
        (f"-{version.size}.").join(path.rsplit(".", 1)),
        os.path.join(os.path.dirname(path), checksum + ".part"),
    )})
    locks = []
    with _registry_lock:
        for key in paths:
            entry = _paths.setdefault(key, [RLock(), 0])
            entry[1] += 1
            locks.append((key, entry[0]))
    acquired = []
    try:
        for _, lock in locks:
            lock.acquire()
            acquired.append(lock)
        yield
    finally:
        for lock in reversed(acquired):
            lock.release()
        with _registry_lock:
            for key, _ in locks:
                _paths[key][1] -= 1
                if _paths[key][1] == 0:
                    del _paths[key]
