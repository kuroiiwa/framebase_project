import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).resolve().parents[1] / 'server/icloud-providers/inventory-recovery.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class RecoveryTests(unittest.TestCase):
    def run_policy(self, ids, known, limits, expected=100, stop=True, clock=lambda: 0):
        events = []
        visits = []
        def album():
            for value in ids:
                visits.append(value)
                yield SimpleNamespace(id=value)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'policy.json'
            path.write_text(json.dumps(dict(knownIds=known, expectedCount=expected, limits=limits, maxSeconds=60, stopOnNoGain=stop)))
            output = [item.id for item in module.inventory_recovery(album(), str(path), clock=clock, emit=events.append)]
        return output, visits, events

    def test_expansion_continues_same_iterator_without_rereading(self):
        output, visits, events = self.run_policy(['a', 'b', 'c', 'd', 'e'], ['a'], [2, 4], stop=False)
        self.assertEqual(output, ['a', 'b', 'c', 'd'])
        self.assertEqual(visits, output)
        self.assertEqual(events[-1]['scanned'], 4)
        self.assertTrue(any(event['reason'] == 'continuing' for event in events))

    def test_no_gain_stops_at_first_window(self):
        output, visits, events = self.run_policy(['a', 'b', 'c'], ['a', 'b'], [2, 4])
        self.assertEqual(output, ['a', 'b'])
        self.assertEqual(events[-1]['reason'], 'no_gain')

    def test_complete_stops_before_remaining_records(self):
        output, visits, events = self.run_policy(['a', 'b', 'c'], ['a'], [2, 4], expected=2)
        self.assertEqual(output, ['a', 'b'])
        self.assertEqual(events[-1]['reason'], 'complete')

    def test_time_budget_stops_without_reading_another_page(self):
        ticks = iter([0, 61])
        output, visits, events = self.run_policy(['a'], [], [2], clock=lambda: next(ticks))
        self.assertEqual(visits, [])
        self.assertEqual(events[-1]['reason'], 'budget')

if __name__ == '__main__':
    unittest.main()
