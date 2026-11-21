const { createRemoteJWKSet, jwtVerify } = require("jose");
const { ObjectId } = require("mongodb");
const { connectDB } = require("../db");

let jwks;

function getAuthUrl() {
  const authUrl = process.env.AUTH_URL;

  if (!authUrl) {
    throw new Error("AUTH_URL is not defined");
  }

  return authUrl.replace(/\/$/, "");
}

// Public keys published by Better Auth. jose caches them in memory.
function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${getAuthUrl()}/api/auth/jwks`));
  }
  return jwks;
}

// Errors that mean "this token is not acceptable" (401).
// Anything else (for example the key server being unreachable) is a 503.
function isTokenProblem(error) {
  const code = error && error.code ? String(error.code) : "";

  return (
    code.startsWith("ERR_JWT_") ||
    code.startsWith("ERR_JWS_") ||
    code === "ERR_JWKS_NO_MATCHING_KEY" ||
    code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS" ||
    code === "ERR_JOSE_ALG_NOT_ALLOWED"
  );
}

async function verifyJWT(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res
        .status(401)
        .json({ message: "Unauthorized: access token is missing." });
    }

    const authUrl = getAuthUrl();
    let payload;

    try {
      const result = await jwtVerify(token, getJwks(), {
        issuer: authUrl,
        audience: authUrl,
        algorithms: ["EdDSA"],
      });
      payload = result.payload;
    } catch (error) {
      if (error && error.code === "ERR_JWT_EXPIRED") {
        return res
          .status(401)
          .json({ message: "Unauthorized: token has expired." });
      }

      if (isTokenProblem(error)) {
        return res
          .status(401)
          .json({ message: "Unauthorized: invalid token." });
      }

      console.error("Token verification failed:", error.message);
      return res
        .status(503)
        .json({ message: "Authentication service is unavailable." });
    }

    if (!payload.sub || !ObjectId.isValid(payload.sub)) {
      return res
        .status(401)
        .json({ message: "Unauthorized: invalid token." });
    }

    // Role and blocked status always come from the database,
    // never from the token or from anything the client sends.
    const db = await connectDB();
    const user = await db
      .collection("users")
      .findOne({ _id: new ObjectId(payload.sub) });

    if (!user) {
      return res
        .status(401)
        .json({ message: "Unauthorized: user not found." });
    }

    if (user.isBlocked) {
      return res
        .status(403)
        .json({ message: "Forbidden: your account has been blocked." });
    }

    req.user = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      image: user.image || null,
      role: user.role || "customer",
      businessName: user.businessName || null,
      subscriptionPlan: user.subscriptionPlan || "free",
      subscriptionExpiresAt: user.subscriptionExpiresAt || null,
    };

    next();
  } catch (error) {
    next(error);
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res
        .status(401)
        .json({ message: "Unauthorized: please sign in first." });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        message: "Forbidden: you do not have permission to access this resource.",
      });
    }

    next();
  };
}

module.exports = { verifyJWT, requireRole };