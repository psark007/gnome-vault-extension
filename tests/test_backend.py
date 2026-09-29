import importlib.util
import io
from contextlib import redirect_stdout
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / "local-vaults@psark007.github.io/backend.py"
spec = importlib.util.spec_from_file_location("vault_backend", SOURCE)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class VaultTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.data = mock.patch.object(backend, "DATA", root / "config/vaults.json")
        self.data.start()
        self.addCleanup(self.data.stop)
        self.cipher = root / "cipher"
        self.plain = root / "plain"

    def password(self, value):
        return mock.patch.object(backend.sys, "stdin", mock.Mock(buffer=io.BytesIO(value + b"\n")))

    def registered(self):
        self.cipher.mkdir(exist_ok=True)
        (self.cipher / "gocryptfs.conf").write_text("synthetic test fixture\n")
        backend.add("Example", str(self.cipher), str(self.plain))
        return backend.load()[0]

    def test_fresh_install_does_not_create_or_scan_vaults(self):
        with mock.patch.object(backend, "mounts", return_value=set()):
            self.assertEqual(backend.listed(), [])
        self.assertFalse(backend.DATA.exists())

    def test_create_initializes_but_does_not_unlock_or_store_password(self):
        calls = []

        def fake_run(args, **kwargs):
            calls.append((args, kwargs))
            return subprocess.CompletedProcess(args, 0)

        secret = b"long test passphrase"
        with self.password(secret), mock.patch.object(backend.subprocess, "run", side_effect=fake_run):
            backend.add("Example", str(self.cipher), str(self.plain), create=True)
        self.assertTrue(self.cipher.is_dir())
        self.assertTrue(self.plain.is_dir())
        self.assertEqual(len(calls), 1)
        self.assertIn("-init", calls[0][0])
        self.assertEqual(calls[0][1]["input"], secret + b"\n")
        self.assertNotIn(secret.decode(), " ".join(calls[0][0]))
        self.assertNotIn(secret.decode(), backend.DATA.read_text())
        self.assertEqual(backend.DATA.stat().st_mode & 0o777, 0o600)
        self.assertEqual(backend.DATA.parent.stat().st_mode & 0o777, 0o700)

    def test_register_edit_and_forget_never_delete_folders(self):
        entry = self.registered()
        with mock.patch.object(backend, "mounts", return_value=set()), \
                mock.patch.object(backend.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)):
            backend.edit(entry["id"], "Renamed", str(self.cipher), str(self.plain))
            self.assertEqual(backend.load()[0]["label"], "Renamed")
            with mock.patch.object(backend.sys, "argv", ["backend.py", "remove", entry["id"]]):
                with redirect_stdout(io.StringIO()):
                    backend.main()
        self.assertEqual(backend.load(), [])
        self.assertTrue((self.cipher / "gocryptfs.conf").exists())

    def test_unlock_sends_passphrase_only_to_stdin_and_close_unmounts(self):
        entry = self.registered()
        calls = []

        def fake_run(args, **kwargs):
            calls.append((args, kwargs))
            return subprocess.CompletedProcess(args, 1 if "mountpoint" in args[0] else 0)

        secret = b"private phrase"
        with self.password(secret), mock.patch.object(backend, "mounts", return_value=set()), \
                mock.patch.object(backend.subprocess, "run", side_effect=fake_run):
            backend.open_vault(entry)
        self.assertEqual(calls[-1][1]["input"], secret + b"\n")
        self.assertNotIn(secret.decode(), " ".join(calls[-1][0]))
        with mock.patch.object(backend, "mounts", return_value={str(self.plain)}), \
                mock.patch.object(backend.subprocess, "run", side_effect=fake_run):
            with mock.patch.object(backend.sys, "argv", ["backend.py", "close", entry["id"]]):
                with redirect_stdout(io.StringIO()):
                    backend.main()
        self.assertEqual(calls[-1][0][1:3], ["-u", str(self.plain)])

    def test_nested_paths_and_symlinks_are_rejected(self):
        with self.assertRaises(ValueError):
            backend.add("Bad", str(self.cipher), str(self.cipher / "inside"))
        link = Path(self.temp.name) / "link"
        self.cipher.mkdir()
        link.symlink_to(self.cipher, target_is_directory=True)
        with self.assertRaises(ValueError):
            backend.add("Bad", str(link), str(self.plain))

    def test_register_requires_gocryptfs_config(self):
        self.cipher.mkdir()
        with self.assertRaisesRegex(ValueError, "gocryptfs.conf"):
            backend.add("Not a vault", str(self.cipher), str(self.plain))
        self.assertFalse(backend.DATA.exists())

    def test_failed_create_leaves_folders_for_review_without_registering(self):
        with self.password(b"test passphrase"), mock.patch.object(backend.subprocess, "run",
                return_value=subprocess.CompletedProcess([], 1)):
            with self.assertRaisesRegex(ValueError, "initialization failed"):
                backend.add("Example", str(self.cipher), str(self.plain), create=True)
        self.assertTrue(self.cipher.is_dir())
        self.assertTrue(self.plain.is_dir())
        self.assertFalse(backend.DATA.exists())

    def test_edit_or_forget_refuses_open_vault(self):
        entry = self.registered()
        with mock.patch.object(backend, "mounts", return_value={str(self.plain)}):
            with self.assertRaises(ValueError):
                backend.edit(entry["id"], "Other", str(self.cipher), str(self.plain))
            with self.assertRaises(ValueError):
                with mock.patch.object(backend.sys, "argv", ["backend.py", "remove", entry["id"]]):
                    backend.main()
        self.assertEqual(len(backend.load()), 1)


if __name__ == "__main__":
    unittest.main()
