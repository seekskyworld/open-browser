"""Regenerate checked-in desktop and extension icons on macOS from the README artwork."""
from pathlib import Path
from tempfile import TemporaryDirectory
import struct
import subprocess

root = Path(__file__).resolve().parents[1]
source = root / 'Docs/assets/open-browser-logo.png'
desktop = root / 'desktop/icons'
extension = root / 'browser-extension/icons'
for directory in (desktop, extension):
    directory.mkdir(exist_ok=True)


def resize(image, size, destination):
    subprocess.run(['sips', '-Z', str(size), str(image), '--out', str(destination)],
                   check=True, stdout=subprocess.DEVNULL)


with TemporaryDirectory() as temp:
    iconset = Path(temp) / 'open-browser.iconset'
    iconset.mkdir()
    for size in (16, 32, 128, 256, 512):
        for scale, suffix in ((1, ''), (2, '@2x')):
            resize(source, size * scale, iconset / f'icon_{size}x{size}{suffix}.png')
    subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(desktop / 'open-browser.icns')], check=True)

    sizes = (16, 32, 48, 128, 256)
    entries, images = [], []
    offset = 6 + 16 * len(sizes)
    for size in sizes:
        png = (extension if size <= 128 else Path(temp)) / f'open-browser-{size}.png'
        resize(source, size, png)
        data = png.read_bytes()
        entries.append(struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset))
        images.append(data)
        offset += len(data)
    (desktop / 'open-browser.ico').write_bytes(struct.pack('<HHH', 0, 1, len(sizes)) + b''.join(entries + images))
resize(root / 'Docs/assets/open-browser-wordmark.png', 576, extension / 'open-browser-wordmark.png')
