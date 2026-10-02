[🇬🇧 English](README.md)

<div align="center">
  <br/>

# Nitori

**秤 · Básculas Torrey desde el navegador, con Web Serial y sin dependencias.**

<br/>

![Web Serial](https://img.shields.io/badge/web%20serial-chrome%20%2F%20edge-4285f4?style=for-the-badge&logo=googlechrome&logoColor=white)
[![CI](https://img.shields.io/github/actions/workflow/status/Chidaruma696/Nitori/ci.yml?branch=main&style=for-the-badge&label=node%20--test)](https://github.com/Chidaruma696/Nitori/actions)
![Sin dependencias](https://img.shields.io/badge/dependencias-0-1b150d?style=for-the-badge)
![Licencia MIT](https://img.shields.io/badge/licencia-MIT-1b150d?style=for-the-badge)

<br/>

*sondeo · parser con ST/US y unidad · estabilizador · reconexión · simulador*

</div>

---

> [!NOTE]
> Nitori es la mitad JavaScript de un par: lee la báscula, y **[Chimata](https://github.com/Chidaruma696/Chimata)** (Python) le pone código de barras a lo que pesó. Cada una vive sola.

<br/>

## ⚖️ Qué es

Una báscula Torrey conectada por USB aparece como un puerto serie. Con Web Serial, Chrome y Edge de escritorio pueden hablarle sin drivers ni instaladores: la página pide el puerto, el usuario lo autoriza una vez y desde ahí el peso llega en vivo. Nitori junta todo lo que hay que saber para que eso funcione de verdad en un mostrador:

| 🔌 Conexión | ⚖️ Lectura | 🎯 Captura |
| --- | --- | --- |
| Abre el puerto a 115200 8N1 y **sondea** con `P\r\n` cada 500 ms, porque la Torrey no habla sola | Procesa solo la **última línea completa**, como mucho cada 200 ms, para filtrar ráfagas | **Estabilizador**: dos lecturas a menos de 3 g arrancan una espera de 800 ms; al cumplirse captura una sola vez |
| Suelta siempre el *writer* aunque la escritura falle; si no, el puerto se traba y la báscula enmudece sin avisar | Lee las banderas **ST/US** y la **unidad**; si la báscula está en libras, avisa y convierte | Detecta el **retiro** (menos de 20 g, o menos del 60 % de lo capturado) para no contar dos veces el mismo paquete |
| **Se reconecta sola** si el cable se cae o la báscula se calla, y recuerda el puerto para no preguntar en cada visita | Te da la trama cruda para ver qué manda exactamente tu modelo | Captura manual cuando la necesitas, diciendo si el peso estaba estable |

Cada umbral salió de un problema real con una Torrey L-PCR en uso diario; todos son opciones por si tu báscula necesita otros valores.

<br/>

## 📲 Instalar

Todavía no está en npm. Directo del repositorio:

```bash
npm install github:Chidaruma696/Nitori
```

```js
import { Scale } from 'nitori-scale';
```

O sin bundler, con la versión UMD (deja `window.Nitori`):

```html
<script src="https://cdn.jsdelivr.net/gh/Chidaruma696/Nitori@main/dist/nitori.umd.js"></script>
```

<br/>

## 🧪 Uso

```js
import { Scale } from 'nitori-scale';

const bascula = new Scale({ messages: { ready: 'Coloca paquete' } });

bascula.on('weight',  w => pantalla.textContent = w.kg.toFixed(3));  // cada lectura
bascula.on('stable',  w => agregarPesada(w.kg));                     // una vez por paquete
bascula.on('removed', () => mensaje('Coloca el siguiente'));
bascula.on('state',   s => chip(s.state, s.message));                // connected · reconnecting · disconnected
bascula.on('warning', w => mensaje(w.message));                      // p. ej. la báscula está en libras

botonConectar.onclick = () => bascula.connect();   // le pide el puerto al usuario
bascula.reconnect();                                // al cargar: usa el puerto ya autorizado, si lo hay
```

### Sin báscula

El simulador tiene la misma interfaz y sirve para desarrollar, para demos y para los tests:

```js
import { simulatedScale } from 'nitori-scale';

const b = simulatedScale({ interval: 250 });
await b.connect();
b.simulator.place(1.25);   // unas lecturas inestables y luego se asienta
b.simulator.remove();
b.simulator.drop();        // como si se desconectara el cable
```

### Solo el estabilizador

Si ya lees el puerto a tu manera, la lógica de captura es una clase pura sin temporizadores:

```js
import { Stabilizer } from 'nitori-scale';

const e = new Stabilizer({ threshold: 0.003, wait: 800, minimum: 0.020 });
for (const ev of e.feed(kg, Date.now(), flagST)) {
  if (ev.type === 'stable') capturar(ev.kg);
  if (ev.type === 'removed') listo();
}
```

### En tu idioma

Los textos que emite la báscula (los mensajes de `state` y `warning`) vienen en inglés. Pasa los que quieras en otro idioma y el resto se queda igual. Las claves están en `MESSAGES`; la demo tiene el juego completo en español, cópialo de ahí.

### La demo

Abre `demo/index.html` en Chrome (servido por `http://`, no `file://`) para verla con una báscula real o simulada, mirar las tramas crudas e imprimir etiquetas de prueba. Habla inglés y español y sigue al idioma del navegador.

<br/>

## 🔧 API

### `new Scale(opciones)`

| Opción | Por defecto | Qué hace |
| --- | --- | --- |
| `baudRate`, `dataBits`, `stopBits`, `parity` | `115200`, `8`, `1`, `'none'` | Parámetros del puerto |
| `poll` | `500` | ms entre cada `P\r\n`; `0` si tu báscula transmite sola |
| `pollCommand` | `'P\r\n'` | Lo que se manda para pedir el peso |
| `threshold` | `0.003` | Diferencia máxima en kg entre dos lecturas "iguales" |
| `wait` | `800` | ms que el peso debe quedarse quieto antes de capturar |
| `minimum` | `0.020` | kg por debajo de los cuales el plato está vacío |
| `removalFraction` | `0.60` | Bajar de esta fracción de lo capturado cuenta como retiro |
| `useFlag` | `true` | La bandera `ST` de la báscula cuenta como lectura quieta |
| `throttle` | `200` | ms mínimos entre pasadas del buffer |
| `parser` | `parseTorrey` | Una función `texto → lectura` si tu trama es distinta |
| `filters` | | Filtros para `requestPort`, p. ej. `[{ usbVendorId: 0x0403 }]` |
| `remember` | `true` | Recuerda el puerto para que `reconnect()` funcione en la siguiente visita |
| `retries` | `3` | Intentos de reconexión si la conexión se cae |
| `silence` | `4000` | ms sin oír a la báscula antes de reabrir el puerto (`0` = nunca) |
| `looseLine` | `600` | ms que espera una trama sin salto de línea antes de procesarse igual |
| `messages` | `MESSAGES` | Textos para personas, ver arriba |
| `transport` | `TorreySerial` | Otro transporte con la misma interfaz (`SimulatedTransport`) |

Métodos: `connect(puerto?)`, `reconnect()`, `disconnect()`, `capture()`, `on(evento, fn)` (devuelve la función para quitar el oyente), `off()`. Propiedades: `state`, `connected`, `weight`, `stable`, `lastReading`. `Scale.supported` dice si el navegador tiene Web Serial.

Eventos: `weight` `{kg, raw, unit, stable}` · `phase` `{phase: empty|weighing|settling|stable|removed, kg}` · `stable` `{kg}` · `removed` `{kg}` · `capture` `{kg, manual, stable}` · `state` `{state, message}` · `frame` `{text}` · `warning` `{type: unit|silence, message}` · `error` `{error}`.

### `parseTorrey(linea)`

Acepta `ST,GS,+   1.250 kg`, `US,GS,-0,015 kg`, `1.250`, `1250 g`, `2.000 lb`. Devuelve `{ kg, raw, unit, declaredUnit, stable, text }`, o `null` si la línea no trae número. Libras, onzas y gramos pasan a kg.

> [!IMPORTANT]
> No todos los modelos de Torrey mandan la misma trama. Activa "mostrar tramas crudas" en la demo con tu báscula, mira qué llega y, si el parser por defecto no la entiende, pasa el tuyo con la opción `parser`. Si tienes una trama que no entiende, abre una issue con el ejemplo para añadirla.

<br/>

## 🔬 Desarrollo

```bash
git clone https://github.com/Chidaruma696/Nitori.git
cd Nitori
node --test test/         # parser, estabilizador, vigilante y pesadas completas con el simulador
python scripts/build.py   # regenera dist/ (ESM + UMD) sin toolchain
```

El código es un solo archivo, `src/nitori.js`. `dist/` va en el repo para servir la UMD desde jsDelivr sin publicar nada. Por qué está hecho así está en [`docs/decisiones.md`](docs/decisiones.md).

<br/>

## ⚖️ Licencia

[MIT](LICENSE).

<br/>

<div align="center">

*Lo que pesa, pesa.*

秤 · はかり

</div>
