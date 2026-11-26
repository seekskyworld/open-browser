"""Archive Windows packages and unpack checksum-verified upstream ZIPs."""
import os
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

mode, source, destination = sys.argv[1:]
if mode == 'extract':
    with ZipFile(source) as archive:
        for entry in archive.infolist():
            target = Path(archive.extract(entry, destination))
            permissions = (entry.external_attr >> 16) & 0o777
            if permissions and os.name != 'nt':
                target.chmod(permissions)
elif mode == 'pack':
    root = Path(source)
    with ZipFile(destination, 'w', compression=ZIP_DEFLATED, compresslevel=4) as archive:
        for file in sorted(root.rglob('*')):
            if file.is_file():
                archive.write(file, file.relative_to(root.parent))
else:
    raise SystemExit('expected pack or extract')
