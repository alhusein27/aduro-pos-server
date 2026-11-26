// Dates in Ghana. The shop day follows the clock in Accra, so a sale
// made late at night Ghana time counts for that Ghana day, no matter
// what time the server clock says.

const accraFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Africa/Accra',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Returns the Accra calendar date of an ISO timestamp, as YYYY-MM-DD.
// Returns null when the timestamp cannot be read.
function accraDateOf(isoString) {
  const when = new Date(isoString);
  if (Number.isNaN(when.getTime())) return null;
  const parts = accraFormat.formatToParts(when);
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function accraToday() {
  return accraDateOf(new Date().toISOString());
}

// Adds whole calendar months to an ISO timestamp and returns an
// ISO timestamp. The day is clamped to the end of the month it
// lands in, so 31 January plus one month is 28 February, never
// 3 March. Returns null when the timestamp cannot be read.
function addMonths(isoString, months) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}

// The UTC range of one Accra calendar day, as ISO strings, so the
// database can filter sales by day instead of loading them all.
// Ghana keeps no daylight saving time and Accra is UTC+0, so an
// Accra day is exactly a UTC day. Returns null for a bad date.
function accraDayRange(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
  const start = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  if (accraDateOf(start.toISOString()) !== date) return null;
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

module.exports = { accraDateOf, accraToday, accraDayRange, addMonths };
