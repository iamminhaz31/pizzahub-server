const { CATEGORIES, MAX_IMAGES } = require("../constants/categories");

function isImgbbUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "ibb.co" || url.hostname.endsWith(".ibb.co"))
    );
  } catch {
    return false;
  }
}

// Validates and cleans the body of a menu item request.
// Returns { errors, value }. If errors is not empty, the request is invalid.
function validateMenuItem(body) {
  const errors = {};
  const input = body && typeof body === "object" ? body : {};

  const itemName = typeof input.itemName === "string" ? input.itemName.trim() : "";
  if (itemName.length < 2 || itemName.length > 80) {
    errors.itemName = "Item name must be 2 to 80 characters.";
  }

  const category = typeof input.category === "string" ? input.category : "";
  if (!CATEGORIES.includes(category)) {
    errors.category = "Please choose a valid category.";
  }

  const description =
    typeof input.description === "string" ? input.description.trim() : "";
  if (description.length < 10 || description.length > 1000) {
    errors.description = "Description must be 10 to 1000 characters.";
  }

  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0 || price > 100000) {
    errors.price = "Price must be a number greater than 0.";
  }

  const location = typeof input.location === "string" ? input.location.trim() : "";
  if (location.length < 2 || location.length > 100) {
    errors.location = "Location must be 2 to 100 characters.";
  }

  const images = Array.isArray(input.images) ? input.images : [];
  if (images.length < 1 || images.length > MAX_IMAGES) {
    errors.images = `Please add 1 to ${MAX_IMAGES} images.`;
  } else if (!images.every(isImgbbUrl)) {
    errors.images = "Images must be uploaded through the image uploader.";
  }

  return {
    errors,
    value: {
      itemName,
      category,
      description,
      price: Math.round(price * 100) / 100,
      location,
      images,
    },
  };
}

module.exports = { validateMenuItem };