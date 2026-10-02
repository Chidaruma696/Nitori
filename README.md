[🇪🇸 Español](README.es.md)

<div align="center">
  <br/>

# Nitori

**秤 · Torrey scales from the browser, with Web Serial and no dependencies.**

<br/>

![Web Serial](https://img.shields.io/badge/web%20serial-chrome%20%2F%20edge-4285f4?style=for-the-badge&logo=googlechrome&logoColor=white)
[![CI](https://img.shields.io/github/actions/workflow/status/Chidaruma696/Nitori/ci.yml?branch=main&style=for-the-badge&label=node%20--test)](https://github.com/Chidaruma696/Nitori/actions)
![No dependencies](https://img.shields.io/badge/dependencies-0-1b150d?style=for-the-badge)
![MIT License](https://img.shields.io/badge/license-MIT-1b150d?style=for-the-badge)

<br/>

*polling · parser with ST/US and unit · stabilizer · reconnection · simulator*

</div>

---

> [!NOTE]
> Nitori is the JavaScript half of a pair: it reads the scale, and **[Chimata](https://github.com/Chidaruma696/Chimata)** (Python) puts a barcode on whatever it weighed. Each one stands on its own.

<br/>

## ⚖️ What it is

A Torrey scale plugged in over USB shows up as a serial port. With Web Serial, desktop Chrome and Edge can talk to it with no drivers or installers: the page asks for the port, the user allows it once, and from then on the weight comes in live. Nitori packs everything you need to know to make that actually work at a counter:

| 🔌 Connection | ⚖️ Reading | 🎯 Capture |
| --- | --- | --- |
| Opens the port at 115200 8N1 and **polls** with `P\r\n` every 500 ms, because a Torrey doesn't talk on its own | Takes only the **last complete line**, at most every 200 ms, to filter out bursts | **Stabilizer**: two readings within 3 g of each other start an 800 ms wait; once it's over, it captures exactly once |
| Always releases the *writer*, even if the write fails; otherwise the port locks up and the scale goes quiet without a word | Reads the **ST/US** flags and the **unit**; if the scale is set to pounds, it warns you and converts | Notices the **removal** (under 20 g, or under 60 % of what was captured) so the same package is never counted twice |
| **Reconnects by itself** if the cable drops or the scale goes quiet, and remembers the port so it doesn't ask on every visit | Hands you the raw frame so you can see exactly what your model sends | Manual capture when you need it, saying whether the weight was stable |

Every threshold came from a real problem with a Torrey L-PCR in daily use; they're all options in case your scale needs other values.

<br/>

## 📲 Install

It's not on npm yet. Straight from the repository:

```bash
npm install github:Chidaruma696/Nitori
```

```js
import { Scale } from 'nitori-scale';
```

Or with no bundler, using the UMD build (it sets `window.Nitori`):

```html
<script src="https://cdn.jsdelivr.net/gh/Chidaruma696/Nitori@main/dist/nitori.umd.js"></script>
```

<br/>

## 🧪 Usage

```js
import { Scale } from 'nitori-scale';

const scale = new Scale();

scale.on('weight',  w => display.textContent = w.kg.toFixed(3));  // every reading
scale.on('stable',  w => addWeighing(w.kg));                     // once per package
scale.on('removed', () => say('Place the next one'));
scale.on('state',   s => chip(s.state, s.message));              // connected · reconnecting · disconnected
scale.on('warning', w => say(w.message));                        // e.g. the scale is set to pounds

connectButton.onclick = () => scale.connect();   // asks the user for the port
scale.reconnect();                                // on load: uses the port already allowed, if any
```

### Without a scale

The simulator has the same interface and comes in handy for development, demos and the tests:

```js
import { simulatedScale } from 'nitori-scale';

const s = simulatedScale({ interval: 250 });
await s.connect();
s.simulator.place(1.25);   // a few unstable readings, then it settles
s.simulator.remove();
s.simulator.drop();        // pretends the cable came off
```

### Just the stabilizer

If you already read the port your own way, the capture logic is a pure class with no timers:

```js
import { Stabilizer } from 'nitori-scale';

const st = new Stabilizer({ threshold: 0.003, wait: 800, minimum: 0.020 });
for (const ev of st.feed(kg, Date.now(), stFlag)) {
  if (ev.type === 'stable') capture(ev.kg);
  if (ev.type === 'removed') ready();
}
```

### In your language

The texts the scale emits (`state` and `warning` messages) are in English. Pass the ones you want in another language and the rest stay as they are:

```js
new Scale({ messages: { ready: 'Coloca paquete', reconnecting: 'Se perdió la conexión. Reintentando…' } });
```

The keys are in `MESSAGES`. The demo has the full Spanish set.

### The demo

Open `demo/index.html` in Chrome (served over `http://`, not `file://`) to see it with a real or simulated scale, look at the raw frames and print test labels. It speaks English and Spanish and follows your browser.

<br/>

## 🔧 API

### `new Scale(options)`

| Option | Default | What it does |
| --- | --- | --- |
| `baudRate`, `dataBits`, `stopBits`, `parity` | `115200`, `8`, `1`, `'none'` | Port settings |
| `poll` | `500` | ms between each `P\r\n`; `0` if your scale sends on its own |
| `pollCommand` | `'P\r\n'` | What's sent to ask for the weight |
| `threshold` | `0.003` | Largest difference in kg between two "equal" readings |
| `wait` | `800` | ms the weight has to stay still before it's captured |
| `minimum` | `0.020` | kg below which the pan counts as empty |
| `removalFraction` | `0.60` | Dropping below this fraction of the captured weight counts as removed |
| `useFlag` | `true` | The scale's `ST` flag counts as a still reading |
| `throttle` | `200` | Minimum ms between buffer passes |
| `parser` | `parseTorrey` | A `text → reading` function if your frame is different |
| `filters` | | Filters for `requestPort`, e.g. `[{ usbVendorId: 0x0403 }]` |
| `remember` | `true` | Remembers the port so `reconnect()` works on the next visit |
| `retries` | `3` | Reconnection attempts if the connection drops |
| `silence` | `4000` | ms without hearing from the scale before the port is reopened (`0` = never) |
| `looseLine` | `600` | ms a frame with no line break waits before it's processed anyway |
| `messages` | `MESSAGES` | Texts for people, see above |
| `transport` | `TorreySerial` | Another transport with the same interface (`SimulatedTransport`) |

Methods: `connect(port?)`, `reconnect()`, `disconnect()`, `capture()`, `on(event, fn)` (returns a function that removes the listener), `off()`. Properties: `state`, `connected`, `weight`, `stable`, `lastReading`. `Scale.supported` tells you whether the browser has Web Serial.

Events: `weight` `{kg, raw, unit, stable}` · `phase` `{phase: empty|weighing|settling|stable|removed, kg}` · `stable` `{kg}` · `removed` `{kg}` · `capture` `{kg, manual, stable}` · `state` `{state, message}` · `frame` `{text}` · `warning` `{type: unit|silence, message}` · `error` `{error}`.

### `parseTorrey(line)`

Takes `ST,GS,+   1.250 kg`, `US,GS,-0,015 kg`, `1.250`, `1250 g`, `2.000 lb`. Returns `{ kg, raw, unit, declaredUnit, stable, text }`, or `null` if the line has no number. Pounds, ounces and grams become kg.

> [!IMPORTANT]
> Not every Torrey model sends the same frame. Turn on "show raw frames" in the demo with your scale, look at what comes in, and if the default parser doesn't get it, pass your own with the `parser` option. If you have a frame it doesn't understand, open an issue with the example so it can be added.

<br/>

## 🔬 Development

```bash
git clone https://github.com/Chidaruma696/Nitori.git
cd Nitori
node --test test/         # parser, stabilizer, watchdog and full weighings with the simulator
python scripts/build.py   # rebuilds dist/ (ESM + UMD) with no toolchain
```

The source is one file, `src/nitori.js`. `dist/` is committed so the UMD build can be served from jsDelivr without publishing anything. Why it's built this way is in [`docs/decisiones.md`](docs/decisiones.md) (in Spanish).

<br/>

## ⚖️ License

[MIT](LICENSE).

<br/>

<div align="center">

*What weighs, weighs.*

秤 · はかり

</div>
