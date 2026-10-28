# Super Send: transport research before another implementation

Research date: 25 October 2026. This document proposes experiments; it does not claim that a new transport has been built or measured. The installed apps and the 1.6.0 release artifacts were not changed for this research.

## Recommendation

Evaluate a native TQUIC engine with persistent encrypted connections, single-file chunk scheduling, and optional use of multiple independent network paths. Compare it with persistent TLS/TCP on the actual POCO F6 and Windows PC before selecting a production transport.

The potentially large gain comes from reaching a faster direct path, using previously idle independent bandwidth, or removing a measured processing bottleneck. Merely changing the protocol name does not establish a gain. This is an engineering recommendation based on the sources below, not a measured result.

## What the existing evidence establishes

The user reported approximately 65–70 MB/s through the phone hotspot and 25 MB/s through home Wi-Fi. Those observations suggest that connection topology matters substantially. They do not establish whether the router, channel width, signal, shared airtime, adapter, storage, or app was the limiting component.

The earlier Windows-to-desktop-JVM benchmark measures software capacity on one PC. It cannot determine the Android phone's network or storage limit. Its 124–239 MB/s final medians are not POCO Wi-Fi measurements.

Xiaomi lists Wi-Fi Direct and 2×2 MIMO support for the F6, and lists its USB interface as USB 2.0. Its global product specification lists Wi-Fi through 802.11ax. Xiaomi's separate laboratory Wi-Fi maximum is a radio specification, not a file-transfer target. Actual firmware, negotiated channel width and concurrent-radio behavior remain unverified. [POCO F6 FAQ](https://www.mi.com/uk/support/faq/details/KA-166446/), [global specifications](https://www.mi.com/global/product/poco-f6/specs/).

## Technologies compared

| Technology | What could improve | Constraint for this project | Decision |
| --- | --- | --- | --- |
| Native QUIC with persistent streams | Connection reuse, stream scheduling, loss handling and processing efficiency | Same radio/storage limits; implementation and CPU cost matter | Prototype alongside persistent TLS/TCP |
| Multipath QUIC | One transfer uses multiple reachable paths at once | Requires useful concurrent paths and an appropriate scheduler | Strongest candidate for adding bandwidth |
| Application-level chunk striping over TLS | One large file uses several encrypted connections and potentially several paths | Reassembly, seek support, resource limits and recovery must be implemented | Useful simpler comparison prototype |
| Wi-Fi Direct or app-created local hotspot | Direct PC–phone path avoids the home router | Band/channel/driver behavior still controls speed | Prototype automatic direct-path selection |
| Wi-Fi 7 MLO | Radio-level multi-link operation | Requires compatible Wi-Fi 7 endpoints/network, not an app-only update | Hardware-dependent future option |
| Wi-Fi Aware | Nearby discovery and direct data paths | Runtime support and Windows interoperability need verification | Secondary research track |
| USB-only transfer | Stable separate wired path | F6 USB 2.0 signaling ceiling is below the reported hotspot payload rate | Optional additional path, not the primary standalone speed upgrade |
| Kernel Multipath TCP | Aggregates several TCP subflows | Protocol availability alone does not establish usable stock Windows/Android support | Prefer application-controlled prototype initially |

### QUIC and single-file chunks

QUIC provides encrypted, flow-controlled streams within one connection and can keep unrelated streams progressing when one stream loses data. These features help connection reuse and concurrent transfers. Multiple streams on one network path still share that path's capacity. The proposed file protocol would divide a large file into bounded blocks so it can schedule, verify and resume blocks independently. That block protocol is our proposed application design, not an automatic QUIC feature. [RFC 9000](https://www.rfc-editor.org/rfc/rfc9000.html).

### Multipath QUIC

The IETF extension explicitly permits concurrent paths within one QUIC connection. At research time, the document's tracker identifies revision 21 and the RFC Editor queue. The extension leaves application scheduling and address discovery outside its scope; implementation/draft interoperability must be checked for the chosen library revision. [IETF multipath document and status](https://datatracker.ietf.org/doc/draft-ietf-quic-multipath/).

The useful distinction is between opening several streams on the same Wi-Fi path and sending file blocks over separate usable paths. Candidate combinations are Wi-Fi plus USB tethering, or a router path plus a direct phone path when both devices genuinely support concurrent operation. The PC must have suitable concurrently usable interfaces. No additional interface purchase is recommended until capabilities and a concurrent test establish a benefit.

Two paths that are fast separately may contend when used together. Android documents radio time-sharing problems for simultaneous station/hotspot operation. Its STA/STA feature is optional and depends on chip, firmware and manufacturer configuration. Therefore the reported 70 MB/s hotspot plus 25 MB/s router rate cannot be assumed to produce 95 MB/s. [STA/AP concurrency](https://source.android.com/docs/core/connect/wifi-sta-ap-concurrency), [STA/STA concurrency](https://source.android.com/docs/core/connect/wifi-sta-sta-concurrency).

The scheduler must measure both paths concurrently, give more blocks to the path delivering more useful bytes, and stop using a second path if aggregate throughput drops. It also needs bounded reordering memory and recovery when a path disappears. Those policies require our own measurements.

### Direct wireless setup

Both Android and Windows provide Wi-Fi Direct functionality. Microsoft documents desktop API and driver considerations, including a conflict between Windows Mobile Hotspot and legacy Wi-Fi Direct group-owner mode. Android also provides an app-requested local-only hotspot for local communication. These APIs can improve the connection experience and select a direct route, but they do not establish a higher rate than the user's existing phone hotspot. [Windows Wi-Fi Direct](https://learn.microsoft.com/en-us/windows-hardware/drivers/partnerapps/wi-fi-direct), [Android local-only hotspot](https://developer.android.com/develop/connectivity/wifi/localonlyhotspot).

### MLO, Aware and USB

Multi-link operation is a Wi-Fi 7 feature. It needs compatible radio/firmware support; a Wi-Fi 6 router cannot acquire it through a Super Send update. [Android Wi-Fi 7 documentation](https://source.android.com/docs/core/connect/wifi-7).

Android Wi-Fi Aware supports discovery and direct data paths on supporting devices. Availability can change, and concurrent hotspot/Direct use can make it unavailable. No verified F6-to-Windows Aware path was established in this research. [Android Wi-Fi Aware](https://developer.android.com/develop/connectivity/wifi/wifi-aware).

USB-IF specifies 480 Mb/s for USB 2.0 high speed, equivalent to 60 decimal MB/s before overhead. Consequently a USB-only F6 transfer cannot beat an actual 65–70 MB/s hotspot transfer. Adding USB as another independent path could still help aggregate transfer speed; simultaneous operation and actual usable rate need testing. [USB-IF FAQ](https://www.usb.org/faq). Android documents USB tethering as a supported connection method; local app reachability through that interface must be verified on this phone. [Android tethering help](https://support.google.com/android/answer/9059108).

## Library shortlist

- **TQUIC:** the project documents multipath and selectable CUBIC, BBR, BBRv3 and COPA congestion control, with Rust/C/C++ APIs. Its installation guide covers Windows and Android builds. This makes it the first prototype candidate, not a prevalidated Super Send dependency. Pin a revision and verify its multipath wire version, certificate handling and platform behavior. [Project](https://github.com/Tencent/tquic), [installation](https://tquic.net/docs/getting_started/installation/).
- **Cloudflare quiche:** useful single-path QUIC comparison; its README documents Android builds and Windows build requirements. Do not assume that a standard QUIC library also implements multipath. [quiche README](https://github.com/cloudflare/quiche/blob/master/README.md).
- **MsQuic:** useful Windows throughput reference with asynchronous I/O and UDP batching. Its release documentation provides official Windows/Linux support and describes Android as best effort. Its performance dashboard is a library benchmark, not evidence of this phone's rate. [Release/platform support](https://github.com/microsoft/msquic/blob/main/docs/Release.md), [performance dashboard](https://microsoft.github.io/msquic/detailed.html).
- **picoquic:** alternative multipath candidate with a documented path-affinity API and a just-in-time send interface that avoids an intermediate queued copy. Platform integration still needs validation. [Send/receive API](https://www.privateoctopus.com/picoquic/send_receive_data.html).

Kernel MPTCP is a real standardized alternative, but a standards document is not proof of usable support on these two installed operating systems. An application-controlled transport avoids making that unsupported assumption. [RFC 8684](https://datatracker.ietf.org/doc/rfc8684/).

## Proposed prototype structure

Keep the existing Windows and Android interfaces. Put the candidate transport in a native library, accessed through a small desktop bridge and Android JNI. Keep discovery, user approval and authenticated device identity as the control plane.

After approval, negotiate a transfer manifest and bounded block size; initially compare 1, 4 and 8 MiB blocks. Reuse authenticated encrypted sessions instead of opening a fresh session for each file. Use per-file block indexes and integrity checks, bounded writes, a resumable completion map and final validation before publishing the completed destination. Candidate settings are experimental parameters, not established optimums.

For multipath, authenticate every additional endpoint as the same approved device, bind each socket to its intended interface, and schedule blocks according to measured useful throughput. Android exposes network-specific socket binding, and Windows exposes an outgoing-interface socket option. [Android Network](https://developer.android.com/reference/android/net/Network), [Windows socket options](https://learn.microsoft.com/en-us/windows/win32/winsock/ipproto-ip-socket-options).

Android file providers are an implementation constraint: read/write descriptors may be pipes, whereas seekable disk access is associated with read-write descriptors. Some sources therefore require sequential scheduling or bounded staging rather than arbitrary parallel seeks. Temporary copying has time/storage costs and must be included in end-to-end measurements. [ContentResolver](https://developer.android.com/reference/android/content/ContentResolver#openFileDescriptor(android.net.Uri,java.lang.String,android.os.CancellationSignal)).

If a peer lacks the new protocol or UDP is unavailable, negotiate the existing encrypted transfer path. A direct local design does not inherently need a VPS. WAN/cellular reachability is a separate problem and is not established by local multipath support.

## Tests required before choosing the implementation

1. Record actual PC Wi-Fi adapter, router model, negotiated band/channel/width/link rate, phone OS and available interfaces. Check concurrent capability at runtime rather than inferring it from a marketing feature name.
2. Establish a network-only TCP baseline in both directions on router Wi-Fi and hotspot, with one and several streams. Repeat with CPU and temperature observations. iperf3's parallel-stream option is useful for this distinction. [ESnet iperf3 documentation](https://software.es.net/iperf/invoking.html).
3. Measure phone source read and destination write capacity separately. Then compare persistent TLS/TCP, native QUIC, and chunked modes on identical payloads. Use an incompressible file of at least 1 GiB and a fixed photo batch, three or more runs per case, with warmup reported separately.
4. For every candidate two-path configuration, measure path A, path B and both together. Compare useful bytes saved per second, not the sum of socket counters or nominal link speeds. Include staging, final file close and integrity validation in the final user-visible timing.
5. Test interrupted paths, reconnection, cancellation, changed sources, full storage, invalid blocks and certificate changes. Confirm the exact destination contents and that incomplete files are not shown as successful transfers.
6. Proposed selection gate: adopt a candidate only after a repeatable material improvement, for example at least 20% median end-to-end gain in the relevant workload, with acceptable heat, power and recovery behavior. This is a proposed engineering gate, not a claim that the gain has been achieved.

No new APK/setup should be described as faster on the user's hardware until these real-device comparisons pass. The next justified implementation is a small transport prototype with comparable modes, followed by the actual PC–POCO measurements.
