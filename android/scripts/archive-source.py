"""Archive editable Android sources, excluding credentials and build outputs."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import xml.etree.ElementTree as ET

root=Path(__file__).resolve().parents[1]
version=ET.parse(root/"app"/"src"/"main"/"AndroidManifest.xml").getroot().get("{http://schemas.android.com/apk/res/android}versionName")
output=root.parent/"release"/f"Super-Send-Android-{version}-Source.zip"
with ZipFile(output,"w",ZIP_DEFLATED,compresslevel=6) as archive:
    for name in ["app", "scripts", "test", "docs", "README.md", "Build Android.cmd", ".gitignore", "settings.gradle", "build.gradle", "gradle.properties"]:
        item=root/name
        for file in sorted(item.rglob("*")) if item.is_dir() else [item]:
            if file.is_file() and not any(part in {"__pycache__","build",".gradle","signing","tools"} for part in file.relative_to(root).parts):
                archive.write(file,Path("Super-Send-Android")/file.relative_to(root))
    for name in ["LICENSE","THIRD_PARTY_NOTICES.md"]:
        archive.write(root.parent/name,Path("Super-Send-Android")/name)
    for name in ["service.js","certificate.js","reverse-receiver.js","transfer-pool.js"]:
        archive.write(root.parent/"src"/name,Path("Super-Send-Android")/"pc-test-host"/name)
    archive.write(root.parent/"docs"/"SUPER-SEND-1.4.0.md",Path("Super-Send-Android")/"docs"/"SUPER-SEND-1.4.0.md")
    for name in ["PERFORMANCE-1.5.0.md", "HOTSPOT-FIX-1.5.1.md", "VALIDATION-1.5.1.json", "THROUGHPUT-BENCHMARK.md", "throughput-baseline-1.4.json", "throughput-optimized-1.5.json", "throughput-baseline-confirm-1.4.json", "throughput-optimized-confirm-1.5.json"]:
        archive.write(root.parent/"docs"/name,Path("Super-Send-Android")/"docs"/name)
    for name in ["PERFORMANCE-1.6.0.md", "VALIDATION-1.6.0.json", *[p.name for p in sorted((root.parent/"docs").glob("throughput-1.6.0-*.json"))]]:
        archive.write(root.parent/"docs"/name,Path("Super-Send-Android")/"docs"/name)
    archive.write(root.parent/"docs"/"BLIP-FINDINGS-AND-TRANSFER-FIX-1.3.0.md",Path("Super-Send-Android")/"docs"/"BLIP-FINDINGS-AND-TRANSFER-FIX-1.3.0.md")
    archive.write(root.parent/"docs"/"UI-VALIDATION-1.1.0.md",Path("Super-Send-Android")/"docs"/"UI-VALIDATION-1.1.0.md")
with ZipFile(output) as archive:
    bad=archive.testzip()
    if bad:raise SystemExit(f"CRC check failed: {bad}")
print(f"{output}: {output.stat().st_size:,} bytes, CRC verified")
