# Reproducing the transport throughput benchmark

`scripts/benchmark-throughput.js` measures the real PC service and the exact Java transport class compiled into the Android APK. It is a Windows loopback benchmark. It measures the engine's capacity on this PC; it does not measure an Android phone, Wi-Fi, or a router and cannot establish a minimum speed for users.

The harness copies the selected source files into a new output directory, records their SHA-256 hashes, and compiles the Java snapshot independently of the ordinary test build. It generates one deterministic, uncompressed AES-CTR fixture with a public test seed. Each transfer uses the full fixture, mutual TLS, ordinary approval, ordinary destination file writes, and successful completion at both ends. The phone-to-PC reverse test denies every incoming request to the PC and asserts that none occurs.

Timing starts immediately before approving the transfer and stops when both peers report successful completion. It includes subsequent HTTPS setup, file write/close, and the saved acknowledgment. File generation, waiting for the initial approval dialog, and post-transfer checksum verification are outside the interval. Destination length, both peers' byte counters, and destination SHA-256 must match the source for every run. This checks the file after closing it; it does not assert fsync or durable storage after a power failure.

The default is a 512 MiB file, one warmup and three measured transfers per direction. Results use decimal MB/s (`bytes / 1,000,000 / seconds`) and also include MiB/s. Summaries exclude warmup. The benchmark transfers data through the filesystem, so operating-system cache, JIT warmup, CPU load, antivirus, and storage can affect the measured rate. Run comparisons without simultaneous bulk builds or other benchmarks. Repeat comparisons if results overlap or differ only slightly.

From the repository root, using Node and JDK 17:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot'
& 'C:\Program Files\nodejs\node.exe' scripts/benchmark-throughput.js --label current --mib 512 --runs 3 --warmups 1
```

To measure the preserved release 1.4.0 source:

```powershell
& 'C:\Program Files\nodejs\node.exe' scripts/benchmark-throughput.js --label baseline-1.4 --mib 512 --runs 3 --warmups 1 --pc-src test-output/throughput-baseline-1.4-source/pc-src --engine test-output/throughput-baseline-1.4-source/TransferEngine.java
```

Optional arguments are `--pc-src`, `--engine`, `--harness`, `--output`, `--label`, `--mib`, `--files`, `--runs`, and `--warmups`. `--mib` is per-file size; `--files` defaults to 1 and accepts 1–1000. For photo-sized batches use `--mib 1 --files 64`; all files must match the fixture SHA-256 and both total counters must match. Output directories must not already exist. `--output` is relative to the repository unless absolute. A short harness smoke check can use `--mib 1 --runs 1 --warmups 0`; small-file results primarily measure setup latency and are unsuitable for estimating bulk throughput.

Each output directory contains `results.json`, exact source snapshots, compiled Java classes, compile output, and per-direction isolated test identity/state/log files. Generated payload and destination files are removed after successful verification; failed runs retain their evidence. Test private keys are disposable local identities, not production signing keys. This directory is under `test-output` and must not be included in a distribution.

The harness requires local socket access. Running it with sandbox permission to open loopback sockets does not require changing the Windows Firewall, network profile, router, or any user setting.

Actual phone-to-PC throughput must be checked separately on the intended hardware with a large file, final completion time, and matching destination checksum. The slower direction/device and the shared wireless airtime can limit performance. A reported link speed is not a measured file-transfer rate. A 100 MB/s application target alone requires 800 Mbps of payload capacity plus network/protocol overhead.
