# Evidence and reconstruction ledger

Inspected on 17 October 2026. Target: installed **LocalSend 1.17.0**, `C:\Program Files\LocalSend`.

## Observations

- The installed executable is 160,768 bytes, SHA-256 `83bad026583a847ab579cefc463627601b2c9341707bf0e0e8e3c21d20ae5949`. REA PE resource Evidence `ev_84d5144b0441e4c35e15c8554b27c15700e6c8a206ec24c9e45bbbcebaabac03` inventories nine resources and six icon candidates. Icon loading was not observed.
- The package contains `flutter_windows.dll`, `data/app.so`, Flutter assets, and native plugins for file selection, drag and drop, clipboard, tray, window management, and networking. Ordinary filesystem inventory establishes their presence, not their runtime use.
- The compiled Dart artifact `data/app.so` is 15,516,576 bytes, SHA-256 `1b3e063a64555b840a07aa8e589a51c26fb8e0fda23b086fd7b10af37b533444`. A bounded ordinary ASCII scan recorded offsets; raw extracted strings are excluded from this public source. Endpoint strings and translated UI labels provide corroboration, not control-flow proof.
- REA analyzed the actual packaged `assets/web` directory without executing it. Parent Evidence `ev_6ebabf426ede9a67a695cc3b733d1ef1268279c099d4d34362551816edc97607`; summary view `ev_a0068d14d4a3cc810c325ef676fd25d8e07d3052e366130b0ebe4382a9613413`. The root digest is `daad8cfa6e4f993c75c8a6654dd5172e89d0df748b46e1f25981acbf769e6a86`. Three relevant files and one JavaScript file were parsed, with no parse failures. Application inventory is complete within this directory. Semantic analysis reports 151 unknowns and is not runtime evidence.
- The packaged web JavaScript uses `/api/localsend/v2/prepare-download` and `/download`, sessionStorage session IDs, optional PINs, and explicit handling for 401, 403, and 429. Packaged CSS uses teal `#00796B` and `#009688`. These browser-sharing endpoints were observed but are not implemented in this rebuild.
- The packaged changelog identifies 1.17.0 (19 February 2025), and describes clear selection, text/history, receive folder, aliases, clipboard, streaming large files, and path traversal fixes across releases. Changelog claims describe intended original behavior; they were not exercised here.

The original local analysis bundle is excluded from this public source. No native target was opened, so no native session required closing.

## Implementation choices

The rebuilt app uses Electron and Node instead of Flutter because the workspace has Node but no Flutter SDK. Its interface follows the core Receive/Send/Settings workflow and teal visual language, with a new layout. The logo is copied from installed assets. Protocol behavior follows primary public documentation summarized in `PROTOCOL.md`.

The service streams file bytes to disk, requires approval by default, uses persistent self-signed certificates for mutual TLS, binds receive sessions to sender IP, checks per-file tokens, validates sizes and supplied checksums, prevents traversal, preserves duplicates, and records recent transfer history. The app has a context-isolated renderer and a fixed IPC bridge.

## Coverage checklist

| Question | Result |
|---|---|
| Identify installed target and resources | Answered, REA + ordinary installed-file inventory |
| Recover original Flutter source | Unresolved; not claimed |
| Inspect packaged browser-sharing code | Answered statically, REA Evidence above |
| Establish LAN protocol fields and routes | Answered from official protocol and source documentation |
| Rebuild core desktop workflows | Implemented as independent source |
| Verify actual byte transfer and boundary handling | Automated loopback integration tests; see VALIDATION.md |
| Match original every feature and pixel | Partial; neither exhaustive equivalence nor pixel identity claimed |
| Test with physical devices / original app | Unresolved |

## Limits

The connected REA Ghidra provider is unconfigured; it also reports that the installed Java 17 does not meet its Java 21 requirement. No unrelated analysis engine or Java upgrade was performed. Original native function bodies and UI runtime behavior were not decompiled or captured. Browser link sharing, PIN, favorites, original platform integrations, and global source equivalence remain outside this build's implemented scope.
