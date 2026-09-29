# Local Vaults for GNOME Shell

Create, register, unlock, and lock gocryptfs vaults on Fedora GNOME Shell 51.
Synthetic tests pass; a live vault cycle has not been tested. New installs
start empty and never open vaults automatically. The panel lock icon opens
when any registered vault is unlocked.

## Use

- **Create** requires two new folders with existing parent directories and a
  passphrase entered twice in the masked popup. Confirming initializes the
  encrypted folder; **Unlock** is a separate action. Back up the encrypted
  folder, including `gocryptfs.conf`, and keep the passphrase safe.
- **Register** an existing gocryptfs folder and an empty unlock location.
  **Unlock**, **Lock**, and **Browse** act only when selected. Open files may
  prevent locking.
- **Edit** changes a locked vault's saved entry, not its folders. **Forget**
  removes only that entry after confirmation; it does not delete any files.

Passphrases go by stdin to the local helper, not argv or saved settings. The
popup clears them when closed or submitted. Labels and paths are saved with
private permissions at `~/.config/gnome-shell-vaults/vaults.json`; do not commit
this file or vault contents. Plaintext is accessible to your user while a vault
is unlocked. Vaults do not replace backups or full-disk encryption.

## Install on Fedora

```sh
sudo dnf install gocryptfs fuse3 util-linux python3 glib2
```

Then, as your regular user:

```sh
./install.sh
gnome-extensions enable local-vaults@psark007.github.io
```

Log out and back in if GNOME does not discover the extension, or after updating
its JavaScript. Lock vaults before uninstalling; removing the code does not
unmount them or erase settings.

## Test

Synthetic tests use temporary folders and mocks; Node.js is only needed for
the UI tests:

```sh
python3 -m unittest discover -s tests -v
node --test tests/ui.test.cjs
```

## AI disclosure

AI tools assisted with the code and documentation. The tests use synthetic
data; creating and unlocking a real vault has not been tested here.

Licensed under MIT; see [LICENSE](LICENSE).
