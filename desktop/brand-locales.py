#!/usr/bin/env python3
"""Brand the macOS CFT 159 UI resources in a staged app before signing."""
import argparse
from pathlib import Path
import re
import struct


HEADER = struct.Struct('<IB3xHH')
ENTRY = struct.Struct('<HI')
ALIAS = struct.Struct('<HH')
# Reviewed against the pinned engine's English locale. 961 and 963 are
# aliased window-title templates. Engine notices and credits have other IDs.
DISPLAY = {
    103: 'Google Chrome for Testing',
    302: 'About &Google Chrome for Testing',
    801: 'About Chrome for Testing',
    802: 'Get help with Chrome for Testing',
    925: 'Chrome for Testing',
    961: '$1 - Google Chrome for Testing',
    963: '$1 - Google Chrome for Testing',
    1153: 'Customize Chrome for Testing',
}
PRODUCT = re.compile(
    r'(?:Google\s+)?Chrome(?:\s+for\s+Testing|\s+ya\s+(?:Majaribio|Kujaribia)'
    r'|\s+para testes|\s+för testning|\s+na Pang-test|\s+для тестирования'
    r'|-toetsweergawe|\s+สำหรับการทดสอบ|ን?\s+ለሙከራ)', re.IGNORECASE)


def resources(data):
    version, encoding, count, aliases = HEADER.unpack_from(data)
    if (version, encoding) != (5, 1):
        raise ValueError('Expected a Chromium v5 UTF-8 locale pack')
    start = HEADER.size
    entries = list(ENTRY.iter_unpack(data[start:start + (count + 1) * ENTRY.size]))
    index = start + (count + 1) * ENTRY.size
    if entries[-1] != (0, len(data)) or entries[0][1] != index + aliases * ALIAS.size:
        raise ValueError('Unexpected Chromium resource offsets')
    result = {key: data[offset:entries[i + 1][1]]
              for i, (key, offset) in enumerate(entries[:-1])}
    for key, target in ALIAS.iter_unpack(data[index:entries[0][1]]):
        result[key] = result[entries[target][0]]
    return result


def pack(values):
    entries, aliases, indices = [], [], {}
    for key, value in sorted(values.items()):
        if value in indices:
            aliases.append(ALIAS.pack(key, indices[value]))
        else:
            indices[value] = len(entries)
            entries.append((key, value))
    offset = HEADER.size + (len(entries) + 1) * ENTRY.size + len(aliases) * ALIAS.size
    table = []
    for key, value in entries:
        table.append(ENTRY.pack(key, offset))
        offset += len(value)
    return b''.join([HEADER.pack(5, 1, len(entries), len(aliases)), *table,
                     ENTRY.pack(0, offset), *aliases, *(value for _, value in entries)])


def brand(app):
    locations = sorted(app.glob('Contents/Frameworks/*.framework/Versions/[0-9]*/Resources/en.lproj/locale.pak'))
    if not locations:
        raise ValueError(f'Missing Chromium English resources under {app}')
    changed = 0
    for english in locations:
        en = resources(english.read_bytes())
        for key, expected in DISPLAY.items():
            if en.get(key, b'').decode() not in (expected, PRODUCT.sub('open-browser', expected)):
                raise ValueError(f'Chromium English resource {key} changed; review this engine version')
        for path in sorted(english.parent.parent.glob('*.lproj/locale.pak')):
            values = resources(path.read_bytes())
            modified = False
            for key in DISPLAY.keys() & values.keys():
                original = values[key].decode()
                replacement = PRODUCT.sub('open-browser', original)
                if 'open-browser' not in replacement:
                    raise ValueError(f'Unrecognized product spelling in {path.parent.name} resource {key}')
                if replacement != original:
                    values[key] = replacement.encode()
                    modified = True
            if modified:
                path.write_bytes(pack(values))
                changed += 1
    return changed


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path, help='Path to the staged Chromium .app')
    print(f'Branded {brand(parser.parse_args().app)} Chromium locale packs')
