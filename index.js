require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose'); // Removed unused cors import
const admin = require('firebase-admin');
const app = express();
const port = process.env.PORT || 3000;

const allowCors = fn => async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', 'https://w-306-mealy.vercel.app');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, Cache-Control'
    );
    
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }
    return await fn(req, res);
  };
  
  // Parse JSON requests
app.use(express.json());

// Root route with error handling
app.get('/', (req, res) => {
    try {
        res.json({ message: 'Welcome to the API' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


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
  

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

const connection = mongoose.connection;
connection.once('open', () => {
  console.log("MongoDB database connection established successfully");
});

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
    if (!token) throw new Error('No token provided');
    
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

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
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users/fcm-token', authenticateUser, async (req, res) => {
    try {
      const { token } = req.body;
      await User.findOneAndUpdate(
        { firebaseUid: req.user.uid },
        { fcmToken: token }
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/users', authenticateUser, async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const users = await User.find();
      res.json(users);
    } catch (error) {
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

    // Get users who have eaten
    const usersWhoAte = users.filter(user => user.hasEaten);
    
    // Send notifications to remaining users
    for (const user of remainingUsers) {
      const message = {
        notification: {
          title: "Food Finished!",
          body: `Food is finished. ${usersWhoAte.map(u => u.name).join(', ')} have eaten.`
        },
        token: user.fcmToken // You'll need to store FCM tokens for users
      };
      
      await admin.messaging().send(message);
    }

    // Send notifications to users who have eaten
    for (const user of usersWhoAte) {
      const message = {
        notification: {
          title: "Food Status",
          body: `${user.name} will be hungry tonight!`
        },
        token: user.fcmToken
      };
      
      await admin.messaging().send(message);
    }

    res.json({ message: "Notifications sent successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/schedule', authenticateUser, async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      let schedule = await Schedule.findOne();
      if (!schedule) {
        schedule = new Schedule();
        await schedule.save();
      }
      res.json(schedule);
    } catch (error) {
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
    res.status(500).json({ error: error.message });
  }
});

// Reset users' eaten status at midnight
const resetEatenStatus = async () => {
  await User.updateMany({}, { hasEaten: false });
};

// Schedule the reset job
const schedule = require('node-schedule');
schedule.scheduleJob('0 0 * * *', resetEatenStatus);

app.listen(port, () => {
  console.log(`Server is running on port: ${port}`);
});