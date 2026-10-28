# Integrated Windows receiving setup — 1.2.0

## User flow

Install `LocalSend-Rebuilt-1.2.0-Windows-Setup.exe`, then open LocalSend Rebuilt. The per-user installer defaults to `%LOCALAPPDATA%\Programs\LocalSend Rebuilt` and adds a Start menu shortcut and Windows Installed Apps entry. Close an existing copy before installation, updating, or uninstallation. Installation itself does not add firewall rules.

On first launch, **Receive from nearby devices** explains the scope. **Enable Private networks** is the default. **Also allow Public networks** is a separate, unchecked choice. Selecting Enable invokes Windows administrator approval. Selecting Later, closing the dialog, or cancelling Windows approval does not add rules. Settings always provides **Configure receiving**, **Check status**, and **Remove network access**.

The app discovers its own executable path, actual listening TCP port, and current Windows network profiles. No phone IP, username, installation path, or current PC port is baked into a release. The rules are restricted to this exact executable, `LocalSubnet`, its receiving TCP port, and UDP 53317 for discovery. Private access is always included; Public access is added only through the separate choice. Domain networks remain an administrator-managed deployment case. The app does not disable the firewall, change network categories, remove other applications' rules, or bypass block-all-inbound policies.

## Status and repair

Startup, returning focus after 30 seconds, and Check status read the actual Windows ActiveStore rule and profile state. A saved setup receipt never proves access. Status verifies both rules' program, protocol, local port, remote subnet restriction, action, enabled state, direction, and profiles. Matching app block rules and profile policies are surfaced. **Receiving access enabled** describes Windows rule configuration; router isolation, third-party security software, and actual phone reachability still require a real transfer.

Private-only permission on Public Wi-Fi is shown as limited, and the header does not claim readiness. Blocked policy gives an **Open Windows Firewall** action. The app requests no elevated changes automatically on startup, focus, network changes, or updates. Repair requires a user action and Windows approval.

Fallback TCP ports are saved so a busy default port does not generate a new random firewall scope on every launch. Updates installed at the same stable path reuse the rules. If the receiving port or portable location changes, the app requests repair. A moved app that retains its setup receipt cleans up its recorded prior path's owned rules only after a successful new setup. The old executable need not still exist. Rule ownership is checked before updates and cleanup.

## Data and uninstall

Installed settings, history, device certificate, and setup receipt live in `%APPDATA%\LocalSend Rebuilt`. Received files default to `%USERPROFILE%\Downloads\LocalSend Rebuilt`. Updates preserve these locations. Portable builds retain adjacent `data` and `received` folders.

For a first migration from the earlier portable build, close both copies and copy the contents of its `data` folder to `%APPDATA%\LocalSend Rebuilt` before opening the installed app. Copy downloads out of temporary WinRAR folders and select a permanent receive folder in Settings. The installer never reads another copy's certificates or user files automatically.

Windows Installed Apps launches the included uninstaller. Before removing application files, it removes only this path's owned TCP/UDP and legacy receiving rules. It requests Windows approval if those rules exist. Cancelling or failing cleanup aborts uninstallation and retains the application. Settings and received files are preserved. The uninstaller deletes an explicit payload file list, uses non-recursive directory removal, and leaves unrecognized files alone. It does not recursively delete the installation directory. Portable users can remove access in Settings before deleting or moving a folder.

## Validation

- 24 Node tests: 13 service checks, including persistent port fallback, plus 11 receiving-controller checks.
- 17 PowerShell policy assertions using in-memory replacements for every NetSecurity command. These exercise exact scopes, idempotent port/profile updates, narrower Public removal, broad-rule rejection, ownership collisions, active/inactive block profiles, previous-path cleanup, and preserving unrelated rules during uninstall cleanup.
- 11 Java/Node cross-language checks using the exact Android engine and real loopback mutual TLS, including both transfer directions and binary integrity.
- The packaged Electron UI audit uses the real renderer, preload, IPC, and controller with a simulated Windows adapter. It covers first run, Later, cancelled approval/retry, Private-only on Public Wi-Fi, explicit Public consent, port repair, removal confirmation, block-all policy, and light/dark dialogs at regular, compact, and 150% zoom sizes. It also runs the full real loopback transfer/approval/history workflow.
- The production PowerShell Status action was separately executed read-only against the real host. It detected a Public Wi-Fi profile with `AllowInboundRules=False`. The setup reports that restriction and does not alter it.
- Final packaged results: all 36 desktop layout/interaction checks pass; the integrated setup passes 9 scenarios and 6 theme/window-size cases, followed by a complete real loopback transfer workflow. The NSIS installer compiles without warnings. Installer/uninstaller paths, explicit deletion list, per-user settings, and rule cleanup hooks are inspected. The installer was not installed on this user's machine.

No firewall mutation or UAC approval was exercised against this host. No physical Android device was attached. The original phone-to-PC timeout is not claimed resolved by host-only tests. The installer is compiled and inspected; real installation, UAC, enterprise policies, update/uninstall, and cross-device networking should be exercised on clean Windows machines before public release.

## Build and release

Run `npm run check`, `npm test`, `npm run test:firewall`, `npm run package`, and `npm run installer`. The installer build uses official NSIS 3.12; set `NSIS_HOME` to its extracted compiler directory. It needs no NSIS installation on users' PCs. Source archives exclude the compiler, signing secrets, build outputs, user data, and test outputs. `python scripts/archive.py` creates and CRC-checks the portable and source ZIPs.

This distribution is unsigned. Public release still needs the publisher's Authenticode signing certificate and validation on target Windows machines; signing credentials are not invented or bundled. The original LocalSend logo and Electron notices remain included.

Policy behavior is based on Microsoft's [Windows Firewall rule guidance](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules) and [program, profile, address, and port rule parameters](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule). Installer execution levels and per-user shell folders follow the [NSIS scripting reference](https://nsis.sourceforge.io/Docs/Chapter4.html).
