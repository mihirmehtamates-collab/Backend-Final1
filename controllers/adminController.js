const mongoose = require('mongoose');
const User = require('../models/User');
const CompanyUser = require('../models/CompanyUser');
const Branch = require('../models/Branch');
const Product = require('../models/Product');
const Category = require('../models/Category');
const SubCategory = require('../models/SubCategory');
const Order = require('../models/Order');
const DeliveryPartner = require('../models/DeliveryPartner');
const DeliveryChallan = require('../models/DeliveryChallan');
const Cart = require('../models/Cart');
const bcrypt = require('bcryptjs');
const { sendCredentialsEmail } = require('../utils/emailService');
const { uploadPDFToCloudinary } = require('../utils/fileUpload');

// Helper function to generate random password
const generateRandomPassword = (length = 12) => {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < length; i++) {
        password += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    return password;
};

// @desc    Create sub-admin (Admin only)
// @route   POST /api/admin/create-sub-admin
// @access  Private/Admin
exports.createSubAdmin = async (req, res) => {
    try {
        const { name, email } = req.body;

        // Validate input
        if (!name || !email) {
            return res.status(400).json({
                success: false,
                message: 'Please provide name and email'
            });
        }

        // Check if user already exists
        const userExists = await User.findOne({ email });
        if (userExists) {
            return res.status(400).json({
                success: false,
                message: 'User already exists with this email'
            });
        }

        // Generate random password
        const password = generateRandomPassword();

        // Create sub-admin user
        const subAdmin = await User.create({
            name,
            email,
            password,
            role: 'sub-admin',
            isApproved: true,
            approvalStatus: 'approved',
            approvedBy: req.user.id,
            approvedAt: Date.now()
        });

        // Send email with credentials
        try {
            await sendCredentialsEmail(email, name, password, 'sub-admin');
        } catch (emailError) {
            console.error('Error sending email:', emailError);
            // Continue even if email fails - user is still created
        }

        res.status(201).json({
            success: true,
            message: 'Sub-admin created successfully. Login credentials have been sent to their email.',
            data: {
                user: {
                    id: subAdmin._id,
                    name: subAdmin.name,
                    email: subAdmin.email,
                    role: subAdmin.role
                }
            }
        });
    } catch (error) {
        console.error('Create sub-admin error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Create vendor (Admin and Sub-admin)
// @route   POST /api/admin/create-vendor
// @access  Private/Admin, Sub-admin
exports.createVendor = async (req, res) => {
    try {
        const { name, email, gstNumber, panCard, vendorLocation } = req.body;

        // Validate input
        if (!name || !email || !vendorLocation) {
            return res.status(400).json({
                success: false,
                message: 'Please provide name, email, and vendor location'
            });
        }

        // Validate S&E Certificate
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'S&E Certificate PDF is required'
            });
        }

        // Validate GST format
        // const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
        // if (!gstRegex.test(gstNumber.toUpperCase())) {
        //     return res.status(400).json({
        //         success: false,
        //         message: 'Please provide a valid GST number (format: 22AAAAA0000A1Z5)'
        //     });
        // }

        // Check if user already exists
        const userExists = await User.findOne({ email });
        if (userExists) {
            return res.status(400).json({
                success: false,
                message: 'User already exists with this email'
            });
        }

        // Check if GST number already exists
        const gstExists = await User.findOne({ gstNumber: gstNumber.toUpperCase() });
        if (gstExists) {
            return res.status(400).json({
                success: false,
                message: 'This GST number is already registered'
            });
        }

        // Upload S&E Certificate to Cloudinary
        let seCertificateData;
        try {
            const fileName = `vendor_${email.split('@')[0]}_certificate`;
            seCertificateData = await uploadPDFToCloudinary(req.file.buffer, fileName);
        } catch (uploadError) {
            console.error('Certificate upload error:', uploadError);
            return res.status(500).json({
                success: false,
                message: 'Error uploading S&E Certificate. Please try again.'
            });
        }

        // Generate random password
        const password = generateRandomPassword();

        // Create vendor user (auto-verified)
        const vendorData = {
            name,
            email,
            password,
            role: 'vendor',
            vendorLocation,
            seCertificate: seCertificateData,
            isApproved: true,
            approvalStatus: 'approved',
            approvedBy: req.user.id,
            approvedAt: Date.now()
        };

        // Add optional fields if provided
        if (gstNumber) vendorData.gstNumber = gstNumber.toUpperCase();
        if (panCard) vendorData.panCard = panCard.toUpperCase();

        const vendor = await User.create(vendorData);

        // Send email with credentials
        try {
            await sendCredentialsEmail(email, name, password, 'vendor');
        } catch (emailError) {
            console.error('Error sending email:', emailError);
            // Continue even if email fails - user is still created
        }

        res.status(201).json({
            success: true,
            message: 'Vendor created successfully and auto-verified. Login credentials have been sent to their email.',
            data: {
                user: {
                    id: vendor._id,
                    name: vendor.name,
                    email: vendor.email,
                    role: vendor.role,
                    gstNumber: vendor.gstNumber,
                    panCard: vendor.panCard,
                    vendorLocation: vendor.vendorLocation,
                    seCertificate: vendor.seCertificate,
                    approvalStatus: vendor.approvalStatus
                }
            }
        });
    } catch (error) {
        console.error('Create vendor error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Create company (Admin and Sub-admin)
// @route   POST /api/admin/create-company
// @access  Private/Admin, Sub-admin
exports.createCompany = async (req, res) => {
    try {
        const { name, email, gstNumber, panCard, companyLocation } = req.body;

        // Validate input
        if (!name || !email || !companyLocation) {
            return res.status(400).json({
                success: false,
                message: 'Please provide name, email, and company location'
            });
        }

        // Validate S&E Certificate
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'S&E Certificate PDF is required'
            });
        }

        // Validate GST format
        // const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
        // if (!gstRegex.test(gstNumber.toUpperCase())) {
        //     return res.status(400).json({
        //         success: false,
        //         message: 'Please provide a valid GST number (format: 22AAAAA0000A1Z5)'
        //     });
        // }

        // Check if user already exists
        const userExists = await User.findOne({ email });
        if (userExists) {
            return res.status(400).json({
                success: false,
                message: 'User already exists with this email'
            });
        }

        // Check if GST number already exists (only if provided)
        if (gstNumber) {
            const gstExists = await User.findOne({ gstNumber: gstNumber.toUpperCase() });
            if (gstExists) {
                return res.status(400).json({
                    success: false,
                    message: 'This GST number is already registered'
                });
            }
        }

        // Check if PAN card already exists (only if provided)
        if (panCard) {
            const panExists = await User.findOne({ panCard: panCard.toUpperCase() });
            if (panExists) {
                return res.status(400).json({
                    success: false,
                    message: 'This PAN card is already registered'
                });
            }
        }

        // Upload S&E Certificate to Cloudinary
        let seCertificateData;
        try {
            const fileName = `company_${email.split('@')[0]}_certificate`;
            seCertificateData = await uploadPDFToCloudinary(req.file.buffer, fileName);
        } catch (uploadError) {
            console.error('Certificate upload error:', uploadError);
            return res.status(500).json({
                success: false,
                message: 'Error uploading S&E Certificate. Please try again.'
            });
        }

        // Generate random password
        const password = generateRandomPassword();

        // Create company (auto-verified)
        const companyData = {
            name,
            email,
            password,
            role: 'company',
            companyLocation,
            seCertificate: seCertificateData,
            isApproved: true,
            approvalStatus: 'approved',
            approvedBy: req.user.id,
            approvedAt: Date.now()
        };

        // Add optional fields if provided
        if (gstNumber) companyData.gstNumber = gstNumber.toUpperCase();
        if (panCard) companyData.panCard = panCard.toUpperCase();

        const company = await User.create(companyData);

        // Create company super-admin user
        try {
            await CompanyUser.create({
                name: name,
                email: email,
                password: password,
                role: 'super-admin',
                company: company._id,
                createdBy: null,
                isActive: true
            });
        } catch (companyUserError) {
            console.error('Error creating company super-admin:', companyUserError);
            // Rollback: delete the company if CompanyUser creation fails
            await User.findByIdAndDelete(company._id);
            return res.status(500).json({
                success: false,
                message: 'Error creating company super-admin user'
            });
        }

        // Send email with credentials
        try {
            await sendCredentialsEmail(email, name, password, 'company');
        } catch (emailError) {
            console.error('Error sending email:', emailError);
            // Continue even if email fails - company is still created
        }

        res.status(201).json({
            success: true,
            message: 'Company created successfully and auto-verified. Login credentials have been sent to their email.',
            data: {
                company: {
                    id: company._id,
                    name: company.name,
                    email: company.email,
                    role: company.role,
                    gstNumber: company.gstNumber,
                    panCard: company.panCard,
                    companyLocation: company.companyLocation,
                    seCertificate: company.seCertificate,
                    approvalStatus: company.approvalStatus
                }
            }
        });
    } catch (error) {
        console.error('Create company error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get all sub-admins with pagination and search
// @route   GET /api/admin/sub-admins
// @access  Private/Admin
exports.getAllSubAdmins = async (req, res) => {
    try {
        const { page = 1, limit = 10, search = '' } = req.query;

        // Convert to numbers and validate
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);

        if (pageNum < 1 || limitNum < 1) {
            return res.status(400).json({
                success: false,
                message: 'Page and limit must be positive numbers'
            });
        }

        // Build query for sub-admins with optional name search
        const query = { role: 'sub-admin' };
        
        if (search) {
            query.name = { $regex: search, $options: 'i' }; // Case-insensitive search
        }

        // Calculate skip value for pagination
        const skip = (pageNum - 1) * limitNum;

        // Get total count for pagination metadata
        const totalSubAdmins = await User.countDocuments(query);

        // Fetch sub-admins with pagination
        const subAdmins = await User.find(query)
            .select('-password -resetPasswordOTP -resetPasswordOTPExpire') // Exclude sensitive fields
            .populate('approvedBy', 'name email') // Populate approvedBy with name and email
            .sort({ createdAt: -1 }) // Sort by newest first
            .skip(skip)
            .limit(limitNum);

        // Calculate pagination metadata
        const totalPages = Math.ceil(totalSubAdmins / limitNum);
        const hasNextPage = pageNum < totalPages;
        const hasPrevPage = pageNum > 1;

        res.status(200).json({
            success: true,
            message: 'Sub-admins fetched successfully',
            data: {
                subAdmins,
                pagination: {
                    currentPage: pageNum,
                    totalPages,
                    totalSubAdmins,
                    limit: limitNum,
                    hasNextPage,
                    hasPrevPage
                }
            }
        });
    } catch (error) {
        console.error('Get sub-admins error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Toggle user active status (activate/deactivate)
// @route   PUT /api/admin/toggle-status/:userId
// @access  Private/Admin
exports.toggleUserStatus = async (req, res) => {
    try {
        const { userId } = req.params;

        // Find user
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Prevent admin from deactivating themselves
        if (user._id.toString() === req.user.id) {
            return res.status(400).json({
                success: false,
                message: 'You cannot deactivate your own account'
            });
        }

        // Prevent deactivating other admins (optional - remove if not needed)
        if (user.role === 'admin') {
            return res.status(400).json({
                success: false,
                message: 'Cannot deactivate admin accounts'
            });
        }

        // Toggle the active status
        user.isActive = !user.isActive;
        await user.save();

        const action = user.isActive ? 'activated' : 'deactivated';
        const statusMessage = user.isActive 
            ? 'User can now login to the system' 
            : 'User will not be able to login';

        res.status(200).json({
            success: true,
            message: `${user.role.charAt(0).toUpperCase() + user.role.slice(1)} ${action} successfully. ${statusMessage}`,
            data: {
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    isActive: user.isActive,
                    approvalStatus: user.approvalStatus
                }
            }
        });
    } catch (error) {
        console.error('Toggle user status error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// ==================== BRANCH MANAGEMENT ====================

// @desc    Get all branches with filters (Admin only)
// @route   GET /api/admin/branches
// @access  Private/Admin
exports.getAllBranches = async (req, res) => {
    try {
        const { status, page = 1, limit = 10, search, companyId } = req.query;

        // Build filter query
        const filter = {};

        // Add status filter if provided
        if (status && ['pending', 'approved', 'rejected'].includes(status)) {
            filter.approvalStatus = status;
        }

        // Add company filter if provided
        if (companyId) {
            filter.company = companyId;
        }

        // Add search filter (branch name, address, city, state, or company name)
        if (search) {
            filter.$or = [
                { branchName: { $regex: search, $options: 'i' } },
                { address: { $regex: search, $options: 'i' } },
                { city: { $regex: search, $options: 'i' } },
                { state: { $regex: search, $options: 'i' } },
                { companyName: { $regex: search, $options: 'i' } }
            ];
        }

        // Calculate pagination
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        // Get total count
        const totalBranches = await Branch.countDocuments(filter);

        // Get branches with pagination
        const branches = await Branch.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .populate('company', 'name email gstNumber panCard')
            .populate('approvedBy', 'name email')
            .populate('branchAdmin', 'name email role')
            .populate('createdBy', 'name email role');

        // Calculate pagination info
        const totalPages = Math.ceil(totalBranches / limitNum);

        res.status(200).json({
            success: true,
            count: branches.length,
            totalBranches,
            totalPages,
            currentPage: pageNum,
            data: branches,
            pagination: {
                page: pageNum,
                limit: limitNum,
                totalPages,
                totalRecords: totalBranches,
                hasNextPage: pageNum < totalPages,
                hasPrevPage: pageNum > 1
            }
        });
    } catch (error) {
        console.error('Get all branches error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Approve branch (Admin only)
// @route   PUT /api/admin/branches/approve/:branchId
// @access  Private/Admin
exports.approveBranch = async (req, res) => {
    try {
        const { branchId } = req.params;

        const branch = await Branch.findById(branchId)
            .populate('company', 'name email')
            .populate('branchAdmin', 'name email role')
            .populate('createdBy', 'name email role');

        if (!branch) {
            return res.status(404).json({
                success: false,
                message: 'Branch not found'
            });
        }

        if (branch.approvalStatus === 'approved') {
            return res.status(400).json({
                success: false,
                message: 'Branch is already approved'
            });
        }

        branch.isApproved = true;
        branch.approvalStatus = 'approved';
        branch.approvedBy = req.user.id;
        branch.approvedAt = Date.now();
        branch.rejectionReason = undefined;

        await branch.save();

        res.status(200).json({
            success: true,
            message: 'Branch approved successfully',
            data: {
                branch: {
                    id: branch._id,
                    branchName: branch.branchName,
                    address: branch.address,
                    city: branch.city,
                    state: branch.state,
                    companyName: branch.companyName,
                    approvalStatus: branch.approvalStatus,
                    approvedAt: branch.approvedAt
                }
            }
        });
    } catch (error) {
        console.error('Approve branch error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Reject branch (Admin only)
// @route   PUT /api/admin/branches/reject/:branchId
// @access  Private/Admin
exports.rejectBranch = async (req, res) => {
    try {
        const { branchId } = req.params;
        const { reason } = req.body;

        const branch = await Branch.findById(branchId)
            .populate('company', 'name email')
            .populate('branchAdmin', 'name email role')
            .populate('createdBy', 'name email role');

        if (!branch) {
            return res.status(404).json({
                success: false,
                message: 'Branch not found'
            });
        }

        if (branch.approvalStatus === 'rejected') {
            return res.status(400).json({
                success: false,
                message: 'Branch is already rejected'
            });
        }

        branch.isApproved = false;
        branch.approvalStatus = 'rejected';
        branch.rejectionReason = reason || 'Not specified';
        branch.approvedBy = req.user.id;

        await branch.save();

        res.status(200).json({
            success: true,
            message: 'Branch rejected successfully',
            data: {
                branch: {
                    id: branch._id,
                    branchName: branch.branchName,
                    address: branch.address,
                    city: branch.city,
                    state: branch.state,
                    companyName: branch.companyName,
                    approvalStatus: branch.approvalStatus,
                    rejectionReason: branch.rejectionReason
                }
            }
        });
    } catch (error) {
        console.error('Reject branch error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Toggle branch active status (Admin only)
// @route   PUT /api/admin/branches/toggle-status/:branchId
// @access  Private/Admin
exports.toggleBranchStatus = async (req, res) => {
    try {
        const { branchId } = req.params;

        const branch = await Branch.findById(branchId);

        if (!branch) {
            return res.status(404).json({
                success: false,
                message: 'Branch not found'
            });
        }

        // Toggle the active status
        branch.isActive = !branch.isActive;
        await branch.save();

        const action = branch.isActive ? 'activated' : 'deactivated';

        res.status(200).json({
            success: true,
            message: `Branch ${action} successfully`,
            data: {
                branch: {
                    id: branch._id,
                    branchName: branch.branchName,
                    address: branch.address,
                    city: branch.city,
                    state: branch.state,
                    isActive: branch.isActive,
                    approvalStatus: branch.approvalStatus
                }
            }
        });
    } catch (error) {
        console.error('Toggle branch status error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get branch statistics (Admin only)
// @route   GET /api/admin/branches/stats
// @access  Private/Admin
exports.getBranchesStats = async (req, res) => {
    try {
        const stats = {
            total: await Branch.countDocuments({}),
            pending: await Branch.countDocuments({ approvalStatus: 'pending' }),
            approved: await Branch.countDocuments({ approvalStatus: 'approved' }),
            rejected: await Branch.countDocuments({ approvalStatus: 'rejected' }),
            active: await Branch.countDocuments({ isActive: true, approvalStatus: 'approved' }),
            inactive: await Branch.countDocuments({ isActive: false })
        };

        res.status(200).json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('Get branches stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get comprehensive dashboard statistics (Admin only)
// @route   GET /api/admin/dashboard
// @access  Private/Admin, Sub-admin
exports.getDashboardStats = async (req, res) => {
    try {
        // Get current date for time-based queries
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0, 0, 0, 0);
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfYear = new Date(now.getFullYear(), 0, 1);

        // ==================== USER STATISTICS ====================
        const userStats = {
            total: await User.countDocuments({}),
            byRole: {
                admin: await User.countDocuments({ role: 'admin' }),
                subAdmin: await User.countDocuments({ role: 'sub-admin' }),
                vendor: await User.countDocuments({ role: 'vendor' }),
                company: await User.countDocuments({ role: 'company' })
            },
            byStatus: {
                active: await User.countDocuments({ isActive: true }),
                inactive: await User.countDocuments({ isActive: false })
            },
            byApprovalStatus: {
                approved: await User.countDocuments({ approvalStatus: 'approved' }),
                pending: await User.countDocuments({ approvalStatus: 'pending' }),
                rejected: await User.countDocuments({ approvalStatus: 'rejected' })
            },
            recentRegistrations: {
                today: await User.countDocuments({ createdAt: { $gte: startOfToday } }),
                thisWeek: await User.countDocuments({ createdAt: { $gte: startOfWeek } }),
                thisMonth: await User.countDocuments({ createdAt: { $gte: startOfMonth } }),
                thisYear: await User.countDocuments({ createdAt: { $gte: startOfYear } })
            }
        };

        // ==================== COMPANY USER STATISTICS ====================
        const companyUserStats = {
            total: await CompanyUser.countDocuments({}),
            byRole: {
                superAdmin: await CompanyUser.countDocuments({ role: 'super-admin' }),
                companyAdmin: await CompanyUser.countDocuments({ role: 'company-admin' }),
                branchAdmin: await CompanyUser.countDocuments({ role: 'branch-admin' })
            },
            active: await CompanyUser.countDocuments({ isActive: true }),
            inactive: await CompanyUser.countDocuments({ isActive: false })
        };

        // ==================== BRANCH STATISTICS ====================
        const branchStats = {
            total: await Branch.countDocuments({}),
            byApprovalStatus: {
                approved: await Branch.countDocuments({ approvalStatus: 'approved' }),
                pending: await Branch.countDocuments({ approvalStatus: 'pending' }),
                rejected: await Branch.countDocuments({ approvalStatus: 'rejected' })
            },
            byStatus: {
                active: await Branch.countDocuments({ isActive: true, approvalStatus: 'approved' }),
                inactive: await Branch.countDocuments({ isActive: false })
            },
            recentBranches: {
                today: await Branch.countDocuments({ createdAt: { $gte: startOfToday } }),
                thisWeek: await Branch.countDocuments({ createdAt: { $gte: startOfWeek } }),
                thisMonth: await Branch.countDocuments({ createdAt: { $gte: startOfMonth } })
            }
        };

        // ==================== PRODUCT STATISTICS ====================
        const productStats = {
            total: await Product.countDocuments({}),
            byApprovalStatus: {
                approved: await Product.countDocuments({ approvalStatus: 'approved' }),
                pending: await Product.countDocuments({ approvalStatus: 'pending' }),
                rejected: await Product.countDocuments({ approvalStatus: 'rejected' })
            },
            byStatus: {
                active: await Product.countDocuments({ status: 'active', approvalStatus: 'approved' }),
                inactive: await Product.countDocuments({ status: 'inactive' })
            },
            recentProducts: {
                today: await Product.countDocuments({ createdAt: { $gte: startOfToday } }),
                thisWeek: await Product.countDocuments({ createdAt: { $gte: startOfWeek } }),
                thisMonth: await Product.countDocuments({ createdAt: { $gte: startOfMonth } })
            }
        };

        // ==================== CATEGORY STATISTICS ====================
        const categoryStats = {
            totalCategories: await Category.countDocuments({}),
            activeCategories: await Category.countDocuments({ isActive: 'active' }),
            inactiveCategories: await Category.countDocuments({ isActive: 'inactive' }),
            totalSubCategories: await SubCategory.countDocuments({}),
            activeSubCategories: await SubCategory.countDocuments({ isActive: 'active' }),
            inactiveSubCategories: await SubCategory.countDocuments({ isActive: 'inactive' })
        };

        // ==================== ORDER STATISTICS ====================
        const orderStats = {
            total: await Order.countDocuments({}),
            byStatus: {
                pending: await Order.countDocuments({ status: 'pending' }),
                approved: await Order.countDocuments({ status: 'approved' }),
                processing: await Order.countDocuments({ status: 'processing' }),
                shipped: await Order.countDocuments({ status: 'shipped' }),
                delivered: await Order.countDocuments({ status: 'delivered' }),
                cancelled: await Order.countDocuments({ status: 'cancelled' }),
                rejected: await Order.countDocuments({ status: 'rejected' })
            },
            byPaymentStatus: {
                completed: await Order.countDocuments({ 'payment.paymentStatus': 'completed' }),
                pending: await Order.countDocuments({ 'payment.paymentStatus': 'pending' }),
                failed: await Order.countDocuments({ 'payment.paymentStatus': 'failed' })
            },
            recentOrders: {
                today: await Order.countDocuments({ createdAt: { $gte: startOfToday } }),
                thisWeek: await Order.countDocuments({ createdAt: { $gte: startOfWeek } }),
                thisMonth: await Order.countDocuments({ createdAt: { $gte: startOfMonth } }),
                thisYear: await Order.countDocuments({ createdAt: { $gte: startOfYear } })
            },
            withDeliveryPartner: await Order.countDocuments({ deliveryPartner: { $ne: null } }),
            withoutDeliveryPartner: await Order.countDocuments({ 
                deliveryPartner: null, 
                'payment.paymentStatus': 'completed',
                status: { $nin: ['cancelled', 'rejected', 'delivered'] }
            })
        };

        // ==================== REVENUE & FINANCIAL STATISTICS ====================
        const baseRevenueMatch = {
            $or: [
                { 'payment.paymentStatus': 'completed' },
                { status: 'delivered' }
            ]
        };

        // Calculate total revenue from completed payments
        const revenueAggregation = await Order.aggregate([
            { 
                $match: baseRevenueMatch
            },
            {
                $group: {
                    _id: null,
                    totalRevenue: { $sum: '$totalAmount' },
                    averageOrderValue: { $avg: '$totalAmount' },
                    count: { $sum: 1 }
                }
            }
        ]);

        // Revenue by time period
        const revenueToday = await Order.aggregate([
            { 
                $match: { 
                    ...baseRevenueMatch,
                    createdAt: { $gte: startOfToday }
                } 
            },
            { $group: { _id: null, total: { $sum: '$totalAmount' } } }
        ]);

        const revenueThisWeek = await Order.aggregate([
            { 
                $match: { 
                    ...baseRevenueMatch,
                    createdAt: { $gte: startOfWeek }
                } 
            },
            { $group: { _id: null, total: { $sum: '$totalAmount' } } }
        ]);

        const revenueThisMonth = await Order.aggregate([
            { 
                $match: { 
                    ...baseRevenueMatch,
                    createdAt: { $gte: startOfMonth }
                } 
            },
            { $group: { _id: null, total: { $sum: '$totalAmount' } } }
        ]);

        const revenueThisYear = await Order.aggregate([
            { 
                $match: { 
                    ...baseRevenueMatch,
                    createdAt: { $gte: startOfYear }
                } 
            },
            { $group: { _id: null, total: { $sum: '$totalAmount' } } }
        ]);

        const financialStats = {
            totalRevenue: revenueAggregation[0]?.totalRevenue || 0,
            averageOrderValue: revenueAggregation[0]?.averageOrderValue || 0,
            completedOrdersCount: revenueAggregation[0]?.count || 0,
            revenueByPeriod: {
                today: revenueToday[0]?.total || 0,
                thisWeek: revenueThisWeek[0]?.total || 0,
                thisMonth: revenueThisMonth[0]?.total || 0,
                thisYear: revenueThisYear[0]?.total || 0
            },
            pendingPaymentsValue: await Order.aggregate([
                { $match: { 'payment.paymentStatus': 'pending' } },
                { $group: { _id: null, total: { $sum: '$totalAmount' } } }
            ]).then(result => result[0]?.total || 0)
        };

        // ==================== DELIVERY PARTNER STATISTICS ====================
        const deliveryPartnerStats = {
            total: await DeliveryPartner.countDocuments({}),
            active: await DeliveryPartner.countDocuments({ isActive: true }),
            inactive: await DeliveryPartner.countDocuments({ isActive: false }),
            byVehicleType: {
                bike: await DeliveryPartner.countDocuments({ vehicleType: 'bike', isActive: true }),
                car: await DeliveryPartner.countDocuments({ vehicleType: 'car', isActive: true }),
                van: await DeliveryPartner.countDocuments({ vehicleType: 'van', isActive: true }),
                truck: await DeliveryPartner.countDocuments({ vehicleType: 'truck', isActive: true })
            },
            totalDeliveries: await DeliveryPartner.aggregate([
                { $group: { _id: null, total: { $sum: '$totalDeliveries' } } }
            ]).then(result => result[0]?.total || 0),
            averageRating: await DeliveryPartner.aggregate([
                { $match: { rating: { $gt: 0 } } },
                { $group: { _id: null, avgRating: { $avg: '$rating' } } }
            ]).then(result => result[0]?.avgRating || 0)
        };

        // ==================== CART STATISTICS ====================
        const cartStats = {
            totalCarts: await Cart.countDocuments({}),
            activeCarts: await Cart.countDocuments({ 'items.0': { $exists: true } }), // Carts with at least one item
            emptyCarts: await Cart.countDocuments({ items: { $size: 0 } }),
            totalItemsInCarts: await Cart.aggregate([
                { $unwind: '$items' },
                { $group: { _id: null, count: { $sum: 1 } } }
            ]).then(result => result[0]?.count || 0)
        };

        // ==================== TOP PERFORMERS ====================
        // Top 5 vendors by products
        const topVendorsByProducts = await Product.aggregate([
            { $match: { approvalStatus: 'approved' } },
            { 
                $group: { 
                    _id: '$vendor', 
                    productCount: { $sum: 1 } 
                } 
            },
            { $sort: { productCount: -1 } },
            { $limit: 5 },
            {
                $lookup: {
                    from: 'users',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'vendorDetails'
                }
            },
            { $unwind: '$vendorDetails' },
            {
                $project: {
                    vendorId: '$_id',
                    vendorName: '$vendorDetails.name',
                    vendorEmail: '$vendorDetails.email',
                    productCount: 1,
                    _id: 0
                }
            }
        ]);

        // Top 5 companies by orders
        const topCompaniesByOrders = await Order.aggregate([
            { $match: baseRevenueMatch },
            { 
                $group: { 
                    _id: '$company', 
                    orderCount: { $sum: 1 },
                    totalSpent: { $sum: '$totalAmount' }
                } 
            },
            { $sort: { totalSpent: -1 } },
            { $limit: 5 },
            {
                $lookup: {
                    from: 'users',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'companyDetails'
                }
            },
            { $unwind: '$companyDetails' },
            {
                $project: {
                    companyId: '$_id',
                    companyName: '$companyDetails.name',
                    companyEmail: '$companyDetails.email',
                    orderCount: 1,
                    totalSpent: 1,
                    _id: 0
                }
            }
        ]);

        // Top 5 delivery partners by deliveries
        const topDeliveryPartners = await DeliveryPartner.find({ isActive: true })
            .sort({ totalDeliveries: -1 })
            .limit(5)
            .select('name email phone vehicleType totalDeliveries rating');

        // ==================== RECENT ACTIVITIES ====================
        // Recent orders (last 10)
        const recentOrders = await Order.find({})
            .sort({ createdAt: -1 })
            .limit(10)
            .select('orderNumber totalAmount status payment.paymentStatus createdAt')
            .populate('orderedBy', 'name email')
            .populate('company', 'name');

        // Recent users (last 10)
        const recentUsers = await User.find({})
            .sort({ createdAt: -1 })
            .limit(10)
            .select('name email role approvalStatus createdAt');

        // Response
        res.status(200).json({
            success: true,
            message: 'Dashboard statistics fetched successfully',
            data: {
                overview: {
                    totalUsers: userStats.total,
                    totalCompanies: userStats.byRole.company,
                    totalVendors: userStats.byRole.vendor,
                    totalBranches: branchStats.total,
                    totalProducts: productStats.total,
                    totalOrders: orderStats.total,
                    totalRevenue: financialStats.totalRevenue,
                    totalDeliveryPartners: deliveryPartnerStats.total
                },
                users: userStats,
                companyUsers: companyUserStats,
                branches: branchStats,
                products: productStats,
                categories: categoryStats,
                orders: orderStats,
                financial: financialStats,
                deliveryPartners: deliveryPartnerStats,
                carts: cartStats,
                topPerformers: {
                    vendors: topVendorsByProducts,
                    companies: topCompaniesByOrders,
                    deliveryPartners: topDeliveryPartners
                },
                recentActivities: {
                    orders: recentOrders,
                    users: recentUsers
                },
                generatedAt: now
            }
        });
    } catch (error) {
        console.error('Get dashboard stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};

// @desc    Get Admin's direct sales dashboard statistics
// @route   GET /api/admin/my-store/dashboard
// @access  Private/Admin, Sub-admin
exports.getAdminStoreStats = async (req, res) => {
    try {
        const adminId = req.user.id;

        const productStats = {
            total: await Product.countDocuments({ vendor: adminId }),
            active: await Product.countDocuments({ vendor: adminId, status: 'active' })
        };

        const orderStats = {
            total: await Order.countDocuments({ vendor: adminId }),
            pending: await Order.countDocuments({ vendor: adminId, vendorApprovalStatus: 'pending' }),
            approved: await Order.countDocuments({ vendor: adminId, vendorApprovalStatus: 'approved' }),
            delivered: await Order.countDocuments({ vendor: adminId, status: 'delivered' })
        };

        const challanStats = {
            total: await DeliveryChallan.countDocuments({ vendor: adminId })
        };

        const revenueAgg = await Order.aggregate([
            { 
                $match: { 
                    vendor: new mongoose.Types.ObjectId(adminId), 
                    $or: [
                        { 'payment.paymentStatus': 'completed' },
                        { status: 'delivered' }
                    ]
                } 
            },
            { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } }
        ]);

        res.status(200).json({
            success: true,
            data: {
                products: productStats,
                orders: orderStats,
                deliveryChallans: challanStats,
                totalRevenue: revenueAgg.length > 0 ? revenueAgg[0].totalRevenue : 0
            }
        });
    } catch (error) {
        console.error('Get admin store stats error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
};