"""Build and sign a dependency-free Android APK with an installed Android SDK."""
from pathlib import Path
import json
import os
import secrets
import subprocess
import zipfile
import hashlib
import shutil
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
if not os.environ.get("ANDROID_HOME") or not os.environ.get("JAVA_HOME"):
    raise SystemExit("Set ANDROID_HOME and JAVA_HOME to the Android SDK and JDK 17 directories.")
SDK = Path(os.environ["ANDROID_HOME"])
JAVA_HOME = Path(os.environ["JAVA_HOME"])
TOOLS = SDK / "build-tools" / "36.0.0"
PLATFORM = SDK / "platforms" / "android-36" / "android.jar"
BUILD = ROOT / "build"
SIGNING = ROOT / "signing"
RELEASE = ROOT.parent / "release"
SRC = ROOT / "app" / "src" / "main"

def run(args, **kwargs):
    result = subprocess.run([str(a) for a in args], text=True, **kwargs)
    if result.returncode:
        raise SystemExit(f"Build tool failed with exit code {result.returncode}: {Path(str(args[0])).name}")

for item in [JAVA_HOME / "bin" / "javac.exe", TOOLS / "aapt2.exe", PLATFORM]:
    if not item.is_file():
        raise SystemExit(f"Missing required build tool: {item}")
for name in ["generated", "classes", "dex"]:
    target = (BUILD / name).resolve()
    if not target.is_relative_to(BUILD.resolve()):
        raise SystemExit("Build output must remain inside this project's build directory.")
    if target.is_dir():
        shutil.rmtree(target)
    (BUILD / name).mkdir(parents=True, exist_ok=True)
SIGNING.mkdir(exist_ok=True)
RELEASE.mkdir(exist_ok=True)

run([TOOLS / "aapt2.exe", "compile", "--dir", SRC / "res", "-o", BUILD / "resources.zip"])
run([TOOLS / "aapt2.exe", "link", "-I", PLATFORM, "--manifest", SRC / "AndroidManifest.xml", "--java", BUILD / "generated", "--auto-add-overlay", "-A", SRC / "assets", "-o", BUILD / "resources.apk", BUILD / "resources.zip"])

sources = sorted((SRC / "java").rglob("*.java")) + sorted((BUILD / "generated").rglob("*.java"))
if len(sources) < 6:
    raise SystemExit("Android source files are incomplete.")
source_list = BUILD / "sources.txt"
source_list.write_text("\n".join('"' + str(f).replace("\\", "/") + '"' for f in sources), encoding="utf-8")
run([JAVA_HOME / "bin" / "javac.exe", "--release", "8", "-encoding", "UTF-8", "-classpath", PLATFORM, "-d", BUILD / "classes", "@" + str(source_list)])
classes_jar = BUILD / "classes.jar"
with zipfile.ZipFile(classes_jar, "w", zipfile.ZIP_DEFLATED) as archive:
    for file in sorted((BUILD / "classes").rglob("*.class")):
        archive.write(file, file.relative_to(BUILD / "classes").as_posix())
run([JAVA_HOME / "bin" / "java.exe", "-cp", TOOLS / "lib" / "d8.jar", "com.android.tools.r8.D8", "--release", "--min-api", "26", "--lib", PLATFORM, "--output", BUILD / "dex", classes_jar])

unsigned = BUILD / "unsigned.apk"
with zipfile.ZipFile(BUILD / "resources.apk") as source, zipfile.ZipFile(unsigned, "w", zipfile.ZIP_DEFLATED) as target:
    for item in source.infolist():
        target.writestr(item, source.read(item.filename))
    for dex in sorted((BUILD / "dex").glob("*.dex")):
        target.write(dex, dex.name)
aligned = BUILD / "aligned.apk"
run([TOOLS / "zipalign.exe", "-f", "-p", "4", unsigned, aligned])

config_file = SIGNING / "identity.json"
if not config_file.exists():
    config_file.write_text(json.dumps({"storePassword": secrets.token_urlsafe(32), "alias": "localsend-rebuilt"}), encoding="utf-8")
config = json.loads(config_file.read_text(encoding="utf-8"))
environment = dict(os.environ, LOCALSEND_APK_STORE_PASSWORD=config["storePassword"])
keystore = SIGNING / "localsend-rebuilt.p12"
if not keystore.exists():
    run([JAVA_HOME / "bin" / "keytool.exe", "-genkeypair", "-keystore", keystore, "-storetype", "PKCS12", "-storepass:env", "LOCALSEND_APK_STORE_PASSWORD", "-alias", config["alias"], "-keyalg", "RSA", "-keysize", "3072", "-sigalg", "SHA256withRSA", "-validity", "10000", "-dname", "CN=LocalSend Rebuilt"], env=environment)
version = ET.parse(SRC / "AndroidManifest.xml").getroot().get("{http://schemas.android.com/apk/res/android}versionName")
output = RELEASE / f"Super-Send-Android-{version}.apk"
run([JAVA_HOME / "bin" / "java.exe", "-jar", TOOLS / "lib" / "apksigner.jar", "sign", "--ks", keystore, "--ks-key-alias", config["alias"], "--ks-pass", "env:LOCALSEND_APK_STORE_PASSWORD", "--out", output, aligned], env=environment)
run([JAVA_HOME / "bin" / "java.exe", "-jar", TOOLS / "lib" / "apksigner.jar", "verify", "--verbose", "--print-certs", output])
run([TOOLS / "zipalign.exe", "-c", "-v", "4", output], stdout=subprocess.DEVNULL)
checksum = hashlib.sha256(output.read_bytes()).hexdigest()
(RELEASE / (output.name + ".sha256")).write_text(checksum + "  " + output.name + "\n", encoding="ascii")
print(f"APK ready: {output} ({output.stat().st_size:,} bytes), SHA-256 {checksum}")
