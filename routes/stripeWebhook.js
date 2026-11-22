const { ObjectId } = require("mongodb");
const { connectDB } = require("../db");
const stripeUtils = require("../utils/stripe");

const DAY_MS = 24 * 60 * 60 * 1000;

function toObjectId(value) {
  return typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value)
    ? new ObjectId(value)
    : null;
}

function idOf(value) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id || null;
}

async function activatePremium(db, vendorId, expiresAt) {
  await db.collection("users").updateOne(
    { _id: vendorId },
    {
      $set: {
        subscriptionPlan: "premium",
        subscriptionExpiresAt: expiresAt,
        updatedAt: new Date(),
      },
    }
  );
}

async function onCheckoutCompleted(db, session) {
  if (session.mode !== "subscription" || session.payment_status !== "paid") return;

  const vendorId = toObjectId(session.metadata && session.metadata.vendorId);
  if (!vendorId) return;

  const transactions = db.collection("transactions");
  const subscriptionId = idOf(session.subscription);

  // Only the first delivery of this event can flip the status to "paid".
  const first = await transactions.updateOne(
    { stripeSessionId: session.id, status: { $ne: "paid" } },
    { $set: { status: "paid", stripeSubscriptionId: subscriptionId, paidAt: new Date() } }
  );

  if (first.matchedCount === 0) {
    const existing = await transactions.findOne({ stripeSessionId: session.id });
    if (existing) return; // already processed
    await transactions.insertOne({
      vendorId,
      plan: "premium",
      amount: (session.amount_total || 0) / 100,
      currency: session.currency || "usd",
      stripeSessionId: session.id,
      stripeSubscriptionId: subscriptionId,
      status: "paid",
      createdAt: new Date(),
    });
  }

  // Until the first renewal invoice arrives, Premium lasts one billing month plus a day.
  await activatePremium(db, vendorId, new Date(Date.now() + 31 * DAY_MS));
}

async function onInvoicePaid(db, invoice) {
  // The first invoice is already handled by checkout.session.completed.
  if (invoice.billing_reason !== "subscription_cycle") return;

  const subscriptionId = idOf(
    invoice.subscription ||
      (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription)
  );
  if (!subscriptionId) return;

  const transactions = db.collection("transactions");
  const known = await transactions.findOne({ stripeSubscriptionId: subscriptionId });
  if (!known) return;

  if (await transactions.findOne({ stripeInvoiceId: invoice.id })) return;

  await transactions.insertOne({
    vendorId: known.vendorId,
    plan: "premium",
    amount: (invoice.amount_paid || 0) / 100,
    currency: invoice.currency || "usd",
    stripeSessionId: null,
    stripeSubscriptionId: subscriptionId,
    stripeInvoiceId: invoice.id,
    status: "paid",
    createdAt: new Date(),
  });

  const periodEnd = invoice.lines && invoice.lines.data && invoice.lines.data[0] && invoice.lines.data[0].period
    ? invoice.lines.data[0].period.end
    : null;
  const expiresAt = periodEnd ? new Date(periodEnd * 1000) : new Date(Date.now() + 31 * DAY_MS);
  await activatePremium(db, known.vendorId, expiresAt);
}

async function onSubscriptionDeleted(db, subscription) {
  const known = await db.collection("transactions").findOne({ stripeSubscriptionId: subscription.id });
  if (!known) return;

  await db.collection("users").updateOne(
    { _id: known.vendorId },
    { $set: { subscriptionPlan: "free", subscriptionExpiresAt: new Date(), updatedAt: new Date() } }
  );
}

async function onCheckoutExpired(db, session) {
  await db.collection("transactions").updateOne(
    { stripeSessionId: session.id, status: "pending" },
    { $set: { status: "expired" } }
  );
}

// POST /api/payments/webhook
// Needs the raw request body, so index.js mounts it before express.json().
// Every event is checked with the Stripe signature before anything is saved.
async function handleStripeWebhook(req, res) {
  const signature = req.headers["stripe-signature"];
  if (!signature || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).json({ message: "Missing webhook signature." });
  }

  let event;
  try {
    event = stripeUtils
      .getStripe()
      .webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.status(400).json({ message: "Invalid webhook signature." });
  }

  try {
    const db = await connectDB();
    const object = event.data.object;

    switch (event.type) {
      case "checkout.session.completed":
        await onCheckoutCompleted(db, object);
        break;
      case "checkout.session.expired":
        await onCheckoutExpired(db, object);
        break;
      case "invoice.paid":
        await onInvoicePaid(db, object);
        break;
      case "customer.subscription.deleted":
        await onSubscriptionDeleted(db, object);
        break;
      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handling failed:", err.message);
    // A 500 makes Stripe send the event again later.
    res.status(500).json({ message: "Webhook handling failed." });
  }
}

module.exports = handleStripeWebhook;