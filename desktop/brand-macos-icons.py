"""Update the staged browser and its notification helpers before code signing."""
from pathlib import Path
import os
import plistlib
import shutil
import sys

app = Path(sys.argv[1])
root = Path(__file__).resolve().parents[1]
for contents in [app / 'Contents', *app.glob('Contents/Frameworks/*.framework/Versions/[0-9]*/Helpers/*.app/Contents')]:
    path = contents / 'Info.plist'
    with path.open('rb') as file:
        info = plistlib.load(file)
    if 'CFBundleIconFile' in info:
        shutil.copyfile(root / 'desktop/icons/open-browser.icns', contents / 'Resources' / info['CFBundleIconFile'])
        # On macOS 26 IconServices prefers this CFT icon-only catalog even
        # without CFBundleIconName, masking the replacement ICNS.
        (contents / 'Resources/Assets.car').unlink(missing_ok=True)
        info.pop('CFBundleIconName', None)
        path.write_bytes(plistlib.dumps(info))
        # ditto preserves the upstream bundle date, which IconServices caches.
        os.utime(contents.parent, None)
for image in app.glob('Contents/Frameworks/*.framework/Versions/[0-9]*/Resources/product_logo_32.png'):
    shutil.copyfile(root / 'browser-extension/icons/open-browser-32.png', image)
