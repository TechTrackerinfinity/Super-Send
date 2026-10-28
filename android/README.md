# Super Send for Android

An independent Android companion for the rebuilt Windows app. It implements the same LocalSend v2 HTTPS transfer protocol with native Android file selection, receive approval, and streaming storage. The APK contains no native CPU libraries, so one package works on ARM64, ARMv7, and x86 Android devices running Android 8.0 or newer.

## Install and transfer

1. Copy `../release/Super-Send-Android-1.6.0.apk` to your phone and open it. If Android asks, allow installation from the browser or file manager you used, then complete installation. This version updates the earlier rebuilt APK in place, preserving app data; keep the previous installation installed.
2. Open **Super Send** on the phone and the rebuilt app on the PC. Connect both to the same Wi-Fi/local network. Allow the app's notification so its receiver can stay available while transferring.
3. Use version 1.6.0 on both devices for parallel file batches and reduced progress-update overhead. It retains discovery refresh after switching between Wi-Fi and an Android phone hotspot. On the PC, choose **Connect Android phone** (or **Send → Add device**) with the phone’s displayed address and port, then wait for **Phone connected**. This lets the PC receive when incoming PC connections are blocked.
4. On the sending device, choose **Send**, select files or add text, and select the other device. Approve the request on the receiving device.
5. If discovery does not find the other device, use **Add device** with the IP, HTTPS, and port displayed by the other app. Default port is 53317; the PC may show another port when 53317 was already occupied.

On Android 10+, received files appear in **Downloads / Super Send** by default. Settings can select a writable document folder instead. On Android 8–9, choose a document folder for easy access, or use the received-file **Save a copy** action to export from app downloads. Text and history are available inside the app.

Version 1.5 uses bounded 256 KiB transfer buffers, coalesces document-provider writes, and updates progress without repeatedly scanning every selected file for each chunk. Live MB/s is measured from observed bytes and excludes approval time; it needs a brief sample and falls to zero if data stops. Actual speed depends on both devices, Wi-Fi and storage. 100 MB/s needs more than 800 Mbps of usable payload capacity and is not guaranteed by this build. Host JVM benchmarks cannot establish physical-phone throughput.

The new package is `org.localsend.rebuilt`, distinct from the original app. Installing it does not replace the original LocalSend. The app has no account, cloud service, analytics, boot receiver, installer permission, or broad media-library permission.

The receiver runs as a foreground connected-device service with a visible notification. Use its **Stop** action when finished. Closing the screen alone can leave reception available; force-stopping the app stops transfers. Settings include device name, receive folder, Quick Save (automatic acceptance, off by default), and system/light/dark appearance. History supports search, direction filters, and expandable details. Active transfers appear on Receive and Send, with progress updates that preserve controls and scroll position.

## Build from source

The standalone build uses Java 17, Python 3, and the official Android SDK. No Gradle or third-party Android runtime libraries are needed. Set `JAVA_HOME` and `ANDROID_HOME` if they differ from this workspace's defaults. Install SDK platform `android-36` and build-tools `36.0.0`, then run:

```powershell
python scripts/build.py
```

The script compiles resources and Java, creates DEX with D8, aligns the APK, signs it, and verifies the APK signatures. Its private reusable signing identity stays in `signing/`, excluded from source archives. Keep that directory privately if you want future APKs to update this installation without uninstalling. The APK is a locally signed independent build, not an official LocalSend distribution or a Play Store listing.

Protocol engine tests: `python scripts/test-engine.py`. The 24 cross-language checks include transfers with every incoming PC request rejected, approval, cancellation, identity/token checks, and PC restart reconnection. They compile the exact `TransferEngine.java` used by Android and connect it to the PC Node service over real loopback TLS. The JSON library in `tools/` is only a JVM test dependency; Android uses its built-in `org.json` implementation.

Native view tests use the included Gradle project with Android resources and Robolectric native graphics. With Gradle 9.5.0 and Java 17 installed, run:

```powershell
gradle :app:testDebugUnitTest --console=plain
```

The suite explicitly uses SDK 35 (Android 15). It renders 32 theme/size/page combinations and checks editing, progress, history search, dialog validation, and short landscape forms. Screenshots go to `test-output/native-ui/`. Gradle downloads build/test dependencies; the standalone APK build above needs no Gradle dependencies. Gradle's debug APK uses its debug signer; use `scripts/build.py` for the signed distributable.

Original APK inspection and actual validation boundaries are documented in `docs/ANDROID-VALIDATION.md`. Native UI tests run on the host with a simulated service and storage context. Android Keystore, document providers, notifications, keyboard behavior, Wi-Fi multicast, and real-device lifecycle still require a physical device or booted emulator. See the project `docs/UI-VALIDATION-1.1.0.md` for the complete UI report.

## Credits

The app uses the new Super Send bullet-train logo and a monochrome train notification icon. Historical license notices remain in assets. The Java implementation is newly authored under the project MIT license. See the project `THIRD_PARTY_NOTICES.md` and `docs/PROTOCOL.md`. No original application code or signing identity is reused.
