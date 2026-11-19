const { MongoClient, ServerApiVersion } = require("mongodb");

let client;
let db;

async function connectDB() {
  if (db) {
    return db;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not defined");
  }

  client = new MongoClient(uri, {
    serverApi: {
      version: ServerApiVersion.v1,
      deprecationErrors: true,
    },
  });

  await client.connect();
  db = client.db(process.env.DB_NAME || "pizzahub");
  return db;
}

module.exports = { connectDB };