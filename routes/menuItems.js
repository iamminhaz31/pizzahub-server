const express = require("express");
const { ObjectId } = require("mongodb");
const { connectDB } = require("../db");
const { verifyJWT, requireRole } = require("../middleware/auth");
const { validateMenuItem } = require("../validators/menuItem");
const { ACTIVE_STATUSES, FREE_PLAN_LIMIT } = require("../constants/categories");

const router = express.Router();

function isPremium(user) {
  if (user.subscriptionPlan !== "premium") return false;
  if (!user.subscriptionExpiresAt) return true;
  return new Date(user.subscriptionExpiresAt) > new Date();
}

// POST /api/menu-items  (vendor only)
// vendorId always comes from the verified token, never from the request body.
router.post("/", verifyJWT, requireRole("vendor"), async (req, res, next) => {
  try {
    const { errors, value } = validateMenuItem(req.body);
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ message: "Please fix the highlighted fields.", errors });
    }

    const db = await connectDB();
    const menuItems = db.collection("menuItems");
    const vendorId = new ObjectId(req.user.id);

    if (!isPremium(req.user)) {
      const activeCount = await menuItems.countDocuments({
        vendorId,
        status: { $in: ACTIVE_STATUSES },
      });
      if (activeCount >= FREE_PLAN_LIMIT) {
        return res.status(403).json({
          message: `Free plan allows up to ${FREE_PLAN_LIMIT} active menu items. Upgrade to Premium to add more.`,
          code: "PLAN_LIMIT_REACHED",
        });
      }
    }

    const doc = { vendorId, ...value, status: "pending", createdAt: new Date() };
    const result = await menuItems.insertOne(doc);

    res.status(201).json({
      message: "Menu item submitted. It will appear after admin approval.",
      item: { ...doc, _id: result.insertedId },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;