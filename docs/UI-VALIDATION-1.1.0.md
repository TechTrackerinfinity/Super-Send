# UI validation — version 1.1.0

Date: 17 October 2026. Both apps keep their existing transfer protocol and storage behavior.

## Windows

The rebuilt interface uses a consistent light/dark palette, larger text, higher contrast secondary labels, responsive cards, wrapping device/file names, and reachable settings at compact window sizes. Native title-bar appearance follows the selected theme. Modal dialogs isolate the background, focus the form, handle Escape, and return focus to the opener. State updates reconcile existing controls so typing, selection, and keyboard focus survive progress events. Notifications are capped at three.

`scripts/ui-audit.js` runs the actual Electron workflow first, using the context-isolated preload and real IPC and loopback HTTPS. It then checks all four pages at four viewport/zoom combinations in light and dark modes: 32 layout cases. Four further checks cover input identity/draft/cursor persistence, modal focus and Escape, an actual incoming request with a long Unicode filename and keyboard rejection, and secondary text contrast of at least 4.5:1. Screenshots are reviewed for spacing, readability, dialogs, and clipping.

The final portable executable is tested with these environment variables and `--disable-gpu`:

```powershell
$env:LOCALSEND_UI_SMOKE = '<project>\test-output\ui-audit-final'
$env:LOCALSEND_UI_AUDIT = '1'
$env:LOCALSEND_DATA_DIR = '<project>\test-output\ui-audit-final-data'
$env:LOCALSEND_DOWNLOAD_DIR = '<project>\test-output\ui-audit-final-received'
$env:LOCALSEND_PORT = '0'
$env:LOCALSEND_ALLOW_MULTIPLE = '1'
& '.\release\LocalSend-Rebuilt-1.1.0-win32-x64\LocalSend Rebuilt.exe' --disable-gpu
```

The audit writes `audit.json`, layout PNGs, and the preceding workflow's screenshots to its output directory. Tests use generated data and isolated settings.

Final result: the packaged executable exited successfully, its complete workflow passed, and all 36 layout/interaction checks passed. The final light, dark, compact, and long-filename approval screenshots were reviewed.

## Android

The native Java UI now has vector icons, consistent cards and touch targets, system/light/dark themes, bottom navigation, readable long names, and tablet/landscape layouts. Receive and Send show active transfers. History supports search, All/Received/Sent filters, and expandable details. Progress updates change existing progress controls without replacing the page. Dialog errors remain visible inline; manual connection stays open while connecting or on failure. Forms scroll when the available height is small.

`NativeUiTest.java` runs with Robolectric 4.17 native graphics and SDK 35 on Java 17. Five test methods cover:

- 32 native screen renders: four tabs, two themes, 360×740 phone, 412×892 phone at 1.5× text, 800×1000 tablet, and 740×360 landscape.
- Progress updates preserving the same Cancel control and scroll position.
- History search preserving the input and filtering results.
- Light/dark manual connection, message, and incoming dialogs; missing-IP and blank-message validation.
- A connection form at landscape height with enlarged text, scrollable fields, and a reachable Connect button.

Run `gradle :app:testDebugUnitTest --console=plain` from `android/`. Images are written to `android/test-output/native-ui/`. The app itself compiles against SDK 36, minimum SDK 26. The APK has versionCode 2 and retains the previous package/signing identity for installation as an update.

Final result: five tests passed, zero failures/errors/skips. The signed APK is 82,681 bytes, SHA-256 `9e401b673d2c14b031a936cab7839b246e4bb3a3d67311b3967c214eba786c31`; signatures v2/v3 and 4-byte alignment verify successfully.

## Transfer regression and scope

The 12 PC service integration tests and 11 Java/Node interoperability checks pass. They use actual loopback mutual TLS, exercise binary and text transfers, and compare received content. JavaScript syntax checks pass. APK signatures and ZIP alignment are checked by the official Android build tools; source and portable ZIP files are CRC-checked.

Windows UI automation executes the actual bundled desktop app. Android UI tests execute the real Activity and native view drawing with simulated service/storage state; they are host tests, not a phone installation. This host had no connected phone, and its emulator did not boot. Physical-device lifecycle, system keyboards and document pickers, Keystore, notifications, Android 16 behavior, router multicast, and firewall behavior remain outside automated UI coverage. User-reported working transfers are preserved; this report does not claim exhaustive device compatibility or equivalence to the original app.
