// Usage (from the pizzahub-server folder):
//   node scripts/make-admin.js admin@example.com
//
// Promotes an EXISTING user to admin. Admin accounts can never be created
// through the public sign up page, only by someone who has database access.
require("dotenv").config();

const dns = require("dns");
const { MongoClient } = require("mongodb");

// Local development fix: some ISPs block SRV DNS lookups used by mongodb+srv.
if (process.env.NODE_ENV !== "production") {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
}

async function main() {
  const email = (process.argv[2] || "").trim().toLowerCase();

  if (!email) {
    console.error("Usage: node scripts/make-admin.js <email>");
    process.exitCode = 1;
    return;
  }

  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error("MONGODB_URI is not defined. Check your .env file.");
    process.exitCode = 1;
    return;
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();

    const users = client
      .db(process.env.DB_NAME || "pizzahub")
      .collection("users");

    const user = await users.findOne({ email });

    if (!user) {
      console.error(
        `No user found with email ${email}. Sign up first, then run this script again.`
      );
      process.exitCode = 1;
      return;
    }

    if (user.role === "admin") {
      console.log(`${email} is already an admin.`);
      return;
    }

    await users.updateOne(
      { _id: user._id },
      {
        $set: { role: "admin", isBlocked: false },
        $unset: { businessName: "" },
      }
    );

    console.log(`Done. ${email} is now an admin.`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("Failed:", error.message);
  process.exitCode = 1;
});