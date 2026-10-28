# Validation

Version 1.1.0 adds the Windows and Android UI refresh. The current matrix and commands are in `UI-VALIDATION-1.1.0.md`; the results below describe the underlying transport and desktop workflow checks retained by this update.

Date: 17 October 2026. Platform: Windows x64. Node 24.11.1. Electron 44.8.0.

## Service integration tests

`node --test test/service.test.js`: **12 passed, 0 failed**. These use independently created service instances, temporary workspace directories, actual HTTPS loopback sockets, and generated content.

- Self-signed certificate validity, matching private key, fingerprint, persistence.
- Mutual TLS registration with a correct client identity; spoofed fingerprint rejection.
- Rejection of HTTPS identity requests without a client certificate.
- Nested 160 KB binary file transferred and compared byte for byte.
- Duplicate filenames preserve the existing and incoming files.
- Manual approval keeps preparation pending and competing sessions receive 409.
- Manual rejection receives 403 and frees the receiver.
- Traversal, absolute paths, and Windows reserved filenames rejected before approval.
- SHA-256 mismatch receives 422 and removes the failed destination.
- Unauthorized token receives 403 and cannot write a file; correct token still works.
- Zero-byte file completes with an empty destination and full progress.
- Cancellation rejects later upload and allows a new session.

## Actual desktop workflow

The Electron renderer was run offscreen with its real context-isolated preload and IPC bridge. Tests exercised navigation, file-selection state, text submission, alias persistence, manual HTTPS device registration, sending through the device card, receiving through the approval modal, history, and dark mode. The receiving test instance's saved text was compared with the original text. Screenshots were rendered and visually inspected for Receive, Send, Settings, incoming approval, History, and Dark appearance.

The test runner is `scripts/ui-smoke.js`, invoked by launching the app with `LOCALSEND_UI_SMOKE` set to an output directory, `LOCALSEND_DATA_DIR` and `LOCALSEND_DOWNLOAD_DIR` set to isolated workspace directories, and `LOCALSEND_PORT=0`. The hidden test window required `--disable-gpu` for capture on this host. Offscreen rendering is enabled only for this test mode.

`npm run check` passes for the service, main process, preload, and renderer JavaScript.

The full desktop workflow also passed when launched from the finished portable `LocalSend Rebuilt.exe`, with its bundled runtime and application files. The final light and dark screenshots were visually inspected. Portable and source ZIP archives are CRC-checked after creation.

## Limits

Automated transfer tests use two instances of this new implementation. They do not establish physical-device interoperability, original LocalSend equivalence, multicast behavior across a Wi-Fi router, or host firewall permissions. Network discovery and v2 interoperability are implemented from the official protocol; testing with an original LocalSend device remains outstanding.
