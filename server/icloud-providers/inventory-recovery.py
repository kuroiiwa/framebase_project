"""Read-only recovery policy for the bundled icloudpd inventory iterator.

Installed as icloudpd.framebase_inventory_recovery when rebuilding the tool.
The same iterator stays alive across windows, retaining its page and offset.
"""
import json
import os
import time


def inventory_recovery(album, policy_path=None, clock=time.monotonic, emit=None):
    policy_path = policy_path or os.environ.get("FRAMEBASE_INVENTORY_RECOVERY_POLICY")
    if not policy_path:
        yield from album
        return
    with open(policy_path, encoding="utf-8") as source:
        policy = json.load(source)
    known = set(str(value) for value in policy["knownIds"])
    expected = int(policy["expectedCount"])
    limits = sorted(set(int(value) for value in policy["limits"] if int(value) > 0))
    if not limits:
        return
    publish = emit or (lambda update: print("FRAMEBASE_RECOVERY_PROGRESS " + json.dumps(update), flush=True))
    started = clock()
    initial = len(known)
    previous = initial
    scanned = 0
    window = 0
    reason = "exhausted"
    iterator = iter(album)
    while scanned < limits[-1]:
        if clock() - started >= policy["maxSeconds"]:
            reason = "budget"
            break
        try:
            item = next(iterator)
        except StopIteration:
            break
        scanned += 1
        known.add(str(item.id))
        yield item
        if len(known) >= expected:
            reason = "complete"
            break
        if scanned >= limits[window]:
            publish({"scanned": scanned, "limit": limits[window], "added": len(known) - initial, "reason": "window"})
            if len(known) == previous and policy["stopOnNoGain"]:
                reason = "no_gain"
                break
            previous = len(known)
            window += 1
            if window >= len(limits):
                reason = "budget"
                break
            publish({"scanned": scanned, "limit": limits[window], "added": len(known) - initial, "reason": "continuing"})
    publish({"scanned": scanned, "limit": limits[min(window, len(limits) - 1)], "added": len(known) - initial, "reason": reason})
