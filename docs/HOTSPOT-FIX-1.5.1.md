# Super Send 1.5.1 hotspot discovery fix

## Problem

When Super Send stayed open while the PC or phone moved from home Wi-Fi to an Android phone hotspot, UDP discovery could remain joined to the old adapter. Windows also sent its discovery packet through only the operating system's default adapter. On a hotspot, that can leave the devices unable to find one another even though the devices are connected to the same hotspot.

## Change

- Windows refreshes its multicast memberships before every discovery announcement and sends the announcement through every active IPv4 adapter.
- Android refreshes multicast membership every ten seconds and sends discovery through every active IPv4 adapter. It also attempts the operation on hotspot adapters that report multicast capability imperfectly.
- Departed adapters are removed from the discovery socket, so stale home-Wi-Fi membership does not block a later hotspot connection.

## Transfer behavior

Discovery identifies the current IP address only. Files still stream directly over mutually authenticated HTTPS, using each device's certificate fingerprint and temporary per-file transfer tokens. Existing PC-initiated receiving remains available for Android-to-PC transfers where Windows blocks a new incoming hotspot connection.

## Verification

The Windows regression test simulates a PC changing from `192.168.1.20` to an Android-hotspot address `192.168.43.72` and confirms that Super Send drops the previous membership, joins the hotspot interface, and transmits its new announcement there. The complete Node suite and Android/Windows mutual-TLS interoperability suite also pass. A physical hotspot test remains the final device-specific check because hotspot firmware controls multicast forwarding.
