// Data layer: WirePlumber stream memory, connected PipeWire clients,
// desktop app lookup. Uses only Gio/GLib (and Gvc streams passed in), so it
// can be tested with plain gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const STATE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'wireplumber']);

// WpState escapes these characters in key names
const KEY_UNESCAPES = {s: ' ', e: '=', o: '[', c: ']', '\\': '\\'};
// GKeyFile escapes these in string values
const VALUE_UNESCAPES = {s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\'};

function unescape(str, table) {
    return str.replace(/\\(.)/g, (m, ch) => table[ch] ?? ch);
}

function runCommand(argv, cancellable = null) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                if (!p.get_successful())
                    throw new Error(`${argv[0]} exited with status ${p.get_exit_status()}`);
                resolve(stdout ?? '');
            } catch (e) {
                reject(e);
            }
        });
    });
}

function isCancelled(e) {
    return e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// Yields [key, value] of the given group, both unescaped
function* stateEntries(text, group) {
    let inGroup = false;
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('[')) {
            inGroup = line === `[${group}]`;
            continue;
        }
        const eq = line.indexOf('=');
        if (!inGroup || eq < 0)
            continue;
        yield [unescape(line.slice(0, eq), KEY_UNESCAPES),
            unescape(line.slice(eq + 1), VALUE_UNESCAPES)];
    }
}

/**
 * WirePlumber 0.4 state: one line per field, e.g.
 * "Output/Audio:application.name:Telegram\sDesktop:channelVolumes=1.0;1.0;"
 *
 * @param {string} text - contents of ~/.local/state/wireplumber/restore-stream
 * @returns {Map<string, {channelVolumes?: number[], mute?: boolean}>} by key base
 */
export function parseRestoreStream(text) {
    const memory = new Map();
    for (const [key, value] of stateEntries(text, 'restore-stream')) {
        const sep = key.lastIndexOf(':');
        const keyBase = key.slice(0, sep);
        const field = key.slice(sep + 1);
        if (!keyBase.startsWith('Output/Audio:'))
            continue;

        const entry = memory.get(keyBase) ?? {};
        if (field === 'channelVolumes')
            entry.channelVolumes = value.split(';').filter(v => v !== '').map(Number);
        else if (field === 'mute')
            entry.mute = value === 'true';
        memory.set(keyBase, entry);
    }
    return memory;
}

/**
 * WirePlumber 0.5 state: one JSON object per stream, e.g.
 * "Output/Audio:application.name:Telegram\sDesktop={"volume":1.000000, "mute":false,
 * "channelVolumes":[0.064000, 0.064000], "channelMap":["FL", "FR"]}"
 *
 * @param {string} text - contents of ~/.local/state/wireplumber/stream-properties
 * @returns {Map<string, {channelVolumes?: number[], mute?: boolean}>} by key base
 */
export function parseStreamProperties(text) {
    const memory = new Map();
    for (const [keyBase, value] of stateEntries(text, 'stream-properties')) {
        if (!keyBase.startsWith('Output/Audio:'))
            continue;
        let props;
        try {
            props = JSON.parse(value);
        } catch {
            continue;
        }
        const entry = {};
        if (Array.isArray(props.channelVolumes))
            entry.channelVolumes = props.channelVolumes.map(Number);
        if (typeof props.mute === 'boolean')
            entry.mute = props.mute;
        memory.set(keyBase, entry);
    }
    return memory;
}

const STATE_FORMATS = [
    {name: 'stream-properties', parse: parseStreamProperties}, // WirePlumber 0.5
    {name: 'restore-stream', parse: parseRestoreStream}, // WirePlumber 0.4
];

function queryModified(file, cancellable) {
    return new Promise(resolve => {
        file.query_info_async('time::modified,time::modified-usec',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (f, res) => {
                try {
                    const dt = f.query_info_finish(res).get_modification_date_time();
                    resolve(dt.to_unix() * 1e6 + dt.get_microsecond());
                } catch {
                    resolve(null);
                }
            });
    });
}

function loadText(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (f, res) => {
            try {
                const [, contents] = f.load_contents_finish(res);
                resolve(new TextDecoder().decode(contents));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Remembered playback volumes by key base. When both state formats exist
 * (e.g. after upgrading WirePlumber), the running one is the file that was
 * written last.
 */
export async function readStreamMemory(cancellable = null) {
    let newest = null;
    for (const format of STATE_FORMATS) {
        const file = Gio.File.new_for_path(GLib.build_filenamev([STATE_DIR, format.name]));
        const modified = await queryModified(file, cancellable);
        if (modified !== null && (!newest || modified > newest.modified))
            newest = {format, file, modified};
    }
    if (!newest)
        return new Map();

    try {
        return newest.format.parse(await loadText(newest.file, cancellable));
    } catch (e) {
        if (!isCancelled(e))
            console.error(`app-volumes: cannot read ${newest.file.get_path()}: ${e.message}`);
        return new Map();
    }
}

/**
 * PipeWire clients that are connected right now. Apps keep this
 * connection while running, even when silent or hidden in the tray.
 */
export async function listAudioClients(cancellable = null) {
    try {
        const out = await runCommand(['pw-dump'], cancellable);
        const clients = [];
        for (const object of JSON.parse(out)) {
            if (object.type !== 'PipeWire:Interface:Client')
                continue;
            const props = object.info?.props ?? {};
            const name = props['application.name'];
            if (!name)
                continue;
            clients.push({
                name,
                appId: props['application.id'] ?? null,
                binary: props['application.process.binary'] ?? null,
            });
        }
        return clients;
    } catch (e) {
        if (!isCancelled(e))
            console.error(`app-volumes: cannot list PipeWire clients: ${e.message}`);
        return [];
    }
}

/**
 * The memory key WirePlumber uses for this app's playback streams, if it has
 * one (application.id before application.name, as WirePlumber does).
 */
export function memoryKeyFor(memory, appId, name) {
    const candidates = [
        appId && `Output/Audio:application.id:${appId}`,
        name && `Output/Audio:application.name:${name}`,
    ];
    return candidates.find(key => key && memory.has(key)) ?? null;
}

/**
 * Remembered level on the mixer's 0..1 scale (cubic, like PulseAudio),
 * or null when nothing is remembered.
 */
export function memoryLevel(entry) {
    if (!entry?.channelVolumes?.length)
        return null;
    if (entry.mute)
        return 0;
    return Math.cbrt(Math.max(...entry.channelVolumes));
}

/**
 * The route-settings metadata entry for a remembered volume.
 *
 * @param {string} keyBase - e.g. "Output/Audio:application.name:Telegram Desktop"
 * @param {number[]} volumes - linear per-channel volumes
 * @param {boolean} unmute - also clear a remembered mute
 * @returns {string[]} metadata key and JSON value
 */
export function routeSettingsEntry(keyBase, volumes, unmute) {
    const key = `restore.stream.${keyBase.replace(':', '.')}`;
    // WirePlumber keeps JSON integers such as 1 or 0 as integers and then
    // fails to restore them as float volumes, so always write a decimal point
    const floats = volumes.map(v => v.toFixed(6)).join(',');
    const value = `{"volumes":[${floats}]${unmute ? ',"mute":false' : ''}}`;
    return [key, value];
}

/**
 * Stores the volume for future streams of the app via the route-settings
 * metadata, which WirePlumber 0.4 saves to its state (restore-stream.lua,
 * handleRouteSettings). WirePlumber 0.5 only accepts the notification role
 * there and ignores other keys.
 */
export function writeStreamMemory(keyBase, volumes, unmute) {
    const [key, value] = routeSettingsEntry(keyBase, volumes, unmute);
    return runCommand(['pw-metadata', '-n', 'route-settings', '0',
        key, value, 'Spa:String:JSON']);
}

/**
 * Sets a live stream to a 0..1 level, muting at zero like GNOME's own slider.
 *
 * @param {Gvc.MixerStream} stream - a playback stream
 * @param {number} level - 0..1
 * @param {number} norm - Gvc volume for 100%
 */
export function applyLevel(stream, level, norm) {
    const volume = Math.round(level * norm);
    if (volume < 1) {
        stream.volume = 0;
        if (!stream.is_muted)
            stream.change_is_muted(true);
    } else {
        stream.volume = volume;
        if (stream.is_muted)
            stream.change_is_muted(false);
    }
    stream.push_volume();
}

/**
 * Whether a live stream is at the given 0..1 level (as set by applyLevel).
 */
export function hasLevel(stream, level, norm) {
    const volume = level * norm;
    if (volume < 1)
        return stream.is_muted || stream.volume === 0;
    return !stream.is_muted && Math.abs(stream.volume - volume) <= norm * 0.005;
}

/**
 * Rows for the menu: apps playing right now plus apps that are connected
 * to PipeWire and have a remembered volume (they played before).
 *
 * @param {object} params
 * @param {Gvc.MixerStream[]} params.streams - live non-event playback streams
 * @param {object[]} params.clients - from listAudioClients()
 * @param {Map} params.memory - from readStreamMemory()
 * @param {Map<string, number>} params.pending - app name -> level waiting for its next stream
 * @param {number} params.norm - Gvc volume for 100%
 */
export function buildRows({streams, clients, memory, pending, norm}) {
    const rows = new Map();
    const getRow = name => {
        let row = rows.get(name);
        if (!row) {
            row = {name, appId: null, binary: null, streams: []};
            rows.set(name, row);
        }
        return row;
    };

    for (const stream of streams) {
        const row = getRow(stream.get_name());
        row.streams.push(stream);
        row.appId ??= stream.get_application_id();
    }

    for (const client of clients) {
        if (!rows.has(client.name) && !memoryKeyFor(memory, client.appId, client.name))
            continue;
        const row = getRow(client.name);
        row.appId ??= client.appId;
        row.binary ??= client.binary;
    }

    for (const row of rows.values()) {
        row.memKey = memoryKeyFor(memory, row.appId, row.name);
        row.channels = memory.get(row.memKey)?.channelVolumes?.length || 2;

        let level;
        if (row.streams.length > 0) {
            level = Math.max(...row.streams.map(
                stream => stream.is_muted ? 0 : stream.volume / norm));
        } else {
            level = pending.get(row.name) ?? memoryLevel(memory.get(row.memKey));
        }
        row.level = Math.min(Math.max(level ?? 1, 0), 1);

        const info = findAppInfo(row.appId, row.name, row.binary);
        row.displayName = info?.get_name() ?? row.name;
        row.gicon = info?.get_icon() ?? null;
    }

    return [...rows.values()].sort(
        (a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Finds a .desktop entry for display name and icon.
 */
export function findAppInfo(appId, name, binary) {
    if (appId) {
        const info = Gio.DesktopAppInfo.new(`${appId}.desktop`);
        if (info)
            return info;
    }
    for (const term of [name, binary]) {
        if (!term)
            continue;
        for (const group of Gio.DesktopAppInfo.search(term)) {
            for (const id of group) {
                const info = Gio.DesktopAppInfo.new(id);
                if (info)
                    return info;
            }
        }
    }
    return null;
}
