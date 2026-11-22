const express = require("express");
const { ObjectId } = require("mongodb");
const { connectDB } = require("../db");
const { verifyJWT } = require("../middleware/auth");
const { CATEGORIES } = require("../constants/categories");

const router = express.Router();

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;
const MAX_SEARCH_TERMS = 5;

// "_id: 1" is a tie-breaker so pages never repeat or skip items.
const SORTS = {
  newest: { createdAt: -1, _id: 1 },
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: 1 },
};

// Only these fields are sent to the public. No email, no isBlocked, no role.
const PUBLIC_FIELDS = {
  itemName: 1,
  category: 1,
  description: 1,
  price: 1,
  location: 1,
  images: 1,
  createdAt: 1,
  vendorId: 1,
  "vendor._id": 1,
  "vendor.name": 1,
  "vendor.businessName": 1,
  "vendor.image": 1,
  "vendor.subscriptionPlan": 1,
  "vendor.subscriptionExpiresAt": 1,
};

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseObjectId(value) {
  return typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value)
    ? new ObjectId(value)
    : null;
}

function toPositiveInt(value, fallback, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(number, max);
}

function isPremiumVendor(vendor) {
  if (vendor.subscriptionPlan !== "premium") return false;
  if (!vendor.subscriptionExpiresAt) return true;
  return new Date(vendor.subscriptionExpiresAt) > new Date();
}

// Joins each item with its vendor and drops items of blocked (or missing) vendors.
function vendorStages() {
  return [
    {
      $lookup: {
        from: "users",
        localField: "vendorId",
        foreignField: "_id",
        as: "vendor",
      },
    },
    { $unwind: "$vendor" },
    { $match: { "vendor.isBlocked": { $ne: true } } },
  ];
}

function toPublicItem(doc) {
  const { vendor, ...item } = doc;
  return {
    ...item,
    vendor: {
      _id: vendor._id,
      name: vendor.name,
      businessName: vendor.businessName || null,
      image: vendor.image || null,
      isPremium: isPremiumVendor(vendor),
    },
  };
}

// GET /api/menu-items?search=&category=&location=&sort=&page=&limit=   (public)
//   search   words are split; every word must match the item name, description,
//            category, or the vendor name / business name
//   category one of the six categories
//   location exact location text (see /api/menu-items/locations)
//   sort     newest (default) | price_asc | price_desc
//   page     1, 2, 3 ...   limit  1 to 24 (default 12)
router.get("/", async (req, res, next) => {
  try {
    const category = typeof req.query.category === "string" ? req.query.category : "";
    if (category && !CATEGORIES.includes(category)) {
      return res.status(400).json({ message: "Invalid category." });
    }

    const location = typeof req.query.location === "string" ? req.query.location.trim() : "";
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const sortKey = typeof req.query.sort === "string" ? req.query.sort : "";
    const sort = Object.prototype.hasOwnProperty.call(SORTS, sortKey)
      ? SORTS[sortKey]
      : SORTS.newest;
    const page = toPositiveInt(req.query.page, 1, 10000);
    const limit = toPositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);

    const match = { status: "approved" };
    if (category) match.category = category;
    if (location) match.location = location;

    const pipeline = [{ $match: match }, ...vendorStages()];

    const terms = search
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, MAX_SEARCH_TERMS)
      .map(escapeRegex);
    if (terms.length > 0) {
      pipeline.push({
        $match: {
          $and: terms.map((term) => ({
            $or: [
              { itemName: { $regex: term, $options: "i" } },
              { description: { $regex: term, $options: "i" } },
              { category: { $regex: term, $options: "i" } },
              { "vendor.businessName": { $regex: term, $options: "i" } },
              { "vendor.name": { $regex: term, $options: "i" } },
            ],
          })),
        },
      });
    }

    pipeline.push(
      { $sort: sort },
      {
        $facet: {
          items: [
            { $skip: (page - 1) * limit },
            { $limit: limit },
            { $project: PUBLIC_FIELDS },
          ],
          total: [{ $count: "count" }],
        },
      }
    );

    const db = await connectDB();
    const [result] = await db.collection("menuItems").aggregate(pipeline).toArray();
    const total = result.total[0]?.count ?? 0;

    res.json({
      items: result.items.map(toPublicItem),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/menu-items/locations   (public)
// Real locations of approved items, for the location filter dropdown.
router.get("/locations", async (req, res, next) => {
  try {
    const db = await connectDB();
    const rows = await db
      .collection("menuItems")
      .aggregate([
        { $match: { status: "approved" } },
        ...vendorStages(),
        { $group: { _id: "$location" } },
        { $sort: { _id: 1 } },
      ])
      .toArray();
    res.json({ locations: rows.map((row) => row._id) });
  } catch (err) {
    next(err);
  }
});

// GET /api/menu-items/featured?limit=6   (public)
// Items of Premium vendors come first, then the newest items.
router.get("/featured", async (req, res, next) => {
  try {
    const limit = toPositiveInt(req.query.limit, 6, 12);
    const now = new Date();

    const db = await connectDB();
    const rows = await db
      .collection("menuItems")
      .aggregate([
        { $match: { status: "approved" } },
        ...vendorStages(),
        {
          $addFields: {
            premiumRank: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$vendor.subscriptionPlan", "premium"] },
                    {
                      $or: [
                        { $eq: [{ $ifNull: ["$vendor.subscriptionExpiresAt", null] }, null] },
                        { $gt: ["$vendor.subscriptionExpiresAt", now] },
                      ],
                    },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
        { $sort: { premiumRank: -1, createdAt: -1, _id: 1 } },
        { $limit: limit },
        { $project: PUBLIC_FIELDS },
      ])
      .toArray();

    res.json({ items: rows.map(toPublicItem) });
  } catch (err) {
    next(err);
  }
});

// GET /api/menu-items/categories   (public)
// How many approved items each category has, for the homepage.
router.get("/categories", async (req, res, next) => {
  try {
    const db = await connectDB();
    const rows = await db
      .collection("menuItems")
      .aggregate([
        { $match: { status: "approved" } },
        ...vendorStages(),
        { $group: { _id: "$category", count: { $sum: 1 } } },
      ])
      .toArray();

    const counts = Object.fromEntries(rows.map((row) => [row._id, row.count]));
    res.json({
      categories: CATEGORIES.map((name) => ({ name, count: counts[name] ?? 0 })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/menu-items/:id   (any logged-in user)
// Only approved items of vendors who are not blocked can be opened.
router.get("/:id", verifyJWT, async (req, res, next) => {
  try {
    const id = parseObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({ message: "Invalid menu item ID." });
    }

    const db = await connectDB();
    const [doc] = await db
      .collection("menuItems")
      .aggregate([
        { $match: { _id: id, status: "approved" } },
        ...vendorStages(),
        { $project: PUBLIC_FIELDS },
        { $limit: 1 },
      ])
      .toArray();

    if (!doc) {
      return res.status(404).json({ message: "This menu item is not available." });
    }
    res.json({ item: toPublicItem(doc) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;