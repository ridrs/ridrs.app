<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->

# ADR 0006: Plugin File Discovery (`tinyglobby`)

We use **tinyglobby** (0.2.17, MIT) to discover plugin directories and `*/manifest.json` files under a plugin root directory. `tinyglobby` is a fast, lightweight, pure-JavaScript glob library with minimal transitive dependencies and no native addons, ensuring compatibility across macOS, Linux, and Termux/Node on Android. Alternatives considered included `fast-glob` and `globby` (both pull in significantly larger dependency trees) and manual `fs.readdir` recursion.
