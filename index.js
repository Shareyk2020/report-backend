/**
 * index.js — Report & Moderation Backend for AI Photo Enhancer
 *
 * Handles:
 * - Submissions of flagged/reported AI content from ReportContentModal
 * - Querying, reviewing, and updating reports (Moderation dashboard APIs)
 * - Safe persistence: MongoDB (Mongoose) with automatic local JSON fallback
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 5001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ai-photo-reports';

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Simple Request Logger (skips ping to keep logs clean)
app.use((req, res, next) => {
  if (req.originalUrl === '/ping' || req.originalUrl === '/health' || req.originalUrl === '/api/ping') {
    return next();
  }
  const time = new Date().toISOString();
  console.log(`[${time}] ${req.method} ${req.originalUrl}`);
  next();
});

// ─── Local File Fallback Storage ────────────────────────────────────────────
// Ensures reports are NEVER lost even if MongoDB is not running locally.
const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_FILE = path.join(DATA_DIR, 'reports_backup.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readLocalBackup() {
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      const raw = fs.readFileSync(BACKUP_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('⚠️ Could not read local backup:', err.message);
  }
  return [];
}

function saveLocalBackup(reports) {
  try {
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(reports, null, 2), 'utf-8');
  } catch (err) {
    console.error('⚠️ Could not save local backup:', err.message);
  }
}

// ─── Database Setup (MongoDB / Mongoose) ─────────────────────────────────────
let mongoose;
let isMongoConnected = false;
let ReportModel = null;

try {
  mongoose = require('mongoose');

  const reportSchema = new mongoose.Schema(
    {
      reason: {
        type: String,
        required: [true, 'Report reason is required'],
        enum: {
          values: ['nsfw', 'hate', 'violence', 'offensive_ai', 'privacy', 'other'],
          message: '{VALUE} is not a valid report reason',
        },
      },
      details: {
        type: String,
        default: '',
        trim: true,
        maxlength: [1000, 'Details cannot exceed 1000 characters'],
      },
      imageUri: {
        type: String,
        default: null,
      },
      platform: {
        type: String,
        default: 'unknown',
      },
      reporterIp: {
        type: String,
        default: null,
      },
      status: {
        type: String,
        enum: ['pending', 'in_review', 'resolved', 'dismissed'],
        default: 'pending',
      },
      reviewNotes: {
        type: String,
        default: '',
      },
      reportedAt: {
        type: Date,
        default: Date.now,
      },
    },
    {
      timestamps: true,
    }
  );

  ReportModel = mongoose.model('Report', reportSchema);

  // Connect to MongoDB
  mongoose
    .connect(MONGO_URI)
    .then(() => {
      isMongoConnected = true;
      console.log(`🌿 Connected to MongoDB for Reports: ${MONGO_URI}`);
    })
    .catch((err) => {
      isMongoConnected = false;
      console.warn(`⚠️ MongoDB connection warning: ${err.message}`);
      console.log(`📁 Falling back to local storage (${BACKUP_FILE}). All reports will still be safely saved.`);
    });

  mongoose.connection.on('disconnected', () => {
    isMongoConnected = false;
    console.warn('⚠️ MongoDB disconnected. Using local storage fallback.');
  });

  mongoose.connection.on('reconnected', () => {
    isMongoConnected = true;
    console.log('🌿 MongoDB reconnected successfully.');
  });
} catch (e) {
  console.warn('⚠️ Mongoose not available or failed to load. Using file storage mode.');
}

// ─── Helper Functions ───────────────────────────────────────────────────────
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket ? req.socket.remoteAddress : null;
}

// ─── API Routes ─────────────────────────────────────────────────────────────

// Ultra-lightweight Ping / Keep-Alive Endpoint (0 DB queries, instant 200 OK)
app.get(['/ping', '/health', '/api/ping'], (req, res) => {
  res.status(200).send('pong');
});

// Health Check & Documentation
app.get(['/', '/api'], (req, res) => {
  res.json({
    service: 'AI Photo Enhancer — Report & Moderation Backend',
    status: 'online',
    database: isMongoConnected ? 'MongoDB (Connected)' : 'Local File Storage (Active)',
    endpoints: {
      ping: 'GET /ping (Keep-alive, instant pong)',
      submitReport: 'POST /api/reports',
      listReports: 'GET /api/reports',
      getReportById: 'GET /api/reports/:id',
      updateStatus: 'PATCH /api/reports/:id',
      deleteReport: 'DELETE /api/reports/:id',
      stats: 'GET /api/reports/stats/summary',
    },
  });
});

/**
 * POST /api/reports & POST /reports
 * Primary endpoint called from the mobile app (ReportContentModal)
 *
 * Request Body:
 * {
 *   reason: "nsfw" | "hate" | "violence" | "offensive_ai" | "privacy" | "other",
 *   details: "optional text...",
 *   imageUri: "optional image URI or base64 preview...",
 *   platform: "ios" | "android" | "web",
 *   timestamp: "2026-10-31T06:00:00.000Z" (optional)
 * }
 */
app.post(['/api/reports', '/reports'], async (req, res) => {
  try {
    const { reason, details, imageUri, platform, timestamp } = req.body;

    // Validate required fields
    if (!reason || typeof reason !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'A valid "reason" field is required (e.g., nsfw, hate, violence, offensive_ai, privacy, other).',
      });
    }

    const reportData = {
      reason: reason.trim().toLowerCase(),
      details: details ? String(details).trim() : '',
      imageUri: imageUri || null,
      platform: platform || 'unknown',
      reporterIp: getClientIp(req),
      status: 'pending',
      reviewNotes: '',
      reportedAt: timestamp ? new Date(timestamp) : new Date(),
    };

    let savedReport;

    if (isMongoConnected && ReportModel) {
      // Save directly to MongoDB
      const doc = new ReportModel(reportData);
      savedReport = await doc.save();
    } else {
      // Save to local backup JSON
      const localReports = readLocalBackup();
      savedReport = {
        _id: 'rep_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
        ...reportData,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      localReports.unshift(savedReport);
      saveLocalBackup(localReports);
    }

    console.log(`🚩 [NEW REPORT RECORDED]: [${savedReport.reason}] ID: ${savedReport._id}`);

    return res.status(201).json({
      success: true,
      message: 'Report submitted successfully. Our moderation team will review this content.',
      reportId: savedReport._id,
      report: savedReport,
    });
  } catch (error) {
    console.error('❌ Error handling report submission:', error);
    return res.status(500).json({
      success: false,
      error: 'Server Error',
      message: error.message || 'Failed to submit report. Please try again later.',
    });
  }
});

/**
 * GET /api/reports & GET /reports
 * Retrieve all reports with optional filters (for moderation panel)
 * Query params: ?status=pending&reason=nsfw&limit=20&page=1
 */
app.get(['/api/reports', '/reports'], async (req, res) => {
  try {
    const { status, reason, platform, limit = 50, page = 1 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    if (isMongoConnected && ReportModel) {
      const query = {};
      if (status) query.status = status;
      if (reason) query.reason = reason;
      if (platform) query.platform = platform;

      const [reports, total] = await Promise.all([
        ReportModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
        ReportModel.countDocuments(query),
      ]);

      return res.json({
        success: true,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
        data: reports,
      });
    } else {
      // Local storage querying
      let reports = readLocalBackup();
      if (status) reports = reports.filter((r) => r.status === status);
      if (reason) reports = reports.filter((r) => r.reason === reason);
      if (platform) reports = reports.filter((r) => r.platform === platform);

      const total = reports.length;
      const paginated = reports.slice(skip, skip + limitNum);

      return res.json({
        success: true,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
        data: paginated,
      });
    }
  } catch (error) {
    console.error('❌ Error fetching reports:', error);
    return res.status(500).json({
      success: false,
      error: 'Server Error',
      message: error.message,
    });
  }
});

/**
 * GET /api/reports/stats/summary
 * Overview statistics of submitted reports
 */
app.get(['/api/reports/stats/summary', '/reports/stats/summary'], async (req, res) => {
  try {
    if (isMongoConnected && ReportModel) {
      const [total, pending, inReview, resolved, dismissed, byReason] = await Promise.all([
        ReportModel.countDocuments(),
        ReportModel.countDocuments({ status: 'pending' }),
        ReportModel.countDocuments({ status: 'in_review' }),
        ReportModel.countDocuments({ status: 'resolved' }),
        ReportModel.countDocuments({ status: 'dismissed' }),
        ReportModel.aggregate([{ $group: { _id: '$reason', count: { $sum: 1 } } }]),
      ]);

      const reasonsMap = {};
      byReason.forEach((item) => {
        reasonsMap[item._id] = item.count;
      });

      return res.json({
        success: true,
        stats: {
          total,
          pending,
          inReview,
          resolved,
          dismissed,
          reasons: reasonsMap,
        },
      });
    } else {
      const reports = readLocalBackup();
      const reasonsMap = {};
      let pending = 0;
      let inReview = 0;
      let resolved = 0;
      let dismissed = 0;

      reports.forEach((r) => {
        reasonsMap[r.reason] = (reasonsMap[r.reason] || 0) + 1;
        if (r.status === 'pending') pending++;
        else if (r.status === 'in_review') inReview++;
        else if (r.status === 'resolved') resolved++;
        else if (r.status === 'dismissed') dismissed++;
      });

      return res.json({
        success: true,
        stats: {
          total: reports.length,
          pending,
          inReview,
          resolved,
          dismissed,
          reasons: reasonsMap,
        },
      });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/reports/:id
 * Retrieve a specific report by ID
 */
app.get(['/api/reports/:id', '/reports/:id'], async (req, res) => {
  try {
    const { id } = req.params;

    if (isMongoConnected && ReportModel) {
      const report = await ReportModel.findById(id);
      if (!report) {
        return res.status(404).json({ success: false, message: 'Report not found' });
      }
      return res.json({ success: true, data: report });
    } else {
      const reports = readLocalBackup();
      const found = reports.find((r) => String(r._id) === String(id));
      if (!found) {
        return res.status(404).json({ success: false, message: 'Report not found' });
      }
      return res.json({ success: true, data: found });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * PATCH /api/reports/:id
 * Update status (e.g. resolve, dismiss, review) or add review notes
 * Body: { status: "resolved", reviewNotes: "Image removed from dataset" }
 */
app.patch(['/api/reports/:id', '/reports/:id'], async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reviewNotes } = req.body;

    const validStatuses = ['pending', 'in_review', 'resolved', 'dismissed'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      });
    }

    if (isMongoConnected && ReportModel) {
      const updates = {};
      if (status) updates.status = status;
      if (reviewNotes !== undefined) updates.reviewNotes = reviewNotes;

      const updated = await ReportModel.findByIdAndUpdate(id, updates, { new: true });
      if (!updated) {
        return res.status(404).json({ success: false, message: 'Report not found' });
      }
      return res.json({ success: true, message: 'Report updated successfully', data: updated });
    } else {
      const reports = readLocalBackup();
      const index = reports.findIndex((r) => String(r._id) === String(id));
      if (index === -1) {
        return res.status(404).json({ success: false, message: 'Report not found' });
      }

      if (status) reports[index].status = status;
      if (reviewNotes !== undefined) reports[index].reviewNotes = reviewNotes;
      reports[index].updatedAt = new Date().toISOString();

      saveLocalBackup(reports);
      return res.json({ success: true, message: 'Report updated successfully', data: reports[index] });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * DELETE /api/reports/:id
 * Delete a report
 */
app.delete(['/api/reports/:id', '/reports/:id'], async (req, res) => {
  try {
    const { id } = req.params;

    if (isMongoConnected && ReportModel) {
      const deleted = await ReportModel.findByIdAndDelete(id);
      if (!deleted) {
        return res.status(404).json({ success: false, message: 'Report not found' });
      }
      return res.json({ success: true, message: 'Report deleted successfully' });
    } else {
      let reports = readLocalBackup();
      const exists = reports.some((r) => String(r._id) === String(id));
      if (!exists) {
        return res.status(404).json({ success: false, message: 'Report not found' });
      }
      reports = reports.filter((r) => String(r._id) !== String(id));
      saveLocalBackup(reports);
      return res.json({ success: true, message: 'Report deleted successfully' });
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ─── 404 & Global Error Handler ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, next) => {
  console.error('🔥 Unhandled Exception:', err);
  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred.',
  });
});

// ─── Start Server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🛡️  Report & Moderation Backend is LIVE on port ${PORT}`);
  console.log(`🌐 Base URL:   http://localhost:${PORT}`);
  console.log(`🏓 Ping:       GET  http://localhost:${PORT}/ping`);
  console.log(`📥 Submit:     POST http://localhost:${PORT}/api/reports`);
  console.log(`📊 View All:   GET  http://localhost:${PORT}/api/reports`);
  console.log(`📈 Summary:    GET  http://localhost:${PORT}/api/reports/stats/summary`);
  console.log(`💾 Storage:    ${isMongoConnected ? 'MongoDB' : 'Local File Fallback (Active)'}`);
  console.log(`==================================================\n`);

  // Start 5-minute Keep-Alive auto-ping (prevents Render free tier from sleeping)
  startKeepAlive();
});

// ─── Render Keep-Alive / Auto-Ping (Every 5 Minutes) ────────────────────────
// Render free tier automatically spins down after 15 minutes of inactivity.
// This auto-pings /ping every 5 minutes so the server stays active 24/7.
function startKeepAlive() {
  const PING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  const targetHost =
    process.env.RENDER_EXTERNAL_URL ||
    process.env.SERVER_URL ||
    `http://localhost:${PORT}`;

  const pingUrl = `${targetHost.replace(/\/$/, '')}/ping`;
  console.log(`⏰ Keep-Alive scheduler started: Pinging ${pingUrl} every 5 minutes`);

  setInterval(() => {
    try {
      const parsed = new URL(pingUrl);
      const client = parsed.protocol === 'https:' ? https : http;

      const req = client.get(pingUrl, (res) => {
        res.resume(); // Consume response data to prevent memory leak
        const timeStr = new Date().toLocaleTimeString();
        console.log(`[Keep-Alive ⏰ ${timeStr}]: Ping OK (${res.statusCode})`);
      });

      req.on('error', (err) => {
        console.warn(`[Keep-Alive Warning]: Could not ping server:`, err.message);
      });

      req.setTimeout(10000, () => {
        req.destroy();
      });
    } catch (err) {
      console.warn(`[Keep-Alive Error]:`, err.message);
    }
  }, PING_INTERVAL_MS);
}

module.exports = app;

