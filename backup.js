const { MongoClient } = require('mongodb');
const cron = require('node-cron');
const { exec } = require('child_process');
const winston = require('winston');
const fs = require('fs');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const moment = require('moment-timezone');

// Configure logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: '/backups/backup.log' })
  ]
});

// Environment variables
const MONGO_CONNECTION_STRING = process.env.MONGO_CONNECTION_STRING;
const DAILY_BACKUP_INTERVAL_MINUTES = parseInt(process.env.DAILY_BACKUP_INTERVAL_MINUTES) || 60;
const MAX_DAILY_BACKUPS = parseInt(process.env.MAX_DAILY_BACKUPS) || -1;
const NUMBER_OF_WEEKLY_BACKUPS = parseInt(process.env.NUMBER_OF_WEEKLY_BACKUPS) || 7;
const MAX_AGE_OF_WEEKLY_BACKUPS = parseInt(process.env.MAX_AGE_OF_WEEKLY_BACKUPS) || 4;
const NUMBER_OF_MONTHLY_BACKUPS = parseInt(process.env.NUMBER_OF_MONTHLY_BACKUPS) || 12;
const MAX_AGE_OF_MONTHLY_BACKUPS = parseInt(process.env.MAX_AGE_OF_MONTHLY_BACKUPS) || 12;
const NUMBER_OF_YEARLY_BACKUPS = parseInt(process.env.NUMBER_OF_YEARLY_BACKUPS) || 5;
const MAX_AGE_OF_YEARLY_BACKUPS = parseInt(process.env.MAX_AGE_OF_YEARLY_BACKUPS) || 5;
const BACKUP_PATH = process.env.BACKUP_PATH || '/backups';
const WEB_UI_PORT = parseInt(process.env.WEB_UI_PORT) || 3000;
const TIMEZONE = process.env.TIMEZONE || 'UTC';

// Global backup state
let isBackupRunning = false;
let currentBackupInfo = null;

// Validate required environment variables
if (!MONGO_CONNECTION_STRING) {
  logger.error('MONGO_CONNECTION_STRING environment variable is required');
  process.exit(1);
}

if (MAX_DAILY_BACKUPS === 0) {
  logger.error('MAX_DAILY_BACKUPS cannot be 0. Use -1 for unlimited or a positive number.');
  process.exit(1);
}

// Ensure backup directories exist
const backupDirs = ['daily', 'weekly', 'monthly', 'yearly'];
backupDirs.forEach(dir => {
  const fullPath = path.join(BACKUP_PATH, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
});

// Initialize SQLite database for backup metadata
const dbPath = path.join(BACKUP_PATH, 'backup_metadata.db');
const db = new sqlite3.Database(dbPath);

// Create backup metadata table
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    folder_name TEXT NOT NULL,
    database_name TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_seconds INTEGER,
    collections_count INTEGER,
    documents_count INTEGER,
    indexes_count INTEGER,
    error_message TEXT,
    backup_size_bytes INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // Add backup_logs column if it doesn't exist
  db.run(`ALTER TABLE backups ADD COLUMN backup_logs TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      logger.warn(`Could not add backup_logs column: ${err.message}`);
    }
  });
});

/**
 * Extract database name from MongoDB connection string
 */
function extractDatabaseName(connectionString) {
  try {
    const url = new URL(connectionString);
    const dbName = url.pathname.substring(1); // Remove leading slash
    return dbName || 'default';
  } catch (error) {
    logger.warn('Could not extract database name from connection string, using "default"');
    return 'default';
  }
}

/**
 * Generate backup folder name with timestamp and database name
 */
function generateBackupFolderName(dbName) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  
  return `${year}${month}${day}_${hour}${minute}${second}_${dbName}`;
}

/**
 * Test MongoDB connection
 */
async function testConnection() {
  try {
    const client = new MongoClient(MONGO_CONNECTION_STRING);
    await client.connect();
    const admin = client.db().admin();
    await admin.ping();
    await client.close();
    logger.info('MongoDB connection test successful');
    return true;
  } catch (error) {
    logger.error(`MongoDB connection test failed: ${error.message}`);
    return false;
  }
}

/**
 * Get backup statistics from mongodump output
 */
function parseBackupStats(stdout) {
  const stats = {
    collections: 0,
    documents: 0,
    indexes: 0
  };
  
  try {
    const lines = stdout.split('\n');
    lines.forEach(line => {
      if (line.includes('done dumping')) {
        stats.collections++;
      }
    });
  } catch (error) {
    logger.warn('Could not parse backup statistics');
  }
  
  return stats;
}

/**
 * Calculate directory size recursively
 */
function getDirectorySize(dirPath) {
  let totalSize = 0;
  
  try {
    const files = fs.readdirSync(dirPath);
    files.forEach(file => {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isDirectory()) {
        totalSize += getDirectorySize(filePath);
      } else {
        totalSize += stats.size;
      }
    });
  } catch (error) {
    logger.warn(`Error calculating directory size: ${error.message}`);
  }
  
  return totalSize;
}

/**
 * Save backup metadata to database
 */
function saveBackupMetadata(metadata) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`INSERT INTO backups 
      (timestamp, type, folder_name, database_name, status, duration_seconds, 
       collections_count, documents_count, indexes_count, error_message, backup_size_bytes, backup_logs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    
    stmt.run([
      metadata.timestamp,
      metadata.type,
      metadata.folderName,
      metadata.databaseName,
      metadata.status,
      metadata.duration,
      metadata.collections,
      metadata.documents,
      metadata.indexes,
      metadata.errorMessage,
      metadata.backupSize,
      metadata.backupLogs || ''
    ], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
    
    stmt.finalize();
  });
}

/**
 * Determine backup type based on schedule
 */
function determineBackupType() {
  const now = moment().tz(TIMEZONE);
  const hour = now.hour();
  const minute = now.minute();
  const dayOfMonth = now.date();
  const dayOfYear = now.dayOfYear();
  
  // Yearly backup (January 1st at midnight)
  if (NUMBER_OF_YEARLY_BACKUPS > 0 && dayOfYear === 1 && hour === 0 && minute === 0) {
    return 'yearly';
  }
  
  // Monthly backup (1st of month at midnight)
  if (NUMBER_OF_MONTHLY_BACKUPS > 0 && dayOfMonth === 1 && hour === 0 && minute === 0) {
    return 'monthly';
  }
  
  // Weekly backup (distributed throughout the week)
  if (NUMBER_OF_WEEKLY_BACKUPS > 0) {
    const backupsPerDay = NUMBER_OF_WEEKLY_BACKUPS / 7;
    const hoursPerBackup = 24 / backupsPerDay;
    
    if (minute === 0 && hour % Math.round(hoursPerBackup) === 0) {
      return 'weekly';
    }
  }
  
  return 'daily';
}

/**
 * Clean up old backups based on retention policies
 */
async function cleanupOldBackups(backupType) {
  try {
    if (backupType === 'daily' && MAX_DAILY_BACKUPS > 0) {
      const today = moment().tz(TIMEZONE).format('YYYY-MM-DD');
      
      db.all(`SELECT * FROM backups 
              WHERE type = 'daily' 
              AND status = 'success' 
              AND date(timestamp) = ? 
              ORDER BY timestamp DESC`, 
              [today], (err, rows) => {
        if (err) {
          logger.error(`Error querying daily backups: ${err.message}`);
          return;
        }
        
        if (rows.length > MAX_DAILY_BACKUPS) {
          const toDelete = rows.slice(MAX_DAILY_BACKUPS);
          toDelete.forEach(backup => {
            const backupPath = path.join(BACKUP_PATH, 'daily', backup.folder_name);
            if (fs.existsSync(backupPath)) {
              fs.rmSync(backupPath, { recursive: true, force: true });
              logger.info(`Deleted old daily backup: ${backup.folder_name}`);
            }
          });
        }
      });
    }
    
    // Clean up old weekly/monthly/yearly backups by age
    const ageConfigs = [
      { type: 'weekly', maxAge: MAX_AGE_OF_WEEKLY_BACKUPS, unit: 'weeks' },
      { type: 'monthly', maxAge: MAX_AGE_OF_MONTHLY_BACKUPS, unit: 'months' },
      { type: 'yearly', maxAge: MAX_AGE_OF_YEARLY_BACKUPS, unit: 'years' }
    ];
    
    ageConfigs.forEach(config => {
      if (backupType === config.type && config.maxAge > 0) {
        const cutoffDate = moment().tz(TIMEZONE).subtract(config.maxAge, config.unit).format('YYYY-MM-DD');
        
        db.all(`SELECT * FROM backups 
                WHERE type = ? 
                AND date(timestamp) < ?`, 
                [config.type, cutoffDate], (err, rows) => {
          if (err) return;
          
          rows.forEach(backup => {
            const backupPath = path.join(BACKUP_PATH, config.type, backup.folder_name);
            if (fs.existsSync(backupPath)) {
              fs.rmSync(backupPath, { recursive: true, force: true });
              logger.info(`Deleted old ${config.type} backup: ${backup.folder_name}`);
            }
          });
        });
      }
    });
    
  } catch (error) {
    logger.error(`Error during cleanup: ${error.message}`);
  }
}

/**
 * Perform MongoDB backup using mongodump
 */
async function performBackup(backupType = null) {
  if (isBackupRunning) {
    logger.warn('Backup already in progress, skipping this interval');
    return;
  }

  // Determine backup type if not specified
  if (!backupType) {
    backupType = determineBackupType();
  }

  isBackupRunning = true;
  const startTime = Date.now();
  const timestamp = moment().tz(TIMEZONE).format();
  const backupLogs = [];
  
  // Custom logger for this backup
  const backupLogger = {
    info: (msg) => {
      logger.info(msg);
      backupLogs.push(`[INFO] ${new Date().toISOString()}: ${msg}`);
    },
    warn: (msg) => {
      logger.warn(msg);
      backupLogs.push(`[WARN] ${new Date().toISOString()}: ${msg}`);
    },
    error: (msg) => {
      logger.error(msg);
      backupLogs.push(`[ERROR] ${new Date().toISOString()}: ${msg}`);
    }
  };
  
  try {
    backupLogger.info(`Starting ${backupType} MongoDB backup...`);
    
    const dbName = extractDatabaseName(MONGO_CONNECTION_STRING);
    const backupFolderName = generateBackupFolderName(dbName, backupType);
    const backupDir = path.join(BACKUP_PATH, backupType, backupFolderName);
    
    // Set current backup info for web UI
    currentBackupInfo = {
      type: backupType,
      folderName: backupFolderName,
      startTime: timestamp,
      status: 'running'
    };
    
    // Create backup directory
    fs.mkdirSync(backupDir, { recursive: true });
    backupLogger.info(`Created backup directory: ${backupDir}`);
    
    // Build mongodump command with production-safe options
    const mongodumpCmd = [
      'mongodump',
      `--uri="${MONGO_CONNECTION_STRING}"`,
      `--out="${backupDir}"`,
      '--readPreference=secondaryPreferred',
      '--numParallelCollections=1',
      '--quiet'
    ].join(' ');
    
    backupLogger.info(`Executing ${backupType} backup command`);
    
    // Execute mongodump
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      exec(mongodumpCmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    
    if (stderr) {
      backupLogger.warn(`Backup stderr: ${stderr}`);
    }
    
    if (stdout) {
      backupLogger.info(`Backup stdout: ${stdout}`);
    }
    
    const duration = Math.round((Date.now() - startTime) / 1000);
    const backupSize = getDirectorySize(backupDir);
    const stats = parseBackupStats(stdout);
    
    // Count actual collections from backup
    const dbDir = path.join(backupDir, dbName);
    let actualCollections = 0;
    if (fs.existsSync(dbDir)) {
      const files = fs.readdirSync(dbDir);
      actualCollections = files.filter(file => file.endsWith('.bson')).length;
      backupLogger.info(`Backed up ${actualCollections} collections`);
    }
    
    // Save metadata
    await saveBackupMetadata({
      timestamp,
      type: backupType,
      folderName: backupFolderName,
      databaseName: dbName,
      status: 'success',
      duration,
      collections: actualCollections,
      documents: stats.documents,
      indexes: stats.indexes,
      errorMessage: null,
      backupSize,
      backupLogs: backupLogs.join('\n')
    });
    
    backupLogger.info(`${backupType} backup completed successfully in ${duration} seconds. Collections: ${actualCollections}, Size: ${(backupSize / 1024 / 1024).toFixed(2)}MB`);
    
    // Cleanup old backups
    await cleanupOldBackups(backupType);
    
  } catch (error) {
    const duration = Math.round((Date.now() - startTime) / 1000);
    backupLogger.error(`${backupType} backup failed after ${duration} seconds: ${error.message}`);
    
    // Save failure metadata
    const dbName = extractDatabaseName(MONGO_CONNECTION_STRING);
    const backupFolderName = generateBackupFolderName(dbName, backupType);
    
    await saveBackupMetadata({
      timestamp,
      type: backupType,
      folderName: backupFolderName,
      databaseName: dbName,
      status: 'failed',
      duration,
      collections: 0,
      documents: 0,
      indexes: 0,
      errorMessage: error.message,
      backupSize: 0,
      backupLogs: backupLogs.join('\n')
    });
  } finally {
    isBackupRunning = false;
    currentBackupInfo = null;
  }
}

/**
 * Check if backups are needed for each type and create them
 */
async function checkAndCreateMissingBackups() {
  if (isBackupRunning) {
    logger.info('Backup in progress, will check for missing backups later...');
    setTimeout(() => checkAndCreateMissingBackups(), 30000); // Try again in 30 seconds
    return;
  }

  const now = moment().tz(TIMEZONE);
  
  // Check for missing weekly backup
  if (NUMBER_OF_WEEKLY_BACKUPS > 0) {
    const weekStart = now.clone().startOf('week');
    
    const weeklyResult = await new Promise((resolve) => {
      db.get(`SELECT COUNT(*) as count FROM backups 
              WHERE type = 'weekly' 
              AND status = 'success' 
              AND datetime(timestamp) >= datetime(?)`, 
              [weekStart.format()], (err, row) => {
        resolve(!err && row.count === 0);
      });
    });
    
    if (weeklyResult) {
      logger.info('No weekly backup found for this week, creating one now...');
      await performBackup('weekly');
    }
  }
  
  // Check for missing monthly backup
  if (NUMBER_OF_MONTHLY_BACKUPS > 0) {
    const monthStart = now.clone().startOf('month');
    
    const monthlyResult = await new Promise((resolve) => {
      db.get(`SELECT COUNT(*) as count FROM backups 
              WHERE type = 'monthly' 
              AND status = 'success' 
              AND datetime(timestamp) >= datetime(?)`, 
              [monthStart.format()], (err, row) => {
        resolve(!err && row.count === 0);
      });
    });
    
    if (monthlyResult) {
      logger.info('No monthly backup found for this month, creating one now...');
      await performBackup('monthly');
    }
  }
  
  // Check for missing yearly backup
  if (NUMBER_OF_YEARLY_BACKUPS > 0) {
    const yearStart = now.clone().startOf('year');
    
    const yearlyResult = await new Promise((resolve) => {
      db.get(`SELECT COUNT(*) as count FROM backups 
              WHERE type = 'yearly' 
              AND status = 'success' 
              AND datetime(timestamp) >= datetime(?)`, 
              [yearStart.format()], (err, row) => {
        resolve(!err && row.count === 0);
      });
    });
    
    if (yearlyResult) {
      logger.info('No yearly backup found for this year, creating one now...');
      await performBackup('yearly');
    }
  }
}

/**
 * Initialize and start the backup scheduler
 */
async function startBackupScheduler() {
  logger.info(`Starting MongoDB Backup Service`);
  logger.info(`Connection: ${MONGO_CONNECTION_STRING.replace(/\/\/.*@/, '//[REDACTED]@')}`);
  logger.info(`Daily Interval: ${DAILY_BACKUP_INTERVAL_MINUTES} minutes`);
  logger.info(`Backup Path: ${BACKUP_PATH}`);
  
  // Test connection first
  const connectionOk = await testConnection();
  if (!connectionOk) {
    logger.error('Cannot connect to MongoDB. Exiting...');
    process.exit(1);
  }
  
  // Create cron expression for daily backups
  const dailyCronExpression = `*/${DAILY_BACKUP_INTERVAL_MINUTES} * * * *`;
  
  logger.info(`Scheduling daily backups with cron expression: ${dailyCronExpression}`);
  
  // Schedule daily backup job
  cron.schedule(dailyCronExpression, async () => {
    await performBackup('daily');
  });
  
  // Schedule weekly backups (if enabled)
  if (NUMBER_OF_WEEKLY_BACKUPS > 0) {
    const backupsPerDay = NUMBER_OF_WEEKLY_BACKUPS / 7;
    const hoursPerBackup = 24 / backupsPerDay;
    const weeklyMinutes = Math.round(hoursPerBackup * 60);
    const weeklyCronExpression = `0 */${Math.round(hoursPerBackup)} * * *`;
    
    logger.info(`Scheduling ${NUMBER_OF_WEEKLY_BACKUPS} weekly backups with cron: ${weeklyCronExpression}`);
    cron.schedule(weeklyCronExpression, async () => {
      await performBackup('weekly');
    });
  }
  
  // Schedule monthly backups (1st of each month at midnight)
  if (NUMBER_OF_MONTHLY_BACKUPS > 0) {
    logger.info('Scheduling monthly backups on 1st of each month at midnight');
    cron.schedule('0 0 1 * *', async () => {
      await performBackup('monthly');
    });
  }
  
  // Schedule yearly backups (January 1st at midnight)
  if (NUMBER_OF_YEARLY_BACKUPS > 0) {
    logger.info('Scheduling yearly backups on January 1st at midnight');
    cron.schedule('0 0 1 1 *', async () => {
      await performBackup('yearly');
    });
  }
  
  // Check for missing backups and create them
  logger.info('Checking for missing backups...');
  setTimeout(() => {
    checkAndCreateMissingBackups();
  }, 5000); // Wait 5 seconds for database to be ready
  
  // Perform initial daily backup
  logger.info('Performing initial daily backup...');
  await performBackup('daily');
  
  logger.info('Backup scheduler started successfully');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

/**
 * Initialize Express web server
 */
function initializeWebServer() {
  const app = express();
  
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json());
  
  // Serve index.html at root path
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
  
  // API endpoint to get backup history
  app.get('/api/backups/:type?', (req, res) => {
    const backupType = req.params.type || 'daily';
    const limit = parseInt(req.query.limit) || 5;
    const maxLimit = Math.min(limit, 30);
    
    db.all(`SELECT * FROM backups 
            WHERE type = ? 
            ORDER BY timestamp DESC 
            LIMIT ?`, 
            [backupType, maxLimit], (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json(rows);
    });
  });
  
  // API endpoint to get backup statistics
  app.get('/api/stats/:type?', (req, res) => {
    const backupType = req.params.type || 'daily';
    
    db.all(`SELECT 
              COUNT(*) as total_backups,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_backups,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_backups,
              AVG(CASE WHEN status = 'success' THEN duration_seconds ELSE NULL END) as avg_duration,
              SUM(CASE WHEN status = 'success' THEN backup_size_bytes ELSE 0 END) as total_size
            FROM backups 
            WHERE type = ?`, 
            [backupType], (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      
      const stats = rows[0];
      let maxInfo = {};
      
      if (backupType === 'daily') {
        maxInfo = {
          max_backups: MAX_DAILY_BACKUPS,
          max_type: 'backups'
        };
      } else if (backupType === 'weekly') {
        maxInfo = {
          max_backups: MAX_AGE_OF_WEEKLY_BACKUPS,
          max_type: 'weeks'
        };
      } else if (backupType === 'monthly') {
        maxInfo = {
          max_backups: MAX_AGE_OF_MONTHLY_BACKUPS,
          max_type: 'months'
        };
      } else if (backupType === 'yearly') {
        maxInfo = {
          max_backups: MAX_AGE_OF_YEARLY_BACKUPS,
          max_type: 'years'
        };
      }
      
      res.json({
        total_successful_backups: stats.successful_backups || 0,
        total_failed_backups: stats.failed_backups || 0,
        max_backups: maxInfo.max_backups,
        max_type: maxInfo.max_type,
        total_available_successful_backups: stats.successful_backups || 0,
        average_duration_seconds: Math.round(stats.avg_duration || 0),
        total_size_mb: Math.round((stats.total_size || 0) / 1024 / 1024),
        database_name: extractDatabaseName(MONGO_CONNECTION_STRING)
      });
    });
  });
  
  // API endpoint to get current backup status
  app.get('/api/current', (req, res) => {
    res.json({
      isRunning: isBackupRunning,
      currentBackup: currentBackupInfo
    });
  });
  
  // API endpoint to get backup logs
  app.get('/api/logs/:backupId', (req, res) => {
    const backupId = req.params.backupId;
    
    db.get(`SELECT * FROM backups WHERE id = ?`, [backupId], (err, row) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      
      if (!row) {
        res.status(404).json({ error: 'Backup not found' });
        return;
      }
      
      // Return backup-specific logs from database
      const logs = row.backup_logs ? row.backup_logs.split('\n') : ['No logs available for this backup'];
      
      res.json({
        backup: row,
        logs: logs
      });
    });
  });
  
  // API endpoint to download backup files
  app.get('/api/download/:backupId', (req, res) => {
    const backupId = req.params.backupId;
    
    db.get(`SELECT * FROM backups WHERE id = ?`, [backupId], (err, row) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      
      if (!row) {
        res.status(404).json({ error: 'Backup not found' });
        return;
      }
      
      if (row.status !== 'success') {
        res.status(400).json({ error: 'Cannot download failed backup' });
        return;
      }
      
      const backupDir = path.join(BACKUP_PATH, row.type, row.folder_name);
      
      if (!fs.existsSync(backupDir)) {
        res.status(404).json({ error: 'Backup files not found on disk' });
        return;
      }
      
      // Create a tar.gz archive of the backup directory
      const archiver = require('archiver');
      const archive = archiver('tar', { gzip: true });
      
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${row.folder_name}.tar.gz"`);
      
      archive.pipe(res);
      archive.directory(backupDir, row.folder_name);
      
      archive.on('error', (err) => {
        logger.error(`Archive error: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to create archive' });
        }
      });
      
      archive.finalize();
    });
  });
  
  app.listen(WEB_UI_PORT, () => {
    logger.info(`Web UI server started on port ${WEB_UI_PORT}`);
  });
}

// Start the application
async function startApplication() {
  // Start web server first so it's immediately available
  initializeWebServer();
  
  // Then start backup scheduler (which includes initial backups)
  await startBackupScheduler();
}

startApplication().catch((error) => {
  logger.error(`Failed to start application: ${error.message}`);
  process.exit(1);
});
