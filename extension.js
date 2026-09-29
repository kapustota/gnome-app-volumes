// Per-app volume sliders in the output volume menu (the arrow next to the
// volume slider), including apps that are running but silent right now.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension, InjectionManager, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import * as Backend from './backend.js';

const SAVE_DELAY_MS = 150;
const REFRESH_DELAY_MS = 200;
// WirePlumber restores its remembered volume a moment after a stream appears
const PENDING_GUARD_MS = 1500;

const AppVolumeItem = GObject.registerClass(
class AppVolumeItem extends PopupMenu.PopupBaseMenuItem {
    _init(onChanged) {
        // the default hidden ornament keeps the icon in line with the
        // output device items, which move their ornament after the label
        super._init({activate: false, can_focus: false});

        this.row = null;
        this.dragging = false;

        this._icon = new St.Icon({style_class: 'popup-menu-icon'});
        this.add_child(this._icon);

        this._label = new St.Label({
            style_class: 'app-volumes-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(this._label);

        this.slider = new Slider(0);
        this.slider.y_align = Clutter.ActorAlign.CENTER;
        this.add_child(this.slider);

        this._updating = false;
        this.slider.connectObject(
            'notify::value', () => {
                if (!this._updating)
                    onChanged(this);
            },
            'drag-begin', () => {
                this.dragging = true;
            },
            'drag-end', () => {
                this.dragging = false;
            },
            this);
    }

    update(row) {
        this.row = row;
        this._label.text = row.displayName;
        this.slider.accessible_name = row.displayName;
        if (row.gicon)
            this._icon.gicon = row.gicon;
        else
            this._icon.icon_name = 'application-x-executable-symbolic';

        if (!this.dragging) {
            this._updating = true;
            this.slider.value = row.level;
            this._updating = false;
        }
    }
});

export default class AppVolumesExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // levels chosen for silent apps, applied to their next stream
        this._pending = new Map(Object.entries(
            this._settings.get_value('pending-volumes').deepUnpack()));

        this._injections = new InjectionManager();
        this._cancellable = new Gio.Cancellable();
        this._items = new Map();
        this._memoryWrites = new Map();
        this._guards = new Set();
        this._saveId = 0;
        this._refreshSerial = 0;
        this._refreshId = 0;
        this._waitId = 0;

        let attempts = 0;
        const tryAttach = () => {
            // quick settings indicators are created asynchronously at startup
            const outputSlider = Main.panel.statusArea.quickSettings._volumeOutput?._output;
            if (outputSlider) {
                this._waitId = 0;
                this._attach(outputSlider);
                return GLib.SOURCE_REMOVE;
            }
            if (++attempts > 100) {
                this._waitId = 0;
                console.error('app-volumes: volume menu not found');
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        };
        if (tryAttach() === GLib.SOURCE_CONTINUE)
            this._waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, tryAttach);
    }

    disable() {
        if (this._waitId)
            GLib.source_remove(this._waitId);
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        for (const guard of this._guards)
            this._endGuard(guard);
        this._flushSaves();
        this._cancellable.cancel();

        this._control?.disconnectObject(this);
        this._outputSlider?.menu.disconnectObject(this);
        Main.panel.statusArea.quickSettings.menu.disconnectObject(this);

        this._injections.clear();
        this._outputSlider?._sync();
        this._appsSection?.destroy();
        this._section?.destroy();

        this._settings = null;
        this._pending = null;
        this._injections = null;
        this._cancellable = null;
        this._items = null;
        this._memoryWrites = null;
        this._guards = null;
        this._control = null;
        this._outputSlider = null;
        this._section = null;
        this._appsSection = null;
    }

    _attach(outputSlider) {
        this._outputSlider = outputSlider;
        this._control = Volume.getMixerControl();

        this._section = new PopupMenu.PopupMenuSection();
        this._section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Applications')));
        this._appsSection = new PopupMenu.PopupMenuSection();
        this._section.addMenuItem(this._appsSection);
        this._section.actor.hide();
        // right after the output devices, before "Sound Settings"
        outputSlider.menu.addMenuItem(this._section, 1);

        // the arrow is normally hidden with fewer than two output devices
        this._injections.overrideMethod(outputSlider, '_sync', originalSync => function () {
            originalSync.call(this);
            this.menuEnabled = true;
        });
        outputSlider._sync();

        const refreshOnOpen = (menu, open) => {
            if (open)
                this._refresh();
        };
        Main.panel.statusArea.quickSettings.menu.connectObject(
            'open-state-changed', refreshOnOpen, this);
        outputSlider.menu.connectObject(
            'open-state-changed', refreshOnOpen, this);
        this._control.connectObject(
            'stream-added', (control, id) => {
                this._applyPending(id);
                this._queueRefresh();
            },
            'stream-removed', () => this._queueRefresh(),
            this);

        this._refresh();
    }

    _queueRefresh() {
        if (this._refreshId || !Main.panel.statusArea.quickSettings.menu.isOpen)
            return;
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_DELAY_MS, () => {
            this._refreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _liveStreams() {
        return this._control.get_sink_inputs()
            .filter(stream => !stream.is_event_stream && stream.get_name());
    }

    async _refresh() {
        const serial = ++this._refreshSerial;
        const cancellable = this._cancellable;
        const [clients, memory] = await Promise.all([
            Backend.listAudioClients(cancellable),
            Backend.readStreamMemory(cancellable),
        ]);
        if (cancellable.is_cancelled() || serial !== this._refreshSerial)
            return;
        this._showRows(Backend.buildRows({
            streams: this._liveStreams(),
            clients,
            memory,
            pending: this._pending,
            norm: this._control.get_vol_max_norm(),
        }));
    }

    _showRows(rows) {
        const shown = new Set();
        rows.forEach((row, position) => {
            let item = this._items.get(row.name);
            if (item) {
                this._appsSection.moveMenuItem(item, position);
            } else {
                item = new AppVolumeItem(changedItem => this._onSliderChanged(changedItem));
                this._items.set(row.name, item);
                this._appsSection.addMenuItem(item, position);
            }
            item.update(row);
            shown.add(row.name);
        });

        for (const [name, item] of this._items) {
            if (shown.has(name) || item.dragging)
                continue;
            item.destroy();
            this._items.delete(name);
        }

        this._section.actor.visible = this._items.size > 0;
    }

    _onSliderChanged(item) {
        const {row} = item;
        const level = item.slider.value;
        const norm = this._control.get_vol_max_norm();

        // playing: change the streams, WirePlumber remembers the volume itself
        const live = this._liveStreams().filter(stream => stream.get_name() === row.name);
        if (live.length > 0) {
            live.forEach(stream => Backend.applyLevel(stream, level, norm));
            if (this._pending.delete(row.name))
                this._queueSave();
            return;
        }

        // silent: store the volume for the next stream
        if (!row.memKey)
            return;
        this._pending.set(row.name, level);
        this._memoryWrites.set(row.memKey, {channels: row.channels, level});
        this._queueSave();
    }

    _applyPending(id) {
        const stream = this._control.lookup_stream_id(id);
        if (!(stream instanceof Gvc.MixerSinkInput) || stream.is_event_stream)
            return;
        const name = stream.get_name();
        const level = this._pending.get(name);
        if (level === undefined)
            return;

        this._pending.delete(name);
        this._queueSave();

        const norm = this._control.get_vol_max_norm();
        Backend.applyLevel(stream, level, norm);

        // put our level back when WirePlumber restores its remembered one;
        // it then remembers ours for the following streams
        const guard = {stream, notifyId: 0, timeoutId: 0};
        guard.notifyId = stream.connect('notify::volume', () => {
            if (!Backend.hasLevel(stream, level, norm))
                Backend.applyLevel(stream, level, norm);
        });
        guard.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PENDING_GUARD_MS, () => {
            guard.timeoutId = 0;
            this._endGuard(guard);
            return GLib.SOURCE_REMOVE;
        });
        this._guards.add(guard);
    }

    _endGuard(guard) {
        guard.stream.disconnect(guard.notifyId);
        if (guard.timeoutId)
            GLib.source_remove(guard.timeoutId);
        this._guards.delete(guard);
    }

    _queueSave() {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushSaves() {
        if (!this._saveId)
            return;
        GLib.source_remove(this._saveId);
        this._saveId = 0;
        this._save();
    }

    _save() {
        this._settings.set_value('pending-volumes',
            new GLib.Variant('a{sd}', Object.fromEntries(this._pending)));

        for (const [memKey, {channels, level}] of this._memoryWrites) {
            Backend.writeStreamMemory(memKey, new Array(channels).fill(level ** 3), level > 0)
                .catch(e => console.error(`app-volumes: cannot store volume for ${memKey}: ${e.message}`));
        }
        this._memoryWrites.clear();
    }
}
