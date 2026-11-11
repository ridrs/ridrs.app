<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# MRC test vectors

MRC is the percent-of-FTP variant of the course file format (`MINUTES PERCENT`); see `../erg/README.md` for the format and its sources. All files are hand-written for ridrs from the format as the files and TrainerRoad's help article show it, CC-BY-SA-4.0, written for ridrs. A public file (colinligertwood/erg-files, `10-minute-ramp-test.mrc`) was looked at for the shape of such a ramp test, but it states no licence, so it is not included and `steps-ramp-test.mrc` is written afresh.

| File                      | What it shows                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `steps-ramp-test.mrc`     | Percent, a staircase of steady steps and jumps                                                                                    |
| `over-unders.mrc`         | A ramp, jumps, `FTP`, course text                                                                                                 |
| `missing-end-markers.mrc` | The closing markers are missing: imported without a warning, the file ends where the data ends                                    |
| `negative-value.mrc`      | A negative value: refused (`bad-point`)                                                                                           |
| `no-column-line.mrc`      | No `MINUTES ...` line (read as percent, with a warning), a bad `FTP`, course texts before the start, after the end and unreadable |

Each `<name>.golden.json` is the expected result of the import, checked by hand against the file.
