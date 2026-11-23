const express = require("express");
const { ObjectId } = require("mongodb");
const { connectDB } = require("../db");
const { verifyJWT } = require("../middleware/auth");

const router = express.Router();

// Only these fields can ever be changed through this route.
// Role, blocked status and subscription fields are never accepted.
const ALLOWED_FIELDS = [
  "name",
  "image",
  "businessName",
  "phone",
  "area",
  "address",
  "description",
];

// Bangladesh mobile numbers: 01XXXXXXXXX, optionally with +88 or 88 in front.
const PHONE_PATTERN = /^(?:\+?88)?01[3-9]\d{8}$/;

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Reads an optional text field. Empty text or null means "clear this value".
function readOptionalText(value, label, max) {
  if (value === null || value === undefined || value === "") {
    return { value: null };
  }

  if (typeof value !== "string") {
    return { error: `${label} must be text.` };
  }

  const text = value.trim();

  if (text === "") {
    return { value: null };
  }

  if (text.length > max) {
    return { error: `${label} must be at most ${max} characters.` };
  }

  return { value: text };
}

router.patch("/", verifyJWT, async (req, res, next) => {
  try {
    // Only customers and vendors can update their profiles.
    if (!["customer", "vendor"].includes(req.user.role)) {
      return res.status(403).json({
        message: "You cannot update this profile.",
      });
    }

    const body = req.body;

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({
        message: "Invalid profile data.",
      });
    }

    const submittedFields = Object.keys(body);

    if (submittedFields.length === 0) {
      return res.status(400).json({
        message: "Please provide at least one field to update.",
      });
    }

    // Reject fields that are not allowed to be updated.
    const invalidFields = submittedFields.filter(
      (field) => !ALLOWED_FIELDS.includes(field)
    );

    if (invalidFields.length > 0) {
      return res.status(400).json({
        message: "You cannot update restricted profile fields.",
        fields: invalidFields,
      });
    }

    const toSet = {};
    const toUnset = {};

    // Saves a cleaned value, or removes the field when it was cleared.
    function store(field, value) {
      if (value === null) {
        toUnset[field] = "";
      } else {
        toSet[field] = value;
      }
    }

    // Name (required when sent).
    if (has(body, "name")) {
      if (typeof body.name !== "string") {
        return res.status(400).json({ message: "Name must be a string." });
      }

      const name = body.name.trim();

      if (name.length < 2 || name.length > 80) {
        return res.status(400).json({
          message: "Name must be between 2 and 80 characters.",
        });
      }

      toSet.name = name;
    }

    // Profile image (HTTPS URL, or cleared).
    if (has(body, "image")) {
      if (body.image === null || body.image === "") {
        store("image", null);
      } else {
        if (typeof body.image !== "string" || body.image.length > 2048) {
          return res.status(400).json({ message: "Invalid profile image." });
        }

        try {
          const imageUrl = new URL(body.image);

          if (imageUrl.protocol !== "https:") {
            throw new Error("Invalid image protocol");
          }

          toSet.image = imageUrl.toString();
        } catch {
          return res.status(400).json({
            message: "Please provide a valid HTTPS image URL.",
          });
        }
      }
    }

    // Business name (vendors only, required when sent).
    if (has(body, "businessName")) {
      if (req.user.role !== "vendor") {
        return res.status(403).json({
          message: "Only vendors can update their business name.",
        });
      }

      if (typeof body.businessName !== "string") {
        return res.status(400).json({
          message: "Business name must be a string.",
        });
      }

      const businessName = body.businessName.trim();

      if (businessName.length < 2 || businessName.length > 80) {
        return res.status(400).json({
          message: "Business name must be between 2 and 80 characters.",
        });
      }

      toSet.businessName = businessName;
    }

    // Phone number (optional).
    if (has(body, "phone")) {
      const result = readOptionalText(body.phone, "Phone number", 20);

      if (result.error) {
        return res.status(400).json({ message: result.error });
      }

      if (result.value !== null) {
        const compact = result.value.replace(/[\s-]/g, "");

        if (!PHONE_PATTERN.test(compact)) {
          return res.status(400).json({
            message: "Please enter a valid Bangladesh phone number.",
          });
        }

        store("phone", compact);
      } else {
        store("phone", null);
      }
    }

    // Area / city (optional).
    if (has(body, "area")) {
      const result = readOptionalText(body.area, "Area", 80);

      if (result.error) {
        return res.status(400).json({ message: result.error });
      }

      store("area", result.value);
    }

    // Address (optional). For customers this is the default delivery
    // address, for vendors it is the restaurant address.
    if (has(body, "address")) {
      const result = readOptionalText(body.address, "Address", 200);

      if (result.error) {
        return res.status(400).json({ message: result.error });
      }

      store("address", result.value);
    }

    // Short description (vendors only, optional).
    if (has(body, "description")) {
      if (req.user.role !== "vendor") {
        return res.status(403).json({
          message: "Only vendors can add a restaurant description.",
        });
      }

      const result = readOptionalText(body.description, "Description", 300);

      if (result.error) {
        return res.status(400).json({ message: result.error });
      }

      store("description", result.value);
    }

    const updateDoc = {};

    if (Object.keys(toSet).length > 0) {
      updateDoc.$set = toSet;
    }

    if (Object.keys(toUnset).length > 0) {
      updateDoc.$unset = toUnset;
    }

    if (Object.keys(updateDoc).length === 0) {
      return res.status(400).json({
        message: "Please provide at least one field to update.",
      });
    }

    const db = await connectDB();

    const result = await db.collection("users").updateOne(
      {
        _id: new ObjectId(req.user.id),
        isBlocked: { $ne: true },
      },
      updateDoc
    );

    if (result.matchedCount === 0) {
      return res.status(403).json({
        message: "Profile update is not allowed.",
      });
    }

    // Return the updated profile from the database.
    const updatedUser = await db.collection("users").findOne(
      { _id: new ObjectId(req.user.id) },
      {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          businessName: 1,
          phone: 1,
          area: 1,
          address: 1,
          description: 1,
          subscriptionPlan: 1,
          subscriptionExpiresAt: 1,
        },
      }
    );

    if (!updatedUser) {
      return res.status(404).json({
        message: "User not found.",
      });
    }

    return res.status(200).json({
      message: "Profile updated successfully.",
      user: {
        id: updatedUser._id.toString(),
        name: updatedUser.name,
        email: updatedUser.email,
        image: updatedUser.image || null,
        role: updatedUser.role || "customer",
        businessName: updatedUser.businessName || null,
        phone: updatedUser.phone || null,
        area: updatedUser.area || null,
        address: updatedUser.address || null,
        description: updatedUser.description || null,
        subscriptionPlan: updatedUser.subscriptionPlan || "free",
        subscriptionExpiresAt: updatedUser.subscriptionExpiresAt || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;