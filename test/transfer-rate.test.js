'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TransferRateMeter, formatTransferSpeed } = require('../renderer/app');

function fixture() {
  let now = 0;
  const meter = new TransferRateMeter(() => now);
  return {
    meter,
    time: value => { now = value; },
    observe: (status, transferred, id = 'transfer') => meter.observe([{ id, status, transferred }]),
  };
}

test('observed transfer rate excludes approval time and uses decimal megabytes', () => {
  const f = fixture();
  f.observe('waiting', 0);
  f.time(120000);
  assert.equal(f.meter.read('transfer'), null);
  f.observe('transferring', 0);
  f.time(121000);
  f.observe('transferring', 100000000);
  assert.equal(f.meter.read('transfer').bytesPerSecond, 100000000);
  assert.equal(f.meter.read('transfer').averageBytesPerSecond, 100000000);
  assert.equal(formatTransferSpeed(100000000), '100.0 MB/s');
});

test('stalled transfers decay to zero without another engine update', () => {
  const f = fixture();
  f.observe('transferring', 0);
  f.time(1000); f.observe('transferring', 100000000);
  f.time(3001);
  assert.equal(f.meter.read('transfer').bytesPerSecond, 0);
  assert.equal(formatTransferSpeed(f.meter.read('transfer').bytesPerSecond), '0.0 MB/s');
});

test('rolling rate follows recent bytes while the average covers the observed session', () => {
  const f = fixture();
  f.observe('transferring', 0);
  for (let second = 1; second <= 5; second++) {
    f.time(second * 1000);
    f.observe('transferring', second <= 3 ? second * 100000000 : 300000000 + (second - 3) * 20000000);
  }
  const measurement = f.meter.read('transfer');
  assert.equal(measurement.bytesPerSecond, 20000000);
  assert.equal(measurement.averageBytesPerSecond, 68000000);
});

test('completed, cancelled and failed measurements stop their clocks', () => {
  for (const status of ['completed', 'cancelled', 'failed']) {
    const f = fixture();
    f.observe('transferring', 0);
    f.time(1000); f.observe(status, 25000000);
    f.time(60000);
    const measurement = f.meter.read('transfer');
    assert.equal(measurement.status, status);
    assert.equal(measurement.elapsedMs, 1000);
    assert.equal(measurement.averageBytesPerSecond, 25000000);
  }
});

test('old history has no invented speed and opening midway counts only observed bytes', () => {
  const f = fixture();
  f.observe('completed', 1000000000);
  assert.equal(f.meter.read('transfer'), null);
  f.observe('transferring', 800000000);
  f.time(2000); f.observe('completed', 1000000000);
  assert.equal(f.meter.read('transfer').observedBytes, 200000000);
  assert.equal(f.meter.read('transfer').averageBytesPerSecond, 100000000);
});

test('empty and instant transfers never show infinite or invalid rates', () => {
  const f = fixture();
  f.observe('transferring', 0);
  f.observe('completed', 0);
  assert.equal(f.meter.read('transfer').averageBytesPerSecond, null);
  assert.equal(formatTransferSpeed(null), 'Measuring…');
  assert.equal(formatTransferSpeed(Infinity), 'Measuring…');
  assert.equal(formatTransferSpeed(NaN), 'Measuring…');
  const empty = fixture();
  empty.observe('transferring', 0);
  empty.time(1000); empty.observe('completed', 0);
  assert.equal(empty.meter.read('transfer').averageBytesPerSecond, 0);
});

test('a reset byte count restarts the measurement and discarded history is released', () => {
  const f = fixture();
  f.observe('transferring', 100000000);
  f.time(1000); f.observe('transferring', 0);
  f.time(2000); f.observe('transferring', 20000000);
  assert.equal(f.meter.read('transfer').averageBytesPerSecond, 20000000);
  f.meter.observe([]);
  assert.equal(f.meter.read('transfer'), null);
});

test('separate simultaneous transfers retain independent byte and time measurements', () => {
  const f = fixture();
  f.meter.observe([{ id: 'first', status: 'transferring', transferred: 0 }, { id: 'second', status: 'transferring', transferred: 0 }]);
  f.time(1000);
  f.meter.observe([{ id: 'first', status: 'transferring', transferred: 80000000 }, { id: 'second', status: 'transferring', transferred: 20000000 }]);
  assert.equal(f.meter.read('first').bytesPerSecond, 80000000);
  assert.equal(f.meter.read('second').bytesPerSecond, 20000000);
});
