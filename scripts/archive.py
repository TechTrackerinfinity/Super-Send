"""Archive the portable Windows build and the editable source separately."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parents[1]
release = root / "release"
version = json.loads((root / "package.json").read_text())["version"]
portable = release / f"Super-Send-{version}-win32-x64"
if not (portable / "Super Send.exe").is_file():
    raise SystemExit("Run npm run package first.")

windows_zip = f"Super-Send-{version}-Windows-x64.zip"
source_zip = f"Super-Send-{version}-Source.zip"
with ZipFile(release / windows_zip, "x", ZIP_DEFLATED, compresslevel=6) as archive:
    for file in sorted(portable.rglob("*")):
        if file.is_file():
            archive.write(file, file.relative_to(release))

names = ["src", "renderer", "test", "scripts", "docs", "package.json", "package-lock.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "Start Super Send.cmd", ".gitignore"]
with ZipFile(release / source_zip, "x", ZIP_DEFLATED, compresslevel=6) as archive:
    for name in names:
        item = root / name
        for file in sorted(item.rglob("*")) if item.is_dir() else [item]:
            if file.is_file() and not any(part.startswith(".service-test-") for part in file.parts):
                archive.write(file, Path("Super-Send-source") / file.relative_to(root))

for name in [windows_zip, source_zip]:
    target = release / name
    with ZipFile(target) as archive:
        corrupt = archive.testzip()
        if corrupt:
            raise SystemExit(f"Archive CRC failed: {corrupt}")
        print(f"{target}: {target.stat().st_size:,} bytes, {len(archive.infolist())} entries, CRC verified")
