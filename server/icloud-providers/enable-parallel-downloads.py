"""Apply the download concurrency changes to the local compatibility source."""

import pathlib
import shutil
import sys


root = pathlib.Path(sys.argv[1]).resolve()
module = pathlib.Path(__file__).with_name("parallel-downloads.py")
shutil.copyfile(module, root / "src/icloudpd/framebase_parallel_downloads.py")


def update(relative, marker, transform):
    path = root / relative
    text = path.read_text(encoding="utf-8")
    if marker in text:
        return
    result = transform(text)
    if result == text:
        raise RuntimeError(f"Could not apply concurrency changes to {relative}")
    path.write_text(result, encoding="utf-8")


def replace(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f"Expected exactly one source anchor: {old[:80]}")
    return text.replace(old, new, 1)


def patch_cli(text):
    text = replace(text, "import argparse\n", "import argparse\nfrom icloudpd.framebase_parallel_downloads import download_threads\n")
    start = text.index('    deprecated_kwargs: dict[str, Any] = {}', text.index('"--no-progress-bar"'))
    end = text.index('    cloned.add_argument(\n        "--domain",', start)
    return text[:start] + '''    cloned.add_argument(
        "--threads-num",
        help="Concurrent file downloads (1-8). Default: 1. Ordered/deletion modes use 1.",
        type=download_threads,
        default=1,
    )
''' + text[end:]


def indent_region(text, start, end, prefix):
    left = text.index(start)
    right = text.index(end, left)
    block = text[left:right]
    return text[:left] + prefix + "".join("    " + line if line.strip() else line for line in block.splitlines(True)) + text[right:]


def patch_base(text):
    text = replace(text, "from icloudpd.counter import Counter\n", "from icloudpd.counter import Counter\nfrom icloudpd.framebase_parallel_downloads import download_guard, parallel_downloads_enabled, run_parallel_downloads\n")
    text = indent_region(text, "        original_download_path = None\n", "    # Also download the live photo if present\n", "        with download_guard(download_path, version):\n")
    text = indent_region(text, "            lp_file_exists = os.path.isfile(lp_download_path)\n", "    return success\n", "            with download_guard(lp_download_path, version):\n")
    anchor = "                        for item in photos_bar:\n"
    return replace(text, anchor, '''                        if parallel_downloads_enabled(global_config, user_config, framebase_delete_assets):
                            logger.info("Downloading with %d concurrent workers", global_config.threads_num)

                            def record_parallel_progress(count):
                                status_exchange.get_progress().photos_counter = count

                            photos_counter = run_parallel_downloads(
                                photos_bar,
                                passer,
                                lambda photo: download_photo(Counter(0), photo),
                                global_config.threads_num,
                                lambda: status_exchange.get_progress().cancel,
                                record_parallel_progress,
                            )
                            photos_bar = []

''' + anchor)


def patch_session(text):
    text = replace(text, "import inspect\n", "import inspect\nfrom threading import RLock\n")
    text = replace(text, "        self.service = service\n", "        self.service = service\n        self._framebase_request_lock = RLock()\n")
    return indent_region(text, "        # Charge logging to the right service endpoint\n", "    def _raise_error(", "        with self._framebase_request_lock:\n")


def patch_download(text):
    text = replace(text, "                icloud.authenticate()\n", "                with icloud.photos.session._framebase_request_lock:\n                    icloud.authenticate()\n")
    text = replace(text, '''            if photo_response.ok:
                return download_local(
                    photo_response, temp_download_path, append_mode, download_path, photo.created
                )
            else:
''', '''            if photo_response.ok:
                try:
                    return download_local(
                        photo_response, temp_download_path, append_mode, download_path, photo.created
                    )
                finally:
                    photo_response.close()
            else:
                photo_response.close()
''')
    return text


def patch_download_failure(text):
    text = replace(text, "import time\n", "import time\nfrom threading import current_thread\nfrom pyicloud_ipd.exceptions import PyiCloudConnectionErrorException\n")
    # False also means "already exists" in the caller. Raise here so failed
    # concurrent transfers cannot masquerade as a successful completed batch.
    position = text.rindex("    return False\n")
    return text[:position] + '''    if current_thread().name.startswith("icloudpd-download"):
        raise PyiCloudConnectionErrorException("Concurrent file download failed; retry the backup")
''' + text[position:]


update("src/icloudpd/cli.py", "import download_threads", patch_cli)
update("src/icloudpd/base.py", "import download_guard,", patch_base)
update("src/pyicloud_ipd/session.py", "_framebase_request_lock", patch_session)
update("src/icloudpd/download.py", "_framebase_request_lock", patch_download)
update("src/icloudpd/download.py", "Concurrent file download failed", patch_download_failure)
update(
    "src/icloudpd/download.py",
    "import close_download_response",
    lambda text: replace(text, "import base64\n", "import base64\nfrom icloudpd.framebase_parallel_downloads import close_download_response\n").replace("photo_response.close()", "close_download_response(photo_response)"),
)


def patch_backup_probe(text):
    text = replace(text, '            inventory_request = os.environ.get("FRAMEBASE_INVENTORY_JSON") == "1"\n', '            inventory_request = os.environ.get("FRAMEBASE_INVENTORY_JSON") == "1"\n            backup_request = os.environ.get("FRAMEBASE_BACKUP_READONLY") == "1"\n')
    text = replace(text, 'framebase_request = inventory_request or os.environ.get("FRAMEBASE_VERIFY_SESSION")', 'framebase_request = inventory_request or backup_request or os.environ.get("FRAMEBASE_VERIFY_SESSION")')
    return replace(text, '(inventory_request or bool(os.environ.get("FRAMEBASE_DELETE_REQUEST")))', '(inventory_request or backup_request or bool(os.environ.get("FRAMEBASE_DELETE_REQUEST")))')


update("src/pyicloud_ipd/services/photos.py", "backup_request =", patch_backup_probe)
