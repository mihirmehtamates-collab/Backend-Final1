const express = require('express');
const router = express.Router();
const {
    getCart,
    addToCart,
    addBulkToCart,
    removeFromCart,
    updateCartItemQuantity,
    clearCart
} = require('../controllers/cartController');
const { protect, authorizeCompanyUser } = require('../middleware/authMiddleware');

// All routes are protected and require company user authentication
router.use(protect);
router.use(authorizeCompanyUser);

// @route   GET /api/cart
// @desc    Get user's cart
// @access  Private/Company Users
router.get('/', getCart);

// @route   POST /api/cart/add
// @desc    Add product to cart
// @access  Private/Company Users
router.post('/add', addToCart);

// @route   POST /api/cart/add-bulk
// @desc    Add multiple products to cart
// @access  Private/Company Users
router.post('/add-bulk', addBulkToCart);

// @route   PATCH /api/cart/update/:productId
// @desc    Update product quantity in cart
// @access  Private/Company Users
router.patch('/update/:productId', updateCartItemQuantity);

// @route   DELETE /api/cart/remove/:productId
// @desc    Remove product from cart
// @access  Private/Company Users
router.delete('/remove/:productId', removeFromCart);

// @route   DELETE /api/cart/clear
// @desc    Clear entire cart
// @access  Private/Company Users
router.delete('/clear', clearCart);

module.exports = router;
