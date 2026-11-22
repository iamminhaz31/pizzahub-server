const express = require("express");
const { ObjectId } = require("mongodb");
const { connectDB } = require("../db");
const { verifyJWT, requireRole } = require("../middleware/auth");
const {
  CATEGORIES,
  ACTIVE_STATUSES,
  FREE_PLAN_LIMIT,
} = require("../constants/categories");
const { ORDER_STATUSES, ACTIVE_ORDER_STATUSES } = require("../constants/orders");

const router = express.Router();

// Every route in this file is for admins only, checked on the server for each request.
router.use(verifyJWT, requireRole("admin"));

const ROLES = ["vendor", "customer", "admin"];
const ITEM_STATUSES = ["pending", "approved", "rejected", "inactive"];
const SETTABLE_STATUSES = ["approved", "rejected", "inactive"];

const USER_FIELDS = {
  name: 1,
  email: 1,
  image: 1,
  role: 1,
  isBlocked: 1,
  businessName: 1,
  subscriptionPlan: 1,
  subscriptionExpiresAt: 1,
  createdAt: 1,
};

function parseObjectId(value) {
  return typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value)
    ? new ObjectId(value)
    : null;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toPositiveInt(value, fallback, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(number, max);
}

function pagination(page, limit, total) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

function isPremium(user) {
  if (!user || user.subscriptionPlan !== "premium") return false;
  if (!user.subscriptionExpiresAt) return true;
  return new Date(user.subscriptionExpiresAt) > new Date();
}

function shapeUser(user) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    image: user.image || null,
    role: user.role || "customer",
    isBlocked: user.isBlocked === true,
    businessName: user.businessName || null,
    subscriptionPlan: user.subscriptionPlan || "free",
    subscriptionExpiresAt: user.subscriptionExpiresAt || null,
    createdAt: user.createdAt || null,
  };
}

function shapeVendor(vendor) {
  if (!vendor) return null;
  return {
    _id: vendor._id,
    name: vendor.name,
    email: vendor.email,
    businessName: vendor.businessName || null,
  };
}

async function groupCounts(collection, field, keys) {
  const rows = await collection
    .aggregate([{ $group: { _id: `$${field}`, count: { $sum: 1 } } }])
    .toArray();
  const counts = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const row of rows) {
    if (row._id in counts) counts[row._id] = row.count;
  }
  return counts;
}

// GET /api/admin/overview
router.get("/overview", async (req, res, next) => {
  try {
    const db = await connectDB();
    const users = db.collection("users");
    const menuItems = db.collection("menuItems");
    const orders = db.collection("orders");
    const transactions = db.collection("transactions");

    const [
      totalUsers,
      totalVendors,
      totalCustomers,
      totalMenuItems,
      pendingMenuItems,
      totalTransactions,
      menuItemsByStatus,
      ordersByStatus,
      revenueRows,
    ] = await Promise.all([
      users.countDocuments({}),
      users.countDocuments({ role: "vendor" }),
      users.countDocuments({ role: "customer" }),
      menuItems.countDocuments({}),
      menuItems.countDocuments({ status: "pending" }),
      transactions.countDocuments({}),
      groupCounts(menuItems, "status", ITEM_STATUSES),
      groupCounts(orders, "status", ORDER_STATUSES),
      transactions
        .aggregate([
          { $match: { status: "paid" } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ])
        .toArray(),
    ]);

    res.json({
      totals: {
        users: totalUsers,
        vendors: totalVendors,
        customers: totalCustomers,
        menuItems: totalMenuItems,
        pendingMenuItems,
        transactions: totalTransactions,
        revenue: revenueRows[0]?.total ?? 0,
      },
      menuItemsByStatus,
      ordersByStatus,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users?search=&role=&page=&limit=
router.get("/users", async (req, res, next) => {
  try {
    const filter = {};
    const role = readText(req.query.role);
    if (ROLES.includes(role)) filter.role = role;

    const search = readText(req.query.search);
    if (search) {
      const pattern = { $regex: escapeRegex(search), $options: "i" };
      filter.$or = [{ name: pattern }, { email: pattern }];
    }

    const page = toPositiveInt(req.query.page, 1, 10000);
    const limit = toPositiveInt(req.query.limit, 10, 50);

    const db = await connectDB();
    const users = db.collection("users");
    const total = await users.countDocuments(filter);
    const rows = await users
      .find(filter, { projection: USER_FIELDS })
      .sort({ createdAt: -1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    res.json({ users: rows.map(shapeUser), pagination: pagination(page, limit, total) });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users/:id  (details with a few counts)
router.get("/users/:id", async (req, res, next) => {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid user ID." });

    const db = await connectDB();
    const user = await db.collection("users").findOne({ _id: id }, { projection: USER_FIELDS });
    if (!user) return res.status(404).json({ message: "User not found." });

    const shaped = shapeUser(user);
    const stats = {};
    if (shaped.role === "vendor") {
      stats.menuItems = await db.collection("menuItems").countDocuments({ vendorId: id });
      stats.ordersReceived = await db.collection("orders").countDocuments({ vendorId: id });
    } else if (shaped.role === "customer") {
      stats.ordersPlaced = await db.collection("orders").countDocuments({ customerId: id });
    }

    res.json({ user: shaped, stats });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id/block   Body: { "blocked": true | false }
// Blocking also deletes the user's existing login sessions.
router.patch("/users/:id/block", async (req, res, next) => {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid user ID." });

    const blocked = req.body && req.body.blocked;
    if (typeof blocked !== "boolean") {
      return res.status(400).json({ message: "blocked must be true or false." });
    }

    const db = await connectDB();
    const users = db.collection("users");
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ message: "User not found." });

    if (user.role === "admin" || id.toString() === req.user.id) {
      return res.status(403).json({ message: "Admin accounts cannot be blocked." });
    }

    await users.updateOne({ _id: id }, { $set: { isBlocked: blocked, updatedAt: new Date() } });

    let sessionsRemoved = 0;
    if (blocked) {
      // Better Auth may store the user id as an ObjectId or as text, so match both.
      const result = await db
        .collection("session")
        .deleteMany({ userId: { $in: [id, id.toString()] } });
      sessionsRemoved = result.deletedCount ?? 0;
    }

    res.json({
      message: blocked ? "User blocked." : "User unblocked.",
      user: shapeUser({ ...user, isBlocked: blocked }),
      sessionsRemoved,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/menu-items?search=&status=&category=&page=&limit=
router.get("/menu-items", async (req, res, next) => {
  try {
    const match = {};
    const status = readText(req.query.status);
    if (ITEM_STATUSES.includes(status)) match.status = status;
    const category = readText(req.query.category);
    if (CATEGORIES.includes(category)) match.category = category;

    const search = readText(req.query.search);
    const page = toPositiveInt(req.query.page, 1, 10000);
    const limit = toPositiveInt(req.query.limit, 12, 50);

    const pipeline = [
      { $match: match },
      { $lookup: { from: "users", localField: "vendorId", foreignField: "_id", as: "vendor" } },
      { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
    ];
    if (search) {
      const pattern = { $regex: escapeRegex(search), $options: "i" };
      pipeline.push({
        $match: {
          $or: [
            { itemName: pattern },
            { "vendor.name": pattern },
            { "vendor.email": pattern },
            { "vendor.businessName": pattern },
          ],
        },
      });
    }
    pipeline.push(
      { $sort: { createdAt: -1, _id: 1 } },
      {
        $facet: {
          items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
          total: [{ $count: "count" }],
        },
      }
    );

    const db = await connectDB();
    const menuItems = db.collection("menuItems");
    const [result] = await menuItems.aggregate(pipeline).toArray();
    const total = result.total[0]?.count ?? 0;
    const counts = await groupCounts(menuItems, "status", ITEM_STATUSES);

    res.json({
      items: result.items.map(({ vendor, ...item }) => ({ ...item, vendor: shapeVendor(vendor) })),
      counts: { ...counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0) },
      pagination: pagination(page, limit, total),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/menu-items/:id/status   Body: { "status": "approved" | "rejected" | "inactive" }
router.patch("/menu-items/:id/status", async (req, res, next) => {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid menu item ID." });

    const target = req.body && req.body.status;
    if (!SETTABLE_STATUSES.includes(target)) {
      return res.status(400).json({ message: "Status must be approved, rejected or inactive." });
    }

    const db = await connectDB();
    const menuItems = db.collection("menuItems");
    const item = await menuItems.findOne({ _id: id });
    if (!item) return res.status(404).json({ message: "Menu item not found." });

    if (item.status === target) {
      return res.json({ message: "No change needed.", item });
    }

    // Bringing back a rejected or inactive item uses one of the vendor's Free plan slots.
    if (target === "approved" && !ACTIVE_STATUSES.includes(item.status)) {
      const vendor = await db.collection("users").findOne({ _id: item.vendorId });
      if (vendor && !isPremium(vendor)) {
        const activeCount = await menuItems.countDocuments({
          vendorId: item.vendorId,
          status: { $in: ACTIVE_STATUSES },
          _id: { $ne: id },
        });
        if (activeCount >= FREE_PLAN_LIMIT) {
          return res.status(409).json({
            message: `This vendor is on the Free plan and already has ${FREE_PLAN_LIMIT} active items.`,
          });
        }
      }
    }

    const changes = { status: target, updatedAt: new Date() };
    await menuItems.updateOne({ _id: id }, { $set: changes });

    res.json({
      message:
        target === "approved"
          ? "Menu item approved."
          : target === "rejected"
            ? "Menu item rejected."
            : "Menu item set to inactive.",
      item: { ...item, ...changes },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/menu-items/:id
// Pending and accepted orders for the item are cancelled first, so no order is left hanging.
router.delete("/menu-items/:id", async (req, res, next) => {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid menu item ID." });

    const db = await connectDB();
    const menuItems = db.collection("menuItems");
    const item = await menuItems.findOne({ _id: id });
    if (!item) return res.status(404).json({ message: "Menu item not found." });

    const cancelled = await db
      .collection("orders")
      .updateMany(
        { itemId: id, status: { $in: ACTIVE_ORDER_STATUSES } },
        { $set: { status: "cancelled", updatedAt: new Date() } }
      );
    await menuItems.deleteOne({ _id: id });

    res.json({
      message: "Menu item deleted.",
      cancelledOrders: cancelled.modifiedCount ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/transactions?page=&limit=   (read only: there is no route that changes payments)
router.get("/transactions", async (req, res, next) => {
  try {
    const page = toPositiveInt(req.query.page, 1, 10000);
    const limit = toPositiveInt(req.query.limit, 15, 50);

    const db = await connectDB();
    const transactions = db.collection("transactions");
    const [result] = await transactions
      .aggregate([
        { $sort: { createdAt: -1, _id: 1 } },
        { $lookup: { from: "users", localField: "vendorId", foreignField: "_id", as: "vendor" } },
        { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
        {
          $facet: {
            items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
            total: [{ $count: "count" }],
          },
        },
      ])
      .toArray();
    const total = result.total[0]?.count ?? 0;

    res.json({
      transactions: result.items.map((doc) => ({
        _id: doc._id,
        vendor: shapeVendor(doc.vendor),
        plan: doc.plan,
        amount: doc.amount,
        currency: doc.currency,
        status: doc.status,
        stripeSessionId: doc.stripeSessionId || null,
        createdAt: doc.createdAt,
      })),
      pagination: pagination(page, limit, total),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;