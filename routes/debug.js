const express = require("express");
const { verifyJWT, requireRole } = require("../middleware/auth");

const router = express.Router();

// Temporary routes used only to test the JWT and role middleware.
router.get("/vendor", verifyJWT, requireRole("vendor"), (req, res) => {
  res.json({ message: "Vendor access granted.", role: req.user.role });
});

router.get("/admin", verifyJWT, requireRole("admin"), (req, res) => {
  res.json({ message: "Admin access granted.", role: req.user.role });
});

module.exports = router;