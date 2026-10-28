# Super Send 1.6.0 — measured transfer improvements

This release addresses slow large files and slow batches. Install 1.6.0 on both devices. No physical POCO F6 or Wi-Fi speed was measured during this work. Host benchmark results are not a promised phone transfer rate.

## Changes

- Up to three selected files stream simultaneously after the receiving peer explicitly advertises support in its authenticated transfer response. The ordinary upload and PC-initiated Android receiving paths both support this. Older peers fall back to one stream.
- Windows progress snapshots use cached addresses instead of enumerating network adapters on every update. Discovery refreshes that cache, including after switching to a phone hotspot.
- Android enumerates addresses on its discovery worker, outside the lock used by transfer progress and file completion. Previously each state snapshot performed that potentially slow operation while blocking transfer workers.
- File reads, TLS streams and writes retain bounded 256 KiB buffers. Android caps reverse source handles at three, even when a receiver starts the next file before a previous socket finishes closing. Failed batches stop new work and close active connections/sources. Completed files are preserved and partial files are removed.
- Device identities, APK signer, manual approval, TLS fingerprints, temporary tokens, declared sizes, supplied SHA-256 verification, destination path validation and completed-save acknowledgments remain in use. No new firewall rule, account, server, compression, VPN or relay is required.

Single large files use one encrypted stream. Parallel files reduce idle time and per-file connection overhead; they cannot multiply the available radio bandwidth.

## Measurements

The shipping Node service and exact Java engine were tested on this Windows PC over loopback with real TLS, approval, storage writes and acknowledgment. File generation and post-transfer hashing are excluded from timing. Filesystem cache, JVM warmup and background load affect these results. Android's actual TLS implementation and document providers differ from the desktop JVM.

Decimal MB/s, median of three measured runs after one warmup:

| Path | 1.5.1, 64 × 1 MiB files | 1.6.0, 64 × 1 MiB files | 1.5.1, one 512 MiB file | 1.6.0, one 512 MiB file |
| --- | ---: | ---: | ---: | ---: |
| PC → Java Android engine | 12.6 | 61.2 | 53.3 | 238.6 |
| Java → PC, direct upload | 36.1 | 61.4 | 36.9 | 141.6 |
| Java → PC, PC-initiated receiving | 30.7 | 45.8 | 37.1 | 124.3 |

Final large-file measured ranges were 219.6–263.3, 135.1–143.4 and 110.9–128.0 MB/s, respectively. The original large-file baseline was noisy (including 33.5–199.1 MB/s in one direction), so no fixed speed multiplier is claimed. Historical 1.5 benchmarks on this host were faster than this session's baseline; cross-session comparisons are not controlled.

A further stress run transferred ten 64-file batches in each direction: 30 successful batches, 1,920 checksum-verified destination files, 1,920 MiB of payload. Medians were 59.1, 56.0 and 42.6 MB/s. Two earlier batch attempts terminated on connection failures; the first reported a loopback connect timeout, and the second was cancelled by its sender before the diagnostic capture was added. Their causes were not conclusively identified. Both attempts remain in workspace test-output; a complete diagnostic repeat and the 30-batch stress run then passed without retries. These results do not establish immunity to connection failures.

Every successful benchmark verifies the file count, both peers' byte totals, each saved file's length and SHA-256. Reverse tests deny all incoming PC requests. No fsync or power-loss durability claim is made. See the accompanying throughput-1.6.0 JSON reports and THROUGHPUT-BENCHMARK.md for reproduction.

## Research and rejected alternatives

- [ESnet iperf3 documentation](https://software.es.net/iperf/invoking.html) describes parallel streams for measuring aggregate throughput. This motivated testing a small, bounded pool rather than assuming more connections always help.
- [QUIC is not Quick Enough over Fast Internet](https://arxiv.org/abs/2310.09423), a WWW 2024 study, found significant CPU/receiver overhead in the tested QUIC stacks. A QUIC rewrite is not evidence of a speed gain for this app, so the existing encrypted TCP transport was retained.
- [Android Wi-Fi Direct](https://developer.android.com/develop/connectivity/wifi/wifi-direct) supports direct device connectivity. The user's existing hotspot already provides a direct local path; Wi-Fi Direct would add discovery and pairing work rather than guarantee faster radio throughput.
- [Android WifiManager](https://developer.android.com/reference/android/net/wifi/WifiManager#WIFI_MODE_FULL_LOW_LATENCY) documents that low-latency mode can reduce throughput, and high-performance locks are mapped to that mode on newer Android versions. No unmeasured low-latency override was enabled.
- A bounded 1 MiB read-ahead experiment was built and benchmarked. Its medians were 209.8/142.1/119.4 MB/s. Disabling it yielded 236.4/202.8/113.6 MB/s in the comparison, and the final leaner copy path measured 238.6/141.6/124.3 MB/s. The extra queue/thread complexity offered no consistent advantage and was removed.

## What to expect on the actual phone

The user previously observed 65–70 MB/s through the POCO hotspot and about 25 MB/s through the home router. That difference is consistent with a network-path limit, but does not identify the exact router/radio bottleneck. Software work cannot guarantee a particular speed on either connection.

After updating both devices, compare the same 1 GB or larger video in each direction on the hotspot and home Wi-Fi, then repeat with the same photo batch. Use final completed size/time, not the Wi-Fi link rate or a momentary peak. Keep the phone app open during the comparison. A PC Ethernet connection may reduce shared wireless airtime; it still does not guarantee a particular rate.

## Release checks

The release uses Android package org.localsend.rebuilt, versionCode 7, with the existing signing identity. Windows retains the existing settings/identity path. Release check outcomes and artifact hashes are recorded in VALIDATION-1.6.0.json. APK installation on the physical phone and running the Windows installer are not part of the automated verification. Windows remains unsigned.
