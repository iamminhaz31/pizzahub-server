const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS_AHEAD = 30;

// Accepts only real calendar dates written as YYYY-MM-DD.
function parseDateOnly(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

// Validates and cleans the body of a new order (the item id is checked in the route).
// The server clock is UTC, so one day of tolerance is allowed for other time zones.
function validateOrder(body, now = new Date()) {
  const errors = {};
  const input = body && typeof body === "object" ? body : {};

  const deliveryDate = typeof input.deliveryDate === "string" ? input.deliveryDate.trim() : "";
  const parsed = parseDateOnly(deliveryDate);
  if (!parsed) {
    errors.deliveryDate = "Please choose a valid delivery date.";
  } else {
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (parsed.getTime() < todayUtc - DAY_MS || parsed.getTime() > todayUtc + MAX_DAYS_AHEAD * DAY_MS) {
      errors.deliveryDate = `Delivery date must be today or later, within the next ${MAX_DAYS_AHEAD} days.`;
    }
  }

  const deliveryAddress =
    typeof input.deliveryAddress === "string" ? input.deliveryAddress.trim() : "";
  if (deliveryAddress.length < 10 || deliveryAddress.length > 200) {
    errors.deliveryAddress = "Delivery address must be 10 to 200 characters.";
  }

  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (message.length > 500) {
    errors.message = "Additional message must be 500 characters or less.";
  }

  return { errors, value: { deliveryDate, deliveryAddress, message } };
}

module.exports = { validateOrder };