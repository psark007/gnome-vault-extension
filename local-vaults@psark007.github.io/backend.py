#!/usr/bin/env python3
"""Manual gocryptfs vault controls; never store, log, or accept argv passwords."""

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

DATA = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "gnome-shell-vaults/vaults.json"


def path(value):
    expanded = os.path.expanduser(value.strip())
    candidate = Path(expanded)
    if not candidate.is_absolute() or candidate.is_symlink():
        raise ValueError("Use an absolute, non-symlink directory path other than /")
    resolved = Path(os.path.realpath(candidate))
    if resolved == Path("/"):
        raise ValueError("Do not use / as a vault folder")
    return resolved


def valid_pair(cipher, plain):
    if cipher == plain or cipher in plain.parents or plain in cipher.parents:
        raise ValueError("Encrypted and unlocked folders must be separate")


def load():
    if not DATA.exists():
        return []
    if DATA.is_symlink():
        raise ValueError("Vault list must not be a symlink")
    entries = json.loads(DATA.read_text())
    if not isinstance(entries, list) or any(
        not isinstance(item, dict) or
        any(not isinstance(item.get(key), str) or not item[key] for key in ("id", "label", "cipher", "plain"))
        or not re.fullmatch(r"[0-9a-f]{16}", item["id"])
        for item in entries
    ):
        raise ValueError("Invalid vault list")
    return entries


def save(entries):
    if DATA.parent.is_symlink() or DATA.is_symlink():
        raise ValueError("Vault settings must not be symlinks")
    DATA.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(DATA.parent, 0o700)
    fd, name = tempfile.mkstemp(prefix=".vaults-", dir=DATA.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(entries, stream, indent=2)
            stream.write("\n")
        os.chmod(name, 0o600)
        os.replace(name, DATA)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def mounts():
    # mountinfo gives exact mountpoints without listing vault contents.
    result = set()
    with open("/proc/self/mountinfo", encoding="utf-8") as stream:
        for line in stream:
            before, _, after = line.partition(" - ")
            fields, fs = before.split(), after.split()
            if fs and fs[0] == "fuse.gocryptfs":
                raw = fields[4]
                point = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), raw)
                result.add(point)
    return result


def listed():
    active = mounts()
    return [dict(entry, mounted=entry["plain"] in active) for entry in load()]


def find(entries, vault_id):
    entry = next((item for item in entries if item["id"] == vault_id), None)
    if entry is None:
        raise ValueError("Unknown vault")
    return entry


def ensure_unique(entries, cipher, plain, exclude_id=None):
    for entry in entries:
        if entry["id"] == exclude_id:
            continue
        if str(cipher) in (entry["cipher"], entry["plain"]) or str(plain) in (entry["cipher"], entry["plain"]):
            raise ValueError("One of these folders is already registered")


def add(label, cipher_path, plain_path, create=False):
    entries = load()
    cipher, plain = path(cipher_path), path(plain_path)
    valid_pair(cipher, plain)
    ensure_unique(entries, cipher, plain)
    label = label.strip()
    if not label or len(label) > 100:
        raise ValueError("Enter a vault name (up to 100 characters)")
    if create:
        if cipher.exists() or plain.exists():
            raise ValueError("New vault folders must not already exist")
        if not cipher.parent.is_dir() or not plain.parent.is_dir():
            raise ValueError("Create both parent folders first")
        password = sys.stdin.buffer.readline(4097)
        if len(password) > 4096:
            raise ValueError("Passphrase is too long")
        if len(password.rstrip(b"\r\n")) < 8:
            raise ValueError("Use a passphrase of at least 8 characters")
        cipher.mkdir(mode=0o700)
        plain.mkdir(mode=0o700)
        completed = subprocess.run(
            ["/usr/bin/gocryptfs", "-init", "-passfile", "/dev/stdin", str(cipher)],
            input=password, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120, check=False,
        )
        if completed.returncode != 0:
            raise ValueError("Vault initialization failed; folders were left in place for inspection")
    else:
        if not (cipher / "gocryptfs.conf").is_file():
            raise ValueError("No gocryptfs.conf found in the encrypted folder")
        if plain.exists() and (not plain.is_dir() or plain.is_symlink()):
            raise ValueError("Unlock location must be a directory, not a symlink")
        if plain.exists() and any(plain.iterdir()):
            raise ValueError("Unlock folder must be empty")
    vault_id = os.urandom(8).hex()
    entries.append({"id": vault_id, "label": label, "cipher": str(cipher), "plain": str(plain)})
    save(entries)


def edit(vault_id, label, cipher_path, plain_path):
    entries = load()
    entry = find(entries, vault_id)
    label = label.strip()
    if not label or len(label) > 100:
        raise ValueError("Enter a vault name (up to 100 characters)")
    cipher, plain = path(cipher_path), path(plain_path)
    valid_pair(cipher, plain)
    ensure_unique(entries, cipher, plain, exclude_id=vault_id)
    if entry["plain"] in mounts():
        raise ValueError("Close the vault before editing its entry")
    for folder in {entry["plain"], str(plain)}:
        if subprocess.run(["/usr/bin/mountpoint", "-q", folder], check=False, timeout=5).returncode == 0:
            raise ValueError("Close the vault and choose an unused unlock folder")
    if str(cipher) != entry["cipher"] and not (cipher / "gocryptfs.conf").is_file():
        raise ValueError("No gocryptfs.conf found in the new encrypted folder")
    if str(plain) != entry["plain"] and plain.exists() and (not plain.is_dir() or any(plain.iterdir())):
        raise ValueError("New unlock folder must be empty")
    entry.update(label=label, cipher=str(cipher), plain=str(plain))
    save(entries)


def open_vault(entry):
    plain = path(entry["plain"])
    cipher = path(entry["cipher"])
    if str(plain) in mounts():
        raise ValueError("Vault is already open")
    if subprocess.run(["/usr/bin/mountpoint", "-q", str(plain)], check=False).returncode == 0:
        raise ValueError("Unlock folder is already a mountpoint")
    if not (cipher / "gocryptfs.conf").is_file():
        raise ValueError("Encrypted folder is missing its gocryptfs.conf")
    if not plain.exists():
        plain.mkdir(mode=0o700)
    if not plain.is_dir() or any(plain.iterdir()):
        raise ValueError("Unlock folder must be an empty directory")
    password = sys.stdin.buffer.readline(4097)
    if len(password) > 4096:
        raise ValueError("Passphrase is too long")
    if not password.strip():
        raise ValueError("Enter the passphrase")
    completed = subprocess.run(
        ["/usr/bin/gocryptfs", "-passfile", "/dev/stdin", str(cipher), str(plain)],
        input=password, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120, check=False,
    )
    if completed.returncode != 0:
        raise ValueError("Could not open vault (passphrase or mount failed)")


def browse(entry):
    if entry["plain"] not in mounts():
        raise ValueError("Unlock the vault before browsing")
    completed = subprocess.run(["/usr/bin/gio", "open", Path(entry["plain"]).as_uri()],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=8, check=False)
    if completed.returncode:
        raise ValueError("Could not open the unlocked folder")


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action == "list" and len(sys.argv) == 2:
        result = {"vaults": listed()}
    elif action in ("register", "create") and len(sys.argv) == 5:
        add(*sys.argv[2:], create=action == "create")
        result = {"message": "Vault created; unlock it separately" if action == "create" else "Vault registered; nothing was unlocked"}
    elif action == "edit" and len(sys.argv) == 6:
        edit(*sys.argv[2:])
        result = {"message": "Saved entry updated; no folders were moved"}
    elif action in ("open", "close", "remove", "browse") and len(sys.argv) == 3:
        entries = load()
        entry = find(entries, sys.argv[2])
        mounted = entry["plain"] in mounts()
        if action == "open":
            open_vault(entry)
            result = {"message": "Vault unlocked"}
        elif action == "close":
            if not mounted:
                raise ValueError("Vault is not open")
            completed = subprocess.run(["/usr/bin/fusermount3", "-u", str(path(entry["plain"]))],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30, check=False)
            if completed.returncode != 0:
                raise ValueError("Could not close vault; check for open files")
            result = {"message": "Vault locked"}
        elif action == "browse":
            browse(entry)
            result = {"message": "Opening unlocked folder"}
        else:
            if mounted:
                raise ValueError("Close the vault before removing its entry")
            if subprocess.run(["/usr/bin/mountpoint", "-q", entry["plain"]],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=5, check=False).returncode == 0:
                raise ValueError("Unlock folder is in use; cannot forget")
            save([item for item in entries if item["id"] != entry["id"]])
            result = {"message": "Entry forgotten; encrypted files were not deleted"}
    else:
        raise ValueError("Invalid vault action")
    print(json.dumps({"ok": True, **result}))


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        sys.exit(1)
    except (OSError, subprocess.TimeoutExpired):
        # OS errors may include private paths. Do not echo them into Shell logs.
        print(json.dumps({"ok": False, "error": "Vault action failed; check folder permissions and mount state"}))
        sys.exit(1)
