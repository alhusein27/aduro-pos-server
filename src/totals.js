// The counting rules for Aduro POS. These are the same rules the
// app uses, so the numbers on the server match the numbers on the
// shop phone.
//
// Every recorded sale counts. Aduro POS has no approval step: a
// sale is final when it is recorded on the till.
// Sales total is the sum of totalPesewas over the sales.
// Cash, MoMo and credit totals are the sums per tender.
// Profit is the sum of profitPesewas the till worked out at the
// time of each sale, from its own split unit costs.
// byAttendant splits the sales total by the attendant name on
// each sale, so the owner sees who sold what.
//
// All money is whole pesewas. There are no pesewa fractions.

function amountOf(sale) {
  const value = Number(sale && sale.totalPesewas);
  return Number.isFinite(value) ? value : 0;
}

function profitOf(sale) {
  const value = Number(sale && sale.profitPesewas);
  return Number.isFinite(value) ? value : 0;
}

function computeTotals(sales) {
  const totals = {
    salesPesewas: 0,
    cashPesewas: 0,
    momoPesewas: 0,
    creditPesewas: 0,
    profitPesewas: 0,
    saleCount: 0,
    byAttendant: {},
  };
  for (const sale of sales || []) {
    if (!sale || typeof sale !== 'object') continue;
    const total = amountOf(sale);
    totals.salesPesewas += total;
    totals.profitPesewas += profitOf(sale);
    totals.saleCount += 1;
    if (sale.tender === 'cash') totals.cashPesewas += total;
    else if (sale.tender === 'momo') totals.momoPesewas += total;
    else if (sale.tender === 'credit') totals.creditPesewas += total;
    const attendant = sale.attendant || 'Unknown attendant';
    totals.byAttendant[attendant] = (totals.byAttendant[attendant] || 0) + total;
  }
  return totals;
}

module.exports = { computeTotals };
