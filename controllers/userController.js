const User = require('../models/User'); // Adjust if required
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const CompanyUser = require('../models/CompanyUser');

// @desc    Update user profile (Admin Portal)
// @route   PUT /api/auth/users/:id
// @access  Private/Admin
exports.updateUser = async (req, res) => {
    try {
        const { name, email, companyLocation, vendorLocation, gstNumber, panCard, isActive } = req.body;
        
        const updateData = {};
        if (name) updateData.name = name;
        if (email) updateData.email = email;
        if (companyLocation !== undefined) updateData.companyLocation = companyLocation;
        if (vendorLocation !== undefined) updateData.vendorLocation = vendorLocation;
        if (gstNumber !== undefined) updateData.gstNumber = gstNumber;
        if (panCard !== undefined) updateData.panCard = panCard;
        if (isActive !== undefined) updateData.isActive = isActive;
        
        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            updateData,
            { new: true, runValidators: true }
        );

        if (!updatedUser) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        res.status(200).json({ success: true, message: 'User updated successfully', data: updatedUser });
    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
};

// @desc    Delete user profile (Admin Portal)
// @route   DELETE /api/auth/users/:id
// @access  Private/Admin
exports.deleteUser = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Depending on your requirements, remove associated dependencies
        if (user.role === 'vendor') {
            await Product.deleteMany({ vendor: user._id });
        } else if (user.role === 'company') {
            await Branch.deleteMany({ company: user._id });
            await CompanyUser.deleteMany({ company: user._id });
        }

        await user.deleteOne();

        res.status(200).json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
};