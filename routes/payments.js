const express = require("express");
const { ObjectId } = require("mongodb");
const { connectDB } = require("../db");
const { verifyJWT, requireRole } = require("../middleware/auth");
const stripeUtils = require("../utils/stripe");

const router = express.Router();

const vendorOnly = [verifyJWT, requireRole("vendor")];

function isPremium(user) {
  if (user.subscriptionPlan !== "premium") return false;
  if (!user.subscriptionExpiresAt) return true;
  return new Date(user.subscriptionExpiresAt) > new Date();
}

// POST /api/payments/checkout  (vendor only)
// The vendor id comes from the verified token, so nobody can start a
// subscription for another vendor. Premium is NOT activated here: only the
// verified Stripe webhook does that.
router.post("/checkout", ...vendorOnly, async (req, res, next) => {
  try {
    if (isPremium(req.user)) {
      return res.status(409).json({ message: "You already have an active Premium plan." });
    }

    const { PREMIUM_PLAN } = stripeUtils;
    const stripe = stripeUtils.getStripe();
    const vendorId = req.user.id;
    const baseUrl = stripeUtils.pickClientUrl(req);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: PREMIUM_PLAN.currency,
            unit_amount: PREMIUM_PLAN.unitAmount,
            recurring: { interval: PREMIUM_PLAN.interval },
            product_data: {
              name: PREMIUM_PLAN.name,
              description: PREMIUM_PLAN.description,
            },
          },
        },
      ],
      client_reference_id: vendorId,
      metadata: { vendorId },
      subscription_data: { metadata: { vendorId } },
      success_url: `${baseUrl}/dashboard/vendor/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/dashboard/vendor/subscription/cancel`,
    });

    const db = await connectDB();
    await db.collection("transactions").insertOne({
      vendorId: new ObjectId(vendorId),
      plan: "premium",
      amount: PREMIUM_PLAN.amount,
      currency: PREMIUM_PLAN.currency,
      stripeSessionId: session.id,
      stripeSubscriptionId: null,
      status: "pending",
      createdAt: new Date(),
    });

    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/session/:id  (vendor only, own payment)
// The success page asks this to show the real status that the webhook saved.
router.get("/session/:id", ...vendorOnly, async (req, res, next) => {
  try {
    const sessionId = req.params.id;
    if (typeof sessionId !== "string" || !sessionId.startsWith("cs_") || sessionId.length > 200) {
      return res.status(400).json({ message: "Invalid payment session." });
    }

    const db = await connectDB();
    const transaction = await db.collection("transactions").findOne({ stripeSessionId: sessionId });
    if (!transaction) return res.status(404).json({ message: "Payment not found." });
    if (transaction.vendorId.toString() !== req.user.id) {
      return res.status(403).json({ message: "You can only view your own payments." });
    }

    res.json({
      status: transaction.status,
      plan: transaction.plan,
      amount: transaction.amount,
      currency: transaction.currency,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;