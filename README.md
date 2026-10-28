# Super Send

**Share files across your local network.** Super Send is a Windows and Android app for sending files and text between nearby devices, with an independent implementation of the public LocalSend v2 protocol. It is not an official LocalSend release.

## Features

- Send and receive files or text over the local network with transfer approval, progress and cancellation.
- Connect Windows to an Android phone by its local address when discovery is unavailable.
- Browse transfer history, choose a receive folder, and use light or dark themes.
- HTTPS transfers, device fingerprints and temporary transfer tokens. Quick Save is off by default.
- Supports up to three simultaneous files when the receiver supports it; speed depends on your devices, storage and network.

## Get started

Once published, download the Windows x64 installer and Android 8+ APK from this repository's Releases page. The Windows build is unsigned. Install only builds from a source you trust.

1. Connect the PC and phone to the same local network and open Super Send on both.
2. On Windows, choose **Connect Android phone** and enter the phone's displayed address and port.
3. Choose files or text, select the receiver, and approve the transfer there.

If discovery fails, use the displayed address and port to add the device. Router client isolation, VPNs and firewall rules can block connections. The app has no account, cloud relay or internet-transfer service. On Android, receiving runs as a foreground service with a visible notification; use Stop when finished.

## Build from source

Install Node.js 22.12+ and run `npm ci`, then `npm start`. The Windows packaging scripts also require the official rcedit tool and NSIS, as described in the source scripts. To build Android, install JDK 17, Python 3, Android SDK Platform 36 and build-tools 36.0.0; set `JAVA_HOME` and `ANDROID_HOME`, then run `python android/scripts/build.py`. The script generates a local signing identity on first use. Keep it private: an APK signed with a different key cannot update an existing installation. See [Android instructions](android/README.md).

## Status and security

Current source: 1.6.0. Independent security review and broader real-device testing remain outstanding. Verified QR/PIN pairing is not implemented. See [contributing](CONTRIBUTING.md), [security](SECURITY.md), [third-party notices](THIRD_PARTY_NOTICES.md), and [performance notes](docs/PERFORMANCE-1.6.0.md). If Super Send is useful, consider starring the repository.

## License and credits

Super Send is available under the [MIT license](LICENSE). It implements the [LocalSend protocol](https://github.com/localsend/protocol); see third-party notices for attribution.
