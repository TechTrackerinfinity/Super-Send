# Blip evidence and Android-to-PC connection fix — 1.3.0

## Finding

The reported Android error was a TCP connection timeout to the PC, before TLS or transfer approval. Read-only host diagnosis found the active Wi-Fi marked Public and the effective Public Windows Firewall profile with `AllowInboundRules=False`. The previously installed application's Private-only receiving rules cannot enable incoming transfers on that network. No firewall policy was changed during this work.

Blip provides a useful architectural comparison: its official [security documentation](https://blip.net/security), updated June 16, 2026 and checked October 17, 2026, describes direct transfers with an encrypted relay fallback when direct connection is unavailable. It also describes mutual TLS. These are publisher claims; the local observations below do not independently prove its complete transfer protocol.

## Evidence ledger

Target: installed `BlipStudioInc.BlipApp_1.2.4.0_x64__eydxbjyejh39j`, under `C:\Program Files\WindowsApps`. Blip was already running. It was neither started nor stopped, and no account state or user transfer was manipulated.

| Evidence | Observed result | Boundary |
| --- | --- | --- |
| REA launcher inspection `ev_4800c3c90450b1d2cb81a818997a3404707ec40e9035fa77180722b2d308667a` | Launcher has no CLR metadata | No managed CIL decompilation claimed |
| REA JAR inspection `ev_7ba9e50b36c27303b8e370c5bdd952b1b0150ca350380ac0f381bf8ad06855c6`; archive inventory `ev_74788a31f1b4155c71c88f0ecc756248f6a54f8d9f7e93a02028cd152afaae71` | Java/Kotlin packaged API classes and native bridge inventory | Archive listing is not implementation semantics |
| Java `javap -p` output | Transfer, device-reach, and core interfaces | Interface inspection only; some internal class access was denied |
| Native DLL ASCII literals | `RelayTokenService`, `relayServerDialer`, `isRelayed`, relay dial/handshake symbols | Supports a relay implementation inference; not native decompilation |
| Passive process socket metadata | Running Blip has an established outbound TCP connection to port 443 | Does not prove which connection carries a file transfer or identify the endpoint's role |
| Package manifest | Declared inbound and outbound TCP rules | Manifest declarations alone do not prove effective host access |

The JAR SHA-256 is `52028211b465f17c4162b25dc0cdf848c7e8300e3ba3f0b19c68e9aad53e5722`; the native DLL SHA-256 is `acaab589f4eca8f5ad3fb99402c76c8f5234b65c75e1a71a45524a301681767c`.

Raw evidence is in `blip-analysis/rea-blip-artifact-evidence.json`, `java-transfer-api.txt`, `static-native-network-literals.json`, and `passive-socket-observation.txt`. The REA target was closed after exporting evidence. REA's process-scenario capture was unavailable because this Windows capture backend could not verify descendant cleanup; passive socket metadata was obtained separately through Windows read-only commands. Native Ghidra analysis was unavailable in this environment. No Blip protocol, relay credentials, proprietary code, or account service is copied or used by this application.

## Implemented connection path

The new Android-to-PC path keeps files on the LAN. The PC opens the connection to the phone, polls for transfers addressed to its certificate identity, displays the existing approval dialog, and then retrieves approved files. The phone reports completion only after the PC confirms that the selected files have been saved. Thus the phone does not need to open an incoming connection to the PC. This is a newly implemented local connection path inspired by the fallback principle; it is not a Blip-compatible cloud relay.

Both devices must run LocalSend Rebuilt 1.3.0 or newer. The PC advertises `capabilities.reverseReceive=1`; Android advertises `capabilities.reversePull=1`. Older and stock LocalSend peers retain the standard direct `/prepare-upload` and `/upload` flow. Existing receiving setup remains available for those peers.

PC polling uses mutually authenticated HTTPS and pins the phone's SHA-256 certificate fingerprint. A phone's selected recipient identity gates offers, decisions, and file reads. Approval creates per-file random tokens; replay or another identity cannot reopen the source. Queued offers expire after three minutes; accepted sessions expire after thirty minutes of inactivity. Metadata and queue sizes are bounded. Cancellation interrupts streams and removes incomplete PC files. Files use exact declared lengths and existing safe-path, exclusive-create, and duplicate-name preservation behavior.

Only TLS-verified phone addresses are remembered in `known-peers.json`. Unauthenticated discovery announcements cannot start polling or persist a phone address. The PC reconnects to remembered phones on subsequent starts. Addresses come from discovery or the user's connection action; no user's IP or network profile is embedded in the release. If DHCP changes the phone address and discovery is blocked, reconnect using the phone's current address.

The final verification also exposed a Java TLS session-resumption edge: a resumed session could omit certificate data required for identity pinning. PC requests now use fresh TLS handshakes so the certificate is present and checked on every connection.

## Use

1. Close the old PC app and install the 1.3.0 Windows build. Install the 1.3.0 APK over the previous rebuilt Android app, preserving its data and signing identity.
2. Keep both apps open on the same Wi-Fi. On the PC, choose **Connect Android phone**, or **Send → Add device**, and enter the phone's displayed IP and receiving port (normally HTTPS / 53317).
3. Wait for **Ready through phone connection** on the PC. On Android, select files, choose this PC, and accept on the PC.

This handles incoming-PC restrictions while the PC can reach the phone. It does not provide internet transfers, router client-isolation traversal, or a hosted relay. A physical-device transfer remains the final validation for a particular phone and Wi-Fi network.

## Validation

Final results, source hashes, and the APK hash are recorded in `VALIDATION-1.3.0.json`; distribution hashes are in `release/SHA256SUMS-1.3.0.txt`. The automated network checks use the exact shipped Java engine and PC service over real local mutual TLS. The new scenario destroys every incoming PC request starting before initial PC-initiated pairing, verifies that no incoming requests occur, and checks binary, empty-file, UTF-8 text, approval, rejection, cancellation, and remembered-phone reconnection. Separate checks exercise missing certificates, false identities, another recipient, stolen/wrong tokens, replay, and terminal-state cleanup.

Host tests do not substitute for Android Keystore, document-provider, foreground-service, or real Wi-Fi lifecycle verification. The Windows build remains unsigned; APK signatures use the existing independent project's signing identity. Public release still needs the publisher's Windows signing identity and target-device acceptance testing.
