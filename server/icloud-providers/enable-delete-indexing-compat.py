"""Install the reviewed deletion compatibility patch into the local icloudpd source."""
from pathlib import Path
import sys
import shutil

root = Path(sys.argv[1])
here = Path(__file__).parent
shutil.copyfile(here / "delete-indexing-compat.py", root / "src/icloudpd/framebase_delete_indexing_compat.py")
path = root / "src/icloudpd/base.py"
text = path.read_text(encoding="utf-8")
marker = "from icloudpd.framebase_delete_indexing_compat import running_index_targets, confirmed_delete_response"
if marker not in text:
    text = marker + "\n" + text
anchor = '''    if getattr(library, "framebase_indexing_state", None) == "RUNNING":
        error = PyiCloudServiceNotActivatedException'''
replacement = '''    if getattr(library, "framebase_indexing_state", None) == "RUNNING":
        compatible_targets = running_index_targets(library, photo_album, pending, framebase_target_photos, max(0, 90 - (time.monotonic() - started)))
        if compatible_targets:
            yield from compatible_targets
            return
        error = PyiCloudServiceNotActivatedException'''
if "compatible_targets = running_index_targets" not in text:
    if text.count(anchor) != 1:
        raise RuntimeError("Cannot locate guarded RUNNING target lookup")
    text = text.replace(anchor, replacement, 1)
anchor = '    library_object.session.post(url, data=post_data, headers={"Content-type": "application/json"})\n'
replacement = '''    response = library_object.session.post(url, data=post_data, headers={"Content-type": "application/json"})
    if os.environ.get("FRAMEBASE_DELETE_REQUEST"):
        confirmed_delete_response(response, photo._asset_record["recordName"])
'''
if "confirmed_delete_response(response," not in text:
    if text.count(anchor) != 1:
        raise RuntimeError("Cannot locate conditional record mutation")
    text = text.replace(anchor, replacement, 1)
path.write_text(text, encoding="utf-8")
