/**
 * Nitori: read Torrey scales (and similar ones) from the browser with Web Serial.
 *
 * Pieces:
 *   parseTorrey        text of one frame -> { kg, raw, unit, stable }
 *   Stabilizer         pure state machine: when a weight is still and when it was taken off
 *   TorreySerial       Web Serial transport (opens the port, polls with "P", reads)
 *   SimulatedTransport the same interface with no hardware, for tests and demos
 *   Scale              puts it all together and emits events: weight, stable, removed, state, frame, warning
 *
 * No dependencies. ESM in src/, UMD in dist/.
 */

export const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const TO_KG = { kg: 1, g: 0.001, lb: 0.45359237, oz: 0.028349523 };

/**
 * Reads one line from the scale.
 *
 * Takes the usual Torrey formats and the "ST,GS,+ 1.250 kg" family: with or
 * without stability flags (ST stable / US unstable), with or without a sign,
 * with or without a unit, with a decimal point or comma. Returns null if
 * there is no number in the line.
 *
 * @param {string} line
 * @returns {{kg:number, raw:number, unit:string, declaredUnit:string|null, stable:boolean|null, text:string}|null}
 */
export function parseTorrey(line) {
  const text = String(line == null ? '' : line).trim();
  if (!text) return null;
  const upper = text.toUpperCase();

  let stable = null;
  if (/(^|[^A-Z])ST([^A-Z]|$)/.test(upper)) stable = true;
  else if (/(^|[^A-Z])US([^A-Z]|$)/.test(upper)) stable = false;

  const m = upper.match(/([+-])?\s*(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  let raw = parseFloat(m[2].replace(',', '.'));
  if (!Number.isFinite(raw)) return null;
  if (m[1] === '-') raw = -raw;

  let declaredUnit = null;
  const u = upper.match(/(^|[^A-Z])(KG|LB|OZ|G)([^A-Z]|$)/);
  if (u) declaredUnit = u[2].toLowerCase();
  const unit = declaredUnit || 'kg';
  const kg = raw * TO_KG[unit];
  return { kg, raw, unit, declaredUnit, stable, text };
}

// ---------------------------------------------------------------------------
// Stabilizer
// ---------------------------------------------------------------------------

/**
 * Decides, reading by reading, when a package is sitting still on the pan
 * and when it was taken off. It uses no timers: it gets the timestamp of
 * each reading, so it can be tested without waiting and fits any clock.
 *
 * The defaults came from Torrey scales in daily use: two readings less than
 * 3 g apart start an 800 ms wait; when it's over, the weight is captured.
 * It counts as removed when the weight drops below 20 g or below 60 % of
 * what was captured (so a second package isn't counted on top of the first).
 */
export class Stabilizer {
  /**
   * @param {{threshold?:number, wait?:number, minimum?:number, removalFraction?:number, useFlag?:boolean}} [o]
   *   threshold  largest difference between readings to call them equal (kg)
   *   wait       ms the weight has to stay still before it's captured
   *   minimum    below this the pan is empty (kg)
   *   removalFraction  dropping below this fraction of the captured weight counts as removed
   *   useFlag    if the scale sends ST/US, ST counts as a still reading
   */
  constructor(o = {}) {
    this.threshold = o.threshold ?? 0.003;
    this.wait = o.wait ?? 800;
    this.minimum = o.minimum ?? 0.020;
    this.removalFraction = o.removalFraction ?? 0.60;
    this.useFlag = o.useFlag ?? true;
    this.reset();
  }

  reset() {
    this.last = 0;
    this.stillSince = null;
    this.captured = 0;
    this.holding = false;
  }

  /** Is there a captured package waiting to be taken off? */
  get awaitingRemoval() { return this.holding; }

  /**
   * Feeds one reading and returns the events it produces.
   * @param {number} kg
   * @param {number} [now]  timestamp in ms
   * @param {boolean|null} [stableFlag]  the scale's ST/US, if it sends one
   * @returns {Array<{type:'empty'|'weighing'|'settling'|'stable'|'removed', kg:number}>}
   */
  feed(kg, now = Date.now(), stableFlag = null) {
    const dropped = this.holding && this.captured > 0 && kg < this.captured * this.removalFraction;
    if (kg <= this.minimum || dropped) {
      const had = this.holding;
      const cap = this.captured;
      this.reset();
      return had ? [{ type: 'removed', kg: cap }] : [{ type: 'empty', kg }];
    }
    if (this.holding) return [];

    const diff = Math.abs(kg - this.last);
    this.last = kg;
    const still = diff < this.threshold || (this.useFlag && stableFlag === true);
    if (!still) {
      this.stillSince = null;
      return [{ type: 'weighing', kg }];
    }
    if (this.stillSince == null) {
      this.stillSince = now;
      return [{ type: 'settling', kg }];
    }
    if (now - this.stillSince >= this.wait) {
      this.holding = true;
      this.captured = kg;
      return [{ type: 'stable', kg }];
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/**
 * Web Serial transport. A Torrey doesn't talk on its own: you ask for the
 * weight with "P\r\n" every so often. If a write fails and the writer isn't
 * released, the lock stays taken and the scale goes quiet without a word;
 * that's why it's always released.
 */
export class TorreySerial {
  /**
   * @param {{baudRate?:number, dataBits?:number, stopBits?:number, parity?:string, poll?:number, pollCommand?:string}} [o]
   */
  constructor(o = {}) {
    this.baudRate = o.baudRate ?? 115200;
    this.dataBits = o.dataBits ?? 8;
    this.stopBits = o.stopBits ?? 1;
    this.parity = o.parity ?? 'none';
    this.poll = o.poll ?? 500;                // ms; 0 = the scale sends on its own
    this.pollCommand = o.pollCommand ?? 'P\r\n';
    this.port = null;
    this._reader = null;
    this._timer = null;
    this._closing = false;
  }

  static get available() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  async requestPort(filters) {
    if (!TorreySerial.available) throw new Error('Web Serial is not available: use desktop Chrome or Edge');
    return navigator.serial.requestPort(filters ? { filters } : undefined);
  }

  async rememberedPorts() {
    if (!TorreySerial.available) return [];
    try { return await navigator.serial.getPorts(); } catch { return []; }
  }

  /**
   * Opens the port and starts reading. `onText` gets every chunk that
   * arrives; `onClose` is called once if the connection drops by itself.
   */
  async open(port, onText, onClose) {
    await port.open({ baudRate: this.baudRate, dataBits: this.dataBits, stopBits: this.stopBits, parity: this.parity });
    this.port = port;
    this._closing = false;
    this._loop(onText, onClose);
    if (this.poll > 0) {
      const enc = new TextEncoder();
      this._pending = 0;
      this._timer = setInterval(() => this._sendPoll(enc), this.poll);
    }
  }

  /**
   * Sends the poll command without waiting for the device to accept it. If
   * you wait (`await write`) and the USB gets stuck, the writer's lock stays
   * taken forever, the next polls fail silently and the scale, which only
   * talks when asked, goes quiet. Here the write is queued, the lock is
   * released right away and, if writes pile up unaccepted, it stops insisting
   * (the Scale's watchdog reopens the port).
   */
  _sendPoll(enc) {
    if (!this.port || !this.port.writable) return;
    if (this._pending >= 3) return;
    let w = null;
    try {
      w = this.port.writable.getWriter();
      this._pending++;
      w.write(enc.encode(this.pollCommand)).catch(() => {}).finally(() => { this._pending--; });
    } catch { /* the writer was taken; the next poll tries again */ }
    finally { if (w) { try { w.releaseLock(); } catch { /* already released */ } } }
  }

  /** Are there writes the device hasn't accepted? */
  get stuck() { return (this._pending || 0) >= 3; }

  async _loop(onText, onClose) {
    const dec = new TextDecoder();
    while (!this._closing && this.port && this.port.readable) {
      this._reader = this.port.readable.getReader();
      try {
        for (;;) {
          const r = await this._reader.read();
          if (r.done) break;
          try { onText(dec.decode(r.value)); } catch { /* a listener's error doesn't kill the reading */ }
        }
      } catch {
        break;
      } finally {
        try { this._reader.releaseLock(); } catch { /* already released */ }
      }
    }
    if (!this._closing) {
      const lost = this.port;
      await this.close(false);
      onClose(lost);
    }
  }

  async close(closePort = true) {
    this._closing = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._reader) { try { await this._reader.cancel(); } catch { /* already closed */ } this._reader = null; }
    if (this.port && closePort) { try { await this.port.close(); } catch { /* already closed */ } }
    if (closePort) this.port = null;
  }
}

/**
 * A pretend scale with the same interface as TorreySerial. It sends
 * "ST,GS,+ 1.250 kg" frames every `interval` ms with a bit of noise; when a
 * weight is placed it sends a few unstable (US) readings before settling.
 */
export class SimulatedTransport {
  constructor(o = {}) {
    this.interval = o.interval ?? 250;
    this.noise = o.noise ?? 0.001;
    this.settlingReadings = o.settlingReadings ?? 3;
    this.realWeight = 0;
    this._settling = 0;
    this._timer = null;
    this._onText = null;
    this._onClose = null;
  }

  static get available() { return true; }
  async requestPort() { return { simulated: true }; }
  async rememberedPorts() { return [{ simulated: true }]; }

  async open(_port, onText, onClose) {
    this._onText = onText;
    this._onClose = onClose || null;
    this._timer = setInterval(() => this._tick(), this.interval);
  }

  _tick() {
    if (!this._onText) return;
    const unstable = this._settling > 0;
    if (unstable) this._settling--;
    const noise = (Math.random() * 2 - 1) * this.noise * (unstable ? 8 : 1);
    const kg = this.realWeight > 0 ? Math.max(0, this.realWeight + noise) : 0;
    const sign = kg < 0 ? '-' : '+';
    this._onText(`${unstable ? 'US' : 'ST'},GS,${sign}${Math.abs(kg).toFixed(3).padStart(8, ' ')} kg\r\n`);
  }

  /** Puts a package on the pan. */
  place(kg) { this.realWeight = kg; this._settling = this.settlingReadings; }
  /** Empties the pan. */
  remove() { this.realWeight = 0; this._settling = 0; }
  /** Pretends the cable came off. */
  drop() { const cb = this._onClose; this.close(); if (cb) cb({ simulated: true }); }

  async close() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._onText = null;
    this._onClose = null;
  }
}

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

const STATES = ['disconnected', 'connecting', 'connected', 'reconnecting'];

/**
 * What the scale says to people. Pass `messages` to Scale with the keys you
 * want in another language; the rest stay in English.
 */
export const MESSAGES = {
  ready: 'Place a package',
  reconnectedAlone: 'Scale ready (reconnected by itself)',
  reconnected: 'Scale reconnected',
  reconnecting: 'Connection lost. Retrying…',
  lost: 'Could not recover it. Connect it again.',
  disconnected: 'Not connected',
  unplugged: 'Scale unplugged (USB)',
  connectFailed: 'Could not connect',
  silent: 'The scale is not answering; reopening the port.',
  stuck: 'The port is not taking data; reopening it.',
  unit: 'The scale is set to {unit}; weights are converted to kg.',
};

/**
 * The scale as a source of events.
 *
 *   const s = new Scale();
 *   s.on('weight',  w => show(w.kg));
 *   s.on('stable',  w => add(w.kg));
 *   s.on('removed', () => ready());
 *   await s.connect();
 *
 * Events: 'weight' {kg, raw, unit, stable}, 'phase' {phase, kg}, 'stable' {kg},
 * 'removed' {kg}, 'capture' {kg, manual, stable}, 'state' {state, message}, 'frame' {text},
 * 'warning' {type, message}, 'error' {error}.
 */
export class Scale {
  /**
   * @param {object} [o]  TorreySerial and Stabilizer options, plus:
   *   transport   another instance (e.g. SimulatedTransport)
   *   parser      function text -> reading (parseTorrey by default)
   *   throttle    minimum ms between buffer passes (200)
   *   remember    remember the port to reconnect by itself next time (true)
   *   key         localStorage key for the above ('nitori:auto')
   *   filters     port filters for requestPort (e.g. [{usbVendorId: 0x0403}])
   *   retries     reconnection attempts if the connection drops (3)
   *   silence     ms without hearing from the scale before reopening the port (4000; 0 = never)
   *   looseLine   ms a frame with no line break waits before it's processed anyway (600)
   *   messages    texts for people, see MESSAGES
   */
  constructor(o = {}) {
    this.options = o;
    this.transport = o.transport || new TorreySerial(o);
    this.parser = o.parser || parseTorrey;
    this.stabilizer = new Stabilizer(o);
    this.throttle = o.throttle ?? 200;
    this.remember = o.remember ?? true;
    this.key = o.key || 'nitori:auto';
    this.retries = o.retries ?? 3;
    this.silence = o.silence ?? 4000;
    this.looseLine = o.looseLine ?? 600;
    this.filters = o.filters;
    this.messages = { ...MESSAGES, ...(o.messages || {}) };
    this.lastFrame = 0;
    this._watchdog = null;

    this.state = 'disconnected';
    this.weight = 0;
    this.stable = false;
    this.lastReading = null;
    this.wantsConnection = false;

    this._listeners = new Map();
    this._buffer = '';
    this._lastPass = 0;
    this._throttleTimer = null;
    this._waitTimer = null;
    this._unitWarned = false;
    this._port = null;

    this._listenUsb();
  }

  static get supported() { return TorreySerial.available; }

  get connected() { return this.state === 'connected'; }

  // ---- events ----

  on(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) { this._listeners.get(type)?.delete(fn); }

  emit(type, data = {}) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      try { fn(data); } catch (error) { if (type !== 'error') this.emit('error', { error }); }
    }
  }

  _setState(state, message = '') {
    if (!STATES.includes(state)) throw new Error(`unknown state: ${state}`);
    this.state = state;
    this.emit('state', { state, message });
  }

  // ---- connection ----

  /** Asks the user for a port (or uses the one given) and connects. */
  async connect(port) {
    if (this.connected) return true;
    this._setState('connecting');
    try {
      const p = port || await this.transport.requestPort(this.filters);
      await this._open(p);
      this.wantsConnection = true;
      this._saveRemember(true);
      return true;
    } catch (error) {
      this._setState('disconnected', error && error.message ? error.message : this.messages.connectFailed);
      this.emit('error', { error });
      return false;
    }
  }

  /** Tries to reconnect to an already allowed port, if the user left it remembered. */
  async reconnect() {
    if (this.connected) return true;
    if (this.remember && !this._readRemember()) return false;
    const ports = await this.transport.rememberedPorts();
    for (const p of ports) {
      try {
        await this._open(p);
        this.wantsConnection = true;
        this._setState('connected', this.messages.reconnectedAlone);
        return true;
      } catch { /* next port */ }
    }
    return false;
  }

  async disconnect() {
    this.wantsConnection = false;
    this._saveRemember(false);
    await this._close(true);
    this._setState('disconnected', this.messages.disconnected);
  }

  async _open(port) {
    await this.transport.open(port, (t) => this._onText(t), (lost) => this._onClose(lost));
    this._port = port;
    this._buffer = '';
    this.stabilizer.reset();
    this._unitWarned = false;
    this.lastFrame = Date.now();
    this._watch();
    this._setState('connected', this.messages.ready);
  }

  /**
   * Every second it checks two things: that frames keep coming (if the scale
   * is quiet for more than `silence` ms, or the USB won't take writes, the
   * port is reopened as if it had dropped) and that a frame that came with no
   * line break doesn't sit in the buffer forever.
   */
  _watch() {
    if (this._watchdog) clearInterval(this._watchdog);
    this._watchdog = setInterval(() => {
      if (!this.connected) return;
      const now = Date.now();
      if (this._buffer.trim() && now - this.lastFrame >= this.looseLine) {
        const line = this._buffer.trim();
        this._buffer = '';
        this._processLine(line, now);
      }
      const quiet = this.silence > 0 && now - this.lastFrame >= this.silence;
      const stuck = !!this.transport.stuck;
      if (quiet || stuck) {
        this.emit('warning', { type: 'silence', message: stuck ? this.messages.stuck : this.messages.silent });
        const port = this._port;
        this._close(false).then(() => this._onClose(port));
      }
    }, 1000);
  }

  async _close(closePort) {
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    if (this._throttleTimer) { clearTimeout(this._throttleTimer); this._throttleTimer = null; }
    if (this._waitTimer) { clearTimeout(this._waitTimer); this._waitTimer = null; }
    await this.transport.close(closePort);
    if (closePort) this._port = null;
    this.weight = 0;
    this.stable = false;
    this.stabilizer.reset();
    this._buffer = '';
  }

  async _onClose(lost) {
    await this._close(false);
    if (!this.wantsConnection) { this._setState('disconnected', this.messages.disconnected); return; }
    this._setState('reconnecting', this.messages.reconnecting);
    for (let i = 1; i <= this.retries; i++) {
      await new Promise((r) => setTimeout(r, 1200 * i));
      if (this.connected || !this.wantsConnection) return;
      try { await lost.close(); } catch { /* already closed */ }
      try {
        await this._open(lost);
        this._setState('connected', this.messages.reconnected);
        return;
      } catch { /* next attempt */ }
    }
    this._setState('disconnected', this.messages.lost);
  }

  _listenUsb() {
    if (!TorreySerial.available || !navigator.serial.addEventListener) return;
    navigator.serial.addEventListener('disconnect', (ev) => {
      if (this.connected && ev.target === this._port) {
        this._close(false).then(() => this._setState('disconnected', this.messages.unplugged));
      }
    });
    navigator.serial.addEventListener('connect', async (ev) => {
      if (!this.connected && this.wantsConnection) {
        try { await this._open(ev.target); } catch { /* the user connects again */ }
      }
    });
  }

  _saveRemember(yes) {
    if (!this.remember || typeof localStorage === 'undefined') return;
    try { if (yes) localStorage.setItem(this.key, '1'); else localStorage.removeItem(this.key); } catch { /* no storage */ }
  }

  _readRemember() {
    if (typeof localStorage === 'undefined') return true;
    try { return localStorage.getItem(this.key) === '1'; } catch { return false; }
  }

  // ---- reading ----

  _onText(text) {
    this._buffer += text;
    this.lastFrame = Date.now();
    this.emit('frame', { text });
    if (this._buffer.length > 2048) this._buffer = this._buffer.slice(-512);
    this._processBuffer();
  }

  /** At most once every `throttle` ms and only the last complete line: it filters bursts. */
  _processBuffer() {
    const now = Date.now();
    const since = now - this._lastPass;
    if (since < this.throttle) {
      if (!this._throttleTimer) {
        this._throttleTimer = setTimeout(() => { this._throttleTimer = null; this._processBuffer(); }, this.throttle - since);
      }
      return;
    }
    this._lastPass = now;
    const lines = this._buffer.split(/[\r\n]+/);
    this._buffer = lines.pop() || '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (l) { this._processLine(l, now); return; }
    }
  }

  _processLine(line, now) {
    const reading = this.parser(line);
    if (!reading) return;
    this.lastReading = reading;
    this.weight = reading.kg;
    if (reading.declaredUnit && reading.declaredUnit !== 'kg' && !this._unitWarned) {
      this._unitWarned = true;
      this.emit('warning', { type: 'unit', message: this.messages.unit.replace('{unit}', reading.declaredUnit) });
    }
    this.emit('weight', reading);
    this._feed(reading.kg, now, reading.stable);
  }

  _feed(kg, now, flag) {
    for (const ev of this.stabilizer.feed(kg, now, flag)) {
      if (ev.type === 'stable') {
        this.stable = true;
        this.emit('stable', { kg: ev.kg });
      } else if (ev.type === 'removed') {
        this.stable = false;
        this.emit('removed', { kg: ev.kg });
      } else if (ev.type === 'settling') {
        // The capture happens when the next reading arrives after the wait; if
        // the scale is slow to send it, this timer forces it with the last weight.
        if (this._waitTimer) clearTimeout(this._waitTimer);
        this._waitTimer = setTimeout(() => {
          this._waitTimer = null;
          if (this.connected && !this.stabilizer.awaitingRemoval && this.stabilizer.stillSince != null) {
            this._feed(this.stabilizer.last, Date.now(), null);
          }
        }, this.stabilizer.wait + 20);
      }
      this.emit('phase', { phase: ev.type, kg: ev.kg });
    }
  }

  /** Manual capture of the current weight, stable or not. */
  capture() {
    if (this.weight <= 0) return null;
    const kg = this.weight;
    this.emit('capture', { kg, manual: true, stable: this.stable });
    return kg;
  }
}

/** A simulated scale ready to use: `s.simulator.place(1.25)`. */
export function simulatedScale(o = {}) {
  const transport = new SimulatedTransport(o);
  const s = new Scale({ ...o, transport });
  s.simulator = transport;
  return s;
}
