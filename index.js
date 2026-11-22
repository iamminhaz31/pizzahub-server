const dns = require("dns");

// Local development fix: some ISPs block SRV DNS lookups used by mongodb+srv.
// Skipped in production (Vercel), where DNS works normally.
if (process.env.NODE_ENV !== "production") {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
}

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { connectDB } = require("./db");
const { verifyJWT } = require("./middleware/auth");

const app = express();
const port = process.env.PORT || 5000;

const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")
  .map((url) => url.trim().replace(/\/$/, ""));

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json" }),
  require("./routes/stripeWebhook")
);

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "PizzaHub API is running" });
});

app.get("/api/health", async (req, res) => {
  try {
    const db = await connectDB();
    await db.command({ ping: 1 });
    res.json({
      status: "ok",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Health check failed:", error.message);
    res.status(500).json({
      status: "error",
      database: "disconnected",
      message: "Database connection failed",
    });
  }
});

app.get("/api/me", verifyJWT, (req, res) => {
  res.json({ user: req.user });
});

app.use("/api/debug", require("./routes/debug"));
app.use("/api/menu-items", require("./routes/menuItems"));
app.use("/api/menu-items", require("./routes/browseMenu"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api/profile", require("./routes/profile"));

app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ message: err.message || "Internal server error" });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`PizzaHub server running on port ${port}`);
  });
}

module.exports = app;