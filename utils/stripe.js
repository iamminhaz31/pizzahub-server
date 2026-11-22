const Stripe = require("stripe");

let client;

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not defined");
  }
  if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY);
  return client;
}

// The price lives here on the server. The browser can never change it.
const PREMIUM_PLAN = {
  name: "PizzaHub Premium",
  description: "Unlimited menu items, Premium badge and featured homepage placement.",
  amount: 9.99,
  unitAmount: 999,
  currency: "usd",
  interval: "month",
};

// Success and cancel pages return to the site the vendor came from,
// but only if that site is one of the allowed client URLs.
function pickClientUrl(req) {
  const allowed = (process.env.CLIENT_URL || "http://localhost:3000")
    .split(",")
    .map((url) => url.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const origin = (req.headers.origin || "").replace(/\/$/, "");
  return allowed.includes(origin) ? origin : allowed[0];
}

module.exports = { getStripe, PREMIUM_PLAN, pickClientUrl };