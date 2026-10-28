# Super Send 1.4.0

This release renames the Windows and Android apps to Super Send and replaces the former logo with an original bullet-train mark. Midnight navy, electric blue, and mint accents are shared across both interfaces. Light/dark appearance, keyboard focus, readable labels, scrolling, approval, cancellation, and transfer progress remain available.

The three Windows controls requested for removal (Configure receiving, Check status, and Open Windows Firewall), the related setup dialog, and their renderer IPC methods have been removed. Startup no longer invokes Windows receiving-status checks. Receive and Settings instead show a phone connection panel with a single Connect Android phone action and actual connection state. Removing these controls does not create or remove host firewall rules. The installer/uninstaller retains cleanup support for rules created by older releases.

## Update compatibility

Android keeps application ID `org.localsend.rebuilt`, the existing private APK signer, Android Keystore identity alias, preferences, and transfer protocol. Version code is 4, version name 1.4.0. Install the new APK over the existing rebuilt app; uninstalling first would discard its private app data.

Windows uses `Super Send.exe`, a Super Send Start menu shortcut, new executable version metadata, and the train icon in the executable and installer. The installer honors the previous installation's registered directory, replaces the old launcher, and updates its existing uninstall entry to display Super Send. Existing settings, device certificates, history and remembered phones stay in the legacy internal `%APPDATA%\LocalSend Rebuilt` directory for update compatibility. New installed download folders are named Super Send; an existing configured receive folder is preserved. The installer requires an existing app window to close before updating. Uninstall cleanup checks app-owned rules for both old and new launcher names and preserves settings/downloads.

## Artwork

Generated with the built-in imagegen tool. The original image was inspected and copied into the project. The generated artwork was only resized or converted to platform icon formats, without retouching.

- Editable delivery master: `renderer/assets/super-send-master.png`.
- Shared Windows UI/window asset: `renderer/assets/logo.png`.
- Windows executable/installer icon: `renderer/assets/super-send.ico`.
- Android launcher/UI asset: `android/app/src/main/res/drawable/logo.png`.
- Android notification: a separate monochrome train vector in `ic_notification.xml`.

Generation prompt:

> Use case: logo-brand. Asset: production app icon for a local file transfer app named Super Send. Create a single polished square app icon, 1024 by1024. A bold original geometric bullet-train nose in dynamic front three-quarter view, traveling toward the upper right, a sleek long aerodynamic silver-white train with a dark navy windshield, a tiny electric-blue accent and three short mint speed streaks on its left. Beautiful clean flat vector-like design, crisp broad silhouettes, readable at24pixels, minimal details. Place it centered with generous padding, occupying about70percent of the canvas on a solid deep midnight navy #101A30 square background. Use vivid electric-blue #4D76FF and mint #43E2B1 accents. The train silhouette should be distinctive and futuristic, visually suggest speed and reliability. No text, no letters, no watermarks, no circles, no scenery, no rails, no 3D rendering, no mockup, no shadows outside the silhouette. Full-bleed square background; avoid baked-in rounded outer corners because platforms mask the icon.

Windows resource branding uses official Electron [rcedit v2.0.0](https://github.com/electron/rcedit/releases/tag/v2.0.0); its download URL and SHA-256 are recorded in `rcedit-build-tool.json`. Set `RCEDIT_PATH` when building elsewhere. The compiler/tool binaries and Android signing credentials are excluded from source distributions.

## Verification boundary

The existing v1.3 PC-initiated Android transfer path is retained. Network/security regressions and native Android view checks are run again, along with packaged Windows checks for the removed controls, new identity, both connection states and themes, small windows and 150% zoom. Results are recorded in `VALIDATION-1.4.0.json`.

These are host-based checks. A physical phone transfer and real installation/update/uninstallation are still deployment acceptance checks. The Windows distribution remains unsigned; APK signing is the same independent project identity as before. This visual refresh does not add QR/PIN identity verification or claim an independent security audit.
