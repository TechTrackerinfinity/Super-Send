# Android evidence and validation ledger

The original reconstruction evidence below is retained as a historical record. Version 1.1.0 adds a native UI refresh and host-based native screen tests; its release checks are recorded at the end of this file and in the project `docs/UI-VALIDATION-1.1.0.md`.

Date: 17 October 2026.

## Supplied artifact

User-selected path: `<local downloads>/LocalSend-1.18.2-android-arm64v8.apk`.

REA opened the APK as a ZIP-backed package, SHA-256 `82ec3568fba2aa5295b9aae8b76f701d7a4703d86b9f8bad749472038fbaeab3`. Archive inspection Evidence `ev_d6d9b91193a6f285e114cc76dced1bf59f24f63e6bc65033fffd79a24fa091e3`, inventory Evidence `ev_95f7b1d9dcbd4b4938aa8e040c5a0244728584f6aacdd01f4c8338eafd658fad`. Coverage is complete within archive inventory, with no omitted observations. This does not establish code semantics or execution. The archive reports case-folding name collisions, so it was not blindly extracted to a case-insensitive directory. Raw local artifact evidence is excluded from this public source.

REA's Android/JADX inspection is unavailable because no `REA_JADX_MCP_JAR` is configured. No Android source recovery or native Flutter decompilation is claimed.

The official Android SDK's `aapt dump badging` independently reads the original binary manifest: package `org.localsend.localsend_app`, version `1.18.2`, versionCode `643`, minimum SDK 24, target SDK 37, ARM64 native libraries. The original declares local-network, storage/media, foreground-service, wake-lock, notification, installer, and other platform permissions; see `original-apk-badging.txt`. These are static declarations, not evidence that every permission is exercised.

## Reconstruction decisions

The new app uses native Android Java, package `org.localsend.rebuilt`, minimum SDK 26 and target SDK 36. It shares the PC rebuild's v2 protocol rather than modifying or resigning the supplied original APK. A persistent Android Keystore identity supplies TLS server and client certificates. Java streaming transport is separate from Android UI and document storage.

Android 16/target 36 local networking is available through `INTERNET`; the official [local-network permission guide](https://developer.android.com/privacy-and-security/local-network-permission) explicitly directs apps targeting SDK 36 or below not to request `ACCESS_LOCAL_NETWORK`. A future target-37 update must add the new runtime permission flow.

The visible service uses `connectedDevice`, matching interactions with devices over a network, with `CHANGE_WIFI_MULTICAST_STATE` satisfying the declared prerequisite. See the official [foreground-service types](https://developer.android.com/develop/background-work/services/fgs/service-types#connected-device). Documents use system pickers and MediaStore rather than broad storage permission; see [Android document access](https://developer.android.com/training/data-storage/shared/documents-files).

## Verification boundary

The JVM/PC interoperability suite passed 11 tests (one parent and ten subtests), using the exact `TransferEngine.java` compiled for the APK against the PC's `src/service.js`. Real loopback mutual TLS carried generated binary files in both directions, with manual approval, UTF-8 text, rejection and retry, duplicate preservation, traversal rejection, certificate identity checks, invalid tokens, checksum failure cleanup, zero-byte files, and session cancellation. Binary outputs were compared byte for byte. The Java engine is compiled for Java 8 compatibility with Java 17.

The complete Android app compiled against SDK 36, passed D8 conversion, and produced `LocalSend-Rebuilt-Android-1.0.0.apk` (70,393 bytes). APK Signature Schemes v2 and v3 verify successfully; 4-byte ZIP alignment verifies. The app uses Java/Dalvik bytecode with no ABI-specific native libraries. Manifest inspection confirms package `org.localsend.rebuilt`, minimum SDK 26, target SDK 36, launcher activity, and foreground-service declaration. Verification output is retained in `apk-signature-verification.txt` and `rebuilt-apk-badging.txt`.

Original 1.0.0 APK SHA-256: `9eb174a3ed83c21770064a7c451dcf01c071382609c74241d5b7c9f5d578e486`. REA archive inspection Evidence `ev_7a81b6401098a1fc4f3e56e7f512569f72c82b0b1debb1dfe6b0341c38ca09bd` has complete inventory coverage within substeps, no omitted observations, and no case-folding collision warning. Its bundle is `rea-rebuilt-apk-evidence.json`. Archive inspection does not verify signatures; that check is performed separately by the official Android `apksigner`. The REA target was closed after inspection.

Code review corrected older-Android duplicate destination reservation, SAF failed-file cleanup, and terminal service executor cleanup. Android Keystore authorization includes `DIGEST_NONE` and raw RSA padding needed by TLS stacks, following the official [Keystore builder documentation](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder#setDigests(java.lang.String...)).

No phone or emulator was connected when `adb devices -l` was checked. Cross-language engine tests exercise the actual Java transport source but do not validate Android-specific lifecycle, Keystore, document providers, native screen layout, notifications, or router multicast behavior.

## Version 1.1.0 UI and release validation

The refreshed native interface passed five Robolectric native-graphics test methods on SDK 35, including 32 theme/size/page renders, enlarged text, phone/tablet/landscape layouts, stable progress controls and scroll position, history search, themed dialogs with inline validation, and a scrollable connection form at landscape height. Screenshots were visually reviewed. The simulated service/storage context isolates UI behavior; this is not a real-device installation or a test of Android Keystore, system pickers, notifications, keyboards, Wi-Fi multicast, or Android 16 lifecycle behavior. An attempted local emulator did not boot, and no physical phone was connected.

`LocalSend-Rebuilt-Android-1.1.0.apk`: 82,681 bytes, package `org.localsend.rebuilt`, versionCode 2, minimum SDK 26, target SDK 36, no ABI-specific native libraries. SHA-256: `9e401b673d2c14b031a936cab7839b246e4bb3a3d67311b3967c214eba786c31`. Official `apksigner` verifies v2 and v3 signatures; `zipalign` verifies 4-byte alignment. Signer SHA-256 remains `0a704156883984de2cb788aac20a5bd366e6333462b3658c8c79d9913a82cb67`, allowing an in-place update of the previous rebuilt app. Current tool output is in `apk-signature-verification-1.1.0.txt` and `rebuilt-apk-badging-1.1.0.txt`. The transport regression suite remains green: 12 PC tests and 11 Java/Node checks.
