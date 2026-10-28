# Super Send 1.5.0 performance work

The requested target is at least 100 decimal MB/s between a PC and a mobile device. The optimized transport exceeds 100 MB/s in the measured host benchmark. A physical phone on the user's Wi-Fi has not been measured, so the requested end-to-end minimum remains unverified. There is no universal minimum-speed guarantee.

## Changes

- Windows uses bounded 256 KiB read, transform and destination-write buffers, with ordinary stream backpressure. It updates aggregate byte counts incrementally instead of scanning every selected file for every chunk.
- Android uses 256 KiB buffers for bulk transfers, buffered TLS responses and document-provider output, and TCP_NODELAY on accepted sockets. Expensive progress JSON calculations run about every 100 ms, with exact counts at successful file completion.
- Both receivers calculate SHA-256 when the sender supplies a checksum to verify. The earlier normal path calculated a digest and discarded it. Supplied-checksum comparison, mismatch cleanup and HTTPS integrity are retained.
- Windows and Android show observed decimal MB/s using a monotonic clock. Approval time is excluded. A short initial observation is required, and stalled rates fall to zero. Windows shows an observed average for completed transfers witnessed by that window; old history gets no invented speed. Android clears its observation when the screen pauses and starts a new one on resume.

Files still stream sequentially. Each file uses a fresh HTTPS connection, preserving existing peer-certificate verification. This release does not implement compression, parallel chunk downloads, a cloud relay or a bandwidth limit. Small files still incur per-file TLS and storage overhead.

## Measurements

The exact shipping Node service and exact Java transport source ran on one Windows PC over loopback, using JDK 17 and Node 24.11.1. These are **host engine measurements**, not Android phone, router, radio, or Internet measurements. Each direction used a deterministic, uncompressed 512 MiB file, one warmup and three measured transfers. Source generation and final SHA-256 checks were outside timing; TLS setup after approval, file write/close and final saved acknowledgment were included. Destination lengths, sender/receiver counters and SHA-256 matched in every successful run. No fsync or power-loss durability claim is made; filesystem cache affects results.

Median decimal MB/s, excluding warmup:

| Transport direction | First 1.4 baseline | First optimized 1.5 | Repeat 1.4 baseline | Repeat optimized 1.5 |
| --- | ---: | ---: | ---: | ---: |
| PC to Java Android engine | 247.4 | 302.0 | 148.6 | 392.7 |
| Java Android engine to PC, direct | 117.3 | 284.7 | 120.4 | 273.3 |
| Java Android engine to PC, PC-initiated receiving | 63.2 | 262.8 | 113.3 | 246.1 |

The repeat optimized measured ranges were 367.9–439.2, 256.9–276.8, and 236.3–274.9 MB/s respectively. All measured optimized runs in both batches exceeded 100 MB/s. The large baseline variance is why no fixed improvement multiplier is promised. The reverse benchmark rejected incoming PC requests and verified the transfer used only connections initiated by the PC.

Machine: Intel Core i7-13700HX, Windows 10.0.26300 x64. Java on desktop Windows has different TLS, storage and CPU behavior from Android. File providers and Android hardware remain untested by this benchmark.

Raw reports with source hashes, per-run times and checksums:

- `throughput-baseline-1.4.json`
- `throughput-optimized-1.5.json`
- `throughput-baseline-confirm-1.4.json`
- `throughput-optimized-confirm-1.5.json`

See `THROUGHPUT-BENCHMARK.md` and `scripts/benchmark-throughput.js` for reproduction. Disposable TLS test identities and generated data remain under `test-output/` and are excluded from distributions.

## Actual Wi-Fi boundary and next verification

Read-only Windows adapter inspection during this work reported changing asymmetric Wi-Fi link rates: at the latest observation, receive was 1,201 Mbps and transmit was 576 Mbps. The transmit rate has a raw conversion of 72 MB/s before overhead, so that observed PC sending link cannot sustain 100 MB/s. The receive direction has more nominal capacity, but nominal radio rates do not prove payload throughput. Earlier summary link readings were 649 Mbps; those summary readings did not describe both directions separately.

100 MB/s requires 800 Mbps of payload capacity plus overhead, and sufficiently fast storage, CPU and the other device's connection. Two wireless clients may share airtime. The user prefers Wi-Fi and also has Ethernet available. No adapter, router, firewall, network profile or location-privacy settings were changed.

Install version 1.5 on both devices and transfer a file of at least 1 GB in each direction. Observe sustained MB/s after approval and wait for saved completion; compare the received file's checksum separately. A strong 5/6 GHz link may help, and a gigabit Ethernet PC connection can reduce shared Wi-Fi airtime. These conditions do not guarantee the target. No physical Android device was attached through ADB during this work, and no real-device throughput result is claimed.

## Compatibility and validation

HTTPS peer fingerprints, manual approval, recipient-bound reverse tokens, size checks, supplied checksums, safe filenames, duplicate preservation, cancellation cleanup and saved acknowledgment retain the existing protocol behavior. Android package ID, signer and stored identities are retained; versionCode is 5. Windows retains the existing settings/identity directory and installer upgrade behavior.

Validation details are recorded in `VALIDATION-1.5.0.json`. Windows remains unsigned. The production installer has not been executed on this machine. Existing security-review boundaries and the artwork provenance remain documented in `SUPER-SEND-1.4.0.md`.
