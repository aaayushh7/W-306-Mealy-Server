require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const admin = require('firebase-admin');
const schedule = require('node-schedule');

const app = express();
const port = process.env.PORT || 3000;

// CORS Configuration - Must come before any routes
const corsOptions = {
  origin: ['https://w-306-mealy.vercel.app', 'http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'Cache-Control'
  ],
  optionsSuccessStatus: 200
};

// Apply CORS to all routes
app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Body parser middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
  });
  console.log('Firebase Admin initialized successfully');
} catch (error) {
  console.error('Error initializing Firebase Admin:', error);
}

// MongoDB connection with retry logic
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

connectDB();

// Schema definitions
const userSchema = new mongoose.Schema({
  email: String,
  name: String,
  firebaseUid: String,
  hasEaten: {
    type: Boolean,
    default: false
  },
  lastEatenAt: Date,
  fcmToken: String
});

const scheduleSchema = new mongoose.Schema({
  lunchTime: {
    type: String,
    default: "12:00"
  },
  dinnerTime: {
    type: String,
    default: "19:00"
  }
});

const User = mongoose.model('User', userSchema);
const Schedule = mongoose.model('Schedule', scheduleSchema);

// Auth middleware
const authenticateUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

// Health check route
app.get('/', (req, res) => {
  res.json({ status: 'Server is running' });
});

// Routes
app.post('/api/users/register', authenticateUser, async (req, res) => {
  try {
    const { name, email } = req.body;
    const firebaseUid = req.user.uid;

    let user = await User.findOne({ firebaseUid });
    if (!user) {
      user = new User({ name, email, firebaseUid });
      await user.save();
    }

    res.json(user);
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users/fcm-token', authenticateUser, async (req, res) => {
  try {
    const { token } = req.body;
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.user.uid },
      { fcmToken: token },
      { new: true }
    );
    res.json({ success: true, user });
  } catch (error) {
    console.error('FCM token update error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users', authenticateUser, async (req, res) => {
  try {
    const users = await User.find();
    res.set({
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache'
    }).json(users);
  } catch (error) {
    console.error('Users fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users/mark-eaten', authenticateUser, async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.user.uid },
      { 
        hasEaten: true,
        lastEatenAt: new Date()
      },
      { new: true }
    );
    res.json(user);
  } catch (error) {
    console.error('Mark eaten error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/schedule', authenticateUser, async (req, res) => {
  try {
    let schedule = await Schedule.findOne();
    if (!schedule) {
      schedule = new Schedule();
      await schedule.save();
    }
    res.set({
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache'
    }).json(schedule);
  } catch (error) {
    console.error('Schedule fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/schedule', authenticateUser, async (req, res) => {
  try {
    const { lunchTime, dinnerTime } = req.body;
    let schedule = await Schedule.findOne();
    if (!schedule) {
      schedule = new Schedule();
    }
    
    if (lunchTime) schedule.lunchTime = lunchTime;
    if (dinnerTime) schedule.dinnerTime = dinnerTime;
    
    await schedule.save();
    res.json(schedule);
  } catch (error) {
    console.error('Schedule update error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/report-food-finished', authenticateUser, async (req, res) => {
  try {
    const users = await User.find();
    const remainingUsers = users.filter(user => !user.hasEaten);
    
    if (remainingUsers.length === 0) {
      return res.json({ message: "No users left, great job for finishing food!" });
    }

    const usersWhoAte = users.filter(user => user.hasEaten);
    
    // Send notifications to remaining users
    for (const user of remainingUsers) {
      if (user.fcmToken) {
        try {
          await admin.messaging().send({
            notification: {
              title: "Food Finished!",
              body: `Food is finished. ${usersWhoAte.map(u => u.name).join(', ')} have eaten.`
            },
            token: user.fcmToken
          });
        } catch (error) {
          console.error(`Failed to send notification to user ${user.name}:`, error);
        }
      }
    }

    // Send notifications to users who have eaten
    for (const user of usersWhoAte) {
      if (user.fcmToken) {
        try {
          await admin.messaging().send({
            notification: {
              title: "Food Status",
              body: `${remainingUsers.map(u => u.name).join(', ')} will be hungry tonight!`
            },
            token: user.fcmToken
          });
        } catch (error) {
          console.error(`Failed to send notification to user ${user.name}:`, error);
        }
      }
    }

    res.json({ message: "Notifications sent successfully" });
  } catch (error) {
    console.error('Report food finished error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reset users' eaten status at midnight
const resetEatenStatus = async () => {
  try {
    await User.updateMany({}, { hasEaten: false });
    console.log('Reset eaten status successful');
  } catch (error) {
    console.error('Reset eaten status error:', error);
  }
};

// Schedule the reset job
schedule.scheduleJob('0 0 * * *', resetEatenStatus);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.originalUrl} not found` });
});

// Start server
app.listen(port, () => {
  console.log(`Server is running on port: ${port}`);
});