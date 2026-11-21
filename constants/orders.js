const ORDER_STATUSES = ["pending", "accepted", "rejected", "cancelled"];

// Orders in these statuses are still "alive": they block duplicates and
// they stop a vendor from deleting the menu item.
const ACTIVE_ORDER_STATUSES = ["pending", "accepted"];

module.exports = { ORDER_STATUSES, ACTIVE_ORDER_STATUSES };