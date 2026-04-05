const Invoice = require('../models/Invoice');
const Order = require('../models/Order');
const DeliveryChallan = require('../models/DeliveryChallan');
const User = require('../models/User');
const CompanyUser = require('../models/CompanyUser');
const Product = require('../models/Product');
const getRazorpayInstance = require('../config/razorpay');
const { amountToWords } = require('../utils/numberToWords');

// @desc    Create invoice for an order
// @route   POST /api/invoices
// @access  Private/Admin only
exports.createInvoice = async (req, res) => {
    try {
        const razorpayInstance = getRazorpayInstance();
        const { orderId, notes } = req.body;

        // Check if user is admin or sub-admin
        if (req.user.role !== 'admin' && req.user.role !== 'sub-admin') {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Only admins and sub-admins can create invoices.'
            });
        }

        if (!orderId) {
            return res.status(400).json({
                success: false,
                message: 'Order ID is required'
            });
        }

        // Check if invoice already exists for this order
        const existingInvoice = await Invoice.findOne({ order: orderId });
        if (existingInvoice) {
            return res.status(400).json({
                success: false,
                message: 'Invoice already exists for this order',
                data: existingInvoice
            });
        }

        // Find the order and populate necessary details
        const order = await Order.findById(orderId)
            .populate('company', 'name email gstNumber panCard companyLocation')
            .populate('branch', 'branchName address city state')
            .populate('orderedBy', 'name email role')
            .populate('vendor', 'name email')
            .populate('items.product');

        if (!order) {
            return res.status(404).json({
                success: false,
                message: 'Order not found'
            });
        }

        // Check if order is vendor approved
        if (order.vendorApprovalStatus !== 'approved') {
            return res.status(400).json({
                success: false,
                message: 'Invoice can only be created for vendor-approved orders'
            });
        }

        // Check if delivery challan exists
        const deliveryChallan = await DeliveryChallan.findOne({ order: orderId });

        if (!deliveryChallan) {
            return res.status(400).json({
                success: false,
                message: 'Invoice can only be created after a Delivery Challan has been generated.'
            });
        }

        // Prepare invoice items (without adding extra GST)
        const invoiceItems = [];
        let subtotal = 0;
        let totalGst = 0;

        for (const orderItem of order.items) {
            const product = orderItem.product;
            
            // Get product details for HSN code and description
            const productDetails = await Product.findById(product._id);
            
            const itemSubtotal = orderItem.price * orderItem.quantity;
            const gstRate = productDetails?.gstSlab || 18; // Default 18% if not specified
            // Don't calculate GST separately - prices already include GST or no additional GST needed
            const gstAmount = 0;
            const totalWithGst = itemSubtotal;

            invoiceItems.push({
                product: product._id,
                productName: orderItem.productName,
                description: productDetails?.description || orderItem.productName,
                hsnCode: productDetails?.hsnCode || 'N/A',
                sku: orderItem.sku,
                quantity: orderItem.quantity,
                pricePerUnit: orderItem.price,
                totalPrice: itemSubtotal,
                gstRate: gstRate,
                gstAmount: gstAmount,
                totalWithGst: totalWithGst
            });

            subtotal += itemSubtotal;
            totalGst += gstAmount;
        }

        const grandTotal = subtotal; // No additional GST added

        // Create Razorpay order FIRST (before saving invoice)
        // Generate a temporary receipt ID for Razorpay
        const tempReceipt = `ORD-${orderId.slice(-8)}-${Date.now()}`;
        
        const razorpayOrder = await razorpayInstance.orders.create({
            amount: Math.round(grandTotal * 100), // Amount in paise
            currency: 'INR',
            receipt: tempReceipt,
            notes: {
                orderId: order._id.toString(),
                orderNumber: order.orderNumber,
                companyId: order.company._id.toString()
            }
        });

        // Now create invoice with Razorpay details included
        const invoice = await Invoice.create({
            order: orderId,
            deliveryChallan: deliveryChallan?._id,
            company: order.company._id,
            companyDetails: {
                name: order.company.name,
                gstNumber: order.company.gstNumber,
                panCard: order.company.panCard,
                location: order.company.companyLocation
            },
            branch: order.branch?._id,
            orderedBy: order.orderedBy._id,
            vendor: order.vendor._id,
            items: invoiceItems,
            subtotal: subtotal,
            totalGst: totalGst,
            grandTotal: grandTotal,
            amountInWords: amountToWords(grandTotal),
            paymentStatus: 'pending',
            payment: {
                razorpayOrderId: razorpayOrder.id,
                amount: grandTotal
            },
            createdBy: req.user.id,
            notes: notes
        });

        // Update Razorpay order notes with invoice number
        try {
            await razorpayInstance.orders.edit(razorpayOrder.id, {
                notes: {
                    invoiceId: invoice._id.toString(),
                    invoiceNumber: invoice.invoiceNumber,
                    orderId: order._id.toString(),
                    orderNumber: order.orderNumber,
                    companyId: order.company._id.toString()
                }
            });
        } catch (notesError) {
            console.log('Note: Could not update Razorpay order notes:', notesError.message);
            // Non-critical error, continue
        }

        // Mark the delivery challan as approved since the Admin has accepted it by creating an invoice
        deliveryChallan.status = 'approved';
        await deliveryChallan.save();

        // Populate invoice details
        await invoice.populate([
            { path: 'order', select: 'orderNumber status vendorApprovalStatus totalAmount' },
            { path: 'deliveryChallan', select: 'challanNumber status' },
            { path: 'company', select: 'name email gstNumber panCard companyLocation' },
            { path: 'branch', select: 'branchName address city state' },
            { path: 'orderedBy', select: 'name email role' },
            { path: 'vendor', select: 'name email vendorLocation' },
            { path: 'createdBy', select: 'name email' },
            { path: 'items.product', select: 'productName sku brand images' }
        ]);

        res.status(201).json({
            success: true,
            message: 'Invoice created successfully',
            data: {
                invoice,
                razorpayOrder: {
                    id: razorpayOrder.id,
                    amount: razorpayOrder.amount,
                    currency: razorpayOrder.currency,
                    keyId: process.env.RAZORPAY_KEY_ID
                }
            }
        });
    } catch (error) {
        console.error('Create invoice error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get invoice by ID
// @route   GET /api/invoices/:invoiceId
// @access  Private/Admin, Company Users (with authorization)
exports.getInvoiceById = async (req, res) => {
    try {
        const { invoiceId } = req.params;

        const invoice = await Invoice.findById(invoiceId)
            .populate('order', 'orderNumber status vendorApprovalStatus totalAmount createdAt')
            .populate('deliveryChallan', 'challanNumber status')
            .populate('company', 'name email gstNumber panCard companyLocation')
            .populate('branch', 'branchName address city state')
            .populate('orderedBy', 'name email role')
            .populate('vendor', 'name email vendorLocation')
            .populate('createdBy', 'name email')
            .populate('items.product', 'productName sku brand images');

        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: 'Invoice not found'
            });
        }

        // Check authorization
        let isAuthorized = false;

        // Check if user is admin or sub-admin
        if (!req.user.companyId) {
            const mainUser = await User.findById(req.user.id || req.user._id);
            if (mainUser && (mainUser.role === 'admin' || mainUser.role === 'sub-admin')) {
                isAuthorized = true;
            }
        } else {
            // Company user - check if they belong to the same company
            const companyUser = await CompanyUser.findById(req.user.id).populate('branch');
            
            if (companyUser && invoice.company._id.toString() === req.user.companyId) {
                // Check role-based access
                if (companyUser.role === 'super-admin') {
                    // Super admin can see all invoices from their company
                    isAuthorized = true;
                } else if (companyUser.role === 'company-admin') {
                    // Company admin can see invoices from their branch
                    if (companyUser.branch && invoice.branch && 
                        invoice.branch._id.toString() === companyUser.branch._id.toString()) {
                        isAuthorized = true;
                    }
                } else if (companyUser.role === 'user') {
                    // Regular user can only see their own invoices
                    if (invoice.orderedBy._id.toString() === req.user.id) {
                        isAuthorized = true;
                    }
                }
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({
                success: false,
                message: 'You are not authorized to view this invoice'
            });
        }

        res.status(200).json({
            success: true,
            data: invoice
        });
    } catch (error) {
        console.error('Get invoice by ID error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get invoice by order ID
// @route   GET /api/invoices/order/:orderId
// @access  Private/Admin, Company Users (with authorization)
exports.getInvoiceByOrderId = async (req, res) => {
    try {
        const { orderId } = req.params;

        const invoice = await Invoice.findOne({ order: orderId })
            .populate('order', 'orderNumber status vendorApprovalStatus totalAmount createdAt')
            .populate('deliveryChallan', 'challanNumber status')
            .populate('company', 'name email gstNumber panCard companyLocation')
            .populate('branch', 'branchName address city state')
            .populate('orderedBy', 'name email role')
            .populate('vendor', 'name email vendorLocation')
            .populate('createdBy', 'name email')
            .populate('items.product', 'productName sku brand images');

        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: 'Invoice not found for this order'
            });
        }

        // Check authorization (same as getInvoiceById)
        let isAuthorized = false;

        if (!req.user.companyId) {
            const mainUser = await User.findById(req.user.id || req.user._id);
            if (mainUser && (mainUser.role === 'admin' || mainUser.role === 'sub-admin')) {
                isAuthorized = true;
            }
        } else {
            const companyUser = await CompanyUser.findById(req.user.id).populate('branch');
            
            if (companyUser && invoice.company._id.toString() === req.user.companyId) {
                if (companyUser.role === 'super-admin') {
                    isAuthorized = true;
                } else if (companyUser.role === 'company-admin') {
                    if (companyUser.branch && invoice.branch && 
                        invoice.branch._id.toString() === companyUser.branch._id.toString()) {
                        isAuthorized = true;
                    }
                } else if (companyUser.role === 'user') {
                    if (invoice.orderedBy._id.toString() === req.user.id) {
                        isAuthorized = true;
                    }
                }
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({
                success: false,
                message: 'You are not authorized to view this invoice'
            });
        }

        res.status(200).json({
            success: true,
            data: invoice
        });
    } catch (error) {
        console.error('Get invoice by order ID error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get all invoices (with filters)
// @route   GET /api/invoices
// @access  Private/Admin, Company Users (role-based)
exports.getAllInvoices = async (req, res) => {
    try {
        const { status, paymentStatus, page = 1, limit = 10 } = req.query;

        let filter = {};
        let isAdmin = false;

        // Check if user is admin or sub-admin
        if (!req.user.companyId) {
            const mainUser = await User.findById(req.user.id || req.user._id);
            if (mainUser && (mainUser.role === 'admin' || mainUser.role === 'sub-admin')) {
                isAdmin = true;
                // Admin/Sub-admin can see all invoices - no company filter
            } else {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied'
                });
            }
        } else {
            // Company user - apply company and role-based filters
            const companyUser = await CompanyUser.findById(req.user.id).populate('branch');
            
            if (!companyUser) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            filter.company = req.user.companyId;

            if (companyUser.role === 'user') {
                // Regular user sees only their invoices
                filter.orderedBy = req.user.id;
            } else if (companyUser.role === 'company-admin') {
                // Company admin sees invoices from their branch
                if (companyUser.branch) {
                    filter.branch = companyUser.branch._id;
                }
            }
            // Super admin sees all invoices from their company (filter.company already set)
        }

        // Apply payment status filter if provided
        if (paymentStatus && ['pending', 'completed', 'failed'].includes(paymentStatus)) {
            filter.paymentStatus = paymentStatus;
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const totalInvoices = await Invoice.countDocuments(filter);

        const invoices = await Invoice.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .populate('order', 'orderNumber status vendorApprovalStatus totalAmount')
            .populate('deliveryChallan', 'challanNumber status')
            .populate('company', 'name email gstNumber panCard')
            .populate('branch', 'branchName address city state')
            .populate('orderedBy', 'name email role')
            .populate('vendor', 'name email')
            .populate('createdBy', 'name email');

        const totalPages = Math.ceil(totalInvoices / limitNum);

        res.status(200).json({
            success: true,
            count: invoices.length,
            totalInvoices,
            totalPages,
            currentPage: pageNum,
            userRole: isAdmin ? 'admin' : req.user.role,
            data: invoices,
            pagination: {
                page: pageNum,
                limit: limitNum,
                totalPages,
                totalRecords: totalInvoices,
                hasNextPage: pageNum < totalPages,
                hasPrevPage: pageNum > 1
            }
        });
    } catch (error) {
        console.error('Get all invoices error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Delete invoice (admin only - for cleanup)
// @route   DELETE /api/invoices/:invoiceId
// @access  Private/Admin only
exports.deleteInvoice = async (req, res) => {
    try {
        const { invoiceId } = req.params;

        // Check if user is admin or sub-admin
        if (req.user.role !== 'admin' && req.user.role !== 'sub-admin') {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Only admins and sub-admins can delete invoices.'
            });
        }

        const invoice = await Invoice.findById(invoiceId);

        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: 'Invoice not found'
            });
        }

        // Check if payment is completed
        if (invoice.paymentStatus === 'completed') {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete invoice with completed payment'
            });
        }

        await Invoice.findByIdAndDelete(invoiceId);

        res.status(200).json({
            success: true,
            message: 'Invoice deleted successfully'
        });
    } catch (error) {
        console.error('Delete invoice error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Verify invoice payment
// @route   POST /api/invoices/verify-payment
// @access  Private/Company Users
exports.verifyInvoicePayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, invoiceId } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !invoiceId) {
            return res.status(400).json({
                success: false,
                message: 'All payment details are required'
            });
        }

        // Find the invoice
        const invoice = await Invoice.findById(invoiceId);

        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: 'Invoice not found'
            });
        }

        // Verify the payment signature
        const crypto = require('crypto');
        const generatedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex');

        if (generatedSignature !== razorpay_signature) {
            invoice.paymentStatus = 'failed';
            await invoice.save();

            return res.status(400).json({
                success: false,
                message: 'Payment verification failed. Invalid signature.'
            });
        }

        // Payment verified successfully
        invoice.payment.razorpayPaymentId = razorpay_payment_id;
        invoice.payment.razorpaySignature = razorpay_signature;
        invoice.payment.paidAt = Date.now();
        invoice.paymentStatus = 'completed';
        await invoice.save();

        // Update order payment status
        const order = await Order.findById(invoice.order);
        if (order) {
            order.payment = {
                razorpayOrderId: razorpay_order_id,
                razorpayPaymentId: razorpay_payment_id,
                razorpaySignature: razorpay_signature,
                paymentStatus: 'completed',
                paidAt: Date.now(),
                amount: invoice.grandTotal
            };
            await order.save();
        }

        // Populate invoice details
        await invoice.populate([
            { path: 'order', select: 'orderNumber status' },
            { path: 'company', select: 'name email' },
            { path: 'orderedBy', select: 'name email' }
        ]);

        res.status(200).json({
            success: true,
            message: 'Payment verified successfully',
            data: invoice
        });
    } catch (error) {
        console.error('Verify invoice payment error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

module.exports = exports;
