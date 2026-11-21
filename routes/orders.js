const express = require("express");
const { ObjectId } = require("mongodb");
const { connectDB } = require("../db");
const { verifyJWT, requireRole } = require("../middleware/auth");
const { validateOrder } = require("../validators/order");
const { ORDER_STATUSES, ACTIVE_ORDER_STATUSES } = require("../constants/orders");

const router = express.Router();

const customerOnly = [verifyJWT, requireRole("customer")];
const vendorOnly = [verifyJWT, requireRole("vendor")];

function parseObjectId(value) {
  return typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value)
    ? new ObjectId(value)
    : null;
}

function readStatusFilter(query) {
  const status = typeof query.status === "string" ? query.status : "";
  return ORDER_STATUSES.includes(status) ? status : null;
}

// Order + its menu item + the other side (vendor for a customer, customer for a vendor).
function orderPipeline(match, otherField) {
  return [
    { $match: match },
    { $sort: { createdAt: -1, _id: 1 } },
    { $lookup: { from: "menuItems", localField: "itemId", foreignField: "_id", as: "item" } },
    { $unwind: { path: "$item", preserveNullAndEmptyArrays: true } },
    { $lookup: { from: "users", localField: otherField, foreignField: "_id", as: "other" } },
    { $unwind: { path: "$other", preserveNullAndEmptyArrays: true } },
  ];
}

function shapeItem(item) {
  if (!item) return null;
  return {
    _id: item._id,
    itemName: item.itemName,
    category: item.category,
    price: item.price,
    image: Array.isArray(item.images) ? item.images[0] ?? null : null,
  };
}

function shapeBase(doc) {
  return {
    _id: doc._id,
    itemId: doc.itemId,
    vendorId: doc.vendorId,
    customerId: doc.customerId,
    status: doc.status,
    deliveryDate: doc.deliveryDate,
    deliveryAddress: doc.deliveryAddress,
    message: doc.message,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt ?? null,
    item: shapeItem(doc.item),
  };
}

// What a customer may see about the vendor: name and picture only.
function shapeForCustomer(doc) {
  return {
    ...shapeBase(doc),
    vendor: doc.other
      ? { name: doc.other.businessName || doc.other.name, image: doc.other.image || null }
      : null,
  };
}

// A vendor needs the customer's contact info to deliver the order.
function shapeForVendor(doc) {
  return {
    ...shapeBase(doc),
    customer: doc.other
      ? { name: doc.other.name, email: doc.other.email, image: doc.other.image || null }
      : null,
  };
}

async function statusCounts(orders, match) {
  const rows = await orders
    .aggregate([{ $match: match }, { $group: { _id: "$status", count: { $sum: 1 } } }])
    .toArray();
  const counts = { total: 0, pending: 0, accepted: 0, rejected: 0, cancelled: 0 };
  for (const row of rows) {
    if (row._id in counts) counts[row._id] = row.count;
    counts.total += row.count;
  }
  return counts;
}

// POST /api/orders  (customer only)
// customerId comes from the token and vendorId from the menu item, never from the body.
router.post("/", ...customerOnly, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const itemId = parseObjectId(body.itemId);
    if (!itemId) {
      return res.status(400).json({ message: "Invalid menu item ID." });
    }

    const { errors, value } = validateOrder(body);
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ message: "Please fix the highlighted fields.", errors });
    }

    const db = await connectDB();

    const [item] = await db
      .collection("menuItems")
      .aggregate([
        { $match: { _id: itemId, status: "approved" } },
        { $lookup: { from: "users", localField: "vendorId", foreignField: "_id", as: "vendor" } },
        { $unwind: "$vendor" },
        { $match: { "vendor.isBlocked": { $ne: true } } },
        { $limit: 1 },
      ])
      .toArray();
    if (!item) {
      return res.status(404).json({ message: "This menu item is not available." });
    }

    if (item.vendorId.toString() === req.user.id) {
      return res.status(403).json({ message: "You cannot order your own menu item." });
    }

    const orders = db.collection("orders");
    const customerId = new ObjectId(req.user.id);

    const duplicate = await orders.findOne({
      customerId,
      itemId,
      deliveryDate: value.deliveryDate,
      status: { $in: ACTIVE_ORDER_STATUSES },
    });
    if (duplicate) {
      return res.status(409).json({
        message: "You already have an active order for this item on that date.",
      });
    }

    const doc = {
      itemId,
      vendorId: item.vendorId,
      customerId,
      ...value,
      status: "pending",
      createdAt: new Date(),
    };
    const result = await orders.insertOne(doc);

    res.status(201).json({
      message: "Order placed. The restaurant will review it soon.",
      order: { ...doc, _id: result.insertedId },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/mine?status=pending  (customer only, own orders)
router.get("/mine", ...customerOnly, async (req, res, next) => {
  try {
    const db = await connectDB();
    const orders = db.collection("orders");
    const customerId = new ObjectId(req.user.id);

    const match = { customerId };
    const status = readStatusFilter(req.query);
    if (status) match.status = status;

    const docs = await orders.aggregate(orderPipeline(match, "vendorId")).toArray();
    const counts = await statusCounts(orders, { customerId });

    res.json({ orders: docs.map(shapeForCustomer), counts });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/mine/:id  (customer only, own order)
router.get("/mine/:id", ...customerOnly, async (req, res, next) => {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid order ID." });

    const db = await connectDB();
    const [doc] = await db
      .collection("orders")
      .aggregate(orderPipeline({ _id: id }, "vendorId"))
      .toArray();

    if (!doc) return res.status(404).json({ message: "Order not found." });
    if (doc.customerId.toString() !== req.user.id) {
      return res.status(403).json({ message: "You can only view your own orders." });
    }

    res.json({ order: shapeForCustomer(doc) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/orders/mine/:id/cancel  (customer only, own pending order)
router.patch("/mine/:id/cancel", ...customerOnly, async (req, res, next) => {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid order ID." });

    const db = await connectDB();
    const orders = db.collection("orders");

    const order = await orders.findOne({ _id: id });
    if (!order) return res.status(404).json({ message: "Order not found." });
    if (order.customerId.toString() !== req.user.id) {
      return res.status(403).json({ message: "You can only cancel your own orders." });
    }
    if (order.status !== "pending") {
      return res.status(409).json({
        message: `Only pending orders can be cancelled. This order is already ${order.status}.`,
      });
    }

    // The status is part of the filter, so two requests at once cannot both win.
    const result = await orders.updateOne(
      { _id: id, customerId: order.customerId, status: "pending" },
      { $set: { status: "cancelled", updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) {
      return res.status(409).json({ message: "This order can no longer be cancelled." });
    }

    res.json({ message: "Order cancelled.", order: { ...order, status: "cancelled" } });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/vendor?status=pending  (vendor only, orders for own items)
router.get("/vendor", ...vendorOnly, async (req, res, next) => {
  try {
    const db = await connectDB();
    const orders = db.collection("orders");
    const vendorId = new ObjectId(req.user.id);

    const match = { vendorId };
    const status = readStatusFilter(req.query);
    if (status) match.status = status;

    const docs = await orders.aggregate(orderPipeline(match, "customerId")).toArray();
    const counts = await statusCounts(orders, { vendorId });

    res.json({ orders: docs.map(shapeForVendor), counts });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/orders/vendor/:id/status  (vendor only, own pending order, only once)
// Body: { "status": "accepted" | "rejected" }
router.patch("/vendor/:id/status", ...vendorOnly, async (req, res, next) => {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid order ID." });

    const target = req.body && req.body.status;
    if (target !== "accepted" && target !== "rejected") {
      return res.status(400).json({ message: "Status must be accepted or rejected." });
    }

    const db = await connectDB();
    const orders = db.collection("orders");

    const order = await orders.findOne({ _id: id });
    if (!order) return res.status(404).json({ message: "Order not found." });
    if (order.vendorId.toString() !== req.user.id) {
      return res.status(403).json({ message: "You can only manage orders for your own items." });
    }
    if (order.status !== "pending") {
      return res.status(409).json({
        message: `Only pending orders can be accepted or rejected. This order is already ${order.status}.`,
      });
    }

    const result = await orders.updateOne(
      { _id: id, vendorId: order.vendorId, status: "pending" },
      { $set: { status: target, updatedAt: new Date() } }
    );
    if (result.matchedCount === 0) {
      return res.status(409).json({ message: "This order was already updated." });
    }

    res.json({
      message: target === "accepted" ? "Order accepted." : "Order rejected.",
      order: { ...order, status: target },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;