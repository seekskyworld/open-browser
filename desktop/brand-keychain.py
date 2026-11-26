#!/usr/bin/env python3
"""Apply the macOS Keychain service-name source patch to a staged CfT 159 app.

The matching upstream source edit is in patches/chromium-macos-keychain-service.patch.
Digests are from the official chrome-for-testing-public/159.0.8154.6/mac-{arm64,x64}
archives. The input and output digests cover the complete, pre-codesign framework.
"""
import argparse
import hashlib
import mmap
import os
from pathlib import Path
import plistlib
import stat
import struct
from tempfile import NamedTemporaryFile

VERSION = '159.0.8154.6'
REVISION = '98a2592026af8d673b9fa83b626ac68bdf4ae78a'
FRAMEWORK = 'Google Chrome for Testing Framework'
SOURCE = b'Chromium Safe Storage'
PRODUCT = b'open-browser Keychain'
# Mach CPU type -> offset in __TEXT,__const, input hash, branded hash.
RELEASE = {
    0x0100000C: (225772584, 'a0a2e8854ce90268f5d9b32210cf53fc0709f4b798b3c3a96964ba3ebce4bc4b',
                 'c9a9477055677cf37ee0872c6c0077a562dfefb7f5315832c1f022aa75a7bc33'),
    0x01000007: (246160880, 'cdc858707b7fbf3144528c2c2ee4bd7a2d9a107b7964b6069faf84ac0b0ed894',
                 '1ac99579ee9459c917d8463140dc3f44cde520e4357bf058584f51b783675ef9'),
}


def in_readonly_constants(data, offset):
    command = 32  # mach_header_64
    for _ in range(struct.unpack_from('<I', data, 16)[0]):
        kind, length = struct.unpack_from('<II', data, command)
        if kind == 0x19:  # LC_SEGMENT_64
            protections, count = struct.unpack_from('<II', data, command + 60)
            for n in range(count):
                section = command + 72 + 80 * n
                name, segment, _, size, start = struct.unpack_from('<16s16sQQI', data, section)
                flags, = struct.unpack_from('<I', data, section + 64)
                if (name.rstrip(b'\0') == b'__const' and segment.rstrip(b'\0') == b'__TEXT'
                        and not protections & 2 and not flags & 0x80000400
                        and start <= offset and offset + len(SOURCE) < start + size):
                    return True
        command += length
    return False


def brand(bundle):
    bundle = bundle.resolve(strict=True)
    with (bundle / 'Contents/Info.plist').open('rb') as stream:
        info = plistlib.load(stream)
    if (bundle.name != 'open-browser.app' or info.get('CFBundleIdentifier') != 'local.open-browser.chromium'
            or info.get('CFBundleShortVersionString') != VERSION
            or info.get('SCMRevision', '').split('-')[0] != REVISION):
        raise ValueError('Expected the staged open-browser Chromium bundle at the pinned upstream revision')
    binary = bundle / 'Contents/Frameworks' / (FRAMEWORK + '.framework') / 'Versions' / VERSION / FRAMEWORK
    if binary.resolve(strict=True) != binary:
        raise ValueError('Expected a regular framework binary inside the staged bundle')
    with binary.open('rb') as source, mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_COPY) as data:
        magic, cpu = struct.unpack_from('<II', data)
        if magic != 0xFEEDFACF or cpu not in RELEASE:
            raise ValueError('Unrecognized framework architecture')
        offset, before, after = RELEASE[cpu]
        digest = hashlib.sha256(data).hexdigest()
        if digest == after:
            return
        if digest != before:
            raise ValueError('Framework SHA-256 differs from the reviewed official release')
        if (len(SOURCE) != len(PRODUCT) or not in_readonly_constants(data, offset)
                or data[offset-1:offset+len(SOURCE)+10] != b'\0' + SOURCE + b'\0Chromium\0'
                or data.find(SOURCE) != offset or data.find(SOURCE, offset + 1) != -1):
            raise ValueError('Unexpected keychain service constant layout')
        data[offset:offset+len(SOURCE)] = PRODUCT
        if hashlib.sha256(data).hexdigest() != after:
            raise ValueError('Unexpected branded framework digest')
        # Publish a fully verified copy atomically, even for hardlinked input.
        with NamedTemporaryFile(dir=binary.parent, prefix='.open-browser-keychain-', delete=False) as temp:
            staged = Path(temp.name)
            try:
                temp.write(data)
                temp.flush()
                os.fchmod(temp.fileno(), stat.S_IMODE(os.fstat(source.fileno()).st_mode))
                os.fsync(temp.fileno())
                os.replace(staged, binary)
            finally:
                if staged.exists():
                    staged.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    brand(parser.parse_args().bundle)
