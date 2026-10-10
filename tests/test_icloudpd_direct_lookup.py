import json
from unittest.mock import Mock, patch
import pytest
from icloudpd.base import framebase_direct_targets, framebase_targets_with_deleted
from pyicloud_ipd.exceptions import PyiCloudServiceNotActivatedException


def pair(key="target", record_name="asset-record", deleted=0, reference=None):
    return [
        {"recordName": key, "recordType": "CPLMaster", "fields": {}},
        {"recordName": record_name, "recordType": "CPLAsset", "recordChangeTag": "fresh-tag", "fields": {
            "masterRef": {"value": {"recordName": reference or key}}, "isDeleted": {"value": deleted}}},
    ]


def library(records, state="FINISHED"):
    result = Mock(service_endpoint="https://example.test", params={}, zone_id={"zoneName": "PrimarySync"}, framebase_indexing_state=state)
    result.session.post.return_value.json.return_value = {"records": records}
    result.recently_deleted = []
    result.framebase_read_probe_count = None
    return result


def test_fresh_record_pair_bypasses_all_album_scans_and_keeps_current_change_tag():
    cloud = library(pair())
    requested = {"target": {"lookupAssetRecordName": "asset-record"}}
    with patch("icloudpd.base.framebase_target_photos") as scan:
        items = list(framebase_targets_with_deleted(cloud, object(), requested))
    scan.assert_not_called()
    assert len(items) == 1 and items[0].id == "target"
    assert items[0]._asset_record["recordChangeTag"] == "fresh-tag"
    assert items[0].framebase_already_deleted is False
    call = cloud.session.post.call_args
    assert "/records/lookup?" in call.args[0]
    assert json.loads(call.kwargs["data"])["zoneID"] == {"zoneName": "PrimarySync"}
    assert not any("/records/modify" in entry.args[0] for entry in cloud.session.post.call_args_list)


def test_recently_deleted_lookup_does_not_require_an_active_index_or_full_trash_scan():
    cloud = library(pair(deleted=1), "RUNNING")
    items = list(framebase_targets_with_deleted(cloud, object(), {"target": {"lookupAssetRecordName": "asset-record"}}))
    assert len(items) == 1 and items[0].framebase_already_deleted is True


def test_active_direct_lookup_does_not_bypass_running_index_guard():
    cloud = library(pair(), "RUNNING")
    with pytest.raises(PyiCloudServiceNotActivatedException):
        list(framebase_targets_with_deleted(cloud, object(), {"target": {"lookupAssetRecordName": "asset-record"}}))


@pytest.mark.parametrize("records", [pair(reference="another-master"), pair(deleted=2), pair()[:1], []])
def test_invalid_pairs_fall_back_to_exact_pagination(records):
    cloud = library(records)
    requested = {"target": {"lookupAssetRecordName": "asset-record"}}
    with patch("icloudpd.base.framebase_target_photos", return_value=iter([Mock(id="target")])) as scan:
        items = list(framebase_targets_with_deleted(cloud, object(), requested))
    assert len(items) == 1
    assert scan.call_args.args[1] == requested


def test_lookup_endpoint_failure_uses_pagination_without_assuming_target_is_missing():
    cloud = library([])
    cloud.session.post.side_effect = RuntimeError("lookup unavailable")
    with patch("icloudpd.base.framebase_target_photos", return_value=iter([Mock(id="target")])) as scan:
        assert len(list(framebase_targets_with_deleted(cloud, object(), {"target": {"lookupAssetRecordName": "asset-record"}}))) == 1
    scan.assert_called_once()


def test_old_inventory_without_record_hints_does_not_send_lookup_requests():
    cloud = library([])
    assert list(framebase_direct_targets(cloud, {"target": {"lookupRank": 2000}})) == []
    cloud.session.post.assert_not_called()


def test_batch_record_lookup_uses_bounded_batches_and_fresh_pairs():
    cloud = library([])
    records = {record["recordName"]: record for i in range(100) for record in pair(str(i), f"asset-{i}")}
    def respond(_url, **kwargs):
        names = json.loads(kwargs["data"])["records"]
        assert len(names) <= 100
        return Mock(json=lambda: {"records": [records[item["recordName"]] for item in names]})
    cloud.session.post.side_effect = respond
    requested = {str(i): {"lookupAssetRecordName": f"asset-{i}"} for i in range(100)}
    assert len(list(framebase_direct_targets(cloud, requested))) == 100
    assert cloud.session.post.call_count == 2
