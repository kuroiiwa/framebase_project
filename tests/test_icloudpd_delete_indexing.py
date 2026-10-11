"""Offline tests for positive target evidence, never blanket index bypass."""
import pathlib
import sys
from unittest.mock import Mock, patch
import pytest

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "tools/icloudpd/source-review/icloud_photos_downloader-master/src"
sys.path.insert(0, str(SOURCE))
from icloudpd.base import framebase_targets_with_deleted, delete_photo
from icloudpd.framebase_delete_indexing_compat import running_index_targets, confirmed_delete_response
from pyicloud_ipd.services.photos import PhotoAsset
from pyicloud_ipd.exceptions import PyiCloudServiceNotActivatedException


def photo(key="target"):
    return PhotoAsset({"recordName": key, "recordType": "CPLMaster", "fields": {}},
                      {"recordName": "asset-" + key, "recordType": "CPLAsset", "recordChangeTag": "fresh", "fields": {"masterRef": {"value": {"recordName": key}}}})


def setup():
    library = Mock(framebase_indexing_state="RUNNING", framebase_read_probe_count=20, zone_id={"zoneName": "PrimarySync"})
    library.recently_deleted = []
    album = Mock(list_type="CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted")
    return library, album


def test_sparse_flags_in_active_query_allow_complete_running_index_targets():
    library, album = setup()
    found = photo()
    scan = Mock(return_value=iter([found]))
    assert running_index_targets(library, album, {"target": {}}, scan, 60) == [found]
    assert found.framebase_direct_lookup is True
    assert found.framebase_already_deleted is False
    scan.assert_called_once_with(album, {"target": {}}, max_scan=120, max_seconds=60)


@pytest.mark.parametrize("change", [
    lambda p: p._asset_record.pop("recordChangeTag"),
    lambda p: p._asset_record["fields"].update({"masterRef": {"value": {"recordName": "foreign"}}}),
    lambda p: p._asset_record["fields"].update({"isDeleted": {"value": 1}}),
    lambda p: p._asset_record["fields"].update({"isDeleted": {"value": "0"}}),
    lambda p: p._asset_record["fields"].update({"isExpunged": {"value": 1}}),
    lambda p: p._asset_record.update({"serverErrorCode": "BAD_RECORD"}),
])
def test_unsafe_active_records_never_authorize_release(change):
    library, album = setup()
    found = photo(); change(found)
    assert running_index_targets(library, album, {"target": {}}, Mock(return_value=iter([found])), 60) == []


def test_incomplete_active_query_does_not_yield_partial_batch():
    library, album = setup()
    assert running_index_targets(library, album, {"target": {}, "missing": {}}, Mock(return_value=iter([photo()])), 60) == []


def test_unknown_query_or_missing_read_probe_cannot_use_compatibility():
    library, album = setup()
    scan = Mock()
    album.list_type = "CPLAssetAndMasterByAssetDate"
    assert running_index_targets(library, album, {"target": {}}, scan, 60) == []
    album.list_type = "CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted"
    library.framebase_read_probe_count = None
    assert running_index_targets(library, album, {"target": {}}, scan, 60) == []
    scan.assert_not_called()


def test_integrated_running_fallback_materializes_active_targets_before_mutation():
    library, album = setup()
    found = photo()
    with patch("icloudpd.base.framebase_target_photos", return_value=iter([found])):
        assert list(framebase_targets_with_deleted(library, album, {"target": {}})) == [found]
    with patch("icloudpd.base.framebase_target_photos", return_value=iter([])):
        with pytest.raises(PyiCloudServiceNotActivatedException):
            list(framebase_targets_with_deleted(library, album, {"target": {}}))


@pytest.mark.parametrize("payload", [{}, {"serverErrorCode": "CONFLICT"}, {"records": [{"recordName": "asset-target", "serverErrorCode": "CONFLICT"}]}, {"records": [{"recordName": "foreign", "fields": {"isDeleted": {"value": 1}}}]}])
def test_http_success_without_exact_deletion_confirmation_is_not_success(payload):
    with pytest.raises(RuntimeError):
        confirmed_delete_response(Mock(json=lambda: payload), "asset-target")


def test_modify_uses_fresh_tag_and_requires_apple_confirmation(monkeypatch):
    monkeypatch.setenv("FRAMEBASE_DELETE_REQUEST", "offline-test")
    library, _ = setup()
    library.params = {}; library.service_endpoint = "https://example.invalid"
    library.session.post.return_value.json.return_value = {"records": [{"recordName": "asset-target", "fields": {"isDeleted": {"value": 1}}}]}
    delete_photo(Mock(), library, photo(), lambda _photo: "target.jpg")
    assert '"recordChangeTag": "fresh"' in library.session.post.call_args.kwargs["data"]
    library.session.post.return_value.json.return_value = {"records": []}
    with pytest.raises(RuntimeError):
        delete_photo(Mock(), library, photo(), lambda _photo: "target.jpg")
