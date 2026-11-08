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

module.exports = { accraDateOf, accraToday };
