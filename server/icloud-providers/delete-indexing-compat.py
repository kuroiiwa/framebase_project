"""Positive, bounded target verification while Apple's global index is updating."""
import json


def running_index_targets(library, album, requested, scan, max_seconds):
    # Membership in this server-side query is evidence of active state. Sparse
    # flags from record lookup alone are deliberately not treated as active.
    if getattr(album, "list_type", None) != "CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted":
        return []
    count = getattr(library, "framebase_read_probe_count", None)
    if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
        return []
    verified = {}
    rejected = 0
    for photo in scan(album, requested, max_scan=count + 100, max_seconds=max_seconds):
        master = photo._master_record
        asset = photo._asset_record
        key = str(photo.id)
        fields = asset.get("fields", {})
        if (key not in requested or master.get("recordType") != "CPLMaster"
                or master.get("recordName") != key
                or asset.get("recordType") != "CPLAsset"
                or not asset.get("recordName") or not asset.get("recordChangeTag")
                or fields.get("masterRef", {}).get("value", {}).get("recordName") != key
                or fields.get("isDeleted", {}).get("value") not in (None, 0)
                or fields.get("isExpunged", {}).get("value") not in (None, 0)
                or asset.get("serverErrorCode") or master.get("serverErrorCode")):
            rejected += 1
            continue
        # This is not an album iterator used for mutation: prevent rank shifts
        # after yielding the materialized, freshly verified target records.
        photo.framebase_direct_lookup = True
        photo.framebase_already_deleted = False
        verified[key] = photo
    print("FRAMEBASE_DELETE_INDEX_COMPAT " + json.dumps({"requested": len(requested), "matched": len(verified), "rejected": rejected, "source": "active_membership"}), flush=True)
    # Never authorize a partially located batch during an unstable index.
    return list(verified.values()) if set(verified) == set(requested) else []


def confirmed_delete_response(response, record_name):
    payload = response.json()
    if not isinstance(payload, dict) or payload.get("serverErrorCode"):
        raise RuntimeError("Apple did not confirm deletion")
    records = payload.get("records", [])
    if not isinstance(records, list):
        raise RuntimeError("Apple deletion response is invalid")
    confirmed = [record for record in records if record.get("recordName") == record_name
                 and not record.get("serverErrorCode")
                 and record.get("fields", {}).get("isDeleted", {}).get("value") == 1]
    if len(confirmed) != 1:
        raise RuntimeError("Apple did not confirm the requested record as deleted")
