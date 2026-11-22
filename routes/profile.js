
const express = require("express");
const { ObjectId } = require("mongodb");
const { connectDB } = require("../db");
const { verifyJWT } = require("../middleware/auth");

const router = express.Router();

const ALLOWED_FIELDS = ["name", "image", "businessName"];

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

    if (submittedFields.length === 0) {
      return res.status(400).json({
        message: "Please provide at least one field to update.",
      });
    }

    const updates = {};

    // Update name.
    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      if (typeof body.name !== "string") {
        return res.status(400).json({
          message: "Name must be a string.",
        });
      }

      const name = body.name.trim();

      if (name.length < 2 || name.length > 80) {
        return res.status(400).json({
          message: "Name must be between 2 and 80 characters.",
        });
      }

      updates.name = name;
    }

    // Update profile image.
    if (Object.prototype.hasOwnProperty.call(body, "image")) {
      if (body.image === null || body.image === "") {
        updates.image = null;
      } else {
        if (typeof body.image !== "string" || body.image.length > 2048) {
          return res.status(400).json({
            message: "Invalid profile image.",
          });
        }

        try {
          const imageUrl = new URL(body.image);

          if (imageUrl.protocol !== "https:") {
            throw new Error("Invalid image protocol");
          }

          updates.image = imageUrl.toString();
        } catch {
          return res.status(400).json({
            message: "Please provide a valid HTTPS image URL.",
          });
        }
      }
    }

    // Only vendors can update businessName.
    if (
      Object.prototype.hasOwnProperty.call(body, "businessName")
    ) {
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
          message: "Business name must be between 2 and 100 characters.",
        });
      }

      updates.businessName = businessName;
    }

    const db = await connectDB();

    const result = await db.collection("users").updateOne(
      {
        _id: new ObjectId(req.user.id),
        isBlocked: { $ne: true },
      },
      {
        $set: updates,
      }
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
          subscriptionPlan: 1,
          subscriptionExpiresAt: 1,
          isBlocked: 1,
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
        subscriptionPlan: updatedUser.subscriptionPlan || "free",
        subscriptionExpiresAt: updatedUser.subscriptionExpiresAt || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
