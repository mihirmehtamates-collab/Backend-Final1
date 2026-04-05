const Order = require('../models/Order');
const OrderEscalation = require('../models/OrderEscalation');
const Cart = require('../models/Cart');
const CompanyUser = require('../models/CompanyUser');
const Product = require('../models/Product');
const getRazorpayInstance = require('../config/razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');

const calculateRequiredMonthlyLimit = (user, orderAmount) => {
    if (user.role === 'super-admin') {
        return null;
    }

    return Number((user.monthlySpent + orderAmount).toFixed(2));
};

// @desc    Place order from cart
// @route   POST /api/orders/place
// @access  Private/Company Users
exports.placeOrder = async (req, res) => {
    try {
        const { notes } = req.body;

        // Get user's cart
        const cart = await Cart.findOne({ user: req.user.id }).populate('items.product');

        if (!cart || cart.items.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Cart is empty'
            });
        }

        // Validate all products are still available
        for (const item of cart.items) {
            if (!item.product || item.product.status !== 'active' || item.product.approvalStatus !== 'approved') {
                return res.status(400).json({
                    success: false,
                    message: `Product ${item.product?.productName || 'Unknown'} is no longer available`
                });
            }
        }

        const orderAmount = cart.totalAmount;

        // Get fresh user data
        const user = await CompanyUser.findById(req.user.id);

        // Check if user can place order
        const limitCheck = await user.canPlaceOrder(orderAmount);

        if (limitCheck.needsLimit) {
            return res.status(403).json({
                success: false,
                message: 'You do not have a monthly limit set. Please contact your administrator.',
                needsEscalation: false
            });
        }

        if (!limitCheck.canOrder && limitCheck.exceedsLimit) {
            // User exceeds limit, needs escalation
            return res.status(403).json({
                success: false,
                message: 'Order amount exceeds your monthly limit. Please escalate this order.',
                needsEscalation: true,
                limitInfo: {
                    monthlyLimit: user.monthlyLimit,
                    monthlySpent: user.monthlySpent,
                    remainingLimit: limitCheck.remainingLimit,
                    orderAmount: orderAmount,
                    exceedsBy: orderAmount - limitCheck.remainingLimit
                }
            });
        }

        // Group cart items by vendor
        const itemsByVendor = {};
        for (const item of cart.items) {
            const vendorId = item.product.vendor.toString();
            if (!itemsByVendor[vendorId]) {
                itemsByVendor[vendorId] = [];
            }
            itemsByVendor[vendorId].push(item);
        }

        // Create separate orders for each vendor
        const createdOrders = [];
        
        for (const [vendorId, vendorItems] of Object.entries(itemsByVendor)) {
            // Calculate vendor-specific totals
            const vendorTotalAmount = vendorItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const vendorTotalItems = vendorItems.reduce((sum, item) => sum + item.quantity, 0);

            // Create order items for this vendor
            const orderItems = vendorItems.map(item => ({
                product: item.product._id,
                productName: item.product.productName,
                sku: item.product.sku,
                quantity: item.quantity,
                price: item.price,
                totalPrice: item.price * item.quantity
            }));

            // Create order in database - pending vendor approval
            const order = await Order.create({
                company: req.user.companyId,
                branch: user.branch,
                orderedBy: req.user.id,
                orderPlacedBy: req.user.id,
                vendor: vendorId,
                items: orderItems,
                totalAmount: vendorTotalAmount,
                totalItems: vendorTotalItems,
                status: 'pending',
                vendorApprovalStatus: 'pending',
                notes: notes
            });

            // Populate order details
            await order.populate([
                { path: 'orderedBy', select: 'name email role' },
                { path: 'orderPlacedBy', select: 'name email role' },
                { path: 'vendor', select: 'name email' },
                { path: 'items.product', select: 'productName sku brand images' }
            ]);

            createdOrders.push(order);
        }

        // Clear cart after orders are created
        cart.items = [];
        await cart.save();

        res.status(201).json({
            success: true,
            message: `${createdOrders.length} order(s) created successfully. Waiting for vendor approval.`,
            data: createdOrders,
            orderCount: createdOrders.length
        });
    } catch (error) {
        console.error('Place order error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Verify payment and complete order
// @route   POST /api/orders/verify-payment
// @access  Private/Company Users
exports.verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !orderId) {
            return res.status(400).json({
                success: false,
                message: 'Missing payment verification details'
            });
        }

        // Find the order
        const order = await Order.findById(orderId);

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        // Verify the payment signature
        const generatedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

        if (generatedSignature !== razorpay_signature) {
            // Payment verification failed
            order.payment.paymentStatus = 'failed';
            await order.save();

            return res.status(400).json({
                success: false,
                message: 'Payment verification failed. Invalid signature.'
            });
        }

        // Payment verified successfully
        order.payment.razorpayPaymentId = razorpay_payment_id;
        order.payment.razorpaySignature = razorpay_signature;
        order.payment.paymentStatus = 'completed';
        order.payment.paidAt = Date.now();
        await order.save();

        // Update monthly spent for the actual requester/order owner.
        const userToUpdate = await CompanyUser.findById(order.orderedBy);
        
        if (userToUpdate) {
            userToUpdate.monthlySpent += order.totalAmount;
            await userToUpdate.save();
        }

        // Clear cart
        await Cart.findOneAndUpdate(
            { user: order.orderedBy },
            { items: [] }
        );

        // Populate order details
        await order.populate([
            { path: 'orderedBy', select: 'name email role' },
            { path: 'orderPlacedBy', select: 'name email role' },
            { path: 'items.product', select: 'productName sku brand images' }
        ]);

        res.status(200).json({
            success: true,
            message: 'Payment verified successfully. Order placed and sent to admin for approval.',
            data: order
        });
    } catch (error) {
        console.error('Verify payment error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Check payment status
// @route   GET /api/orders/:orderId/payment-status
// @access  Private/All authenticated users
exports.checkPaymentStatus = async (req, res) => {
    try {
        const razorpayInstance = getRazorpayInstance();
        const { orderId } = req.params;
        const User = require('../models/User');

        const order = await Order.findById(orderId)
            .populate('company', 'name email companyLocation')
            .populate('branch', 'branchName address city state')
            .populate('vendor', 'name email')
            .populate('orderedBy', 'name email role branch')
            .populate('items.product', 'productName sku brand')
            .populate({
                path: 'orderedBy',
                populate: {
                    path: 'branch',
                    select: 'branchName address city state'
                }
            });

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        // Check authorization
        let isAdminMates = false;
        let isVendor = false;
        
        // Check if user is admin, sub-admin, or vendor
        if (!req.user.companyId) {
            const mainUser = await User.findById(req.user.id || req.user._id);
            if (mainUser && mainUser.role === 'admin') {
                isAdminMates = true;
            } else if (mainUser && mainUser.role === 'sub-admin') {
                isAdminMates = true;
                // Sub-admin can only see orders that have vendor involvement
                if (!order.vendor) {
                    return res.status(403).json({
                        success: false,
                        message: 'You do not have access to this order'
                    });
                }
            } else if (mainUser && mainUser.role === 'vendor') {
                isVendor = true;
                // Vendors can only check orders for their products
                if (order.vendor._id.toString() !== req.user.id) {
                    return res.status(403).json({
                        success: false,
                        message: 'You do not have access to this order'
                    });
                }
            }
        }

        // For company users, apply authorization checks
        if (!isAdminMates && !isVendor) {
            const companyUser = await CompanyUser.findById(req.user.id).populate('branch');
            
            if (!companyUser) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            // Check company match
            if (order.company._id.toString() !== req.user.companyId) {
                return res.status(403).json({
                    success: false,
                    message: 'You do not have access to this order'
                });
            }

            // Role-based access control
            if (companyUser.role === 'user') {
                // Regular users can check orders from their branch
                if (companyUser.branch && order.branch && order.branch._id.toString() !== companyUser.branch._id.toString()) {
                    return res.status(403).json({
                        success: false,
                        message: 'You do not have access to orders from other branches'
                    });
                }
            } else if (companyUser.role === 'company-admin') {
                // Company admin can only check orders from their branch
                if (companyUser.branch && order.branch && order.branch._id.toString() !== companyUser.branch._id.toString()) {
                    return res.status(403).json({
                        success: false,
                        message: 'You do not have access to orders from other branches'
                    });
                }
            }
            // super-admin can access all orders from their company (already checked above)
        }

        // Fetch payment details from Razorpay (optional, for additional verification)
        let razorpayPaymentDetails = null;
        if (order.payment.razorpayOrderId) {
            try {
                const razorpayOrder = await razorpayInstance.orders.fetch(order.payment.razorpayOrderId);
                razorpayPaymentDetails = {
                    status: razorpayOrder.status,
                    amount: razorpayOrder.amount,
                    amountPaid: razorpayOrder.amount_paid,
                    amountDue: razorpayOrder.amount_due
                };

                // Fetch payment details if payment ID exists
                if (order.payment.razorpayPaymentId) {
                    const payment = await razorpayInstance.payments.fetch(order.payment.razorpayPaymentId);
                    razorpayPaymentDetails.paymentMethod = payment.method;
                    razorpayPaymentDetails.paymentStatus = payment.status;
                }
            } catch (razorpayError) {
                console.error('Razorpay fetch error:', razorpayError);
            }
        }

        res.status(200).json({
            success: true,
            data: {
                orderId: order._id,
                orderNumber: order.orderNumber,
                totalAmount: order.totalAmount,
                company: order.company,
                branch: order.branch,
                orderedBy: order.orderedBy,
                vendor: order.vendor,
                vendorApprovalStatus: order.vendorApprovalStatus,
                vendorApprovedAt: order.vendorApprovedAt,
                vendorRejectionReason: order.vendorRejectionReason,
                payment: {
                    status: order.payment?.paymentStatus,
                    razorpayOrderId: order.payment?.razorpayOrderId,
                    razorpayPaymentId: order.payment?.razorpayPaymentId,
                    paidAt: order.payment?.paidAt,
                    amount: order.payment?.amount
                },
                razorpayDetails: razorpayPaymentDetails,
                orderStatus: order.status,
                createdAt: order.createdAt
            }
        });
    } catch (error) {
        console.error('Check payment status error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Create escalation request
// @route   POST /api/orders/escalate
// @access  Private/Company Users (user and company-admin only)
exports.createEscalation = async (req, res) => {
    try {
        const { reason } = req.body;

        if (!reason) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a reason for escalation'
            });
        }

        // Get user's cart
        const cart = await Cart.findOne({ user: req.user.id }).populate('items.product');

        if (!cart || cart.items.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Cart is empty'
            });
        }

        // Validate all products
        for (const item of cart.items) {
            if (!item.product || item.product.status !== 'active' || item.product.approvalStatus !== 'approved') {
                return res.status(400).json({
                    success: false,
                    message: `Product ${item.product?.productName || 'Unknown'} is no longer available`
                });
            }
        }

        const orderAmount = cart.totalAmount;
        const user = await CompanyUser.findById(req.user.id);

        // Determine escalation type and target
        let escalationType;
        let escalatedTo;

        if (user.role === 'user') {
            // User escalates to company-admin
            escalationType = 'user-to-admin';
            const companyAdmin = await CompanyUser.findOne({
                company: req.user.companyId,
                role: 'company-admin',
                isActive: true
            });

            if (!companyAdmin) {
                // If no company-admin, escalate to super-admin
                escalatedTo = await CompanyUser.findOne({
                    company: req.user.companyId,
                    role: 'super-admin',
                    isActive: true
                });
                escalationType = 'admin-to-superadmin';
            } else {
                escalatedTo = companyAdmin;
            }
        } else if (user.role === 'company-admin') {
            // Company admin escalates to super-admin
            escalationType = 'admin-to-superadmin';
            escalatedTo = await CompanyUser.findOne({
                company: req.user.companyId,
                role: 'super-admin',
                isActive: true
            });
        } else {
            return res.status(400).json({
                success: false,
                message: 'Super-admins do not need to escalate orders'
            });
        }

        if (!escalatedTo) {
            return res.status(404).json({
                success: false,
                message: 'No higher authority found to escalate to'
            });
        }

        // Create escalation items
        const escalationItems = cart.items.map(item => ({
            product: item.product._id,
            productName: item.product.productName,
            sku: item.product.sku,
            quantity: item.quantity,
            price: item.price,
            totalPrice: item.price * item.quantity
        }));

        // Create escalation request
        const escalation = await OrderEscalation.create({
            company: req.user.companyId,
            requestedBy: req.user.id,
            escalatedTo: escalatedTo._id,
            escalationType: escalationType,
            items: escalationItems,
            totalAmount: orderAmount,
            totalItems: cart.totalItems,
            requestReason: reason,
            status: 'pending',
            requesterLimit: {
                monthlyLimit: user.monthlyLimit,
                monthlySpent: user.monthlySpent,
                remainingLimit: user.monthlyLimit - user.monthlySpent
            }
        });

        // Populate escalation details
        await escalation.populate([
            { path: 'requestedBy', select: 'name email role monthlyLimit monthlySpent' },
            { path: 'items.product', select: 'productName sku brand images' }
        ]);

        // Create appropriate message based on escalation type
        let message;
        if (escalationType === 'user-to-admin') {
            message = 'Escalation made to company admin. Any company admin can review and approve.';
        } else {
            message = 'Escalation made to super admin. Any super admin can review and approve.';
        }

        res.status(201).json({
            success: true,
            message: message,
            data: escalation
        });
    } catch (error) {
        console.error('Create escalation error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get escalation requests (received by me)
// @route   GET /api/orders/escalations/received
// @access  Private/Company Admin, Super-Admin
exports.getReceivedEscalations = async (req, res) => {
    try {
        const { status, page = 1, limit = 10 } = req.query;

        // Build filter based on user role
        const filter = {
            company: req.user.companyId
        };

        // Company-admin sees all user escalations in their company
        if (req.user.role === 'company-admin') {
            filter.escalationType = 'user-to-admin';
        } 
        // Super-admin sees all admin escalations in their company
        else if (req.user.role === 'super-admin') {
            filter.escalationType = 'admin-to-superadmin';
        }

        if (status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
            filter.status = status;
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const totalEscalations = await OrderEscalation.countDocuments(filter);

        const escalations = await OrderEscalation.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .populate('requestedBy', 'name email role monthlyLimit monthlySpent')
            .populate('respondedBy', 'name email role')
            .populate('items.product', 'productName sku brand images price');

        const totalPages = Math.ceil(totalEscalations / limitNum);

        res.status(200).json({
            success: true,
            count: escalations.length,
            totalEscalations,
            totalPages,
            currentPage: pageNum,
            data: escalations,
            pagination: {
                page: pageNum,
                limit: limitNum,
                totalPages,
                totalRecords: totalEscalations,
                hasNextPage: pageNum < totalPages,
                hasPrevPage: pageNum > 1
            }
        });
    } catch (error) {
        console.error('Get received escalations error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get escalation requests (sent by me)
// @route   GET /api/orders/escalations/sent
// @access  Private/Company Users
exports.getSentEscalations = async (req, res) => {
    try {
        const { status, page = 1, limit = 10 } = req.query;

        const filter = {
            requestedBy: req.user.id
        };

        if (status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
            filter.status = status;
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const totalEscalations = await OrderEscalation.countDocuments(filter);

        const escalations = await OrderEscalation.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .populate('requestedBy', 'name email role')
            .populate('respondedBy', 'name email role')
            .populate('items.product', 'productName sku brand images price');

        const totalPages = Math.ceil(totalEscalations / limitNum);

        res.status(200).json({
            success: true,
            count: escalations.length,
            totalEscalations,
            totalPages,
            currentPage: pageNum,
            data: escalations,
            pagination: {
                page: pageNum,
                limit: limitNum,
                totalPages,
                totalRecords: totalEscalations,
                hasNextPage: pageNum < totalPages,
                hasPrevPage: pageNum > 1
            }
        });
    } catch (error) {
        console.error('Get sent escalations error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Approve escalation and place order
// @route   PUT /api/orders/escalations/:escalationId/approve
// @access  Private/Company Admin, Super-Admin
exports.approveEscalation = async (req, res) => {
    try {
        const { escalationId } = req.params;
        const { responseMessage, approvedMonthlyLimit } = req.body;

        const escalation = await OrderEscalation.findById(escalationId)
            .populate('requestedBy', 'name email role')
            .populate('items.product');

        if (!escalation) {
            return res.status(404).json({
                success: false,
                message: 'Escalation request not found'
            });
        }

        // Check authorization based on role and escalation type
        if (escalation.escalationType === 'user-to-admin' && req.user.role !== 'company-admin') {
            return res.status(403).json({
                success: false,
                message: 'Only company admins can approve user escalations'
            });
        }

        if (escalation.escalationType === 'admin-to-superadmin' && req.user.role !== 'super-admin') {
            return res.status(403).json({
                success: false,
                message: 'Only super admins can approve admin escalations'
            });
        }

        // Check if escalation is from the same company
        if (escalation.company.toString() !== req.user.companyId.toString()) {
            return res.status(403).json({
                success: false,
                message: 'You can only approve escalations from your company'
            });
        }

        if (escalation.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Escalation has already been ${escalation.status}`
            });
        }

        const orderAmount = escalation.totalAmount;

        // Get requester's branch
        const requester = await CompanyUser.findById(escalation.requestedBy._id);
        if (!requester) {
            return res.status(404).json({
                success: false,
                message: 'Escalation requester not found'
            });
        }

        await requester.checkAndResetMonthlySpending();

        const requiredMonthlyLimit = calculateRequiredMonthlyLimit(requester, orderAmount);
        const parsedApprovedMonthlyLimit = approvedMonthlyLimit === undefined || approvedMonthlyLimit === null || approvedMonthlyLimit === ''
            ? null
            : Number(approvedMonthlyLimit);

        if (parsedApprovedMonthlyLimit !== null && (!Number.isFinite(parsedApprovedMonthlyLimit) || parsedApprovedMonthlyLimit < 0)) {
            return res.status(400).json({
                success: false,
                message: 'Approved monthly limit must be a valid non-negative number'
            });
        }

        // Approval should extend the requester limit, not consume/check the approver's limit.
        if (requester.role !== 'super-admin') {
            const finalApprovedMonthlyLimit = parsedApprovedMonthlyLimit ?? requiredMonthlyLimit;

            if (finalApprovedMonthlyLimit < requiredMonthlyLimit) {
                return res.status(400).json({
                    success: false,
                    message: 'Approved monthly limit must be enough to cover the current monthly spend plus this order',
                    limitInfo: {
                        currentMonthlyLimit: requester.monthlyLimit,
                        monthlySpent: requester.monthlySpent,
                        orderAmount,
                        minimumRequiredLimit: requiredMonthlyLimit
                    }
                });
            }

            requester.monthlyLimit = finalApprovedMonthlyLimit;
            await requester.save();
        }

        // Validate products are still available
        for (const item of escalation.items) {
            if (!item.product || item.product.status !== 'active' || item.product.approvalStatus !== 'approved') {
                return res.status(400).json({
                    success: false,
                    message: `Product ${item.productName} is no longer available`
                });
            }
        }

        // Group escalation items by vendor
        const itemsByVendor = {};
        for (const item of escalation.items) {
            const vendorId = item.product.vendor.toString();
            if (!itemsByVendor[vendorId]) {
                itemsByVendor[vendorId] = [];
            }
            itemsByVendor[vendorId].push(item);
        }

        // Create separate orders for each vendor
        const createdOrders = [];
        
        for (const [vendorId, vendorItems] of Object.entries(itemsByVendor)) {
            // Calculate vendor-specific totals
            const vendorTotalAmount = vendorItems.reduce((sum, item) => sum + item.totalPrice, 0);
            const vendorTotalItems = vendorItems.reduce((sum, item) => sum + item.quantity, 0);

            // Create order - pending vendor approval
            const order = await Order.create({
                company: escalation.company,
                branch: requester.branch,
                orderedBy: escalation.requestedBy._id,
                orderPlacedBy: req.user.id,
                vendor: vendorId,
                items: vendorItems,
                totalAmount: vendorTotalAmount,
                totalItems: vendorTotalItems,
                status: 'pending',
                vendorApprovalStatus: 'pending',
                wasEscalated: true,
                escalationDetails: {
                    escalatedFrom: escalation.requestedBy._id,
                    escalatedTo: req.user.id,
                    escalationLevel: escalation.escalationType
                },
                notes: responseMessage
            });

            // Populate order details
            await order.populate([
                { path: 'orderedBy', select: 'name email role' },
                { path: 'orderPlacedBy', select: 'name email role' },
                { path: 'vendor', select: 'name email' },
                { path: 'items.product', select: 'productName sku brand images' }
            ]);

            createdOrders.push(order);
        }

        // Update escalation
        escalation.status = 'approved';
        escalation.responseMessage = responseMessage;
        escalation.respondedBy = req.user.id;
        escalation.respondedAt = Date.now();
        // Store the first order ID for backward compatibility
        escalation.order = createdOrders[0]._id;
        await escalation.save();

        // Clear cart after orders are created
        await Cart.findOneAndUpdate(
            { user: escalation.requestedBy._id },
            { items: [] }
        );

        // Note: Monthly spent will be updated after payment is completed

        res.status(200).json({
            success: true,
            message: `Escalation approved and ${createdOrders.length} order(s) created. Waiting for vendor approval.`,
            data: {
                escalation,
                orders: createdOrders,
                orderCount: createdOrders.length,
                requesterLimit: requester.role === 'super-admin' ? null : {
                    monthlyLimit: requester.monthlyLimit,
                    monthlySpent: requester.monthlySpent,
                    remainingLimit: requester.monthlyLimit - requester.monthlySpent
                }
            }
        });
    } catch (error) {
        console.error('Approve escalation error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Reject escalation
// @route   PUT /api/orders/escalations/:escalationId/reject
// @access  Private/Company Admin, Super-Admin
exports.rejectEscalation = async (req, res) => {
    try {
        const { escalationId } = req.params;
        const { responseMessage } = req.body;

        if (!responseMessage) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a reason for rejection'
            });
        }

        const escalation = await OrderEscalation.findById(escalationId)
            .populate('requestedBy', 'name email role');

        if (!escalation) {
            return res.status(404).json({
                success: false,
                message: 'Escalation request not found'
            });
        }

        // Check authorization based on role and escalation type
        if (escalation.escalationType === 'user-to-admin' && req.user.role !== 'company-admin') {
            return res.status(403).json({
                success: false,
                message: 'Only company admins can reject user escalations'
            });
        }

        if (escalation.escalationType === 'admin-to-superadmin' && req.user.role !== 'super-admin') {
            return res.status(403).json({
                success: false,
                message: 'Only super admins can reject admin escalations'
            });
        }

        // Check if escalation is from the same company
        if (escalation.company.toString() !== req.user.companyId.toString()) {
            return res.status(403).json({
                success: false,
                message: 'You can only reject escalations from your company'
            });
        }

        if (escalation.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Escalation has already been ${escalation.status}`
            });
        }

        // Update escalation
        escalation.status = 'rejected';
        escalation.responseMessage = responseMessage;
        escalation.respondedBy = req.user.id;
        escalation.respondedAt = Date.now();
        await escalation.save();

        res.status(200).json({
            success: true,
            message: 'Escalation rejected',
            data: escalation
        });
    } catch (error) {
        console.error('Reject escalation error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get all orders with filters
// @route   GET /api/orders
// @access  Private/All authenticated users
exports.getAllOrders = async (req, res) => {
    try {
        const { status, page = 1, limit = 10, orderedBy, paymentStatus, vendorApprovalStatus } = req.query;
        const User = require('../models/User');

        let filter = {};
        let isAdminMates = false;
        let isVendor = false;

        // Check if user is from Admin Mates (admin or sub-admin)
        if (!req.user.companyId) {
            // This is a main admin, sub-admin, or vendor (User model)
            const mainUser = await User.findById(req.user.id || req.user._id);
            if (mainUser && mainUser.role === 'admin') {
                isAdminMates = true;
                // Admin can see all orders from all companies
                // No company filter applied
            } else if (mainUser && mainUser.role === 'sub-admin') {
                isAdminMates = true;
                // Sub-admin can only see orders that have vendor involvement
                // Filter to show only orders with vendor (not direct company orders)
                filter.vendor = { $ne: null };
            } else if (mainUser && mainUser.role === 'vendor') {
                isVendor = true;
                // Vendor can only see orders for their products
                filter.vendor = req.user.id;
            }
        }

        // Role-based filtering for company users
        if (!isAdminMates && !isVendor) {
            const companyUser = await CompanyUser.findById(req.user.id).populate('branch');

            if (!companyUser) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            if (companyUser.role === 'user') {
                // Company user: Orders from their branch
                filter.company = req.user.companyId;
                if (companyUser.branch) {
                    filter.branch = companyUser.branch._id;
                }
            } else if (companyUser.role === 'company-admin') {
                // Company admin: Orders from their branch
                filter.company = req.user.companyId;
                if (companyUser.branch) {
                    filter.branch = companyUser.branch._id;
                } else {
                    return res.status(400).json({
                        success: false,
                        message: 'Company admin must be assigned to a branch'
                    });
                }
                // Optional filter by specific user
                if (orderedBy) {
                    filter.orderedBy = orderedBy;
                }
            } else if (companyUser.role === 'super-admin') {
                // Company super-admin: All orders from their company (all branches)
                filter.company = req.user.companyId;
                // Optional filters
                if (orderedBy) {
                    filter.orderedBy = orderedBy;
                }
            }
        }

        // Apply status filter if provided
        if (status) {
            filter.status = status;
        }

        // Apply payment status filter if provided
        if (paymentStatus) {
            filter['payment.paymentStatus'] = paymentStatus;
        }

        // Apply vendor approval status filter if provided
        if (vendorApprovalStatus) {
            filter.vendorApprovalStatus = vendorApprovalStatus;
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const totalOrders = await Order.countDocuments(filter);

        const orders = await Order.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .populate('company', 'name email companyLocation')
            .populate('branch', 'branchName address city state')
            .populate('vendor', 'name email')
            .populate('orderedBy', 'name email role branch')
            .populate('orderPlacedBy', 'name email role')
            .populate('approvedBy', 'name email')
            .populate('deliveryPartner', 'name phone vehicleType vehicleNumber email')
            .populate('deliveryAssignedBy', 'name email')
            .populate('items.product', 'productName sku brand images price category subCategory')
            .populate({
                path: 'orderedBy',
                populate: {
                    path: 'branch',
                    select: 'branchName address city state'
                }
            });

        const totalPages = Math.ceil(totalOrders / limitNum);

        res.status(200).json({
            success: true,
            count: orders.length,
            totalOrders,
            totalPages,
            currentPage: pageNum,
            userRole: isAdminMates ? 'admin-mates' : isVendor ? 'vendor' : req.user.role,
            data: orders,
            pagination: {
                page: pageNum,
                limit: limitNum,
                totalPages,
                totalRecords: totalOrders,
                hasNextPage: pageNum < totalPages,
                hasPrevPage: pageNum > 1
            }
        });
    } catch (error) {
        console.error('Get all orders error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get order by ID
// @route   GET /api/orders/:orderId
// @access  Private/All authenticated users
exports.getOrderById = async (req, res) => {
    try {
        const { orderId } = req.params;
        const User = require('../models/User');

        const order = await Order.findById(orderId)
            .populate('company', 'name email companyLocation')
            .populate('branch', 'branchName address city state')
            .populate('vendor', 'name email')
            .populate('orderedBy', 'name email role monthlyLimit monthlySpent branch')
            .populate('orderPlacedBy', 'name email role')
            .populate('approvedBy', 'name email')
            .populate('deliveryPartner', 'name phone vehicleType vehicleNumber email address')
            .populate('deliveryAssignedBy', 'name email')
            .populate('items.product', 'productName sku brand images price category subCategory')
            .populate('escalationDetails.escalatedFrom', 'name email role')
            .populate('escalationDetails.escalatedTo', 'name email role')
            .populate({
                path: 'orderedBy',
                populate: {
                    path: 'branch',
                    select: 'branchName address city state'
                }
            });

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        // Check authorization
        let isAdminMates = false;
        let isVendor = false;
        
        // Check if user is admin, sub-admin, or vendor
        if (!req.user.companyId) {
            const mainUser = await User.findById(req.user.id || req.user._id);
            if (mainUser && mainUser.role === 'admin') {
                isAdminMates = true;
            } else if (mainUser && mainUser.role === 'sub-admin') {
                isAdminMates = true;
                // Sub-admin can only see orders that have vendor involvement
                if (!order.vendor) {
                    return res.status(403).json({
                        success: false,
                        message: 'You do not have access to this order'
                    });
                }
            } else if (mainUser && mainUser.role === 'vendor') {
                isVendor = true;
                // Vendors can only see orders for their products
                if (order.vendor._id.toString() !== req.user.id) {
                    return res.status(403).json({
                        success: false,
                        message: 'You do not have access to this order'
                    });
                }
            }
        }

        // For company users, apply authorization checks
        if (!isAdminMates && !isVendor) {
            const companyUser = await CompanyUser.findById(req.user.id).populate('branch');
            
            if (!companyUser) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            // Check company match
            if (order.company._id.toString() !== req.user.companyId) {
                return res.status(403).json({
                    success: false,
                    message: 'You do not have access to this order'
                });
            }

            // Role-based access control
            if (companyUser.role === 'user') {
                // Regular users can see orders from their branch
                if (companyUser.branch && order.branch && order.branch._id.toString() !== companyUser.branch._id.toString()) {
                    return res.status(403).json({
                        success: false,
                        message: 'You do not have access to orders from other branches'
                    });
                }
            } else if (companyUser.role === 'company-admin') {
                // Company admin can only see orders from their branch
                if (companyUser.branch && order.branch && order.branch._id.toString() !== companyUser.branch._id.toString()) {
                    return res.status(403).json({
                        success: false,
                        message: 'You do not have access to orders from other branches'
                    });
                }
            }
            // super-admin can access all orders from their company (already checked above)
        }

        let responseData = order;

        // Mask data if requested by a vendor
        if (isVendor) {
            responseData = order.toObject ? order.toObject() : order;
            if (responseData.company) {
                responseData.company.name = "Confidential";
                responseData.company.email = "Confidential";
                if (responseData.company.companyLocation) responseData.company.companyLocation = "Confidential";
            }
            if (responseData.branch) {
                responseData.branch.branchName = "Confidential";
                responseData.branch.address = "Confidential";
                responseData.branch.city = "Confidential";
                responseData.branch.state = "Confidential";
            }
            if (responseData.orderedBy) {
                responseData.orderedBy.name = "Confidential";
                responseData.orderedBy.email = "Confidential";
            }
        }

        res.status(200).json({
            success: true,
            data: responseData
        });
    } catch (error) {
        console.error('Get order by ID error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get orders for vendor's products
// @route   GET /api/orders/vendor/my-orders
// @access  Private/Vendor
exports.getVendorOrders = async (req, res) => {
    try {
        const { status, vendorApprovalStatus, page = 1, limit = 10 } = req.query;

        // Check if user is a vendor or admin
        const isAdmin = ['admin', 'super-admin', 'sub-admin'].includes(req.user.role);
        if (req.user.role !== 'vendor' && !isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Only vendors and admins can access this endpoint.'
            });
        }

        // Build filter
        const filter = {
            vendor: req.user.id
        };

        if (status && ['pending', 'approved', 'rejected', 'processing', 'shipped', 'delivered', 'cancelled'].includes(status)) {
            filter.status = status;
        }

        if (vendorApprovalStatus && ['pending', 'approved', 'rejected'].includes(vendorApprovalStatus)) {
            filter.vendorApprovalStatus = vendorApprovalStatus;
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const totalOrders = await Order.countDocuments(filter);

        const orders = await Order.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .populate('company', 'name email companyLocation')
            .populate('branch', 'branchName address city state')
            .populate('orderedBy', 'name email role')
            .populate('orderPlacedBy', 'name email role')
            .populate('vendor', 'name email')
            .populate('items.product', 'productName sku brand images price');

        const totalPages = Math.ceil(totalOrders / limitNum);

        // Mask Company & Branch data to protect against client poaching (ONLY FOR VENDORS)
        const isVendor = req.user.role === 'vendor';
        const finalOrders = isVendor ? orders.map(order => {
            const orderObj = order.toObject ? order.toObject() : order;
            if (orderObj.company) {
                orderObj.company.name = "Confidential";
                orderObj.company.email = "Confidential";
                if (orderObj.company.companyLocation) orderObj.company.companyLocation = "Confidential";
            }
            if (orderObj.branch) {
                orderObj.branch.branchName = "Confidential";
                orderObj.branch.address = "Confidential";
                orderObj.branch.city = "Confidential";
                orderObj.branch.state = "Confidential";
            }
            if (orderObj.orderedBy) {
                orderObj.orderedBy.name = "Confidential";
                orderObj.orderedBy.email = "Confidential";
            }
            if (orderObj.orderPlacedBy) {
                orderObj.orderPlacedBy.name = "Confidential";
                orderObj.orderPlacedBy.email = "Confidential";
            }
            return orderObj;
        }) : orders;

        res.status(200).json({
            success: true,
            count: orders.length,
            totalOrders,
            totalPages,
            currentPage: pageNum,
            data: finalOrders,
            pagination: {
                page: pageNum,
                limit: limitNum,
                totalPages,
                totalRecords: totalOrders,
                hasNextPage: pageNum < totalPages,
                hasPrevPage: pageNum > 1
            }
        });
    } catch (error) {
        console.error('Get vendor orders error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Approve order and create payment
// @route   PUT /api/orders/vendor/:orderId/approve
// @access  Private/Vendor
exports.approveVendorOrder = async (req, res) => {
    try {
        const { orderId } = req.params;

        // Check if user is a vendor or admin
        const isAdmin = ['admin', 'super-admin', 'sub-admin'].includes(req.user.role);
        if (req.user.role !== 'vendor' && !isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Only vendors and admins can approve orders.'
            });
        }

        const order = await Order.findById(orderId)
            .populate('orderedBy', 'name email role')
            .populate('items.product');

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        // Check if this order belongs to this vendor (admins can bypass or approve their own)
        if (!isAdmin && order.vendor.toString() !== req.user.id) {
            return res.status(403).json({
                success: false,
                message: 'You are not authorized to approve this order'
            });
        }

        // Check if order is pending vendor approval
        if (order.vendorApprovalStatus !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Order has already been ${order.vendorApprovalStatus} by vendor`
            });
        }

        // Validate products are still available
        for (const item of order.items) {
            const product = await Product.findById(item.product._id);
            if (!product || product.status !== 'active' || product.approvalStatus !== 'approved') {
                return res.status(400).json({
                    success: false,
                    message: `Product ${item.productName} is no longer available`
                });
            }
        }

        // Update order - vendor approved
        order.vendorApprovalStatus = 'approved';
        order.vendorApprovedAt = Date.now();
        order.status = 'approved';
        await order.save();

        // Populate order details
        await order.populate([
            { path: 'company', select: 'name email companyLocation' },
            { path: 'branch', select: 'branchName address city state' },
            { path: 'orderedBy', select: 'name email role' },
            { path: 'orderPlacedBy', select: 'name email role' },
            { path: 'vendor', select: 'name email' },
            { path: 'items.product', select: 'productName sku brand images price' }
        ]);

        res.status(200).json({
            success: true,
            message: 'Order approved successfully.',
            data: order
        });
    } catch (error) {
        console.error('Approve vendor order error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Reject order
// @route   PUT /api/orders/vendor/:orderId/reject
// @access  Private/Vendor
exports.rejectVendorOrder = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { rejectionReason } = req.body;

        if (!rejectionReason) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a rejection reason'
            });
        }

        // Check if user is a vendor or admin
        const isAdmin = ['admin', 'super-admin', 'sub-admin'].includes(req.user.role);
        if (req.user.role !== 'vendor' && !isAdmin) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Only vendors and admins can reject orders.'
            });
        }

        // Validate ObjectId format
        if (!mongoose.Types.ObjectId.isValid(orderId)) {
            return res.status(404).json({
                success: false,
                message: 'Invalid order ID format'
            });
        }

        const order = await Order.findById(orderId);

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        // Check if this order belongs to this vendor (admins can bypass or reject their own)
        if (!isAdmin && order.vendor.toString() !== req.user.id) {
            return res.status(403).json({
                success: false,
                message: 'You are not authorized to reject this order'
            });
        }

        // Check if order is pending vendor approval
        if (order.vendorApprovalStatus !== 'pending') {
            return res.status(400).json({
                success: false,
                message: `Order has already been ${order.vendorApprovalStatus} by vendor`
            });
        }

        // Update order - vendor rejected
        order.vendorApprovalStatus = 'rejected';
        order.vendorRejectionReason = rejectionReason;
        order.status = 'rejected';
        await order.save();

        // Populate order details
        await order.populate([
            { path: 'company', select: 'name email companyLocation' },
            { path: 'branch', select: 'branchName address city state' },
            { path: 'orderedBy', select: 'name email role' },
            { path: 'orderPlacedBy', select: 'name email role' },
            { path: 'vendor', select: 'name email' },
            { path: 'items.product', select: 'productName sku brand images price' }
        ]);

        res.status(200).json({
            success: true,
            message: 'Order rejected successfully',
            data: order
        });
    } catch (error) {
        console.error('Reject vendor order error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Reject any order globally (Admin only)
// @route   PUT /api/orders/admin/:orderId/reject-order
// @access  Private/Admin, Sub-Admin
exports.adminRejectOrder = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { rejectionReason } = req.body;

        if (!rejectionReason) {
            return res.status(400).json({
                success: false,
                message: 'Please provide a rejection reason'
            });
        }

        const order = await Order.findById(orderId);

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        if (['delivered', 'cancelled', 'rejected'].includes(order.status)) {
            return res.status(400).json({
                success: false,
                message: `Order cannot be rejected because it is already ${order.status}`
            });
        }

        order.status = 'rejected';
        order.rejectionReason = rejectionReason;

        // Also update vendor status if it was pending
        if (order.vendorApprovalStatus === 'pending') {
            order.vendorApprovalStatus = 'rejected';
            order.vendorRejectionReason = `Rejected by Admin: ${rejectionReason}`;
        }

        await order.save();

        res.status(200).json({
            success: true,
            message: 'Order rejected successfully',
            data: order
        });
    } catch (error) {
        console.error('Admin reject order error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

module.exports = exports;
