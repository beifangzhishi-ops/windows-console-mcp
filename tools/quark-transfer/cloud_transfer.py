from __future__ import annotations

import argparse
import base64
import ctypes
import glob
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import time
import urllib.error
import urllib.request

DESKTOP_URL = "http://127.0.0.1:9125"
SOURCE = "desktop_lite"
METHOD = "transfer.upload.create"
HOST_FLAVOR = "clouddrive"
LOCAL_STORAGE_ORIGIN = "_uccd://browser.quark"
DEFAULT_FOLDER_NAME = "夸克上传文件"


class ToolError(RuntimeError):
    pass


def _program_files() -> Path:
    return Path(os.environ.get("ProgramFiles", r"C:\Program Files"))


def wsg_dll_path() -> Path:
    return (_program_files() / "QuarkCloudDrive" / "components" /
            "clouddrive_desktop_widget_independent" / "wsg_impl.dll")


def local_storage_dir() -> Path:
    return (Path(os.environ["LOCALAPPDATA"]) / "QuarkCloudDrive" / "User Data" /
            "Default" / "Local Storage" / "leveldb")


def persistence_root() -> Path:
    return (Path(os.environ["LOCALAPPDATA"]) / "QuarkCloudDrive" / "User Data" /
            "persistence")


class Wsg:
    def __init__(self, path: Path):
        if not path.is_file():
            raise ToolError(f"未找到 Quark WSG 组件: {path}")
        os.add_dll_directory(str(path.parent))
        self.dll = ctypes.WinDLL(str(path))
        self._bind()
        self.handle = self.dll.WSG_CreateInstance()
        if not self.handle:
            raise ToolError("WSG_CreateInstance 失败")

    def _bind(self) -> None:
        d = self.dll
        d.WSG_CreateInstance.argtypes = []
        d.WSG_CreateInstance.restype = ctypes.c_void_p
        d.WSG_GetEncryptedToBase64Size.argtypes = [ctypes.c_size_t]
        d.WSG_GetEncryptedToBase64Size.restype = ctypes.c_size_t
        d.WSG_EncryptToBase64.argtypes = [ctypes.c_void_p, ctypes.c_uint32,
            ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t]
        d.WSG_EncryptToBase64.restype = ctypes.c_int
        d.WSG_GetDecryptedFromBase64Size.argtypes = [ctypes.c_size_t]
        d.WSG_GetDecryptedFromBase64Size.restype = ctypes.c_size_t
        d.WSG_DecryptFromBase64.argtypes = [ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_uint16), ctypes.c_void_p, ctypes.c_size_t,
            ctypes.c_void_p, ctypes.c_size_t]
        d.WSG_DecryptFromBase64.restype = ctypes.c_int
        if hasattr(d, "WSG_DestroyInstance"):
            d.WSG_DestroyInstance.argtypes = [ctypes.c_void_p]

    def decrypt_b64(self, cipher: str) -> tuple[int, bytes]:
        raw = cipher.encode("ascii")
        cap = self.dll.WSG_GetDecryptedFromBase64Size(len(raw))
        out = ctypes.create_string_buffer(cap)
        number = ctypes.c_uint16(0)
        src = ctypes.create_string_buffer(raw)
        n = self.dll.WSG_DecryptFromBase64(self.handle, ctypes.byref(number),
            src, len(raw), out, cap)
        if n < 0:
            raise ToolError("WSG 解密失败")
        return number.value, out.raw[:n]

    def encrypt_b64(self, number: int, plain: bytes) -> str:
        cap = self.dll.WSG_GetEncryptedToBase64Size(len(plain))
        out = ctypes.create_string_buffer(cap)
        src = ctypes.create_string_buffer(plain)
        n = self.dll.WSG_EncryptToBase64(self.handle, number, src, len(plain),
            out, cap)
        if n < 0:
            raise ToolError("WSG 加密失败")
        return out.raw[:n].decode("ascii")

    def close(self) -> None:
        if getattr(self, "handle", None) and hasattr(self.dll, "WSG_DestroyInstance"):
            self.dll.WSG_DestroyInstance(self.handle)
            self.handle = None

    def __enter__(self) -> "Wsg":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


def fetch_desktop_info() -> dict:
    url = os.environ.get("QUARK_DESKTOP_URL", DESKTOP_URL).rstrip("/") + "/desktop_info"
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            body = json.load(response)
    except Exception as exc:
        raise ToolError("无法连接 Quark Desktop 服务；请确认夸克网盘正在运行") from exc

    if not isinstance(body, dict) or not body.get("success"):
        raise ToolError("Quark Desktop 服务返回异常")
    data = body.get("data")
    if not isinstance(data, dict):
        raise ToolError("Quark Desktop 信息结构异常")
    if data.get("isLogin") is not True:
        raise ToolError("夸克网盘当前未登录")
    if not isinstance(data.get("wsUid"), str) or not data["wsUid"]:
        raise ToolError("Quark Desktop 缺少当前账号信息")
    return data


def current_origin_and_number(wsg: Wsg, info: dict) -> tuple[str, int]:
    number, raw = wsg.decrypt_b64(info["wsUid"])
    try:
        origin = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ToolError("当前账号标识解码失败") from exc
    if not origin or any(ord(ch) < 32 for ch in origin):
        raise ToolError("当前账号标识无效")
    return origin, number


def _json_string_hits(raw: bytes, key: str, encoding: str) -> list[tuple[int, str]]:
    prefix = (f'"{key}":"').encode(encoding)
    quote = '"'.encode(encoding)
    hits: list[tuple[int, str]] = []
    start = 0
    while True:
        pos = raw.find(prefix, start)
        if pos < 0:
            break
        value_start = pos + len(prefix)
        value_end = raw.find(quote, value_start)
        if value_end >= 0:
            try:
                value = raw[value_start:value_end].decode(encoding)
                hits.append((pos, value))
            except UnicodeDecodeError:
                pass
        start = pos + max(1, len(prefix))
    return hits


def find_uid_wsg(origin: str) -> str:
    root = local_storage_dir()
    if not root.is_dir():
        raise ToolError("未找到 Quark Local Storage")
    candidates: set[str] = set()
    files = [p for p in root.iterdir() if p.is_file() and p.suffix in {".ldb", ".log"}]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    key_forms = [b"atom_user_info", "atom_user_info".encode("utf-16le")]
    origin_forms = [LOCAL_STORAGE_ORIGIN.encode(), LOCAL_STORAGE_ORIGIN.encode("utf-16le")]
    for path in files:
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        positions = sorted({pos for key in key_forms for pos in _all_positions(raw, key)})
        for pos in positions:
            lo, hi = max(0, pos - 65536), min(len(raw), pos + 131072)
            window = raw[lo:hi]
            if not any(mark in window for mark in origin_forms):
                continue
            candidates.update(_uid_candidates_from_window(window, origin))
    if len(candidates) != 1:
        raise ToolError(f"当前账号映射不唯一（匹配数: {len(candidates)}），已安全中止")
    return next(iter(candidates))


def _all_positions(raw: bytes, needle: bytes) -> list[int]:
    if not needle:
        return []
    result: list[int] = []
    start = 0
    while True:
        pos = raw.find(needle, start)
        if pos < 0:
            return result
        result.append(pos)
        start = pos + len(needle)


def _uid_candidates_from_window(window: bytes, origin: str) -> set[str]:
    result: set[str] = set()
    for encoding in ("utf-16le", "utf-8"):
        uid_hits = _json_string_hits(window, "uId", encoding)
        wsg_hits = [(p, v) for p, v in _json_string_hits(window, "uid_wsg", encoding) if v]
        for uid_pos, uid in uid_hits:
            if uid != origin:
                continue
            nearby = [(abs(p - uid_pos), v) for p, v in wsg_hits if abs(p - uid_pos) <= 16384]
            if not nearby:
                continue
            nearby.sort(key=lambda item: item[0])
            best_distance = nearby[0][0]
            best = {value for distance, value in nearby if distance == best_distance}
            result.update(best)
    return result


def current_upload_db(origin: str) -> Path:
    db = persistence_root() / origin / "upload.db"
    return db


def _connect_ro(db: Path) -> sqlite3.Connection:
    uri = "file:" + db.as_posix() + "?mode=ro"
    return sqlite3.connect(uri, uri=True, timeout=1)


def submit_upload(wsg: Wsg, number: int, account_id: str,
                  paths: list[Path]) -> tuple[int, dict]:
    issued_at = int(time.time() * 1000)
    operation_id = base64.urlsafe_b64encode(secrets.token_bytes(16)).rstrip(b"=").decode("ascii")
    payload = {
        "version": 1,
        "host_flavor": HOST_FLAVOR,
        "secure_no": number,
        "account_id": account_id,
        "operation_id": operation_id,
        "batch_id": operation_id,
        "batch_index": 0,
        "batch_count": 1,
        "total_count": len(paths),
        "issued_at": issued_at,
        "method": METHOD,
        "params": {"paths": [str(p) for p in paths], "source": SOURCE},
    }
    plain = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    cipher = wsg.encrypt_b64(number, plain)
    outer = json.dumps({"version": 1, "cipher": cipher}, separators=(",", ":")).encode()
    url = os.environ.get("QUARK_DESKTOP_URL", DESKTOP_URL).rstrip("/") + "/desktop_upload"
    request = urllib.request.Request(url, data=outer,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        raise ToolError(f"Desktop Upload HTTP {exc.code}") from exc
    except Exception as exc:
        raise ToolError("调用 Desktop Upload 失败") from exc
    if not isinstance(result, dict):
        raise ToolError("Desktop Upload 返回结构异常")
    if result.get("success") is not True:
        code = str(result.get("code") or "UNKNOWN")[:80]
        msg = str(result.get("msg") or "desktop upload rejected")[:160]
        raise ToolError(f"上传请求被拒绝: {code} ({msg})")
    data = result.get("data")
    if not isinstance(data, dict):
        data = {}
    return issued_at, {
        "queued": data.get("status") == "QUEUED",
        "upload_id_present": bool(data.get("upload_id")),
        "code": result.get("code"),
    }


def _norm_path(value: str | Path) -> str:
    try:
        return os.path.normcase(os.path.normpath(os.path.abspath(str(value))))
    except Exception:
        return os.path.normcase(os.path.normpath(str(value)))


def query_task(db: Path, path: Path, since_ms: int) -> dict | None:
    if not db.is_file():
        return None
    size = path.stat().st_size
    try:
        con = _connect_ro(db)
        rows = con.execute(
            "SELECT id,name,path,size,status,progress,finishSize,createTime,"
            "updateTime,finishTime FROM upload_task "
            "WHERE name=? AND size=? AND createTime>=? ORDER BY createTime DESC LIMIT 12",
            (path.name, size, since_ms - 5000)).fetchall()
        con.close()
    except sqlite3.Error:
        return None
    if not rows:
        return None
    exact = [row for row in rows if row[2] and _norm_path(row[2]) == _norm_path(path)]
    if exact:
        row = exact[0]
    elif len(rows) == 1:
        row = rows[0]
    else:
        return None
    keys = ("id", "name", "path", "size", "status", "progress", "finishSize",
            "createTime", "updateTime", "finishTime")
    return dict(zip(keys, row))


SUCCESS_STATUSES = {"FINISH", "SUCCEEDED", "SUCCESS"}
FAIL_STATUSES = {"ERROR", "FAIL", "FAILED", "CANCEL", "CANCELED", "CANCELLED"}


def task_state(task: dict, local_size: int) -> str:
    status = str(task.get("status") or "").upper()
    if status in FAIL_STATUSES:
        return "failed"
    progress = float(task.get("progress") or 0)
    remote_size = task.get("size")
    finish_size = task.get("finishSize")
    size_ok = remote_size == local_size
    finish_ok = finish_size == remote_size if finish_size is not None else False
    if status in SUCCESS_STATUSES and progress >= 100 and size_ok and finish_ok:
        return "finished"
    return "running"


def wait_for_uploads(db: Path, paths: list[Path], since_ms: int,
                     timeout: float, json_mode: bool = False) -> list[dict]:
    deadline = time.monotonic() + timeout
    pending = {_norm_path(p): p for p in paths}
    final: dict[str, dict] = {}
    last_report: dict[str, tuple[str, int]] = {}
    while pending and time.monotonic() < deadline:
        for key, path in list(pending.items()):
            task = query_task(db, path, since_ms)
            if not task:
                continue
            state = task_state(task, path.stat().st_size)
            status = str(task.get("status") or "UNKNOWN")
            progress = int(float(task.get("progress") or 0))
            if state == "failed":
                raise ToolError(f"上传失败: {path.name} ({status})")
            if state == "finished":
                final[key] = {
                    "name": path.name,
                    "size": path.stat().st_size,
                    "status": status,
                    "progress": float(task.get("progress") or 0),
                }
                pending.pop(key)
                if not json_mode:
                    print(f"完成: {path.name} ({path.stat().st_size} bytes)")
                continue
            marker = (status, progress)
            if not json_mode and last_report.get(key) != marker:
                print(f"上传中: {path.name} {progress}% [{status}]")
                last_report[key] = marker
        if pending:
            time.sleep(0.5)
    if pending:
        names = ", ".join(p.name for p in pending.values())
        raise ToolError(f"等待上传完成超时: {names}")
    return [final[_norm_path(p)] for p in paths]


def resolve_files(values: list[str]) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    for value in values:
        try:
            path = Path(value).expanduser().resolve(strict=True)
        except OSError as exc:
            raise ToolError(f"文件不存在: {value}") from exc
        if not path.is_file():
            raise ToolError(f"当前只支持文件上传: {path}")
        key = _norm_path(path)
        if key not in seen:
            seen.add(key)
            result.append(path)
    if not result:
        raise ToolError("没有可上传文件")
    return result


def probe_data() -> dict:
    info = fetch_desktop_info()
    dll_path = wsg_dll_path()
    with Wsg(dll_path) as wsg:
        origin, _number = current_origin_and_number(wsg, info)
        _account = find_uid_wsg(origin)
        db = current_upload_db(origin)
    return {
        "ok": True,
        "desktop_service": True,
        "logged_in": True,
        "quark_cloud_version": str(info.get("quarkCloudVersion") or ""),
        "desktop_component_version": str(info.get("version") or ""),
        "wsg_component": True,
        "account_mapping": True,
        "upload_db_exists": db.is_file(),
        "default_destination": DEFAULT_FOLDER_NAME,
        "destination_mode": "Quark system manual_upload",
    }


def command_probe(args: argparse.Namespace) -> int:
    data = probe_data()
    if args.json:
        print(json.dumps(data, ensure_ascii=False))
    else:
        print("Quark Desktop: OK（已登录）")
        print(f"客户端版本: {data['quark_cloud_version'] or 'unknown'}")
        print("WSG 组件: OK")
        print("当前账号映射: OK")
        print(f"上传任务库: {'OK' if data['upload_db_exists'] else '尚未创建'}")
        print(f"默认目标: {data['default_destination']}（system manual_upload）")
    return 0


def command_upload(args: argparse.Namespace) -> int:
    paths = resolve_files(args.paths)
    info = fetch_desktop_info()
    with Wsg(wsg_dll_path()) as wsg:
        origin, number = current_origin_and_number(wsg, info)
        account = find_uid_wsg(origin)
        db = current_upload_db(origin)
        issued_at, ack = submit_upload(wsg, number, account, paths)
    if args.no_wait:
        result = {"ok": True, "accepted": True, "count": len(paths),
                  "queued": ack["queued"], "destination": DEFAULT_FOLDER_NAME}
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(f"已提交 {len(paths)} 个文件 -> {DEFAULT_FOLDER_NAME}")
        return 0
    if not args.json:
        print(f"已排队 {len(paths)} 个文件 -> {DEFAULT_FOLDER_NAME}")
    completed = wait_for_uploads(db, paths, issued_at, args.timeout, args.json)
    result = {"ok": True, "accepted": True, "completed": completed,
              "destination": DEFAULT_FOLDER_NAME}
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cloud_transfer",
        description="使用本机已登录的夸克网盘 Desktop Upload 通道后台上传文件。",
    )
    parser.add_argument("--version", action="version", version="cloud_transfer 0.1.0")
    sub = parser.add_subparsers(dest="command", required=True)

    probe = sub.add_parser("probe", help="检查客户端、登录、账号映射和上传任务库")
    probe.add_argument("--json", action="store_true", help="输出 JSON")
    probe.set_defaults(func=command_probe)

    upload = sub.add_parser("upload", help="上传一个或多个本地文件到夸克默认上传目录")
    upload.add_argument("paths", nargs="+", help="本地文件路径")
    upload.add_argument("--timeout", type=float, default=1800.0,
                        help="等待上传完成的最长秒数，默认 1800")
    upload.add_argument("--no-wait", action="store_true", help="提交成功后立即退出")
    upload.add_argument("--json", action="store_true", help="输出 JSON")
    upload.set_defaults(func=command_upload)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ToolError as exc:
        if getattr(args, "json", False):
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"错误: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
