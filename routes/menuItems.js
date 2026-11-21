const express = require("express");
const { ObjectId } = require("mongodb");
const { connectDB } = require("../db");
const { verifyJWT, requireRole } = require("../middleware/auth");
const { validateMenuItem } = require("../validators/menuItem");
const { ACTIVE_STATUSES, FREE_PLAN_LIMIT } = require("../constants/categories");

const router = express.Router();

const ALL_STATUSES = ["pending", "approved", "rejected", "inactive"];
const CONTENT_FIELDS = ["itemName", "category", "description", "price", "location", "images"];
const vendorOnly = [verifyJWT, requireRole("vendor")];

function isPremium(user) {
  if (user.subscriptionPlan !== "premium") return false;
  if (!user.subscriptionExpiresAt) return true;
  return new Date(user.subscriptionExpiresAt) > new Date();
}

function parseObjectId(value) {
  return typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value)
    ? new ObjectId(value)
    : null;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Counts the vendor's items that use up a Free plan slot.
function countActive(menuItems, vendorId, excludeId) {
  const filter = { vendorId, status: { $in: ACTIVE_STATUSES } };
  if (excludeId) filter._id = { $ne: excludeId };
  return menuItems.countDocuments(filter);
}

function planLimitResponse(res) {
  return res.status(403).json({
    message: `Free plan allows up to ${FREE_PLAN_LIMIT} active menu items. Upgrade to Premium to add more.`,
    code: "PLAN_LIMIT_REACHED",
  });
}

// Loads one item and makes sure it belongs to the logged-in vendor.
// Sends the error response itself and returns null when something is wrong.
async function loadOwnedItem(req, res, menuItems) {
  const id = parseObjectId(req.params.id);
  if (!id) {
    res.status(400).json({ message: "Invalid menu item ID." });
    return null;
  }
  const item = await menuItems.findOne({ _id: id });
  if (!item) {
    res.status(404).json({ message: "Menu item not found." });
    return null;
  }
  if (item.vendorId.toString() !== req.user.id) {
    res.status(403).json({ message: "You can only manage your own menu items." });
    return null;
  }
  return item;
}

// POST /api/menu-items  (vendor only)
// vendorId always comes from the verified token, never from the request body.
router.post("/", ...vendorOnly, async (req, res, next) => {
  try {
    const { errors, value } = validateMenuItem(req.body);
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ message: "Please fix the highlighted fields.", errors });
    }

    const db = await connectDB();
    const menuItems = db.collection("menuItems");
    const vendorId = new ObjectId(req.user.id);

    if (!isPremium(req.user)) {
      const activeCount = await countActive(menuItems, vendorId);
      if (activeCount >= FREE_PLAN_LIMIT) return planLimitResponse(res);
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

// GET /api/menu-items/mine?status=pending&search=margherita  (vendor only)
router.get("/mine", ...vendorOnly, async (req, res, next) => {
  try {
    const db = await connectDB();
    const menuItems = db.collection("menuItems");
    const vendorId = new ObjectId(req.user.id);

    const filter = { vendorId };
    const status = typeof req.query.status === "string" ? req.query.status : "";
    if (ALL_STATUSES.includes(status)) filter.status = status;

    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    if (search) filter.itemName = { $regex: escapeRegex(search), $options: "i" };

    const items = await menuItems.find(filter).sort({ createdAt: -1 }).toArray();

    const grouped = await menuItems
      .aggregate([{ $match: { vendorId } }, { $group: { _id: "$status", count: { $sum: 1 } } }])
      .toArray();
    const counts = { total: 0, pending: 0, approved: 0, rejected: 0, inactive: 0 };
    for (const row of grouped) {
      if (row._id in counts) counts[row._id] = row.count;
      counts.total += row.count;
    }

    res.json({
      items,
      counts,
      plan: {
        name: isPremium(req.user) ? "premium" : "free",
        maxActive: isPremium(req.user) ? null : FREE_PLAN_LIMIT,
        activeUsed: counts.pending + counts.approved,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/menu-items/mine/:id  (vendor only, own item)
router.get("/mine/:id", ...vendorOnly, async (req, res, next) => {
  try {
    const db = await connectDB();
    const item = await loadOwnedItem(req, res, db.collection("menuItems"));
    if (!item) return;
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

// PUT /api/menu-items/mine/:id  (vendor only, own item)
// If the content changes, the item goes back to "pending" for a new admin review.
router.put("/mine/:id", ...vendorOnly, async (req, res, next) => {
  try {
    const { errors, value } = validateMenuItem(req.body);
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ message: "Please fix the highlighted fields.", errors });
    }

    const db = await connectDB();
    const menuItems = db.collection("menuItems");
    const item = await loadOwnedItem(req, res, menuItems);
    if (!item) return;

    const changed = CONTENT_FIELDS.some(
      (field) => JSON.stringify(item[field]) !== JSON.stringify(value[field])
    );
    if (!changed) {
      return res.json({ message: "No changes to save.", item });
    }

    // A rejected or inactive item becomes "pending" (active) again, so it needs a free slot.
    const wasActive = ACTIVE_STATUSES.includes(item.status);
    if (!wasActive && !isPremium(req.user)) {
      const activeCount = await countActive(menuItems, item.vendorId, item._id);
      if (activeCount >= FREE_PLAN_LIMIT) return planLimitResponse(res);
    }

    const changes = { ...value, status: "pending", updatedAt: new Date() };
    await menuItems.updateOne(
      { _id: item._id, vendorId: item.vendorId },
      { $set: changes }
    );

    res.json({
      message: "Menu item updated. It will be reviewed again by an admin.",
      item: { ...item, ...changes },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/menu-items/mine/:id/availability  (vendor only, own item)
// Body: { "status": "approved" | "inactive" }
// Only approved <-> inactive. Pending and rejected items cannot be switched.
router.patch("/mine/:id/availability", ...vendorOnly, async (req, res, next) => {
  try {
    const target = req.body && req.body.status;
    if (target !== "approved" && target !== "inactive") {
      return res.status(400).json({ message: "Status must be approved or inactive." });
    }

    const db = await connectDB();
    const menuItems = db.collection("menuItems");
    const item = await loadOwnedItem(req, res, menuItems);
    if (!item) return;

    if (item.status === target) {
      return res.json({ message: "No change needed.", item });
    }
    if (item.status !== "approved" && item.status !== "inactive") {
      return res.status(409).json({
        message:
          "Only approved items can be paused or resumed. Pending items wait for admin review, and rejected items must be edited first.",
      });
    }

    if (target === "approved" && !isPremium(req.user)) {
      const activeCount = await countActive(menuItems, item.vendorId, item._id);
      if (activeCount >= FREE_PLAN_LIMIT) return planLimitResponse(res);
    }

    const changes = { status: target, updatedAt: new Date() };
    await menuItems.updateOne(
      { _id: item._id, vendorId: item.vendorId },
      { $set: changes }
    );

    res.json({
      message: target === "inactive" ? "Menu item paused." : "Menu item is available again.",
      item: { ...item, ...changes },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/menu-items/mine/:id  (vendor only, own item)
router.delete("/mine/:id", ...vendorOnly, async (req, res, next) => {
  try {
    const db = await connectDB();
    const menuItems = db.collection("menuItems");
    const item = await loadOwnedItem(req, res, menuItems);
    if (!item) return;

    await menuItems.deleteOne({ _id: item._id, vendorId: item.vendorId });
    res.json({ message: "Menu item deleted." });
  } catch (err) {
    next(err);
  }
});

module.exports = router;