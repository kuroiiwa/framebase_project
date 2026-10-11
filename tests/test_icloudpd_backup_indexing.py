"""Offline checks of the RUNNING-index backup probe and delete boundary."""
import json
import pathlib
import sys
from unittest.mock import Mock, patch

import pytest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "tools/icloudpd/source-review/icloud_photos_downloader-master/src"
sys.path.insert(0, str(SOURCE))
from pyicloud_ipd.services.photos import PhotoLibrary
from pyicloud_ipd.exceptions import PyiCloudServiceNotActivatedException


def session(count=42, paired=True):
    replies = [
        {"records": [{"fields": {"state": {"value": "RUNNING"}}}]},
        {"batch": [{"records": [{"fields": {"itemCount": {"value": count}}}]}]},
        {"records": [{"recordType": "CPLMaster", "recordName": "master"}, {"recordType": "CPLAsset", "fields": {"masterRef": {"value": {"recordName": "master" if paired else "unknown"}}}}]},
    ]
    mock = Mock()
    mock.post.side_effect = [Mock(json=Mock(return_value=data)) for data in replies]
    return mock


def test_backup_probes_readable_running_index(capsys):
    mock = session()
    with patch.dict("os.environ", {"FRAMEBASE_BACKUP_READONLY": "1", "FRAMEBASE_VERIFY_SESSION": "1"}, clear=True):
        library = PhotoLibrary("https://example.invalid", {}, mock, {"zoneName": "PrimarySync"}, "private")
    assert library.framebase_indexing_state == "RUNNING"
    assert library.framebase_read_probe_count == 42
    assert mock.post.call_count == 3
    assert json.loads(capsys.readouterr().out.split("FRAMEBASE_INDEXING ")[1])["readProbe"] == "readable"


@pytest.mark.parametrize("count,paired", [(0, True), (42, False)])
def test_unreadable_backup_remains_blocked(count, paired):
    mock = session(count, paired)
    with patch.dict("os.environ", {"FRAMEBASE_BACKUP_READONLY": "1"}, clear=True):
        with pytest.raises(PyiCloudServiceNotActivatedException) as error:
            PhotoLibrary("https://example.invalid", {}, mock, {"zoneName": "PrimarySync"}, "private")
    assert error.value.read_probe_error == "ValueError"


def test_running_index_still_blocks_active_target_deletion():
    from icloudpd.base import framebase_targets_with_deleted
    library = Mock(framebase_indexing_state="RUNNING", zone_id={"zoneName": "PrimarySync"})
    library.recently_deleted = []
    with patch("icloudpd.base.framebase_direct_targets", return_value=iter([])), patch("icloudpd.base.framebase_target_photos") as scan:
        with pytest.raises(PyiCloudServiceNotActivatedException):
            list(framebase_targets_with_deleted(library, object(), {"target": {}}))
    scan.assert_not_called()


def test_network_probe_failure_preserves_block():
    mock = session()
    first = mock.post.side_effect
    mock.post.side_effect = [next(first), TimeoutError()]
    with patch.dict("os.environ", {"FRAMEBASE_BACKUP_READONLY": "1"}, clear=True):
        with pytest.raises(PyiCloudServiceNotActivatedException) as error:
            PhotoLibrary("https://example.invalid", {}, mock, {"zoneName": "PrimarySync"}, "private")
    assert error.value.read_probe_error == "TimeoutError"
