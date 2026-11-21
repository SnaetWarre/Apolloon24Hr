"""Sample a visible X11 rectangle at 5ms cadence; emit changes, retain evidence."""
import ctypes as c
import hashlib
import json
import os
import sys
import time
from PIL import Image

x, y, width, height = map(int, sys.argv[1:5])
out = sys.argv[5]
lib = c.CDLL('libX11.so.6')
lib.XOpenDisplay.argtypes = [c.c_char_p]
lib.XOpenDisplay.restype = c.c_void_p
lib.XDefaultRootWindow.argtypes = [c.c_void_p]
lib.XDefaultRootWindow.restype = c.c_ulong
lib.XGetImage.argtypes = [c.c_void_p, c.c_ulong, c.c_int, c.c_int,
                          c.c_uint, c.c_uint, c.c_ulong, c.c_int]


class XImage(c.Structure):
    _fields_ = [('width', c.c_int), ('height', c.c_int), ('xoffset', c.c_int),
                ('format', c.c_int), ('data', c.c_void_p), ('byte_order', c.c_int),
                ('bitmap_unit', c.c_int), ('bitmap_bit_order', c.c_int),
                ('bitmap_pad', c.c_int), ('depth', c.c_int),
                ('bytes_per_line', c.c_int), ('bits_per_pixel', c.c_int)]


lib.XGetImage.restype = c.POINTER(XImage)
lib.XDestroyImage.argtypes = [c.POINTER(XImage)]
display = lib.XOpenDisplay(os.environ.get('DISPLAY', ':0').encode())
if not display:
    raise RuntimeError('Cannot open X display')
root = lib.XDefaultRootWindow(display)
previous = None
index = 0
last = time.time_ns() / 1e6
gaps = []
while True:
    began = time.monotonic()
    raw = lib.XGetImage(display, root, x, y, width, height, c.c_ulong(-1), 2)
    if not raw:
        raise RuntimeError('XGetImage failed')
    stamp = time.time_ns() / 1e6
    gaps.append(stamp - last)
    last = stamp
    frame = raw.contents
    if frame.bits_per_pixel != 32:
        raise RuntimeError('Sampler needs 32-bit X11 pixels')
    data = c.string_at(frame.data, frame.bytes_per_line * height)
    digest = hashlib.sha256(data).hexdigest()
    if digest != previous:
        Image.frombytes('RGB', (width, height), data, 'raw', 'BGRX',
                        frame.bytes_per_line).save(f'{out}/{index:05}.png')
        print(json.dumps({'at': stamp, 'hash': digest, 'index': index,
                          'maxGapMs': max(gaps), 'samples': len(gaps)}), flush=True)
        index += 1
        previous = digest
    if len(gaps) % 200 == 0:
        print(json.dumps({'sampleAt': stamp, 'maxGapMs': max(gaps),
                          'samples': len(gaps)}), flush=True)
    lib.XDestroyImage(raw)
    time.sleep(max(0, .005 - (time.monotonic() - began)))
