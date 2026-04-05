const Cart = require('../models/Cart');
const Product = require('../models/Product');
const CompanyUser = require('../models/CompanyUser');

const parseQuantityValue = (value) => {
    const parsedValue = Number(value);

    if (!Number.isInteger(parsedValue) || parsedValue < 1) {
        return null;
    }

    return parsedValue;
};

const populateCart = async (cart) => {
    await cart.populate({
        path: 'items.product',
        select: 'productName sku brand price images category subCategory status approvalStatus',
        populate: [
            { path: 'category', select: 'name' },
            { path: 'subCategory', select: 'name' }
        ]
    });
};

const findOrCreateCart = async (req) => {
    let cart = await Cart.findOne({ user: req.user.id });

    if (!cart) {
        cart = new Cart({
            user: req.user.id,
            company: req.user.companyId,
            items: []
        });
    }

    return cart;
};

const validateCartProduct = async (productId) => {
    const product = await Product.findById(productId);

    if (!product) {
        return { error: 'Product not found', statusCode: 404 };
    }

    if (product.status !== 'active') {
        return { error: 'Product is not available', statusCode: 400 };
    }

    if (product.approvalStatus !== 'approved') {
        return { error: 'Product is not approved for ordering', statusCode: 400 };
    }

    return { product };
};

const addOrUpdateCartItem = (cart, productId, quantity, price) => {
    const existingItemIndex = cart.items.findIndex(
        item => item.product.toString() === productId.toString()
    );

    if (existingItemIndex > -1) {
        cart.items[existingItemIndex].quantity += quantity;
        cart.items[existingItemIndex].price = price;
    } else {
        cart.items.push({
            product: productId,
            quantity,
            price
        });
    }
};

// @desc    Get user's cart
// @route   GET /api/cart
// @access  Private/Company Users
exports.getCart = async (req, res) => {
    try {
        let cart = await Cart.findOne({ user: req.user.id })
            .populate({
                path: 'items.product',
                select: 'productName sku brand price images category subCategory status approvalStatus',
                populate: [
                    { path: 'category', select: 'name' },
                    { path: 'subCategory', select: 'name' }
                ]
            });

        if (!cart) {
            // Create empty cart if doesn't exist
            cart = await Cart.create({
                user: req.user.id,
                company: req.user.companyId,
                items: []
            });
        }

        res.status(200).json({
            success: true,
            data: cart
        });
    } catch (error) {
        console.error('Get cart error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Add product to cart
// @route   POST /api/cart/add
// @access  Private/Company Users
exports.addToCart = async (req, res) => {
    try {
        const { productId, quantity = 1 } = req.body;
        const parsedQuantity = parseQuantityValue(quantity);

        // Validate input
        if (!productId) {
            return res.status(400).json({
                success: false,
                message: 'Product ID is required'
            });
        }

        if (parsedQuantity === null) {
            return res.status(400).json({
                success: false,
                message: 'Quantity must be a whole number greater than or equal to 1'
            });
        }

        // Check if product exists and is approved
        const { product, error, statusCode } = await validateCartProduct(productId);
        if (error) {
            return res.status(statusCode).json({
                success: false,
                message: error
            });
        }

        // Find or create cart
        const cart = await findOrCreateCart(req);
        addOrUpdateCartItem(cart, productId, parsedQuantity, product.price);

        await cart.save();
        await populateCart(cart);

        res.status(200).json({
            success: true,
            message: 'Product added to cart successfully',
            data: cart
        });
    } catch (error) {
        console.error('Add to cart error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Add multiple products to cart in one request
// @route   POST /api/cart/add-bulk
// @access  Private/Company Users
exports.addBulkToCart = async (req, res) => {
    try {
        const { items } = req.body;

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Items array is required'
            });
        }

        const cart = await findOrCreateCart(req);
        const validationErrors = [];

        for (const item of items) {
            const productId = item?.productId;
            const parsedQuantity = parseQuantityValue(item?.quantity);

            if (!productId || parsedQuantity === null) {
                validationErrors.push({
                    productId: productId || null,
                    message: 'Each item must include a valid productId and quantity'
                });
                continue;
            }

            const { product, error } = await validateCartProduct(productId);
            if (error) {
                validationErrors.push({
                    productId,
                    message: error
                });
                continue;
            }

            addOrUpdateCartItem(cart, productId, parsedQuantity, product.price);
        }

        if (validationErrors.length === items.length) {
            return res.status(400).json({
                success: false,
                message: 'No valid products were added to cart',
                errors: validationErrors
            });
        }

        await cart.save();
        await populateCart(cart);

        res.status(200).json({
            success: true,
            message: 'Products added to cart successfully',
            data: cart,
            errors: validationErrors
        });
    } catch (error) {
        console.error('Bulk add to cart error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Remove product from cart
// @route   DELETE /api/cart/remove/:productId
// @access  Private/Company Users
exports.removeFromCart = async (req, res) => {
    try {
        const { productId } = req.params;

        const cart = await Cart.findOne({ user: req.user.id });

        if (!cart) {
            return res.status(404).json({
                success: false,
                message: 'Cart not found'
            });
        }

        // Filter out the product
        const initialLength = cart.items.length;
        cart.items = cart.items.filter(
            item => item.product.toString() !== productId
        );

        if (cart.items.length === initialLength) {
            return res.status(404).json({
                success: false,
                message: 'Product not found in cart'
            });
        }

        await cart.save();

        await populateCart(cart);

        res.status(200).json({
            success: true,
            message: 'Product removed from cart successfully',
            data: cart
        });
    } catch (error) {
        console.error('Remove from cart error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Update product quantity in cart (increment/decrement)
// @route   PATCH /api/cart/update/:productId
// @access  Private/Company Users
exports.updateCartItemQuantity = async (req, res) => {
    try {
        const { productId } = req.params;
        const { action, quantity } = req.body;

        // Validate action
        if (!action || !['increment', 'decrement', 'set'].includes(action)) {
            return res.status(400).json({
                success: false,
                message: 'Valid action is required (increment, decrement, or set)'
            });
        }

        const cart = await Cart.findOne({ user: req.user.id });

        if (!cart) {
            return res.status(404).json({
                success: false,
                message: 'Cart not found'
            });
        }

        // Find the item in cart
        const itemIndex = cart.items.findIndex(
            item => item.product.toString() === productId
        );

        if (itemIndex === -1) {
            return res.status(404).json({
                success: false,
                message: 'Product not found in cart'
            });
        }

        const parsedQuantity = quantity === undefined ? 1 : parseQuantityValue(quantity);
        if (parsedQuantity === null) {
            return res.status(400).json({
                success: false,
                message: 'Quantity must be a whole number greater than or equal to 1'
            });
        }

        // Update quantity based on action
        if (action === 'increment') {
            cart.items[itemIndex].quantity += parsedQuantity;
        } else if (action === 'decrement') {
            if (cart.items[itemIndex].quantity <= parsedQuantity) {
                // Remove item if quantity would be 0
                cart.items.splice(itemIndex, 1);
            } else {
                cart.items[itemIndex].quantity -= parsedQuantity;
            }
        } else if (action === 'set') {
            cart.items[itemIndex].quantity = parsedQuantity;
        }

        await cart.save();
        await populateCart(cart);

        res.status(200).json({
            success: true,
            message: 'Cart updated successfully',
            data: cart
        });
    } catch (error) {
        console.error('Update cart item quantity error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Clear entire cart
// @route   DELETE /api/cart/clear
// @access  Private/Company Users
exports.clearCart = async (req, res) => {
    try {
        const cart = await Cart.findOne({ user: req.user.id });

        if (!cart) {
            return res.status(404).json({
                success: false,
                message: 'Cart not found'
            });
        }

        cart.items = [];
        await cart.save();

        res.status(200).json({
            success: true,
            message: 'Cart cleared successfully',
            data: cart
        });
    } catch (error) {
        console.error('Clear cart error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

module.exports = exports;
