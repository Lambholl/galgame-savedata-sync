"""One-shot private-LAN SAF experiment. Sources are read-only; only owned fixtures are cleaned.

The three input paths are CLI arguments, never included in the anonymized result JSON.
The server exposes only manifest-indexed files behind a random URL path on one LAN IP.
No ADB reverse/forward carries measured data. ADB is used only for deployment/control.
"""

import argparse
import gzip
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import socket
import stat
import subprocess
import tarfile
import tempfile
import threading
import time
import uuid


BASE: Path


def hash_file(path: Path) -> str:
    """Hash a regular file in bounded chunks without modifying it."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(65536):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot(root: Path) -> dict:
    """Reject reparse points/non-flat inputs and retain content plus identity/mtime in memory."""
    result = {}
    for path in sorted(root.iterdir()):
        info = path.lstat()
        if info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT or not path.is_file():
            raise RuntimeError("Only flat regular-file samples are accepted")
        before = (info.st_size, info.st_mtime_ns, info.st_dev, info.st_ino)
        digest = hash_file(path)
        after_info = path.stat()
        after = (after_info.st_size, after_info.st_mtime_ns, after_info.st_dev, after_info.st_ino)
        if before != after:
            raise RuntimeError("Source changed during read")
        if len(path.name.encode("utf-8")) >= 100 or any(ord(char) < 32 for char in path.name):
            raise RuntimeError("Sample name outside experiment USTAR subset")
        result[path.name] = (*before, digest)
    if not result:
        raise RuntimeError("Empty input sample")
    return result


def clean_owned(path: Path) -> None:
    """Recursively remove only a strict descendant of this newly created temporary root."""
    resolved = path.resolve()
    if resolved == BASE or not resolved.is_relative_to(BASE):
        raise RuntimeError("Unsafe cleanup target")
    if path.exists():
        shutil.rmtree(path)


class State:
    def __init__(self, args):
        self.args = args
        self.token = secrets.token_hex(8)
        self.secret = secrets.token_hex(16)
        self.remote = "/storage/emulated/0/Download/SaveDataSync-NetBench-" + self.token
        self.datasets = {}
        self.trials = {}
        self.rows = []
        self.finished = False
        self.errors = []
        self.lock = threading.Lock()

    def adb(self, *args, timeout=120):
        return subprocess.run(["adb", "-s", self.args.serial, *args], capture_output=True,
                              text=True, encoding="utf-8", errors="replace", timeout=timeout, check=True)

    def prepare(self):
        input_root = BASE / "input"
        input_root.mkdir()
        (BASE / "trials").mkdir()
        for index, root_string in enumerate(self.args.sources):
            root = Path(root_string).resolve()
            baseline = snapshot(root)
            label = chr(65 + index)
            directory = "input-" + str(index + 1)
            copied = input_root / directory
            copied.mkdir()
            files = []
            for name, metadata in baseline.items():
                destination = copied / name
                with (root / name).open("rb") as source, destination.open("xb") as target:
                    shutil.copyfileobj(source, target, 65536)
                if hash_file(destination) != metadata[-1]:
                    raise RuntimeError("Source copy failed validation")
                files.append({"name": name, "size": metadata[0], "sha256": metadata[-1]})
            self.datasets[label] = {"sample": label, "directory": directory, "files": files,
                                    "bytes": sum(item["size"] for item in files), "copied": copied,
                                    "source": root, "baseline": baseline}
            print(json.dumps({"prepared": label, "files": len(files), "bytes": self.datasets[label]["bytes"]}), flush=True)
        absent = subprocess.run(["adb", "-s", self.args.serial, "shell", "test -e " + shlex.quote(self.remote)], capture_output=True)
        if absent.returncode != 1:
            raise RuntimeError("Device fixture is not confirmed absent")
        self.adb("shell", "mkdir " + shlex.quote(self.remote))
        for data in self.datasets.values():
            self.adb("push", str(data["copied"]), self.remote + "/" + data["directory"])
        print(json.dumps({"fixtureReady": self.remote.split("/")[-1]}), flush=True)

    def new_trial(self, request):
        sample, direction, method, round_index = (request[key] for key in ["sample", "direction", "method", "round"])
        if sample not in self.datasets or direction not in ["up", "down"] or method not in ["files", "tar", "gzip1"] or round_index not in range(3):
            raise ValueError("Invalid experiment case")
        data = self.datasets[sample]
        identifier = uuid.uuid4().hex[:12]
        directory = BASE / "trials" / identifier
        directory.mkdir()
        (directory / "received").mkdir()
        trial = {"id": identifier, "sample": sample, "direction": direction, "method": method,
                 "round": round_index, "directory": directory, "requests": 0, "peers": set(),
                 "verified": 0, "seen": set(), "packMs": 0, "wireBytes": data["bytes"]}
        if direction == "down" and method != "files":
            archive = directory / "wire.tar"
            started = time.perf_counter()
            digest = hashlib.sha256()
            with archive.open("xb") as raw:
                checked = DigestWriter(raw, digest)
                compressor = gzip.GzipFile(filename="", mode="wb", compresslevel=1, fileobj=checked, mtime=0) if method == "gzip1" else checked
                try:
                    with tarfile.open(fileobj=compressor, mode="w|", format=tarfile.USTAR_FORMAT, encoding="utf-8") as output:
                        for entry in data["files"]:
                            info = tarfile.TarInfo(entry["name"])
                            info.size, info.mtime, info.mode = entry["size"], 0, 0o600
                            with (data["copied"] / entry["name"]).open("rb") as stream:
                                output.addfile(info, stream)
                finally:
                    if method == "gzip1":
                        compressor.close()
            trial["archiveHash"] = digest.hexdigest()
            trial["packMs"] = (time.perf_counter() - started) * 1000
            trial["wireBytes"] = archive.stat().st_size
            trial["archive"] = archive
        self.trials[identifier] = trial
        return {key: trial[key] for key in ["id", "packMs", "wireBytes", "archiveHash"] if key in trial}

    def register_result(self, request):
        trial = self.trials[request["id"]]
        data = self.datasets[trial["sample"]]
        expected_requests = len(data["files"]) if trial["method"] == "files" else 1
        if trial["requests"] != expected_requests or len(trial["peers"]) != 1:
            raise RuntimeError("Data requests did not reuse exactly one TCP connection")
        if request["filesVerified"] != len(data["files"]) or (trial["direction"] == "up" and trial["verified"] != len(data["files"])):
            raise RuntimeError("Missing actual receiver content verification")
        row = {key: trial[key] for key in ["sample", "direction", "method", "round"]}
        row.update({key: request[key] for key in ["totalMs", "packMs", "transferAndReceiveMs", "wireBytes", "filesVerified"]})
        row.update({"httpRequests": trial["requests"], "tcpConnections": len(trial["peers"])})
        with self.lock:
            if any(all(existing[key] == row[key] for key in ["sample", "direction", "method", "round"]) for existing in self.rows):
                raise RuntimeError("Duplicate measurement")
            self.rows.append(row)
            (BASE / "results.json").write_text(json.dumps(self.rows, indent=2), encoding="utf-8")
        print(json.dumps({"measurement": len(self.rows), **row}), flush=True)
        clean_owned(trial["directory"])
        return {"ok": True}


class DigestWriter:
    """Hash archive bytes while writing, without an extra archive reread in the timed path."""

    def __init__(self, stream, digest):
        self.stream, self.digest = stream, digest

    def write(self, data):
        self.digest.update(data)
        return self.stream.write(data)

    def flush(self):
        self.stream.flush()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.connection.settimeout(90)

    def log_message(self, *_):
        pass

    def route(self):
        if self.client_address[0] != STATE.args.peer:
            raise PermissionError("Unexpected LAN peer")
        prefix = "/" + STATE.secret + "/"
        if not self.path.startswith(prefix):
            raise PermissionError("Unknown experiment path")
        return self.path[len(prefix):].split("/")

    def respond(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def failure(self, error):
        STATE.errors.append(type(error).__name__)
        self.close_connection = True
        self.send_error(500, "Experiment request failed")
        print(json.dumps({"serverError": type(error).__name__}), flush=True)

    def do_GET(self):
        try:
            parts = self.route()
            if parts == ["setup"]:
                data = [{key: item[key] for key in ["sample", "directory", "files", "bytes"]} for item in STATE.datasets.values()]
                return self.respond({"datasets": data, "rounds": 3})
            trial = STATE.trials[parts[1]]
            if parts[0] != "trial" or trial["direction"] != "down":
                raise ValueError("Unexpected download")
            if parts[2] == "file" and trial["method"] == "files":
                data = STATE.datasets[trial["sample"]]
                file = data["copied"] / data["files"][int(parts[3])]["name"]
            elif parts[2] == "archive" and trial["method"] != "files":
                file = trial["archive"]
            else:
                raise ValueError("Unexpected body")
            trial["requests"] += 1
            trial["peers"].add(self.client_address)
            self.send_response(200)
            self.send_header("Content-Length", str(file.stat().st_size))
            self.end_headers()
            with file.open("rb") as stream:
                shutil.copyfileobj(stream, self.wfile, 65536)
        except Exception as error:
            self.failure(error)

    def do_POST(self):
        try:
            parts = self.route()
            size = int(self.headers["Content-Length"])
            if not 0 <= size <= 65536:
                raise ValueError("Oversized control request")
            request = json.loads(self.rfile.read(size))
            if parts == ["new"]:
                return self.respond(STATE.new_trial(request))
            if parts == ["result"]:
                return self.respond(STATE.register_result(request))
            if parts == ["finished"] and request["completed"] == 54 and len(STATE.rows) == 54:
                STATE.finished = True
                return self.respond({"ok": True})
            raise ValueError("Unexpected control route")
        except Exception as error:
            self.failure(error)

    def do_PUT(self):
        try:
            parts = self.route()
            trial = STATE.trials[parts[1]]
            data = STATE.datasets[trial["sample"]]
            if parts[0] != "trial" or trial["direction"] != "up":
                raise ValueError("Unexpected upload")
            size = int(self.headers["Content-Length"])
            if not 0 <= size <= data["bytes"] * 2 + 10485760:
                raise ValueError("Oversized upload")
            trial["requests"] += 1
            trial["peers"].add(self.client_address)
            file = (trial["directory"] / "wire.tar") if parts[2] == "archive" else (
                trial["directory"] / "received" / data["files"][int(parts[3])]["name"])
            digest = hashlib.sha256()
            remaining = size
            with file.open("xb") as output:
                while remaining:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        raise RuntimeError("Truncated upload")
                    output.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
            if digest.hexdigest() != self.headers["X-Bench-Sha256"]:
                raise RuntimeError("Upload body checksum mismatch")
            if parts[2] == "file" and trial["method"] == "files":
                index = int(parts[3])
                expected = data["files"][index]
                if index in trial["seen"] or size != expected["size"] or hash_file(file) != expected["sha256"]:
                    raise RuntimeError("Actual receiver readback mismatch")
                trial["seen"].add(index)
                trial["verified"] += 1
            elif parts[2] == "archive" and trial["method"] != "files":
                expected = {item["name"]: item for item in data["files"]}
                seen = set()
                with tarfile.open(file, "r:*") as archive:
                    for entry in archive:
                        if not entry.isfile() or entry.name not in expected or entry.name in seen:
                            raise RuntimeError("Unexpected archive member")
                        info = expected[entry.name]
                        if entry.size != info["size"]:
                            raise RuntimeError("Unexpected archive length")
                        destination = trial["directory"] / "received" / entry.name
                        with archive.extractfile(entry) as source, destination.open("xb") as output:
                            shutil.copyfileobj(source, output, 65536)
                        if hash_file(destination) != info["sha256"]:
                            raise RuntimeError("Archive receiver readback mismatch")
                        seen.add(entry.name)
                if len(seen) != len(expected):
                    raise RuntimeError("Missing archive files")
                trial["verified"] = len(seen)
            else:
                raise ValueError("Unexpected upload method")
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except Exception as error:
            self.failure(error)


def run(args):
    """Prepare isolated copies, run one real-device experiment, then verify and clean owned data."""
    global STATE
    STATE = State(args)
    server = None
    process = None
    failure = None
    try:
        STATE.prepare()
        server = http.server.ThreadingHTTPServer((args.bind, 0), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://{args.bind}:{server.server_port}/{STATE.secret}/"
        command = ["adb", "-s", args.serial, "shell", "am", "instrument", "-r", "-w", "-e", "class",
                   "io.github.galgame.savedatasync.TransferBenchmarkTest#bidirectionalSafBenchmark", "-e", "benchBase", base,
                   "-e", "benchToken", STATE.token, "io.github.galgame.savedatasync.test/androidx.test.runner.AndroidJUnitRunner"]
        print(json.dumps({"picker": STATE.remote.split("/")[-1], "plannedMeasurements": 54}), flush=True)
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        output = []
        for line in process.stdout:
            output.append(line)
            if "stack=" in line or "FAILURES!!!" in line or "INSTRUMENTATION_RESULT" in line or "INSTRUMENTATION_CODE" in line:
                print(line.rstrip(), flush=True)
        process.wait(timeout=10)
        joined = "".join(output)
        if process.returncode or "OK (1 test)" not in joined or "INSTRUMENTATION_CODE: -1" not in joined or not STATE.finished or STATE.errors:
            raise RuntimeError("No complete successful benchmark receipt")
    except Exception as error:
        failure = type(error).__name__ + ": " + str(error)
        print(json.dumps({"experimentFailure":type(error).__name__}), flush=True)
    finally:
        if process and process.poll() is None:
            STATE.adb("shell", "am force-stop io.github.galgame.savedatasync")
            process.terminate()
        if server:
            server.shutdown()
            server.server_close()
        preserved = True
        for data in STATE.datasets.values():
            try:
                preserved = snapshot(data["source"]) == data["baseline"] and preserved
            except Exception:
                # Still clean only our private copies if a source disappears or changes shape.
                preserved = False
        print(json.dumps({"originalSourcesUnchanged": preserved}), flush=True)
        # A single exact fixture root, created by this invocation; no user path is deleted.
        remote = STATE.remote
        if not remote.startswith("/storage/emulated/0/Download/SaveDataSync-NetBench-") or remote.rsplit("-", 1)[-1] != STATE.token:
            raise RuntimeError("Unsafe device cleanup root")
        result = subprocess.run(["adb", "-s", args.serial, "shell", "realpath " + shlex.quote(remote)], capture_output=True, text=True)
        if result.returncode == 0:
            if result.stdout.strip() != remote:
                raise RuntimeError("Unexpected device fixture resolution")
            STATE.adb("shell", "rm -rf -- " + shlex.quote(remote))
        for child in [BASE / "input", BASE / "trials"]:
            clean_owned(child)
        summary = {"successful":failure is None and preserved, "sourceFilesUnchanged":preserved,
                   "samples":[{"sample":data["sample"],"files":len(data["files"]),"bytes":data["bytes"]} for data in STATE.datasets.values()],
                   "rows":STATE.rows,"serverErrors":STATE.errors}
        (BASE / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        report = Path(args.report).resolve()
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if failure:
        raise RuntimeError(failure)
    if not preserved:
        raise RuntimeError("Original source snapshot changed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", required=True)
    parser.add_argument("--peer", required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--report", default=".reports/transfer-benchmark.json", help="Anonymous timings JSON; cannot be inside a source")
    parser.add_argument("sources", nargs=3)
    arguments = parser.parse_args()
    if os.name != "nt":
        parser.error("This benchmark controller targets the Windows host")
    report = Path(arguments.report).resolve()
    if any(report.is_relative_to(Path(root).resolve()) for root in arguments.sources):
        parser.error("Report cannot be written inside a read-only source")
    BASE = Path(tempfile.mkdtemp(prefix="savedata-netbench-")).resolve()
    try:
        run(arguments)
    finally:
        if BASE.parent != Path(tempfile.gettempdir()).resolve() or not BASE.name.startswith("savedata-netbench-"):
            raise RuntimeError("Unsafe temporary root cleanup")
        shutil.rmtree(BASE)
