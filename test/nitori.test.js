import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTorrey, Stabilizer, simulatedScale, Scale, SimulatedTransport } from '../src/nitori.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- parser

test('parses a Torrey frame with flags and unit', () => {
  const r = parseTorrey('ST,GS,+   1.250 kg');
  assert.equal(r.kg, 1.25);
  assert.equal(r.stable, true);
  assert.equal(r.unit, 'kg');
});

test('US is unstable, decimal comma and negative', () => {
  const r = parseTorrey('US,GS,-0,015 kg');
  assert.equal(r.stable, false);
  assert.equal(r.kg, -0.015);
});

test('no unit means kg and no flags leaves stable as null', () => {
  const r = parseTorrey('  1.250');
  assert.equal(r.kg, 1.25);
  assert.equal(r.declaredUnit, null);
  assert.equal(r.stable, null);
});

test('pounds and grams are converted to kg', () => {
  assert.ok(Math.abs(parseTorrey('2.000 lb').kg - 0.90718474) < 1e-6);
  assert.equal(parseTorrey('1250 g').kg, 1.25);
  assert.equal(parseTorrey('1250 g').declaredUnit, 'g');
});

test('lines with no number give null', () => {
  assert.equal(parseTorrey(''), null);
  assert.equal(parseTorrey('READY'), null);
  assert.equal(parseTorrey(null), null);
});

// ---------------------------------------------------------------- stabilizer

test('captures after the wait and notices the removal', () => {
  const s = new Stabilizer({ wait: 800, threshold: 0.003, minimum: 0.02 });
  assert.deepEqual(s.feed(0, 0), [{ type: 'empty', kg: 0 }]);
  assert.deepEqual(s.feed(1.240, 100), [{ type: 'weighing', kg: 1.240 }]);
  assert.deepEqual(s.feed(1.250, 300), [{ type: 'weighing', kg: 1.250 }]);
  assert.deepEqual(s.feed(1.251, 500), [{ type: 'settling', kg: 1.251 }]);
  assert.deepEqual(s.feed(1.251, 900), []);             // 800 ms haven't passed yet
  assert.deepEqual(s.feed(1.252, 1400), [{ type: 'stable', kg: 1.252 }]);
  assert.deepEqual(s.feed(1.252, 1700), []);            // already captured: quiet
  assert.deepEqual(s.feed(0.010, 2000), [{ type: 'removed', kg: 1.252 }]);
  assert.equal(s.awaitingRemoval, false);
});

test('a movement restarts the wait', () => {
  const s = new Stabilizer({ wait: 800 });
  s.feed(1.0, 0);
  s.feed(1.0, 200);                                      // settling
  assert.deepEqual(s.feed(1.1, 400), [{ type: 'weighing', kg: 1.1 }]);
  assert.deepEqual(s.feed(1.1, 600), [{ type: 'settling', kg: 1.1 }]);
  assert.deepEqual(s.feed(1.1, 1000), []);
  assert.deepEqual(s.feed(1.1, 1500), [{ type: 'stable', kg: 1.1 }]);
});

test('dropping below 60 % of the captured weight counts as removed even above zero', () => {
  const s = new Stabilizer({ wait: 100 });
  s.feed(2.0, 0); s.feed(2.0, 50); s.feed(2.0, 200);
  assert.equal(s.awaitingRemoval, true);
  assert.deepEqual(s.feed(1.0, 300), [{ type: 'removed', kg: 2.0 }]);
});

test("the scale's ST flag counts as a still reading", () => {
  const s = new Stabilizer({ wait: 100, threshold: 0.003 });
  assert.deepEqual(s.feed(1.0, 0, true), [{ type: 'settling', kg: 1.0 }]);
  assert.deepEqual(s.feed(1.5, 200, true), [{ type: 'stable', kg: 1.5 }]);  // big jump but ST
  const noFlag = new Stabilizer({ wait: 100, useFlag: false });
  noFlag.feed(1.0, 0, true);
  assert.deepEqual(noFlag.feed(1.5, 200, true), [{ type: 'weighing', kg: 1.5 }]);
});

// ---------------------------------------------------------------- simulated scale (end to end)

test('a full weighing with the simulated scale', async () => {
  const s = simulatedScale({ interval: 20, throttle: 10, wait: 120, noise: 0.0005 });
  const states = [];
  const stables = [];
  let removed = 0;
  s.on('state', (e) => states.push(e.state));
  s.on('stable', (w) => stables.push(w.kg));
  s.on('removed', () => removed++);

  assert.equal(await s.connect(), true);
  assert.equal(s.connected, true);
  s.simulator.place(1.25);
  await sleep(500);
  assert.equal(stables.length, 1, 'one capture per package');
  assert.ok(Math.abs(stables[0] - 1.25) < 0.01);
  assert.equal(s.stable, true);

  s.simulator.remove();
  await sleep(100);
  assert.equal(removed, 1);
  assert.equal(s.stable, false);

  s.simulator.place(0.8);
  await sleep(500);
  assert.equal(stables.length, 2, 'the second package is captured by itself');

  await s.disconnect();
  assert.equal(s.state, 'disconnected');
  assert.deepEqual(states.slice(0, 2), ['connecting', 'connected']);
});

test('manual capture and unit warning', async () => {
  const t = new SimulatedTransport({ interval: 20 });
  const s = new Scale({ transport: t, throttle: 5, parser: (l) => parseTorrey(l.replace('kg', 'lb')) });
  const warnings = [];
  s.on('warning', (w) => warnings.push(w));
  await s.connect();
  t.place(2.0);
  await sleep(120);
  assert.equal(warnings[0].type, 'unit');
  assert.match(warnings[0].message, /set to lb/);
  assert.ok(s.weight > 0.8 && s.weight < 1.0, 'pounds were converted to kg');
  assert.ok(s.capture() > 0);
  await s.disconnect();
});

test('messages can be translated', async () => {
  const s = simulatedScale({ interval: 20, messages: { ready: 'Coloca paquete' } });
  const messages = [];
  s.on('state', (e) => messages.push(e.message));
  await s.connect();
  await s.disconnect();
  assert.deepEqual(messages.slice(1), ['Coloca paquete', 'Not connected']);
});

test('with no real transport, connect fails cleanly in Node', async () => {
  const s = new Scale({ remember: false });
  assert.equal(Scale.supported, false);
  const errors = [];
  s.on('error', (e) => errors.push(e.error.message));
  assert.equal(await s.connect(), false);
  assert.equal(s.state, 'disconnected');
  assert.match(errors[0], /Web Serial/);
});

// ---------------------------------------------------------------- watchdog

test('if the scale goes quiet, the port is reopened by itself', async () => {
  const s = simulatedScale({ silence: 300, retries: 1 });
  const states = [];
  const warnings = [];
  s.on('state', (e) => states.push(e.state));
  s.on('warning', (w) => warnings.push(w.type));
  await s.connect();
  await s.simulator.close();                     // the transport stops sending frames
  await sleep(1500);                             // > silence + watchdog
  assert.ok(warnings.includes('silence'), 'warns about the silence');
  assert.ok(states.includes('reconnecting'), 'goes into reconnection');
  await sleep(1400);                             // reconnection waits 1200 ms
  assert.equal(s.state, 'connected');
  assert.ok(s.simulator._timer, 'the transport sends frames again');
  await s.disconnect();
});

test('a pulled cable goes into reconnection', async () => {
  const s = simulatedScale({ interval: 20, retries: 1 });
  const states = [];
  s.on('state', (e) => states.push(e.state));
  await s.connect();
  s.simulator.drop();
  await sleep(50);
  assert.equal(s.state, 'reconnecting');
  await sleep(1400);
  assert.equal(s.state, 'connected');
  await s.disconnect();
});

test('a frame with no line break is processed anyway after the wait', async () => {
  const transport = new SimulatedTransport({ interval: 100000 });
  const s = new Scale({ transport, looseLine: 100 });
  const weights = [];
  s.on('weight', (w) => weights.push(w.kg));
  await s.connect();
  transport._onText('ST,GS,+   1.250 kg');       // no \r\n
  assert.deepEqual(weights, [], 'not processed right away without a line break');
  await sleep(1200);                             // the watchdog runs every second
  assert.deepEqual(weights, [1.25]);
  await s.disconnect();
});
