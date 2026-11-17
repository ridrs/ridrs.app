# SPDX-License-Identifier: AGPL-3.0-or-later
"""Minimal GeoTIFF reader, numpy + zlib only (no GDAL), from a local file or over HTTP range requests (Cloud-Optimised GeoTIFF).

Supported, everything else is refused (UnsupportedTiff), never guessed:
- classic TIFF and BigTIFF, the full-resolution image (IFD 0), one sample per pixel;
- tiled or striped layout;
- compression none (1), LZW (5), DEFLATE (8, 32946);
- predictor 1, 2 (horizontal differencing, integer data) or 3 (floating point);
- data types uint8, int16, uint16, int32, float32, float64;
- georeferencing by ModelPixelScale + ModelTiepoint or by a ModelTransformation without rotation; RasterType (PixelIsArea / Point);
- the GDAL nodata tag; nodata pixels become NaN.
`epsg` is read from the GeoKeys (ProjectedCSType 3072 or GeographicType 2048), None if absent."""
from __future__ import annotations

import struct
import urllib.request
import zlib
from pathlib import Path

import numpy as np

UA = "video2gpx-dem/1.0 (open elevation data, on-demand download)"


class UnsupportedTiff(ValueError):
    pass


_TYPES = {1: ("B", 1), 2: ("s", 1), 3: ("H", 2), 4: ("I", 4), 5: ("II", 8), 6: ("b", 1), 8: ("h", 2), 9: ("i", 4), 11: ("f", 4), 12: ("d", 8),
          16: ("Q", 8), 17: ("q", 8)}
_DTYPES = {(8, 1): "u1", (16, 2): "i2", (16, 1): "u2", (32, 2): "i4", (32, 3): "f4", (64, 3): "f8"}


class FileSource:
    def __init__(self, path):
        self.path = Path(path)
        self.name = self.path.name
        self.f = open(self.path, "rb")

    def read(self, off: int, n: int) -> bytes:
        self.f.seek(off)
        return self.f.read(n)

    def close(self):
        self.f.close()


class HttpSource:
    """byte ranges of a remote file; the first 64 KiB (the header of a COG) are fetched once and reused. `bytes_read` counts the transfer."""

    def __init__(self, url: str, timeout: float = 60.0, head: int = 65536):
        self.url, self.name, self.timeout = url, url.rsplit("/", 1)[-1], timeout
        self.bytes_read = 0
        self._head = self._get(0, head)

    def _get(self, off: int, n: int) -> bytes:
        last = None
        for _ in range(3):
            try:
                rq = urllib.request.Request(self.url, headers={"User-Agent": UA, "Range": f"bytes={off}-{off + n - 1}"})
                with urllib.request.urlopen(rq, timeout=self.timeout) as r:
                    b = r.read()
                    if r.status == 200 and off > 0:              # server ignored the range: cut the window out
                        b = b[off:off + n]
                self.bytes_read += len(b)
                return b
            except OSError as e:                                 # URLError, timeouts, resets
                last = e
        raise OSError(f"{self.name}: {last}")

    def read(self, off: int, n: int) -> bytes:
        if off + n <= len(self._head):
            return self._head[off:off + n]
        return self._get(off, n)

    def close(self):
        pass


def lzw_decode(data: bytes) -> bytes:
    """TIFF LZW (MSB-first codes of 9 to 12 bits, Clear 256, EOI 257, 'early change')"""
    total = len(data) * 8
    buf = bytes(data) + b"\0\0\0"
    out = bytearray()
    table = [bytes((i,)) for i in range(256)] + [b"", b""]
    nbits, pos, prev = 9, 0, None
    while pos + nbits <= total:
        i = pos >> 3
        w = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]
        code = (w >> (24 - nbits - (pos & 7))) & ((1 << nbits) - 1)
        pos += nbits
        if code == 256:
            del table[258:]
            nbits, prev = 9, None
            continue
        if code == 257:
            break
        if prev is None:
            s = table[code]
        elif code < len(table):
            s = table[code]
            table.append(prev + s[:1])
        elif code == len(table):
            s = prev + prev[:1]
            table.append(s)
        else:
            raise UnsupportedTiff(f"LZW: bad code {code}")
        out += s
        prev = s
        n = len(table)
        if n >= 511 and nbits == 9 or n >= 1023 and nbits == 10 or n >= 2047 and nbits == 11:
            nbits += 1
    return bytes(out)


def undo_fp_predictor(b: np.ndarray, w: int, h: int, bo: str = "<", size: int = 4) -> np.ndarray:
    """TIFF predictor 3 (floating point): per row, the bytes were split into planes (most significant byte first) and
    horizontally differenced byte-wise. Undo: cumulative sum per row (mod 256), regroup the planes."""
    rows = b.reshape(h, size * w)
    rows = np.cumsum(rows, axis=1, dtype=np.uint8)            # wraps mod 256
    planes = rows.reshape(h, size, w)                           # plane 0 = most significant byte
    be = np.ascontiguousarray(planes.transpose(0, 2, 1)).reshape(h, w * size)
    return be.view(">f4" if size == 4 else ">f8").reshape(h, w).astype(np.float32)


class Tiff:
    """one GeoTIFF, read lazily (only the internal tiles or strips that are sampled are decoded). `src`: a path, a FileSource or an HttpSource."""

    def __init__(self, src, clamp: bool = True):
        self.src = src if hasattr(src, "read") else FileSource(src)
        self.path = Path(getattr(self.src, "path", self.src.name))
        self.clamp = clamp
        nm = self.src.name
        head = self.src.read(0, 16)
        if head[:2] == b"II":
            self.bo = "<"
        elif head[:2] == b"MM":
            self.bo = ">"
        else:
            raise UnsupportedTiff(f"{nm}: not a TIFF")
        magic = struct.unpack(self.bo + "H", head[2:4])[0]
        if magic == 42:
            self.big = False
            off = struct.unpack(self.bo + "I", head[4:8])[0]
        elif magic == 43:
            bs, zero = struct.unpack(self.bo + "HH", head[4:8])
            if bs != 8 or zero != 0:
                raise UnsupportedTiff(f"{nm}: malformed BigTIFF header")
            self.big = True
            off = struct.unpack(self.bo + "Q", head[8:16])[0]
        else:
            raise UnsupportedTiff(f"{nm}: unknown magic {magic}")
        t = self._ifd(off)

        def need(k):
            if k not in t:
                raise UnsupportedTiff(f"{nm}: tag {k} missing")
            return t[k]
        self.W, self.H = int(need(256)[0]), int(need(257)[0])
        bits, comp = int(need(258)[0]), int(t.get(259, [1])[0])
        fmt, spp = int(t.get(339, [1])[0]), int(t.get(277, [1])[0])
        self.pred = int(t.get(317, [1])[0])
        if spp != 1:                                              # (PlanarConfiguration does not matter for one sample)
            raise UnsupportedTiff(f"{nm}: only single-band images are supported (samples {spp})")
        if (bits, fmt) not in _DTYPES:
            raise UnsupportedTiff(f"{nm}: sample type bits {bits} format {fmt} not supported")
        self.dtype = np.dtype(self.bo + _DTYPES[(bits, fmt)])
        if comp not in (1, 5, 8, 32946):
            raise UnsupportedTiff(f"{nm}: compression {comp} not supported")
        if self.pred not in (1, 2, 3) or (self.pred == 3 and fmt != 3) or (self.pred == 2 and fmt == 3):
            raise UnsupportedTiff(f"{nm}: predictor {self.pred} not supported for format {fmt}")
        self.comp = comp
        if 322 in t:
            self.tw, self.th = int(t[322][0]), int(t[323][0])
            self.offs, self.cnts = list(need(324)), list(need(325))
            self.striped = False
        elif 273 in t:
            self.tw, self.th = self.W, int(t.get(278, [self.H])[0])
            self.offs, self.cnts = list(need(273)), list(need(279))
            self.striped = True
        else:
            raise UnsupportedTiff(f"{nm}: neither tiles nor strips")
        self.ntx = -(-self.W // self.tw)
        raster_type, self.epsg = 1, None
        if 34735 in t:
            gk = t[34735]
            for q in range(int(gk[3])):
                kid, loc, _cnt, val = gk[4 + 4 * q: 8 + 4 * q]
                if loc != 0:
                    continue
                if kid == 1025:
                    raster_type = int(val)
                elif kid in (3072, 2048) and 1024 < int(val) < 32767:
                    self.epsg = int(val) if kid == 3072 or self.epsg is None else self.epsg
        if 33550 in t and 33922 in t:
            sc, tp = t[33550], t[33922]
            self.dx, self.dy = float(sc[0]), float(sc[1])
            i0, j0, x0, y0 = float(tp[0]), float(tp[1]), float(tp[3]), float(tp[4])
        elif 34264 in t:
            m = t[34264]
            if abs(m[1]) > 1e-12 or abs(m[4]) > 1e-12:
                raise UnsupportedTiff(f"{nm}: rotated ModelTransformation not supported")
            self.dx, self.dy, i0, j0, x0, y0 = float(m[0]), -float(m[5]), 0.0, 0.0, float(m[3]), float(m[7])
        else:
            raise UnsupportedTiff(f"{nm}: no georeferencing")
        half = 0.5 if raster_type == 1 else 0.0
        self.x00 = x0 + (0 - i0 + half) * self.dx                # model coordinates of the centre of pixel (0, 0)
        self.y00 = y0 - (0 - j0 + half) * self.dy
        self.nodata = None
        if 42113 in t:
            try:
                self.nodata = float(bytes(t[42113]).decode().strip("\x00 "))
            except (ValueError, TypeError):
                pass
        self._cache: dict[int, np.ndarray] = {}

    def _ifd(self, off: int) -> dict:
        bo, big = self.bo, self.big
        if big:
            n = struct.unpack(bo + "Q", self.src.read(off, 8))[0]
            raw, es, pre = self.src.read(off + 8, 20 * n), 20, "HHQ"
        else:
            n = struct.unpack(bo + "H", self.src.read(off, 2))[0]
            raw, es, pre = self.src.read(off + 2, 12 * n), 12, "HHI"
        lim = 8 if big else 4
        out = {}
        for k in range(n):
            e = raw[es * k: es * (k + 1)]
            tag, typ, cnt = struct.unpack(bo + pre, e[:es - lim])
            if typ not in _TYPES:
                continue
            ch, size = _TYPES[typ]
            nbytes = size * cnt
            val = e[es - lim:]
            if nbytes > lim:
                val = self.src.read(struct.unpack(bo + ("Q" if big else "I"), val)[0], nbytes)
            if typ == 2:
                out[tag] = list(val[:cnt])
            else:
                c = ch * cnt if typ != 5 else "I" * (2 * cnt)
                out[tag] = list(struct.unpack(bo + c, val[:nbytes]))
        return out

    def _decode(self, b: bytes, h: int) -> np.ndarray:
        if self.comp in (8, 32946):
            b = zlib.decompress(b)
        elif self.comp == 5:
            b = lzw_decode(b)
        w, sz = self.tw, self.dtype.itemsize
        n = w * h
        if len(b) < sz * n:
            raise UnsupportedTiff(f"{self.src.name}: block has {len(b)} bytes, expected {sz * n}")
        b = b[:sz * n]
        if self.pred == 3:
            return undo_fp_predictor(np.frombuffer(b, np.uint8), w, h, self.bo, sz)
        a = np.frombuffer(b, self.dtype).reshape(h, w)
        if self.pred == 2:
            a = np.cumsum(a, axis=1, dtype=a.dtype)                 # integer wrap-around is what the encoder relied on
        return a.astype(np.float32)

    def tile(self, k: int) -> np.ndarray:
        a = self._cache.get(k)
        if a is not None:
            return a
        b = self.src.read(int(self.offs[k]), int(self.cnts[k]))
        h_last = self.H - (k // self.ntx) * self.th
        if self.striped and h_last < self.th:                     # the last strip holds only the remaining rows
            a = np.vstack([self._decode(b, h_last), np.full((self.th - h_last, self.tw), np.nan, np.float32)])
        else:
            a = self._decode(b, self.th)
        if self.nodata is not None:
            a = np.where(a == self.nodata, np.nan, a)
        if len(self._cache) > 64:
            self._cache.clear()
        self._cache[k] = a
        return a

    def pixel(self, r: np.ndarray, c: np.ndarray) -> np.ndarray:
        r, c = np.asarray(r, np.int64), np.asarray(c, np.int64)
        out = np.full(len(r), np.nan, np.float32)
        inside = (r >= 0) & (r < self.H) & (c >= 0) & (c < self.W)
        if self.clamp:
            r, c, inside = np.clip(r, 0, self.H - 1), np.clip(c, 0, self.W - 1), np.ones(len(r), bool)
        k = (r // self.th) * self.ntx + (c // self.tw)
        for kk in np.unique(k[inside]):
            m = inside & (k == kk)
            out[m] = self.tile(int(kk))[r[m] % self.th, c[m] % self.tw]
        return out

    def window(self, r0: int, c0: int, h: int, w: int) -> np.ndarray:
        rr, cc = np.meshgrid(np.arange(r0, r0 + h), np.arange(c0, c0 + w), indexing="ij")
        return self.pixel(rr.ravel(), cc.ravel()).reshape(h, w)

    def sample(self, x, y) -> np.ndarray:
        """bilinear between pixel centres, in the file's own coordinates (x = lon or easting); edges clamp (clamp=True) or give NaN"""
        fx = (np.asarray(x, float) - self.x00) / self.dx
        fy = (self.y00 - np.asarray(y, float)) / self.dy
        c0 = np.floor(fx).astype(np.int64); r0 = np.floor(fy).astype(np.int64)
        ax, ay = fx - c0, fy - r0
        v00, v01 = self.pixel(r0, c0), self.pixel(r0, c0 + 1)
        v10, v11 = self.pixel(r0 + 1, c0), self.pixel(r0 + 1, c0 + 1)
        return (v00 * (1 - ax) * (1 - ay) + v01 * ax * (1 - ay) + v10 * (1 - ax) * ay + v11 * ax * ay).astype(float)

    def close(self):
        self.src.close()
