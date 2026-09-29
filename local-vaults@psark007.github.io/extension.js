import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const MENU_WIDTH = 480;

function backend(path, action, args = [], passphrase = null) {
    return new Promise((resolve, reject) => {
        let process;
        try {
            process = Gio.Subprocess.new(['/usr/bin/python3', path, action, ...args],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            reject(error);
            return;
        }
        // Passphrases never enter argv, JSON definitions, or the journal.
        process.communicate_utf8_async(passphrase === null ? null : `${passphrase}\n`, null,
            (proc, result) => {
                try {
                    const [, output] = proc.communicate_utf8_finish(result);
                    const data = JSON.parse(output);
                    if (!proc.get_successful() || !data.ok)
                        throw new Error(data.error || 'Vault action failed');
                    resolve(data);
                } catch (error) {
                    reject(error);
                }
            });
    });
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Local Vaults');
        this._backend = `${extension.path}/backend.py`;
        this._vaults = [];
        this._busy = false;
        this._refreshing = false;
        this._stopped = false;
        this._message = '';
        this._formMode = null;
        this._draft = {};
        this._formEntries = {};
        this._unlockId = null;
        this._unlockEntry = null;
        this._pending = null;
        this._icon = new St.Icon({icon_name: 'changes-prevent-symbolic', style_class: 'system-status-icon'});
        this.add_child(this._icon);
        this.menu.actor.add_style_class_name('vault-popup');
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (!open && !this._stopped) {
                this._clearSecrets();
                this._formMode = null;
                this._draft = {};
                this._unlockId = null;
                this._pending = null;
                this._draw();
            }
        });
        this._draw();
        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearSecrets() {
        for (const entry of [this._formEntries.password, this._formEntries.repeat, this._unlockEntry]) {
            if (entry)
                entry.set_text('');
        }
        this._formEntries = {};
        this._unlockEntry = null;
    }

    async _refresh() {
        if (this._stopped || this._refreshing)
            return;
        this._refreshing = true;
        try {
            const data = await backend(this._backend, 'list');
            if (this._stopped)
                return;
            this._vaults = data.vaults;
            this._updateIndicator();
            // Do not discard a passphrase in progress on a status tick.
            if (!this._formMode && !this._unlockId)
                this._draw();
        } catch (error) {
            if (!this._stopped) {
                this._message = error.message;
                if (!this._formMode && !this._unlockId)
                    this._draw();
            }
        } finally {
            this._refreshing = false;
        }
    }

    _updateIndicator() {
        const open = this._vaults.filter(vault => vault.mounted).length;
        this._icon.icon_name = open ? 'changes-allow-symbolic' : 'changes-prevent-symbolic';
        this.accessible_name = open
            ? `Local vaults: ${open} unlocked`
            : 'Local vaults: all locked';
    }

    async _action(action, args = [], passphrase = null) {
        if (this._busy)
            return;
        this._busy = true;
        this._message = '';
        try {
            const result = await backend(this._backend, action, args, passphrase);
            if (this._stopped)
                return;
            this._message = result.message;
            this._formMode = null;
            this._draft = {};
            this._unlockId = null;
            this._pending = null;
        } catch (error) {
            if (this._stopped)
                return;
            this._message = error.message;
            this._pending = null;
        } finally {
            this._busy = false;
        }
        await this._refresh();
        if (!this._stopped)
            this._draw();
    }

    _item(text) {
        const item = new PopupMenu.PopupMenuItem(text);
        item.setSensitive(false);
        item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.menu.addMenuItem(item);
    }

    _row(title, subtitle, controls) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const buttons = [];
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            x_expand: true, style_class: 'vault-row-text'});
        for (const [value, secondary] of [[title, false], [subtitle, true]]) {
            if (!value)
                continue;
            const label = new St.Label({text: value, x_expand: true,
                style_class: secondary ? 'dim-label' : ''});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(label);
        }
        item.add_child(text);
        for (const control of controls) {
            const enabled = control.enabled !== false && !this._busy;
            const button = new St.Button({style_class: 'button vault-action',
                ...(control.icon ? {} : {label: control.label}),
                accessible_name: control.name || control.label,
                reactive: enabled, can_focus: enabled});
            if (control.icon)
                button.set_child(new St.Icon({icon_name: control.icon, style_class: 'popup-menu-icon'}));
            if (enabled)
                button.connect('clicked', control.activate);
            else
                button.opacity = 128;
            item.add_child(button);
            buttons.push(button);
        }
        this.menu.addMenuItem(item);
        return buttons;
    }

    _field(hint, key, secret = false) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const entry = new St.Entry({hint_text: hint, x_expand: true, can_focus: true,
            style_class: 'entry vault-field', accessible_name: hint,
            text: secret ? '' : this._draft[key] || ''});
        if (secret) {
            entry.clutter_text.set_password_char('\u25cf');
            entry.connect('notify::text', () => {
                if (this._pending?.action === 'create') {
                    this._pending = null;
                    if (this._formSubmit)
                        this._formSubmit.label = 'Create vault';
                }
            });
        } else {
            entry.connect('notify::text', () => {
                this._draft[key] = entry.get_text();
                if (this._pending?.action === 'create' && this._formSubmit) {
                    this._pending = null;
                    this._formSubmit.label = 'Create vault';
                }
            });
        }
        this._formEntries[key] = entry;
        item.add_child(entry);
        this.menu.addMenuItem(item);
        return entry;
    }

    _showForm(mode, vault = null) {
        this._clearSecrets();
        this._unlockId = null;
        this._formMode = mode;
        this._formId = vault?.id || null;
        this._draft = vault
            ? {label: vault.label, cipher: vault.cipher, plain: vault.plain}
            : {label: '', cipher: '', plain: ''};
        this._pending = null;
        this._message = '';
        this._draw();
    }

    _submitForm() {
        const label = this._formEntries.label.get_text();
        const cipher = this._formEntries.cipher.get_text();
        const plain = this._formEntries.plain.get_text();
        if (this._pending?.action === 'create' &&
            (label !== this._draft.label || cipher !== this._draft.cipher || plain !== this._draft.plain))
            this._pending = null;
        this._draft = {label, cipher, plain};
        if (!label?.trim() || !cipher?.trim() || !plain?.trim()) {
            this._formHint.text = 'Enter a name and both folder paths.';
            return;
        }
        if (this._formMode === 'create') {
            const password = this._formEntries.password.get_text();
            const repeat = this._formEntries.repeat.get_text();
            if (password.length < 8 || password !== repeat) {
                this._clearSecrets();
                this._message = 'Passphrases must match and have at least 8 characters.';
                this._draw();
                return;
            }
            if (this._pending?.action !== 'create') {
                this._pending = {action: 'create'};
                this._formSubmit.label = 'Confirm Create';
                this._formHint.text = 'Create initializes folders only. Back up gocryptfs.conf and remember the passphrase.';
                return;
            }
            this._formEntries.password.set_text('');
            this._formEntries.repeat.set_text('');
            this._action('create', [label.trim(), cipher.trim(), plain.trim()], password);
        } else if (this._formMode === 'register') {
            this._action('register', [label.trim(), cipher.trim(), plain.trim()]);
        } else {
            this._action('edit', [this._formId, label.trim(), cipher.trim(), plain.trim()]);
        }
    }

    _drawForm() {
        const edit = this._formMode === 'edit';
        if (!edit) {
            const tabs = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            for (const [mode, label] of [['register', 'Register existing'], ['create', 'Create new']]) {
                const button = new St.Button({label, style_class: 'vault-tab', x_expand: true,
                    toggle_mode: true, checked: this._formMode === mode, can_focus: true});
                button.connect('clicked', () => this._showForm(mode));
                tabs.add_child(button);
            }
            this.menu.addMenuItem(tabs);
        } else {
            this._item('Edit entry · vault must be locked');
        }
        this._field('Vault name', 'label');
        this._field('Encrypted folder (absolute or ~/...)', 'cipher');
        this._field('Unlock folder (absolute or ~/...)', 'plain');
        if (this._formMode === 'create') {
            this._formEntries.password = this._field('New passphrase (8+ characters)', 'password', true);
            this._formEntries.repeat = this._field('Repeat new passphrase', 'repeat', true);
        }
        this._formHint = new St.Label({text: edit
            ? 'Editing only changes the saved entry; no files are moved.'
            : this._formMode === 'create'
                ? 'Create initializes only. Unlock later using its passphrase.'
                : 'Register an existing gocryptfs folder; nothing opens now.',
        style_class: 'dim-label', x_expand: true});
        this._formHint.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const hintRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        hintRow.add_child(this._formHint);
        this.menu.addMenuItem(hintRow);
        const [submit] = this._row('', null, [
            {label: this._formMode === 'create' ? 'Create vault' : edit ? 'Save changes' : 'Register vault',
                activate: () => this._submitForm()},
            {label: 'Cancel', activate: () => {
                this._clearSecrets();
                this._formMode = null;
                this._draft = {};
                this._pending = null;
                this._draw();
            }},
        ]);
        this._formSubmit = submit;
    }

    _drawList() {
        const open = this._vaults.filter(vault => vault.mounted).length;
        this._row(`Local vaults · ${open}/${this._vaults.length} open`, null,
            [{label: 'Add', activate: () => this._showForm('register')}]);
        if (!this._vaults.length)
            this._item('No vaults registered. Nothing is scanned automatically.');
        for (const vault of this._vaults) {
            const pendingForget = this._pending?.action === 'remove' && this._pending.id === vault.id;
            const subtitle = pendingForget
                ? 'Forget removes only the saved entry, never encrypted files.'
                : vault.mounted ? 'Unlocked · plaintext available to your user' : 'Locked';
            const controls = vault.mounted
                ? [
                    {icon: 'folder-open-symbolic', name: `Browse ${vault.label}`,
                        activate: () => this._action('browse', [vault.id])},
                    {label: 'Lock', activate: () => this._action('close', [vault.id])},
                ]
                : [
                    {label: 'Unlock', activate: () => {
                        this._unlockId = vault.id;
                        this._pending = null;
                        this._draw();
                    }},
                    {label: 'Edit', activate: () => this._showForm('edit', vault)},
                    {icon: 'edit-delete-symbolic', name: pendingForget ? `Confirm Forget ${vault.label}` : `Forget ${vault.label}`,
                        activate: () => {
                            if (pendingForget) {
                                this._action('remove', [vault.id]);
                            } else {
                                this._pending = {action: 'remove', id: vault.id};
                                this._unlockId = null;
                                this._draw();
                            }
                        }},
                ];
            if (pendingForget)
                controls[2].label = 'Confirm Forget';
            if (pendingForget)
                delete controls[2].icon;
            this._row(vault.label, subtitle, controls);
            if (this._unlockId === vault.id && !vault.mounted) {
                this._unlockEntry = this._field('Vault passphrase', 'unlock', true);
                this._row('', null, [
                    {label: 'Unlock', activate: () => {
                        const password = this._unlockEntry.get_text();
                        this._unlockEntry.set_text('');
                        if (password)
                            this._action('open', [vault.id], password);
                    }},
                    {label: 'Cancel', activate: () => {
                        this._clearSecrets();
                        this._unlockId = null;
                        this._draw();
                    }},
                ]);
            }
        }
    }

    _draw() {
        if (this._stopped)
            return;
        this._clearSecrets();
        this._formSubmit = null;
        this.menu.removeAll();
        this.menu.actor.set_width(MENU_WIDTH);
        if (this._formMode)
            this._drawForm();
        else
            this._drawList();
        if (this._message)
            this._item(this._message);
        this._row('', null, [{icon: 'view-refresh-symbolic', name: 'Refresh vault status',
            activate: () => this._refresh()}]);
    }

    destroy() {
        this._stopped = true;
        if (this._timer)
            GLib.Source.remove(this._timer);
        this._clearSecrets();
        super.destroy();
    }
});

export default class VaultsExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
