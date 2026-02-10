const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const Razorpay = require('razorpay');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Razorpay Instance
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_YOUR_KEY_ID',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'YOUR_KEY_SECRET'
});

// Middleware
app.use(cors({
    origin: ['https://minor-project-backend-i1ci.onrender.com', 'http://localhost:5173', 'http://localhost:3000', 'https://minorproject.easykit.in'],
    credentials: true
}));
app.use(bodyParser.json());

// MongoDB Connection
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/museum_booking';
mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ Connected to MongoDB');
        // Initial Seed for Ticket Types
        const count = await TicketType.countDocuments();
        if (count === 0) {
            await TicketType.insertMany([
                { name: 'General Entry', price: 200, description: 'Access to main museum halls', category: 'Entry' },
                { name: 'Egyptian Mystique', price: 500, description: 'Premium exhibit of the Pharaohs', category: 'Exhibit' },
                { name: 'Digital Art Show', price: 350, description: 'Immersive light and sound show', category: 'Show' }
            ]);
            console.log('🌱 Seeded default ticket types');
        }
    })
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Models
const UserSchema = new mongoose.Schema({
    firebaseUid: String,
    email: String,
    name: String,
    picture: String,
    role: { type: String, default: 'visitor' },
    lastActive: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const BookingSchema = new mongoose.Schema({
    bookingId: String,
    firebaseUid: String, // Linked to user
    visitorName: String,
    ticketType: String,
    date: String,
    quantity: Number,
    totalAmount: Number,
    status: { type: String, default: 'Paid' },
    language: String,
    guestDetails: [{
        name: String,
        gender: String,
        age: String
    }],
    razorpayOrderId: String,
    paymentId: String,
    createdAt: { type: Date, default: Date.now }
});
const Booking = mongoose.model('Booking', BookingSchema);

const TicketTypeSchema = new mongoose.Schema({
    name: String,
    price: Number,
    description: String,
    category: { type: String, default: 'Show' }, // Show, Exhibit, Entry
    isActive: { type: Boolean, default: true },
    dailyLimit: { type: Number, default: 100 },
    createdAt: { type: Date, default: Date.now }
});
const TicketType = mongoose.model('TicketType', TicketTypeSchema);

// Auth Middleware (Admin)
const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        if (decoded.role !== 'admin') throw new Error('Not admin');
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ success: false, message: 'Invalid Admin Token' });
    }
};

// Routes

// 1. Razorpay Order Creation
app.post('/api/razorpay/order', async (req, res) => {
    const { amount, currency = 'INR' } = req.body;
    try {
        const options = {
            amount: amount * 100, // Amount in paise
            currency,
            receipt: `rcpt_${Date.now()}`
        };
        const order = await razorpay.orders.create(options);
        res.json({ success: true, order });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Sync Firebase User
app.post('/api/auth/sync', async (req, res) => {
    const { uid, email, name, picture } = req.body;
    try {
        let user = await User.findOne({ firebaseUid: uid });
        if (!user) {
            user = new User({ firebaseUid: uid, email, name, picture });
            await user.save();
        } else {
            user.name = name;
            user.picture = picture;
            user.lastActive = new Date();
            await user.save();
        }
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Admin Login
app.post('/api/auth/admin-login', (req, res) => {
    const { username, password } = req.body;
    // Check against .env email and password
    if (username === (process.env.ADMIN_EMAIL || 'scmodi9@gmail.com') && password === (process.env.ADMIN_PASSWORD || 'admin123')) {
        const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET || 'secret', { expiresIn: '1d' });
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

// 4. Finalize Booking
app.post('/api/bookings', async (req, res) => {
    try {
        const booking = new Booking(req.body);
        await booking.save();
        res.status(201).json({ success: true, booking });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. Analytics (Admin Protected)
app.get('/api/analytics', authenticateAdmin, async (req, res) => {
    try {
        const totalSales = await Booking.aggregate([{ $group: { _id: null, total: { $sum: "$totalAmount" } } }]);
        const totalBookings = await Booking.countDocuments();

        const totalVisitors = await User.countDocuments({ role: 'visitor' });
        const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000);
        const activeVisitors = await User.countDocuments({ lastActive: { $gte: halfHourAgo }, role: 'visitor' });

        const uniqueBookedUsers = await Booking.distinct('firebaseUid');
        const conversionRate = totalVisitors > 0
            ? ((uniqueBookedUsers.length / totalVisitors) * 100).toFixed(1)
            : 0;

        // Gender Aggregation
        const genderDist = await Booking.aggregate([
            { $unwind: "$guestDetails" },
            {
                $group: {
                    _id: { $toLower: "$guestDetails.gender" },
                    count: { $sum: 1 }
                }
            }
        ]);

        const totalGuests = await Booking.aggregate([
            { $group: { _id: null, total: { $sum: "$quantity" } } }
        ]);

        const recentBookings = await Booking.find().sort({ createdAt: -1 }).limit(10);

        res.json({
            success: true,
            stats: {
                totalSales: totalSales[0]?.total || 0,
                totalBookings,
                activeVisitors,
                conversionRate: `${conversionRate}%`,
                genderStats: {
                    male: genderDist.filter(g => ['male', 'masculin', 'masculino', 'पुरुष', 'männlich', 'maschio', '男性'].includes(g._id)).reduce((acc, curr) => acc + curr.count, 0),
                    female: genderDist.filter(g => ['female', 'féminin', 'femenino', 'महिला', 'weiblich', 'femmina', '女性'].includes(g._id)).reduce((acc, curr) => acc + curr.count, 0),
                    totalGuests: totalGuests[0]?.total || 0
                }
            },
            recentBookings
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. User Booking History
app.get('/api/bookings/:uid', async (req, res) => {
    try {
        const bookings = await Booking.find({ firebaseUid: req.params.uid }).sort({ createdAt: -1 });
        res.json({ success: true, bookings });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 7. Experience Management
app.get('/api/ticket-types', async (req, res) => {
    try {
        const date = req.query.date; // Optional: check availability for specific date
        const types = await TicketType.find({ isActive: true });

        let results = types;
        if (date) {
            results = await Promise.all(types.map(async (type) => {
                const booked = await Booking.aggregate([
                    { $match: { ticketType: type.name, date: date, status: 'Paid' } },
                    { $group: { _id: null, total: { $sum: "$quantity" } } }
                ]);
                const bookedCount = booked.length > 0 ? booked[0].total : 0;
                return { ...type._doc, available: Math.max(0, type.dailyLimit - bookedCount) };
            }));
        }

        res.json({ success: true, types: results });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/ticket-types', authenticateAdmin, async (req, res) => {
    try {
        const newType = new TicketType(req.body);
        await newType.save();
        res.status(201).json({ success: true, type: newType });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.put('/api/ticket-types/:id', authenticateAdmin, async (req, res) => {
    try {
        const updatedType = await TicketType.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json({ success: true, type: updatedType });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/ticket-types/:id/slots', authenticateAdmin, async (req, res) => {
    try {
        const type = await TicketType.findById(req.params.id);
        if (!type) return res.status(404).json({ success: false, message: 'Experience not found' });

        // Get bookings for this type, grouped by date
        const bookings = await Booking.aggregate([
            { $match: { ticketType: type.name } },
            { $group: { _id: "$date", totalBooked: { $sum: "$quantity" } } }
        ]);

        const bookingMap = {};
        bookings.forEach(b => bookingMap[b._id] = b.totalBooked);

        const slots = [];
        const today = new Date();
        for (let i = 0; i < 30; i++) {
            const date = new Date(today);
            date.setDate(today.getDate() + i);
            const dateStr = date.toISOString().split('T')[0];

            const booked = bookingMap[dateStr] || 0;
            const available = Math.max(0, type.dailyLimit - booked);

            slots.push({
                date: dateStr,
                total: type.dailyLimit,
                booked,
                available
            });
        }

        res.json({ success: true, slots, experienceName: type.name });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/verify-ticket/:bookingId', authenticateAdmin, async (req, res) => {
    try {
        const booking = await Booking.findOne({ bookingId: req.params.bookingId });
        if (!booking) {
            return res.status(404).json({ success: false, message: 'Invalid or Expired Ticket' });
        }

        // Also fetch experience details
        const experience = await TicketType.findOne({ name: booking.ticketType });

        res.json({
            success: true,
            booking,
            experience: experience || { description: "General museum experience" }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/ticket-types/:id', authenticateAdmin, async (req, res) => {
    try {
        await TicketType.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'Experience removed' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/', (req, res) => res.send('LuxeMuseum Razorpay API is running...'));

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
