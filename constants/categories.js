// Single source of truth for menu item categories (server side).
// The client keeps the same list in src/lib/menu-items.ts.
const CATEGORIES = [
  "Classic Pizzas",
  "Vegetarian Pizzas",
  "Meat Lovers",
  "Specialty / Gourmet Pizzas",
  "Sides & Appetizers",
  "Beverages & Desserts",
];

// Statuses that count toward the Free plan limit.
const ACTIVE_STATUSES = ["pending", "approved"];

const FREE_PLAN_LIMIT = 3;
const MAX_IMAGES = 5;

module.exports = { CATEGORIES, ACTIVE_STATUSES, FREE_PLAN_LIMIT, MAX_IMAGES };