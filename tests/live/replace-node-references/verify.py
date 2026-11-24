"""Check fresh Godot reloads, independent of the toolkit's verification receipt."""
import json
from pathlib import Path


def verify(output: Path):
    receipts = json.loads((output / 'receipts.json').read_text())
    calls = {call['tag']: call for call in receipts['calls']}
    graphs = json.loads((output / 'fresh-graphs.json').read_text())

    def rows(tag):
        return {row['path']: row for row in graphs[tag]['rows']}

    for scene in ['external', 'retained', 'plain_control', 'non_tool']:
        returned = calls[scene]['returned']
        assert not returned['isError'], (scene, returned)
        assert returned['payloads'][0]['result']['persisted'] is True
        before, after = rows('before_' + scene), rows(scene)
        for path in ['Holder', 'Group/Victim/Child']:
            assert after[path].get('refs') == before[path].get('refs'), (scene, path, after[path].get('refs'))
    assert rows('external')['Group/Victim']['scene'] == 'res://prefab_identity.tscn'
    assert rows('plain_control')['Group/Victim']['type'] == 'Marker3D'
    assert calls['incompatible']['returned']['isError'], 'an incompatible exported reference must refuse the swap'
    assert rows('incompatible')['Holder']['refs'] == rows('before_incompatible')['Holder']['refs']
    assert rows('incompatible')['Group/Victim/Child']['refs'] == rows('before_incompatible')['Group/Victim/Child']['refs']
    assert rows('incompatible')['Group/Victim']['scene'] == ''
    assert all('SummerReplace' not in path for path in rows('incompatible'))
    assert rows('reference_undo')['Holder']['refs']['target'] == 'Group/Victim'
    assert receipts['nativeRedo']['results'][0]['result'] is True
    assert rows('reference_redo')['Holder']['refs']['target'] == 'Group/Victim_SummerReplace'
    assert rows('reference_undo_again')['Holder']['refs']['target'] == 'Group/Victim'
    assert any(item['action'] == 'Rebind replacement Node references' for item in receipts['history'])
    assert calls['setter_refusal']['returned']['isError']
    assert receipts['setterCounters']['results'][0]['result'] == {'first': 2, 'reject': 2}
    assert rows('setter_refusal')['Holder']['refs'] == rows('before_setter_refusal')['Holder']['refs']
    assert all('SummerReplace' not in path for path in rows('setter_refusal'))
    print('PASS: external and retained-child Node references, NodePath/child/type controls, incompatible rollback and reference Undo/Redo')


if __name__ == '__main__':
    import sys
    verify(Path(sys.argv[1]))
