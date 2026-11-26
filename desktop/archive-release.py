"""Snapshot non-ignored source and verify it against local desktop archives."""
import argparse
import gzip
import hashlib
import json
import os
import subprocess
import tarfile
import tempfile
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).resolve().parents[1]
dist = root / 'dist'
version = json.loads((root / 'package.json').read_text())['version']
snapshot_name = 'open-browser-source-' + version
snapshot = dist / (snapshot_name + '.tar.gz')


def digest(file):
    checksum = hashlib.sha256()
    for part in iter(lambda: file.read(1024 * 1024), b''):
        checksum.update(part)
    return checksum.hexdigest()


def source_files():
    names = subprocess.check_output(
        ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root
    ).split(b'\0')
    return sorted({os.fsdecode(name) for name in names if name and (root / os.fsdecode(name)).is_file()})


def create_snapshot():
    dist.mkdir(exist_ok=True)
    files = source_files()
    with tempfile.NamedTemporaryFile(dir=dist, delete=False) as raw:
        temp = Path(raw.name)
        try:
            with gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as gz:
                with tarfile.open(fileobj=gz, mode='w|', format=tarfile.PAX_FORMAT) as tar:
                    for name in files:
                        file = root / name
                        if file.is_symlink():
                            raise ValueError('Review symlink for source snapshot: ' + name)
                        info = tarfile.TarInfo(snapshot_name + '/' + name)
                        info.mode = 0o755 if os.access(file, os.X_OK) else 0o644
                        info.size = file.stat().st_size
                        with file.open('rb') as content:
                            tar.addfile(info, content)
            raw.close()
            os.replace(temp, snapshot)
        finally:
            temp.unlink(missing_ok=True)
    with snapshot.open('rb') as file:
        checksum = digest(file)
    Path(str(snapshot) + '.sha256').write_text(checksum + '  ' + snapshot.name + '\n')
    print(f'{snapshot.name}  {checksum}  ({len(files)} source files)')


def packaged_paths(source, mac):
    common = {name: 'app/' + name for name in source if
              (('/' not in name and name.endswith('.mjs')) or name.startswith(('browser-extension/', 'studio/', 'skills/')))
              and not name.endswith('.test.mjs')}
    for name in ('package.json', 'package-lock.json'):
        common[name] = 'app/' + name
    common['Docs/THIRD-PARTY-NOTICES.md'] = 'app/THIRD-PARTY-NOTICES.md'
    if mac:
        common = {name: 'open-browser.app/Contents/Resources/' + location for name, location in common.items()}
        common['desktop/icons/open-browser.icns'] = 'open-browser.app/Contents/Resources/open-browser.icns'
        common['desktop/Info.plist'] = 'open-browser.app/Contents/Info.plist'
    else:
        common['Docs/跨平台试用与发行.md'] = 'README.md'
        common['desktop/smoke-portable.mjs'] = 'verify.mjs'
    return common


def verify():
    with tarfile.open(snapshot) as tar:
        source = {entry.name.removeprefix(snapshot_name + '/'): digest(tar.extractfile(entry))
                  for entry in tar if entry.isfile()}
    if set(source) != set(source_files()):
        raise ValueError('Working tree file list has changed since snapshot')
    for name, checksum in source.items():
        with (root / name).open('rb') as file:
            if digest(file) != checksum:
                raise ValueError('Working tree differs from snapshot: ' + name)
    sums = {}
    for name in (snapshot.name, 'open-browser-macos-arm64.zip', 'open-browser-win32-x64.zip', 'open-browser-linux-x64.tar.gz'):
        artifact = dist / name
        with artifact.open('rb') as file:
            sums[name] = digest(file)
        if Path(str(artifact) + '.sha256').read_text().split()[0] != sums[name]:
            raise ValueError('Archive checksum mismatch: ' + name)
        if artifact == snapshot:
            continue
        mac = name.startswith('open-browser-macos-')
        paths = packaged_paths(source, mac)
        if 'win32' in name:
            paths.update({'desktop/icons/open-browser.ico': 'open-browser.ico',
                          'desktop/create-shortcut.ps1': 'create-shortcut.ps1'})
        elif 'linux' in name:
            paths['desktop/install-menu-entry.mjs'] = 'install-menu-entry.mjs'
        prefix = '' if mac else name.split('.')[0] + '/'
        with ZipFile(artifact) if name.endswith('.zip') else tarfile.open(artifact, mode='r|gz') as archive:
            # Read compressed tar in a single linear pass.
            entries = archive.namelist() if isinstance(archive, ZipFile) else archive
            by_entry = {prefix + entry: name for name, entry in paths.items()}
            for entry in entries:
                path = entry if isinstance(entry, str) else entry.name
                if path not in by_entry:
                    continue
                src = by_entry.pop(path)
                with archive.open(path) if isinstance(archive, ZipFile) else archive.extractfile(entry) as data:
                    if digest(data) != source[src]:
                        raise ValueError(f'{artifact.name}: {src} differs')
            if by_entry:
                raise ValueError(f'{artifact.name}: missing {list(by_entry)}')
        print(f'{name}: {len(paths)} packaged source files matched the snapshot')
    (dist / 'SHA256SUMS').write_text(''.join(f'{value}  {key}\n' for key, value in sums.items()))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['snapshot', 'verify'])
    if parser.parse_args().command == 'snapshot':
        create_snapshot()
    else:
        verify()
