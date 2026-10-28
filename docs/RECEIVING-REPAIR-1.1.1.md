# Android to Windows connection repair

The reported Android error was a TCP connection timeout to `192.168.1.50:59807` from `192.168.1.51`, before TLS or file approval. Live inspection found the rebuilt receiver listening on `0.0.0.0:59807`, a successful PC-to-phone transfer in its history, a Public Wi-Fi profile, and firewall allow rules only for the original `C:\Program Files\LocalSend\localsend_app.exe`. The rebuilt executable was launched from WinRAR's temporary extraction directory. There was no incoming transfer in PC history and no attached Android debug device.

The evidence identifies a blocked incoming connection as the immediate issue. The Android sender used the actual advertised fallback port correctly. Changing Android's transfer protocol or dropping certificate checks would not resolve that timeout.

## Repair

Extract the Windows ZIP into a permanent folder, open `LocalSend Rebuilt.exe`, then run `Enable LAN receiving.cmd`. Approve Windows' administrator prompt. The helper creates one inbound Allow rule for that exact executable, its currently listening TCP port, and `LocalSubnet` on Private/Public profiles. It does not add a UDP rule, open every TCP port, change network categories, or disable the firewall. If the app moves or selects a different port later, run the helper again. The same rule name updates in place for the same executable path.

The script supports a narrower repair for a single phone and profile, and `-Plan` prints the exact proposal without applying it:

```powershell
powershell -NoProfile -File scripts/enable-lan-receiving.ps1 -ExecutablePath 'C:\path\LocalSend Rebuilt.exe' -Port 59807 -RemoteAddress 192.168.1.51 -ProfileNames Public -Plan
```

Remove `-Plan` to apply after authorization. A non-administrator process requests elevation using the same validated parameters. Rule names are derived from the executable path. Existing app identities, received files, and Android installations are preserved.

## Verification boundary

The helper's PowerShell syntax, parameter validation, exact-port/single-phone plan, packaged paths, and source/package parity are checked without changing firewall policy. Actual reverse-direction completion requires the rule to be authorized and applied, followed by a send from the phone and inspection of the completed PC receive. Until then, the connection repair is prepared but the real transfer is unverified.

The scope follows Microsoft's [program/address/port filtering parameters](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule?view=windowsserver2025-ps).
