# LocalSend interoperability notes

Research date: 17 October 2026. These are public-source protocol observations, not runtime findings from the installed application. The current specification identifies itself as **v2.2**; endpoints remain under `/api/localsend/v2`.

## Discovery and identity

The defaults are UDP multicast `224.0.0.167:53317` and HTTP/HTTPS TCP `53317`. Ports are configurable. HTTPS uses the SHA-256 digest of the certificate as the device fingerprint; HTTP uses a generated persistent random identifier. Ignore your own fingerprint. See the [official defaults and fingerprint specification](https://github.com/localsend/protocol#1-defaults).

Announce JSON to the multicast group:

```json
{
  "alias": "Rebuilt PC",
  "version": "2.2",
  "deviceModel": "Windows",
  "deviceType": "desktop",
  "fingerprint": "persistent-device-id",
  "port": 53317,
  "protocol": "http",
  "download": false,
  "announce": true
}
```

`announce:true` invites a callback to the packet sender's IP at its advertised protocol/port: `POST /api/localsend/v2/register`, carrying the responder's device information without `announce`. A multicast reply uses `announce:false`; it must not trigger another response. Use the transport source IP; the announcement contains no IP field. The [official discovery implementation](https://github.com/localsend/localsend/blob/main/packages/core/src/discovery/mod.rs) confirms peers through registration and learns HTTPS identity from the handshake. Its default discovery request timeout is 500 ms; this is unsuitable for a transfer approval request, which waits for a person.

## JSON contracts

Names and enums on the v2 wire are camelCase/lowercase. `deviceType` accepts `mobile`, `desktop`, `web`, `headless`, `server`; unknown types fall back to desktop. `protocol` is `http` or `https`. Omitted `download` means false. See [official discovery types](https://github.com/localsend/localsend/blob/main/packages/core/src/model/discovery.rs).

The [official v2 DTOs](https://github.com/localsend/localsend/blob/main/packages/core/src/http/dto_v2.rs) define:

| Shape | Fields |
| --- | --- |
| Register request / prepare-upload `info` | `alias:string`, `version:string`, nullable/optional `deviceModel:string`, `deviceType:string`, `fingerprint:string`, `port:number`, `protocol:string`, optional `download:boolean` |
| Register response / GET info response / prepare-download `info` | `alias`, `version`, optional `deviceModel`, `deviceType`, `fingerprint`, optional `download`; **no port or protocol required in response** |
| Prepare upload request | `{ "info": RegisterInfo, "files": { "file-id": FileMetadata } }` |
| Prepare upload response | `{ "sessionId": "session-id", "files": { "accepted-file-id": "file-token" } }` |
| Prepare download response | `{ "info": Info, "sessionId": "session-id", "files": { "file-id": FileMetadata } }` |

Files are a map, never an array. Upload only IDs returned by the receiver; it may accept a subset.

The [official file DTO](https://github.com/localsend/localsend/blob/main/packages/core/src/model/transfer.rs) requires `id`, `fileName`, `size` (bytes, nonnegative integer), and `fileType` (MIME string). Optional nullable fields are `sha256`, `preview`, and `metadata`. Metadata contains optional RFC 3339 `modified` and `accessed` timestamps.

```json
{
  "id": "f1",
  "fileName": "hello.txt",
  "size": 6,
  "fileType": "text/plain",
  "sha256": null,
  "preview": null,
  "metadata": { "modified": "2026-10-17T00:00:00Z" }
}
```

## Transfer routes

All paths below begin `/api/localsend/v2`.

| Method and path | Body / result |
| --- | --- |
| `POST /register` | Register JSON → remote information |
| `GET /info` | No body → information; useful for manual diagnostics |
| `POST /prepare-upload?pin=123456` | Information + file map → session ID and accepted file tokens |
| `POST /upload?sessionId=S&fileId=F&token=T` | Raw file bytes → empty success response |
| `POST /cancel?sessionId=S` | No body → empty response |
| `POST /prepare-download?pin=123456&sessionId=S` | No body → download information + session ID + file map; query arguments optional |
| `GET /download?sessionId=S&fileId=F` | No body → raw bytes |

Encode query values with `URLSearchParams`. `upload` accepts a raw stream, not JSON, base64, or multipart. Independent accepted files can upload concurrently. The [official server](https://github.com/localsend/localsend/blob/main/packages/core/src/http/server/v2.rs) permits one incoming upload session, binds it to sender IP, validates each file token, and releases it when accepted files finish/fail or the sender cancels. A pending approval also occupies the session slot. Disconnecting a pending request releases that slot.

The [official client error contract](https://github.com/localsend/localsend/blob/main/packages/core/src/http/client/v2.rs) identifies:

| Stage | Status meanings |
| --- | --- |
| Preparation | `204` complete without bytes; `400` malformed request; `401` missing/incorrect PIN; `403` rejected; `409` busy; `429` too many attempts; `500` receiver failure |
| Upload | `400` missing arguments; `403` invalid session/token/source IP; `409` busy; `422` checksum mismatch; `500` receiver failure |

Handle `204` before parsing JSON. Stream/check byte counts; do not report success after an interrupted body. Return `422` when a supplied SHA-256 fails. The [protocol changelog](https://github.com/localsend/protocol/blob/main/CHANGELOG.md) attributes PIN and timestamps to 2.1, checksum-mismatch status to 2.2.

For a single text message, the [official send controller](https://github.com/localsend/localsend/blob/main/app/lib/provider/network/send_provider.dart) includes the UTF-8 message in `preview`. A receiver can show it during preparation and return `204` when the person reads/closes it, avoiding a subsequent upload. An ordinary text file can still transfer with an accepted token.

Download sharing is a separate mode: serve a browser page at the sender's address and set `download:true` only while offering this API. An accepted session can request its file map again using `sessionId`. The [official web server](https://github.com/localsend/localsend/blob/main/packages/core/src/http/server/web.rs) checks session + source IP, returns binary downloads with Content-Length and Content-Disposition, returns `400` for missing identifiers and `403` for invalid session/file or disabled download sharing. Preparation may return `401`, `403`, `429`, or `500`.

## HTTPS compatibility

Current [official architecture guidance](https://github.com/localsend/localsend/blob/main/AGENTS.md) requires TLS client certificates for ordinary app transfers. Use a device key/certificate for **outbound** HTTPS requests as well as the HTTPS listener. Fingerprints are uppercase hexadecimal SHA-256 of certificate DER, without separators. A claimed registration fingerprint must match the presented certificate. Disabling ordinary CA validation alone does not satisfy mutual TLS. Pin the certificate learned during discovery before sending data; plaintext HTTP remains an explicit supported mode.

Implementation recommendations for this reconstruction: persist identity, keep token/session state on the backend, stream large files, sanitize received relative paths, reserve duplicate destination names atomically, and discard incomplete files. These are reconstruction design decisions, not additional wire fields.

## Manual smoke transfer to an official app

For the shortest HTTP check, turn off encryption in the receiving LocalSend app, keep it open, and use its displayed LAN IP/port. Save the register information above (without `announce`) as `device.json`; save `{ "info": <that information>, "files": { "f1": <the hello.txt metadata above> } }` as `offer.json`. `hello.txt` must contain exactly six bytes, e.g. `hello` plus LF.

```powershell
curl.exe http://192.168.1.50:53317/api/localsend/v2/info
curl.exe -H "Content-Type: application/json" --data-binary "@device.json" http://192.168.1.50:53317/api/localsend/v2/register
curl.exe -H "Content-Type: application/json" --data-binary "@offer.json" http://192.168.1.50:53317/api/localsend/v2/prepare-upload
# Accept on the receiver, then substitute its actual session ID and f1 token:
curl.exe --data-binary "@hello.txt" "http://192.168.1.50:53317/api/localsend/v2/upload?sessionId=S&fileId=f1&token=T"
```

For HTTPS, use the same routes with `https://` and a matching sender identity: `curl.exe -k --cert device-cert.pem --key device-key.pem ...`. The sender's advertised fingerprint must match that certificate. This research alone does not establish that this reconstruction has passed a physical-device interoperability test.
