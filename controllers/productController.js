const Product = require('../models/Product');
const Category = require('../models/Category');
const SubCategory = require('../models/SubCategory');
const Order = require('../models/Order'); // Required to aggregate revenue
const mongoose = require('mongoose');
const { uploadMultipleImagesToCloudinary, deleteMultipleImagesFromCloudinary } = require('../utils/imageUpload');

const ALLOWED_GST_SLABS = [0, 5, 12, 18, 28];

const parsePositiveNumber = (value) => {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
};

const calculateVendorGstBreakdown = (vendorPrice, gstSlab) => {
    const gstAmount = Number(((vendorPrice * gstSlab) / 100).toFixed(2));
    const priceWithGst = Number((vendorPrice + gstAmount).toFixed(2));

    return {
        vendorPrice: Number(vendorPrice.toFixed(2)),
        gstSlab: Number(gstSlab.toFixed(2)),
        gstAmount,
        priceWithGst
    };
};

// @desc    Create product (Vendor only)
// @route   POST /api/products
// @access  Private/Vendor
exports.createProduct = async (req, res) => {
    try {
        const {
            sku,
            brand,
            productName,
            description,
            vendorPrice,
            price,
            weight,
            dimensions,
            color,
            material,
            packSize,
            uom,
            gstSlab,
            hsnCode,
            categoryId,
            subCategoryId
        } = req.body;

        const vendorPriceInput = vendorPrice ?? price;

        // Validate required fields
        if (!sku || !brand || !productName || !description || vendorPriceInput === undefined || vendorPriceInput === null || vendorPriceInput === '' || gstSlab === undefined || gstSlab === null || gstSlab === '' || !hsnCode || !categoryId || !subCategoryId) {
            return res.status(400).json({
                success: false,
                message: 'Please provide all required fields'
            });
        }

        const vendorPriceNum = parsePositiveNumber(vendorPriceInput);
        if (vendorPriceNum === null || vendorPriceNum < 0) {
            return res.status(400).json({
                success: false,
                message: 'Vendor price must be a valid non-negative number'
            });
        }

        const gstSlabNum = parsePositiveNumber(gstSlab);
        if (gstSlabNum === null || !ALLOWED_GST_SLABS.includes(gstSlabNum)) {
            return res.status(400).json({
                success: false,
                message: `GST slab must be one of: ${ALLOWED_GST_SLABS.join(', ')}`
            });
        }

        // Validate category exists
        const category = await Category.findById(categoryId);
        if (!category) {
            return res.status(404).json({
                success: false,
                message: 'Category not found'
            });
        }

        // Validate sub-category exists and belongs to the category
        const subCategory = await SubCategory.findOne({ _id: subCategoryId, category: categoryId });
        if (!subCategory) {
            return res.status(404).json({
                success: false,
                message: 'Sub-category not found or does not belong to the selected category'
            });
        }

        // Check if SKU already exists
        const existingSKU = await Product.findOne({ sku: sku.toUpperCase() });
        if (existingSKU) {
            return res.status(400).json({
                success: false,
                message: 'Product with this SKU already exists'
            });
        }

        // Validate images
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Please upload at least one product image'
            });
        }

        // Upload images to Cloudinary
        let uploadedImages;
        try {
            uploadedImages = await uploadMultipleImagesToCloudinary(req.files);
        } catch (uploadError) {
            console.error('Image upload error:', uploadError);
            return res.status(500).json({
                success: false,
                message: 'Error uploading images. Please try again.'
            });
        }

        // Parse weight (JSON string to object)
        const weightData = typeof weight === 'string' ? JSON.parse(weight) : weight;
        
        // Parse dimensions (JSON string to object)
        const dimensionsData = typeof dimensions === 'string' ? JSON.parse(dimensions) : dimensions;

        // Calculate GST on the vendor base price
        const priceBreakdown = calculateVendorGstBreakdown(vendorPriceNum, gstSlabNum);

        // Allow Admin to provide a specific vendorId or leave blank for Admin-owned products
        let finalVendorId = req.user.id;
        let isAutoApproved = false;
        if (['admin', 'super-admin', 'sub-admin'].includes(req.user.role)) {
            finalVendorId = req.body.vendorId || req.user.id;
            // Auto-approve if the Admin is creating the product for their own direct store
            if (finalVendorId === req.user.id) {
                isAutoApproved = true;
            }
        }

        // Create product
        const product = await Product.create({
            vendor: finalVendorId,
            sku: sku.toUpperCase(),
            brand,
            productName,
            description,
            vendorPrice: priceBreakdown.vendorPrice,
            adminCut: 0,
            gstAmount: priceBreakdown.gstAmount,
            price: priceBreakdown.priceWithGst,
            weight: weightData,
            dimensions: dimensionsData,
            color,
            material,
            packSize,
            uom,
            gstSlab: priceBreakdown.gstSlab,
            hsnCode,
            images: uploadedImages,
            category: categoryId,
            subCategory: subCategoryId,
            status: 'active',
            approvalStatus: isAutoApproved ? 'approved' : 'pending',
            approvedBy: isAutoApproved ? req.user.id : undefined,
            approvedAt: isAutoApproved ? Date.now() : undefined
        });

        // Populate vendor and category details
        await product.populate([
            { path: 'vendor', select: 'name email' },
            { path: 'category', select: 'name' },
            { path: 'subCategory', select: 'name' }
        ]);

        res.status(201).json({
            success: true,
            message: 'Product created successfully and submitted for approval',
            data: product,
            priceBreakdown: {
                vendorPrice: priceBreakdown.vendorPrice,
                gstSlab: `${priceBreakdown.gstSlab}%`,
                gstAmount: priceBreakdown.gstAmount,
                priceWithGst: priceBreakdown.priceWithGst,
                adminCut: product.adminCut,
                finalPrice: product.price
            }
        });
    } catch (error) {
        console.error('Create product error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Update product (Vendor only - own products)
// @route   PUT /api/products/:productId
// @access  Private/Vendor
exports.updateProduct = async (req, res) => {
    try {
        const { productId } = req.params;
        const {
            brand,
            productName,
            description,
            vendorPrice,
            price,
            weight,
            dimensions,
            color,
            material,
            packSize,
            uom,
            gstSlab,
            hsnCode,
            categoryId,
            subCategoryId,
            removeImages // Array of publicIds to remove
        } = req.body;

        const vendorPriceInput = vendorPrice ?? price;

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(productId)) {
            return res.status(404).json({
                success: false,
                message: 'Invalid product ID format'
            });
        }

        // Find product
        const product = await Product.findById(productId);

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Check if vendor owns this product (Admins can bypass)
        const isAdmin = ['admin', 'super-admin', 'sub-admin'].includes(req.user.role);
        if (!isAdmin && product.vendor.toString() !== req.user.id) {
            return res.status(403).json({
                success: false,
                message: 'You are not authorized to update this product'
            });
        }

        // Handle image removal
        if (removeImages && Array.isArray(removeImages) && removeImages.length > 0) {
            try {
                await deleteMultipleImagesFromCloudinary(removeImages);
                product.images = product.images.filter(
                    img => !removeImages.includes(img.publicId)
                );
            } catch (deleteError) {
                console.error('Error deleting images:', deleteError);
            }
        }

        // Handle new image uploads
        if (req.files && req.files.length > 0) {
            try {
                const newImages = await uploadMultipleImagesToCloudinary(req.files);
                product.images.push(...newImages);
            } catch (uploadError) {
                console.error('Image upload error:', uploadError);
                return res.status(500).json({
                    success: false,
                    message: 'Error uploading new images'
                });
            }
        }

        // Ensure at least one image remains
        if (product.images.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Product must have at least one image'
            });
        }

        // Update fields
        if (brand) product.brand = brand;
        if (productName) product.productName = productName;
        if (description) product.description = description;
        if (vendorPriceInput !== undefined && vendorPriceInput !== null && vendorPriceInput !== '') {
            const parsedVendorPrice = parsePositiveNumber(vendorPriceInput);
            if (parsedVendorPrice === null || parsedVendorPrice < 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Vendor price must be a valid non-negative number'
                });
            }

            product.vendorPrice = parsedVendorPrice;
        }
        if (weight) product.weight = typeof weight === 'string' ? JSON.parse(weight) : weight;
        if (dimensions) product.dimensions = typeof dimensions === 'string' ? JSON.parse(dimensions) : dimensions;
        if (color) product.color = color;
        if (material) product.material = material;
        if (packSize) product.packSize = packSize;
        if (uom) product.uom = uom;
        if (gstSlab !== undefined && gstSlab !== null && gstSlab !== '') {
            const parsedGstSlab = parsePositiveNumber(gstSlab);
            if (parsedGstSlab === null || !ALLOWED_GST_SLABS.includes(parsedGstSlab)) {
                return res.status(400).json({
                    success: false,
                    message: `GST slab must be one of: ${ALLOWED_GST_SLABS.join(', ')}`
                });
            }

            product.gstSlab = parsedGstSlab;
        }
        if (hsnCode) product.hsnCode = hsnCode;
        
        // Update category and subCategory with validation
        if (categoryId || subCategoryId) {
            if (categoryId && subCategoryId) {
                // Validate category exists
                const category = await Category.findById(categoryId);
                if (!category) {
                    return res.status(404).json({
                        success: false,
                        message: 'Category not found'
                    });
                }

                // Validate sub-category exists and belongs to the category
                const subCategory = await SubCategory.findOne({ _id: subCategoryId, category: categoryId });
                if (!subCategory) {
                    return res.status(404).json({
                        success: false,
                        message: 'Sub-category not found or does not belong to the selected category'
                    });
                }

                product.category = categoryId;
                product.subCategory = subCategoryId;
            } else {
                return res.status(400).json({
                    success: false,
                    message: 'Both category and sub-category must be provided together'
                });
            }
        }

        // Reset approval status when product is updated by a vendor
        if (!isAdmin) {
            product.approvalStatus = 'pending';
            product.approvedBy = undefined;
            product.approvedAt = undefined;
            product.rejectionReason = undefined;
            product.adminCut = 0;
            product.adminGst = 0;
            product.adminGstAmount = 0;
        } else if (product.approvalStatus === 'pending' || product.approvalStatus === 'rejected') {
            // Auto-approve if admin explicitly updates a pending/rejected product
            product.approvalStatus = 'approved';
            product.approvedBy = req.user.id;
            product.approvedAt = Date.now();
            product.rejectionReason = undefined;
        }
        
        // Recalculate vendor GST and preserve admin charges on admin-updated approved products
        const priceBreakdown = calculateVendorGstBreakdown(product.vendorPrice, product.gstSlab);
        product.gstAmount = priceBreakdown.gstAmount;
        product.price = Number((priceBreakdown.priceWithGst + product.adminCut + product.adminGstAmount).toFixed(2));

        await product.save();
        await product.populate([
            { path: 'vendor', select: 'name email' },
            { path: 'category', select: 'name' },
            { path: 'subCategory', select: 'name' }
        ]);

        res.status(200).json({
            success: true,
            message: 'Product updated successfully and resubmitted for approval',
            data: product,
            priceBreakdown: {
                vendorPrice: priceBreakdown.vendorPrice,
                gstSlab: `${priceBreakdown.gstSlab}%`,
                gstAmount: priceBreakdown.gstAmount,
                priceWithGst: priceBreakdown.priceWithGst,
                adminCut: product.adminCut,
                adminGstAmount: product.adminGstAmount,
                finalPrice: product.price
            }
        });
    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Delete product (Vendor only - own products)
// @route   DELETE /api/products/:productId
// @access  Private/Vendor
exports.deleteProduct = async (req, res) => {
    try {
        const { productId } = req.params;

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(productId)) {
            return res.status(404).json({
                success: false,
                message: 'Invalid product ID format'
            });
        }

        const product = await Product.findById(productId);

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Check if vendor owns this product (Admins can bypass)
        const isAdmin = ['admin', 'super-admin', 'sub-admin'].includes(req.user.role);
        if (!isAdmin && product.vendor.toString() !== req.user.id) {
            return res.status(403).json({
                success: false,
                message: 'You are not authorized to delete this product'
            });
        }

        // Delete all images from Cloudinary
        if (product.images && product.images.length > 0) {
            try {
                const publicIds = product.images.map(img => img.publicId);
                await deleteMultipleImagesFromCloudinary(publicIds);
            } catch (deleteError) {
                console.error('Error deleting images:', deleteError);
            }
        }

        await product.deleteOne();

        res.status(200).json({
            success: true,
            message: 'Product deleted successfully'
        });
    } catch (error) {
        console.error('Delete product error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get all products with filters
// @route   GET /api/products?status=active&approvalStatus=approved&category=electronics&page=1&limit=10&search=laptop&sortBy=price
// @access  Public/Private (depends on user role)
exports.getAllProducts = async (req, res) => {
    try {
        const {
            status,
            approvalStatus,
            categoryId,
            subCategoryId,
            vendor,
            brand,
            minPrice,
            maxPrice,
            search,
            myProducts,
            page = 1,
            limit = 10,
            sortBy = 'price' // price, -price, createdAt, -createdAt
        } = req.query;

        // Build filter query
        const filter = {};

        // Role-based filtering with strict access control
        if (req.user) {
            if (req.user.role === 'vendor') {
                // Vendors ALWAYS see only their own products - cannot be overridden
                filter.vendor = req.user.id;
                
                // Vendors can filter by status and approvalStatus for their own products
                if (status && ['active', 'inactive'].includes(status)) {
                    filter.status = status;
                }
                if (approvalStatus && ['pending', 'approved', 'rejected'].includes(approvalStatus)) {
                    filter.approvalStatus = approvalStatus;
                }
            } else if (req.user.role === 'company' || ['super-admin', 'company-admin', 'user'].includes(req.user.role)) {
                // Companies and company users ALWAYS see only approved and active products - cannot be overridden
                filter.approvalStatus = 'approved';
                filter.status = 'active';
                
                // Companies and company users can filter by vendor for approved products
                if (vendor) {
                    filter.vendor = vendor;
                }
            } else if (req.user.role === 'admin' || req.user.role === 'sub-admin') {
                // Admins can apply all filters
                if (status && ['active', 'inactive'].includes(status)) {
                    filter.status = status;
                }
                if (approvalStatus && ['pending', 'approved', 'rejected'].includes(approvalStatus)) {
                    filter.approvalStatus = approvalStatus;
                }
                if (myProducts === 'true') {
                    filter.vendor = req.user.id;
                } else if (vendor) {
                    filter.vendor = vendor;
                }
            }
        } else {
            // Public access - only approved and active products
            filter.approvalStatus = 'approved';
            filter.status = 'active';
            
            // Public can filter by vendor for approved products
            if (vendor) {
                filter.vendor = vendor;
            }
        }

        // Common filters that all roles can use
        if (categoryId) {
            filter.category = categoryId;
        }

        if (subCategoryId) {
            filter.subCategory = subCategoryId;
        }

        if (brand) {
            filter.brand = { $regex: brand, $options: 'i' };
        }

        // Price range filter
        if (minPrice || maxPrice) {
            filter.price = {};
            if (minPrice) filter.price.$gte = Number(minPrice);
            if (maxPrice) filter.price.$lte = Number(maxPrice);
        }

        // Search filter
        if (search) {
            filter.$or = [
                { productName: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } },
                { brand: { $regex: search, $options: 'i' } },
                { sku: { $regex: search, $options: 'i' } }
            ];
        }

        // Pagination
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        // Get total count
        const totalProducts = await Product.countDocuments(filter);

        // Determine sort order
        let sortOption = {};
        if (sortBy === 'price') {
            sortOption = { price: 1 }; // Low to high
        } else if (sortBy === '-price') {
            sortOption = { price: -1 }; // High to low
        } else if (sortBy === 'createdAt') {
            sortOption = { createdAt: 1 }; // Oldest first
        } else if (sortBy === '-createdAt') {
            sortOption = { createdAt: -1 }; // Newest first
        } else {
            sortOption = { price: 1 }; // Default: price low to high
        }

        // Get products with pagination
        const products = await Product.find(filter)
            .sort(sortOption)
            .skip(skip)
            .limit(limitNum)
            .populate('vendor', 'name email vendorLocation gstNumber')
            .populate('category', 'name')
            .populate('subCategory', 'name')
            .populate('approvedBy', 'name email');

        // Calculate pagination info
        const totalPages = Math.ceil(totalProducts / limitNum);

        res.status(200).json({
            success: true,
            count: products.length,
            totalProducts,
            totalPages,
            currentPage: pageNum,
            data: products,
            pagination: {
                page: pageNum,
                limit: limitNum,
                totalPages,
                totalRecords: totalProducts,
                hasNextPage: pageNum < totalPages,
                hasPrevPage: pageNum > 1
            }
        });
    } catch (error) {
        console.error('Get products error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get logged in user's own products
// @route   GET /api/products/my-products
// @access  Private/Vendor, Admin, Sub-admin
exports.getMyProducts = async (req, res) => {
    try {
        const { status, approvalStatus, page = 1, limit = 10, search } = req.query;

        // Force filter to ONLY show products created by the logged-in user
        const filter = { vendor: req.user.id };

        if (status && ['active', 'inactive'].includes(status)) {
            filter.status = status;
        }
        if (approvalStatus && ['pending', 'approved', 'rejected'].includes(approvalStatus)) {
            filter.approvalStatus = approvalStatus;
        }
        if (search) {
            filter.$or = [
                { productName: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } },
                { brand: { $regex: search, $options: 'i' } },
                { sku: { $regex: search, $options: 'i' } }
            ];
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const totalProducts = await Product.countDocuments(filter);

        const products = await Product.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .populate('vendor', 'name email')
            .populate('category', 'name')
            .populate('subCategory', 'name')
            .populate('approvedBy', 'name email');

        const totalPages = Math.ceil(totalProducts / limitNum);

        res.status(200).json({
            success: true,
            count: products.length,
            totalProducts,
            totalPages,
            currentPage: pageNum,
            data: products,
            pagination: {
                page: pageNum,
                limit: limitNum,
                totalPages,
                totalRecords: totalProducts,
                hasNextPage: pageNum < totalPages,
                hasPrevPage: pageNum > 1
            }
        });
    } catch (error) {
        console.error('Get my products error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get single product by ID
// @route   GET /api/products/:productId
// @access  Public/Private
exports.getProductById = async (req, res) => {
    try {
        const { productId } = req.params;

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(productId)) {
            return res.status(404).json({
                success: false,
                message: 'Invalid product ID format'
            });
        }

        const product = await Product.findById(productId)
            .populate('vendor', 'name email vendorLocation gstNumber')
            .populate('category', 'name')
            .populate('subCategory', 'name')
            .populate('approvedBy', 'name email');

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Access control
        if (req.user) {
            if (req.user.role === 'vendor' && product.vendor._id.toString() !== req.user.id) {
                return res.status(403).json({
                    success: false,
                    message: 'Access denied'
                });
            }
            if ((req.user.role === 'company' || ['super-admin', 'company-admin', 'user'].includes(req.user.role)) && product.approvalStatus !== 'approved') {
                return res.status(403).json({
                    success: false,
                    message: 'Product not available'
                });
            }
        } else {
            // Public access - only approved products
            if (product.approvalStatus !== 'approved' || product.status !== 'active') {
                return res.status(404).json({
                    success: false,
                    message: 'Product not found'
                });
            }
        }

        res.status(200).json({
            success: true,
            data: product
        });
    } catch (error) {
        console.error('Get product error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Toggle product status (Vendor only - own products)
// @route   PUT /api/products/:productId/toggle-status
// @access  Private/Vendor
exports.toggleProductStatus = async (req, res) => {
    try {
        const { productId } = req.params;

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(productId)) {
            return res.status(404).json({
                success: false,
                message: 'Invalid product ID format'
            });
        }

        const product = await Product.findById(productId);

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Check if vendor owns this product (Admins can bypass)
        const isAdmin = ['admin', 'super-admin', 'sub-admin'].includes(req.user.role);
        if (!isAdmin && product.vendor.toString() !== req.user.id) {
            return res.status(403).json({
                success: false,
                message: 'You are not authorized to modify this product'
            });
        }

        // Toggle status
        product.status = product.status === 'active' ? 'inactive' : 'active';
        await product.save();

        res.status(200).json({
            success: true,
            message: `Product ${product.status === 'active' ? 'activated' : 'deactivated'} successfully`,
            data: {
                id: product._id,
                productName: product.productName,
                status: product.status
            }
        });
    } catch (error) {
        console.error('Toggle product status error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Approve product (Admin only)
// @route   PUT /api/products/:productId/approve
// @access  Private/Admin
exports.approveProduct = async (req, res) => {
    try {
        const { productId } = req.params;
        const { adminCut, adminGst } = req.body; // Admin commission in rupees and admin GST in percentage

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(productId)) {
            return res.status(404).json({
                success: false,
                message: 'Invalid product ID format'
            });
        }

        const product = await Product.findById(productId)
            .populate('vendor', 'name email');

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        if (product.approvalStatus === 'approved') {
            return res.status(400).json({
                success: false,
                message: 'Product is already approved'
            });
        }

        // Validate adminCut
        const adminCommission = parseFloat(adminCut) || 0;
        if (adminCommission < 0) {
            return res.status(400).json({
                success: false,
                message: 'Admin cut cannot be negative'
            });
        }

        // Validate adminGst
        const adminGstPercentage = parseFloat(adminGst) || 0;
        if (adminGstPercentage < 0) {
            return res.status(400).json({
                success: false,
                message: 'Admin GST cannot be negative'
            });
        }

        // Update product with admin cut and admin GST
        product.adminCut = adminCommission;
        product.adminGst = adminGstPercentage;
        
        // Calculate GST amount on vendor price
        product.gstAmount = (product.vendorPrice * product.gstSlab) / 100;
        
        // Calculate admin GST amount on admin cut
        product.adminGstAmount = (adminCommission * adminGstPercentage) / 100;
        
        // Calculate final price: vendorPrice + gstAmount + adminCut + adminGstAmount
        product.price = product.vendorPrice + product.gstAmount + adminCommission + product.adminGstAmount;
        
        product.approvalStatus = 'approved';
        product.approvedBy = req.user.id;
        product.approvedAt = Date.now();
        product.rejectionReason = undefined;

        await product.save();

        res.status(200).json({
            success: true,
            message: 'Product approved successfully',
            data: {
                id: product._id,
                productName: product.productName,
                sku: product.sku,
                vendor: product.vendor.name,
                vendorPrice: product.vendorPrice,
                gstSlab: `${product.gstSlab}%`,
                gstAmount: product.gstAmount,
                adminCut: product.adminCut,
                adminGst: `${product.adminGst}%`,
                adminGstAmount: product.adminGstAmount,
                finalPrice: product.price,
                approvalStatus: product.approvalStatus,
                approvedAt: product.approvedAt
            },
            priceBreakdown: {
                vendorPrice: product.vendorPrice,
                gstSlab: `${product.gstSlab}%`,
                gstAmount: product.gstAmount,
                adminCut: product.adminCut,
                adminGst: `${product.adminGst}%`,
                adminGstAmount: product.adminGstAmount,
                finalPrice: product.price,
                calculation: `${product.vendorPrice} (vendor) + ${product.gstAmount} (GST) + ${product.adminCut} (admin cut) + ${product.adminGstAmount} (admin GST) = ${product.price}`
            }
        });
    } catch (error) {
        console.error('Approve product error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Reject product (Admin only)
// @route   PUT /api/products/:productId/reject
// @access  Private/Admin
exports.rejectProduct = async (req, res) => {
    try {
        const { productId } = req.params;
        const { reason } = req.body;

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(productId)) {
            return res.status(404).json({
                success: false,
                message: 'Invalid product ID format'
            });
        }

        const product = await Product.findById(productId)
            .populate('vendor', 'name email');

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        if (product.approvalStatus === 'rejected') {
            return res.status(400).json({
                success: false,
                message: 'Product is already rejected'
            });
        }

        product.approvalStatus = 'rejected';
        product.rejectionReason = reason || 'Not specified';
        product.approvedBy = req.user.id;
        // Reset admin cut, admin GST and recalculate price with only GST when rejected
        product.adminCut = 0;
        product.adminGst = 0;
        product.adminGstAmount = 0;
        product.gstAmount = (product.vendorPrice * product.gstSlab) / 100;
        product.price = product.vendorPrice + product.gstAmount;

        await product.save();

        res.status(200).json({
            success: true,
            message: 'Product rejected successfully',
            data: {
                id: product._id,
                productName: product.productName,
                sku: product.sku,
                vendor: product.vendor.name,
                approvalStatus: product.approvalStatus,
                rejectionReason: product.rejectionReason
            }
        });
    } catch (error) {
        console.error('Reject product error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get product statistics
// @route   GET /api/products/stats
// @access  Private/Admin
exports.getProductStats = async (req, res) => {
    try {
        let filter = {};
        let stats = {};

        // Role-based statistics
        if (req.user && req.user.role === 'vendor') {
            // Vendor: Show only their products stats
            filter.vendor = req.user.id;

            stats = {
                totalProducts: await Product.countDocuments(filter),
                approved: await Product.countDocuments({ ...filter, approvalStatus: 'approved' }),
                pending: await Product.countDocuments({ ...filter, approvalStatus: 'pending' }),
                rejected: await Product.countDocuments({ ...filter, approvalStatus: 'rejected' }),
                active: await Product.countDocuments({ ...filter, status: 'active' }),
                inactive: await Product.countDocuments({ ...filter, status: 'inactive' }),
                orders: {
                    total: await Order.countDocuments({ vendor: req.user.id }),
                    pending: await Order.countDocuments({ vendor: req.user.id, vendorApprovalStatus: 'pending' }),
                    approved: await Order.countDocuments({ vendor: req.user.id, vendorApprovalStatus: 'approved' }),
                    delivered: await Order.countDocuments({ vendor: req.user.id, status: 'delivered' })
                }
            };

            // Aggregate total revenue specifically for this vendor
            const revenueAggregation = await Order.aggregate([
                { 
                    $match: { 
                        vendor: new mongoose.Types.ObjectId(req.user.id), 
                        $or: [
                            { 'payment.paymentStatus': 'completed' },
                            { status: 'delivered' }
                        ]
                    } 
                },
                { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } }
            ]);
            
            stats.totalRevenue = revenueAggregation.length > 0 ? revenueAggregation[0].totalRevenue : 0;

            // Optionally get products with stats
            const products = await Product.find(filter)
                .sort({ createdAt: -1 })
                .populate('vendor', 'name email')
                .populate('category', 'name')
                .populate('subCategory', 'name')
                .populate('approvedBy', 'name email');

            return res.status(200).json({
                success: true,
                userRole: 'vendor',
                stats,
                data: products
            });
        } else if (req.user && (req.user.role === 'admin' || req.user.role === 'sub-admin')) {
            // Admin/Sub-admin: Show all products stats
            stats = {
                totalProducts: await Product.countDocuments({}),
                pending: await Product.countDocuments({ approvalStatus: 'pending' }),
                approved: await Product.countDocuments({ approvalStatus: 'approved' }),
                rejected: await Product.countDocuments({ approvalStatus: 'rejected' }),
                active: await Product.countDocuments({ status: 'active', approvalStatus: 'approved' }),
                inactive: await Product.countDocuments({ status: 'inactive' })
            };

            // Aggregate global total revenue for Admin
            const adminRevenueAggregation = await Order.aggregate([
                { 
                    $match: { 
                        $or: [
                            { 'payment.paymentStatus': 'completed' },
                            { status: 'delivered' }
                        ]
                    } 
                },
                { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } }
            ]);
            stats.financial = { totalRevenue: adminRevenueAggregation.length > 0 ? adminRevenueAggregation[0].totalRevenue : 0 };

            // Optionally get products breakdown by approval status
            const pendingProducts = await Product.find({ approvalStatus: 'pending' })
                .sort({ createdAt: -1 })
                .populate('vendor', 'name email')
                .populate('category', 'name')
                .populate('subCategory', 'name');

            const approvedProducts = await Product.find({ approvalStatus: 'approved' })
                .sort({ createdAt: -1 })
                .limit(10)
                .populate('vendor', 'name email')
                .populate('category', 'name')
                .populate('subCategory', 'name');

            const rejectedProducts = await Product.find({ approvalStatus: 'rejected' })
                .sort({ createdAt: -1 })
                .limit(10)
                .populate('vendor', 'name email')
                .populate('category', 'name')
                .populate('subCategory', 'name');

            return res.status(200).json({
                success: true,
                userRole: 'admin',
                stats,
                products: {
                    pending: { count: pendingProducts.length, data: pendingProducts },
                    approved: { count: approvedProducts.length, total: stats.approved },
                    rejected: { count: rejectedProducts.length, total: stats.rejected }
                }
            });
        } else {
            return res.status(403).json({
                success: false,
                message: 'Not authorized to access product statistics'
            });
        }
    } catch (error) {
        console.error('Get product stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};
