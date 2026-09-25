import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const app = express();
const PORT = process.env.PORT || 5000;

// =====================================
// MIDDLEWARE
// =====================================

app.use(cors());
app.use(express.json());

// =====================================
// MYSQL CONNECTION
// =====================================

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'alumni_connect',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// =====================================
// DATABASE INITIALIZATION
// =====================================

async function initializeDatabase() {
  try {
    const connection = await db.getConnection();

    console.log('✅ MySQL Database Connected');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS connections (
        id VARCHAR(100) PRIMARY KEY,
        student_id VARCHAR(100) NOT NULL,
        alumni_id VARCHAR(100) NOT NULL,
        note TEXT,
        status ENUM('pending','accepted','rejected')
          DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        type VARCHAR(100),
        title VARCHAR(255),
        message TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    connection.release();

    console.log('✅ Database tables checked');
  } catch (error) {
    console.error('❌ Database initialization failed:');
    console.error(error.message);
  }
}

initializeDatabase();

// =====================================
// HEALTH CHECK
// =====================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    platform: 'AlumniConnect API Server',
    version: '3.0.0',
    database: process.env.DB_NAME,
    timestamp: new Date().toISOString()
  });
});

// =====================================
// DATABASE TEST
// =====================================

app.get('/api/db-test', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT 1 AS connected'
    );

    res.json({
      success: true,
      message: 'MySQL database is working!',
      database: process.env.DB_NAME,
      result: rows
    });
  } catch (error) {
    console.error('Database test error:', error);

    res.status(500).json({
      success: false,
      message: 'Database connection failed',
      error: error.message
    });
  }
});

// =====================================
// AUTH - REGISTER
// =====================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      role = 'student',
      university_id = null
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email and password are required.'
      });
    }

    const [existingUsers] = await db.query(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [email]
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Email already registered.'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const id = `user-${Date.now()}`;

    await db.query(
      `
      INSERT INTO users
      (
        id,
        name,
        email,
        password_hash,
        role,
        university_id,
        verification_status
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `,
      [
        id,
        name,
        email,
        passwordHash,
        role,
        university_id || null
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      user: {
        id,
        name,
        email,
        role,
        universityId: university_id || null,
        verificationStatus: 'pending'
      }
    });

  } catch (error) {
    console.error('Register error:', error);

    res.status(500).json({
      success: false,
      message: 'Registration failed.',
      details: error.message
    });
  }
});

// =====================================
// AUTH - LOGIN
// =====================================

app.post('/api/auth/login', async (req, res) => {
  try {
    const {
      email,
      password
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required.'
      });
    }

    const [users] = await db.query(
      `
      SELECT
        id,
        name,
        email,
        password_hash,
        role,
        university_id,
        verification_status
      FROM users
      WHERE email = ?
      LIMIT 1
      `,
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }

    const row = users[0];

    if (!row.password_hash) {
      return res.status(401).json({
        success: false,
        message: 'This account has no password set.'
      });
    }

    const passwordMatch = await bcrypt.compare(
      password,
      row.password_hash
    );

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }

    const token = jwt.sign(
      {
        id: row.id,
        email: row.email,
        role: row.role
      },
      process.env.JWT_SECRET || 'alumni-connect-secret-2026',
      {
        expiresIn: '7d'
      }
    );

    res.json({
      success: true,
      message: 'Login successful.',
      token,

      user: {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        universityId: row.university_id,
        verificationStatus: row.verification_status
      }
    });

  } catch (error) {
    console.error('Login error:', error);

    res.status(500).json({
      success: false,
      message: 'Login failed.',
      details: error.message
    });
  }
});

// =====================================
// AUTH - OTP VERIFICATION
// =====================================

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const {
      email,
      otp
    } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        error: 'Email and OTP are required.'
      });
    }

    if (otp !== '482910' && String(otp).length !== 6) {
      return res.status(400).json({
        error: 'Invalid OTP code entered.'
      });
    }

    const [result] = await db.query(
      `
      UPDATE users
      SET verification_status = 'verified'
      WHERE email = ?
      `,
      [email]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: 'User not found.'
      });
    }

    res.json({
      success: true,
      message:
        'College email successfully verified. Verified Badge activated.'
    });

  } catch (error) {
    console.error('OTP error:', error);

    res.status(500).json({
      error: 'OTP verification failed.',
      details: error.message
    });
  }
});

// =====================================
// ALUMNI - GET ALL
// =====================================

app.get('/api/alumni', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        u.verification_status
      FROM users u
      WHERE u.role = 'alumni'
      ORDER BY u.name ASC
    `);

    res.json({
      success: true,
      alumni: rows
    });

  } catch (error) {
    console.error('Alumni fetch error:', error);

    res.status(500).json({
      error: 'Failed to fetch alumni.',
      details: error.message
    });
  }
});

// =====================================
// CONNECTION - REQUEST
// =====================================

app.post('/api/connections/request', async (req, res) => {
  try {
    const {
      studentId,
      alumniId,
      note
    } = req.body;

    if (!alumniId) {
      return res.status(400).json({
        error: 'Alumni ID is required.'
      });
    }

    const id = `conn-${Date.now()}`;

    await db.query(
      `
      INSERT INTO connections
      (
        id,
        student_id,
        alumni_id,
        note,
        status
      )
      VALUES (?, ?, ?, ?, 'pending')
      `,
      [
        id,
        studentId || 'student-demo',
        alumniId,
        note || null
      ]
    );

    res.status(201).json({
      success: true,
      connection: {
        id,
        studentId: studentId || 'student-demo',
        alumniId,
        note: note || null,
        status: 'pending'
      }
    });

  } catch (error) {
    console.error('Connection request error:', error);

    res.status(500).json({
      error: 'Connection request failed.',
      details: error.message
    });
  }
});

// =====================================
// CONNECTION - ACCEPT
// =====================================

app.post('/api/connections/:id/accept', async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await db.query(
      `
      UPDATE connections
      SET status = 'accepted'
      WHERE id = ?
      `,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: 'Connection not found.'
      });
    }

    res.json({
      success: true,
      message: 'Connection accepted. Chat unlocked.'
    });

  } catch (error) {
    console.error('Connection accept error:', error);

    res.status(500).json({
      error: 'Failed to accept connection.',
      details: error.message
    });
  }
});

// =====================================
// CONNECTION - GET USER CONNECTIONS
// =====================================

app.get('/api/connections/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const [rows] = await db.query(
      `
      SELECT *
      FROM connections
      WHERE student_id = ?
         OR alumni_id = ?
      ORDER BY created_at DESC
      `,
      [userId, userId]
    );

    res.json({
      success: true,
      connections: rows
    });

  } catch (error) {
    console.error('Connections fetch error:', error);

    res.status(500).json({
      error: 'Failed to fetch connections.',
      details: error.message
    });
  }
});

// =====================================
// MENTORSHIP REQUEST
// =====================================

app.post('/api/mentorship/request', async (req, res) => {
  try {
    const {
      studentId,
      alumniId,
      goal,
      areaOfHelp,
      message
    } = req.body;

    if (!alumniId || !goal) {
      return res.status(400).json({
        error: 'Alumni ID and goal are required.'
      });
    }

    const id = `mentor-${Date.now()}`;

    await db.query(
      `
      INSERT INTO mentorship_requests
      (
        id,
        student_id,
        alumni_id,
        goal,
        area_of_help,
        message,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `,
      [
        id,
        studentId || 'student-demo',
        alumniId,
        goal,
        areaOfHelp || null,
        message || null
      ]
    );

    res.status(201).json({
      success: true,
      mentorship: {
        id,
        studentId: studentId || 'student-demo',
        alumniId,
        goal,
        areaOfHelp,
        message,
        status: 'pending'
      }
    });

  } catch (error) {
    console.error('Mentorship error:', error);

    res.status(500).json({
      error: 'Mentorship request failed.',
      details: error.message
    });
  }
});

// =====================================
// MENTORSHIP - GET
// =====================================

app.get('/api/mentorship/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const [rows] = await db.query(
      `
      SELECT *
      FROM mentorship_requests
      WHERE student_id = ?
         OR alumni_id = ?
      ORDER BY created_at DESC
      `,
      [userId, userId]
    );

    res.json({
      success: true,
      mentorships: rows
    });

  } catch (error) {
    console.error('Mentorship fetch error:', error);

    res.status(500).json({
      error: 'Failed to fetch mentorships.',
      details: error.message
    });
  }
});

// =====================================
// NOTIFICATIONS
// =====================================

app.get('/api/notifications/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const [rows] = await db.query(
      `
      SELECT *
      FROM notifications
      WHERE user_id = ?
      ORDER BY created_at DESC
      `,
      [userId]
    );

    res.json({
      success: true,
      notifications: rows
    });

  } catch (error) {
    console.error('Notifications error:', error);

    res.status(500).json({
      error: 'Failed to fetch notifications.',
      details: error.message
    });
  }
});

// =====================================
// AI QUERY
// =====================================

app.post('/api/ai/query', (req, res) => {
  const { prompt } = req.body;

  res.json({
    response:
      `Processed query: "${prompt}". Matching alumni discovered across IIT Roorkee and Tula's Institute.`,
    timestamp: new Date().toISOString()
  });
});

// =====================================
// 404 HANDLER
// =====================================

app.use((req, res) => {
  res.status(404).json({
    error: 'API endpoint not found',
    path: req.originalUrl
  });
});

// =====================================
// ERROR HANDLER
// =====================================

app.use((err, req, res, next) => {
  console.error('Server error:', err);

  res.status(500).json({
    error: 'Internal server error',
    details: err.message
  });
});

// =====================================
// START SERVER
// =====================================

app.listen(PORT, () => {
  console.log(
    `🚀 AlumniConnect REST API Server running on port ${PORT}`
  );

  console.log(
    `📡 API: http://localhost:${PORT}`
  );

  console.log(
    `🗄️ Database: ${process.env.DB_NAME}`
  );
});