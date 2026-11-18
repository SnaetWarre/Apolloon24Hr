"""Check that a staged native package can serve its browser client outside the checkout."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen


def check(binary: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="apolloon-package-") as temp:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        url = f"http://127.0.0.1:{port}"
        db = Path(temp) / "app.db"
        env = {
            **os.environ,
            "PORT": str(port),
            "APOLLOON_NATIVE_DATA": str(db),
            "CLUSTER_ENABLED": "false",
            "BACKUP_ENABLED": "false",
        }
        env.pop("APOLLOON_WEB_DIR", None)
        process = subprocess.Popen([str(binary.resolve()), "--server"], cwd=temp, env=env)
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    with urlopen(url + "/api/health", timeout=1) as response:
                        if json.load(response)["ok"]:
                            break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError(f"Packaged server did not start (exit {process.poll()})")
            with urlopen(url + "/display/inside", timeout=5) as response:
                assert b"app.js" in response.read()
            with urlopen(url + "/app_bg.wasm", timeout=5) as response:
                assert response.headers.get_content_type() == "application/wasm"
                assert response.read(4) == b"\x00asm"
            assert db.is_file()
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
    print("PASS: packaged Rust server opens SQLite and serves Rune's browser entry point and WASM")


if __name__ == "__main__":
    check(Path(sys.argv[1]))
