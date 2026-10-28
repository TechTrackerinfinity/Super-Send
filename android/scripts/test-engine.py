"""Compile the exact Android transport class for local cross-language tests."""
from pathlib import Path
import os
import subprocess
import urllib.request

root=Path(__file__).resolve().parents[1]
java=Path(os.environ.get("JAVA_HOME",r"C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot"))
node=Path(os.environ.get("LOCALSEND_NODE",r"C:\Program Files\nodejs\node.exe"))
library=root/"tools"/"json-20250517.jar"
if not library.is_file():
    library.parent.mkdir(parents=True,exist_ok=True)
    urllib.request.urlretrieve("https://repo.maven.apache.org/maven2/org/json/json/20250517/json-20250517.jar",library)
output=root/"build"/"jvm-test"
output.mkdir(parents=True,exist_ok=True)
sources=[root/"app"/"src"/"main"/"java"/"org"/"localsend"/"rebuilt"/"TransferEngine.java",root/"test"/"EngineHarness.java"]
subprocess.run([str(java/"bin"/"javac.exe"),"--release","8","-encoding","UTF-8","-classpath",str(library),"-d",str(output),*[str(x)for x in sources]],check=True)
subprocess.run([str(node),"--test",str(root/"test"/"interop.test.js")],check=True,cwd=root.parent)
