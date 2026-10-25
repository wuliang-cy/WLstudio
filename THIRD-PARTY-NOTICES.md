# Third-Party Notices

WLstudio bundles the following third-party component. It is redistributed **unmodified**.

## Mozilla Firefox Developer Edition

- **Component**: `firefox-devedition-setup.exe` (Firefox Developer Edition, 64-bit, zh-CN)
- **Version**: 159.0b1
- **Copyright**: Copyright (c) Mozilla and individual contributors.
- **License**: Mozilla Public License, v. 2.0 (MPL 2.0) — <https://www.mozilla.org/MPL/2.0/>
- **Source**: The identical official binary, published by Mozilla at
  <https://download.mozilla.org/?product=firefox-devedition-latest-ssl&os=win64&lang=zh-CN>
- **Source code**: <https://hg.mozilla.org/releases/mozilla-beta/>

The binary is installed only when the user selects the optional "bridge browser" component
during setup. It is installed unmodified into the user's own `%LOCALAPPDATA%\WLstudio\firefox`
directory and is never placed over an existing Firefox installation.

### Why it is bundled

WLstudio's browser bridge can drive a real Firefox over the WebDriver BiDi protocol, which the
browser exposes when it is started with the standard `--remote-debugging-port` command-line flag.
Bundling the browser lets the bridge work out of the box.

### How it is used (no modification)

- The requested behavior is enabled **only** through standard Firefox command-line flags
  (`--remote-debugging-port`, `-profile`, `-no-remote`) and a per-user Firefox **profile**.
- A profile is a user-level data directory, not a change to the browser. The profile contains a
  `user.js` and a `userChrome.css` that hide Firefox's "remote control" indicator. Both are
  standard Firefox user-customization mechanisms and do not alter the redistributed browser files.
- WLstudio does not modify Firefox's program files, branding, default search engine, or any file
  covered by the Mozilla Public License.

### Trademarks

Firefox and the Firefox logos are trademarks of the Mozilla Foundation. WLstudio is an independent
project and is **not** affiliated with, endorsed by, or sponsored by Mozilla. The Firefox name and
logo are used only to identify the unmodified browser that is redistributed.

### License text

The full text of the Mozilla Public License 2.0 is available at
<https://www.mozilla.org/MPL/2.0/>. A copy will also be present in the installed Firefox
directory as `license.txt` after installation.

## Bundled plugin dependencies

WLstudio ships a small set of npm packages so that its document tools work out of the box. They are
redistributed unmodified; each package keeps its own license file inside its directory under
`seed/config/wlstudio/node_modules/`.

- `mammoth` — BSD-2-Clause
- `xlsx` (SheetJS) — Apache-2.0
- `adm-zip` — MIT
- `jszip` — MIT or GPLv3
- `@xmldom/xmldom` — MIT
- `codepage` — Apache-2.0
- plus their transitive dependencies (all MIT/BSD/Apache-2.0)

## Bundled tools

- `bkcrack` (ZIP known-plaintext attack) — redistributed unmodified under its own license, included
  alongside the binary as `seed/config/wlstudio/plugin/wuliang-zip-parse/bkcrack/license.txt`.

