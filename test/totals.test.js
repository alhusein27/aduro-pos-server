const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTotals } = require('../src/totals');

function sale(overrides) {
  return {
    id: 's1',
    attendant: 'Efua (Attendant A)',
    tender: 'cash',
    lines: [],
    totalPesewas: 1000,
    profitPesewas: 300,
    createdAt: '2026-11-08T08:00:00.000Z',
    ...overrides,
  };
}

test('empty list gives zeros', () => {
  const t = computeTotals([]);
  assert.equal(t.salesPesewas, 0);
  assert.equal(t.saleCount, 0);
  assert.deepEqual(t.byAttendant, {});
});

test('tenders split and profit sums from the sales', () => {
  const t = computeTotals([
    sale({ totalPesewas: 1000, profitPesewas: 300, tender: 'cash' }),
    sale({ id: 's2', totalPesewas: 2000, profitPesewas: 500, tender: 'momo' }),
    sale({ id: 's3', totalPesewas: 4000, profitPesewas: 900, tender: 'credit' }),
  ]);
  assert.equal(t.salesPesewas, 7000);
  assert.equal(t.cashPesewas, 1000);
  assert.equal(t.momoPesewas, 2000);
  assert.equal(t.creditPesewas, 4000);
  assert.equal(t.profitPesewas, 1700);
  assert.equal(t.saleCount, 3);
});

test('byAttendant splits the sales total', () => {
  const t = computeTotals([
    sale({ totalPesewas: 1000 }),
    sale({ id: 's2', totalPesewas: 2500, attendant: 'Kofi (Attendant B)' }),
    sale({ id: 's3', totalPesewas: 500 }),
  ]);
  assert.equal(t.byAttendant['Efua (Attendant A)'], 1500);
  assert.equal(t.byAttendant['Kofi (Attendant B)'], 2500);
});

test('bad shapes are ignored, not crashed on', () => {
  const t = computeTotals([null, { totalPesewas: 'x' }, sale({})]);
  assert.equal(t.saleCount, 2);
  assert.equal(t.salesPesewas, 1000);
});
