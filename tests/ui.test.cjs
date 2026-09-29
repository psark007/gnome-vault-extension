// Synthetic widget tests; never load a real vault definition or run gocryptfs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class Actor {
    constructor(properties = {}) {
        Object.assign(this, properties);
        this.children = [];
        this.signals = {};
    }

    add_child(child) { this.children.push(child); }
    set_child(child) { this.children = [child]; }
    connect(signal, callback) { this.signals[signal] = callback; }
}

class BoxLayout extends Actor {
    constructor(properties) {
        assert.ok(!Object.hasOwn(properties, 'vertical'), 'Use GNOME 51 orientation, not vertical');
        super(properties);
    }
}

class Label extends Actor {
    constructor(properties) {
        super(properties);
        this.clutter_text = {};
    }
}

class Entry extends Actor {
    constructor(properties) {
        super(properties);
        this.clutter_text = {set_password_char: char => { this.password_char = char; }};
    }

    get_text() { return this.text; }
    set_text(text) {
        this.text = text;
        this.signals['notify::text']?.();
    }
}

class PopupItem extends Actor {
    constructor(value) {
        super(typeof value === 'object' ? value : {});
        this.label = new Label({text: typeof value === 'string' ? value : ''});
    }

    setSensitive(sensitive) { this.sensitive = sensitive; }
}

class Menu {
    constructor() {
        this.items = [];
        this.actor = {width: 0, set_width(width) { this.width = width; }};
    }

    removeAll() { this.items = []; }
    addMenuItem(item) { this.items.push(item); }
}

const source = fs.readFileSync(path.join(__dirname, '../local-vaults@psark007.github.io/extension.js'), 'utf8')
    .replace(/^import .*;\s*$/gm, '')
    .replace('export default class VaultsExtension', 'class VaultsExtension');
const context = {
    Clutter: {Orientation: {VERTICAL: 1}},
    Pango: {EllipsizeMode: {END: 3}},
    Extension: class {}, Gio: {}, GLib: {}, GObject: {registerClass: klass => klass},
    St: {Button: Actor, BoxLayout, Entry, Icon: Actor, Label},
    PanelMenu: {Button: class {}},
    PopupMenu: {PopupBaseMenuItem: PopupItem, PopupMenuItem: PopupItem},
};
vm.runInNewContext(`${source}\nglobalThis.IndicatorForTest = Indicator;`, context);

function indicator(vaults = []) {
    const item = Object.create(context.IndicatorForTest.prototype);
    item.menu = new Menu();
    item._stopped = false;
    item._busy = false;
    item._vaults = vaults;
    item._message = '';
    item._formMode = null;
    item._draft = {};
    item._formEntries = {};
    item._unlockId = null;
    item._unlockEntry = null;
    item._pending = null;
    return item;
}

test('fresh menu stays empty at a fixed width', () => {
    const item = indicator();
    item._draw();
    assert.equal(item.menu.actor.width, 480);
    assert.equal(item._vaults.length, 0);
    assert.equal(item._formMode, null);
});

test('panel lock opens if any vault is unlocked and closes when all are locked', () => {
    const item = indicator([{id: 'one', mounted: false}, {id: 'two', mounted: true}]);
    item._icon = {icon_name: 'changes-prevent-symbolic'};
    item._updateIndicator();
    assert.equal(item._icon.icon_name, 'changes-allow-symbolic');
    assert.equal(item.accessible_name, 'Local vaults: 1 unlocked');
    item._vaults[1].mounted = false;
    item._updateIndicator();
    assert.equal(item._icon.icon_name, 'changes-prevent-symbolic');
    assert.equal(item.accessible_name, 'Local vaults: all locked');
});

test('create requires confirmation; masked passwords never enter argv or draft', () => {
    const item = indicator();
    let submitted;
    item._action = (...args) => { submitted = args; };
    item._showForm('create');
    item._formEntries.label.set_text('Synthetic');
    item._formEntries.cipher.set_text('/tmp/test-cipher');
    item._formEntries.plain.set_text('/tmp/test-plain');
    item._formEntries.password.set_text('test passphrase');
    item._formEntries.repeat.set_text('test passphrase');
    assert.equal(item._formEntries.password.password_char, '●');
    assert.equal(item._formEntries.repeat.password_char, '●');
    item._submitForm();
    assert.equal(submitted, undefined);
    assert.equal(item._formSubmit.label, 'Confirm Create');
    assert.equal(item._formEntries.password.get_text(), 'test passphrase');
    item._submitForm();
    assert.equal(submitted[0], 'create');
    assert.deepEqual(Array.from(submitted[1]), ['Synthetic', '/tmp/test-cipher', '/tmp/test-plain']);
    assert.equal(submitted[2], 'test passphrase');
    assert.equal(item._formEntries.password.get_text(), '');
    assert.ok(!JSON.stringify(item._draft).includes('test passphrase'));
});

test('editing a registered form keeps Save changes, never switches to Create', () => {
    const item = indicator([{id: 'synthetic', label: 'Synthetic', cipher: '/tmp/cipher',
        plain: '/tmp/plain', mounted: false}]);
    item._showForm('edit', item._vaults[0]);
    item._formEntries.label.set_text('Renamed');
    assert.equal(item._formSubmit.label, 'Save changes');
});

test('unlock uses a masked entry and passes a secret separately', () => {
    const item = indicator([{id: 'synthetic', label: 'Synthetic', mounted: false}]);
    let submitted;
    item._action = (...args) => { submitted = args; };
    item._draw();
    const unlock = item.menu.items[1].children.find(child => child.label === 'Unlock');
    unlock.signals.clicked();
    assert.equal(item._unlockEntry.password_char, '●');
    item._unlockEntry.set_text('test passphrase');
    const submit = item.menu.items[3].children.find(child => child.label === 'Unlock');
    submit.signals.clicked();
    assert.equal(submitted[0], 'open');
    assert.deepEqual(Array.from(submitted[1]), ['synthetic']);
    assert.equal(submitted[2], 'test passphrase');
    assert.equal(item._unlockEntry.get_text(), '');
});

test('forget is a two-click action, not a folder deletion', () => {
    const item = indicator([{id: 'synthetic', label: 'Synthetic', mounted: false}]);
    let submitted;
    item._action = (...args) => { submitted = args; };
    item._draw();
    const forget = item.menu.items[1].children.at(-1);
    forget.signals.clicked();
    assert.equal(submitted, undefined);
    assert.equal(item._pending.action, 'remove');
    item.menu.items[1].children.at(-1).signals.clicked();
    assert.equal(submitted[0], 'remove');
    assert.deepEqual(Array.from(submitted[1]), ['synthetic']);
});
