# Automated MongoDB Backup System with Web UI

A production-ready Docker container that automatically backs up MongoDB databases with multiple backup schedules, comprehensive web dashboard, and minimal impact on database performance.

![Demo](https://github.com/jaaywags/automated-mongo-backup/blob/main/images/Demo.gif?raw=true)

## Features

- **Multi-Schedule Backups**: Daily, weekly, monthly, and yearly backup schedules
- **Web Dashboard**: Real-time backup monitoring and history viewing
- **Production-Safe**: Uses `--readPreference=secondaryPreferred` and `--numParallelCollections=1` for minimal database load
- **Smart Retention**: Configurable backup retention policies with automatic cleanup
- **Non-Overlapping Backups**: Prevents concurrent backup operations
- **Organized Storage**: Separate folders for daily/weekly/monthly/yearly backups
- **Detailed Tracking**: SQLite database tracks backup metadata, duration, and statistics
- **Backup-Specific Logging**: Each backup stores its own detailed logs in the database
- **Missing Backup Detection**: Automatically creates missing weekly/monthly/yearly backups on startup
- **Resource Limited**: Configurable CPU and memory limits
- **Unraid Compatible**: Easy deployment on Unraid servers

## Quick Start

### 1. Clone and Configure

```bash
git clone <repository-url>
cd automated-mongo-backup
cp .env.example .env
```

Edit `.env` file.

### 2. Run with Docker Compose

```bash
# Using pre-built image from Docker Hub
docker-compose up -d

# Or build locally by uncommenting the build line in docker-compose.yml
```

## Web Dashboard

Access the web dashboard at `http://localhost:3000` (or your server IP) to:

- **Monitor Current Backups**: See real-time backup progress
- **View Backup History**: Browse recent backups by type (daily/weekly/monthly/yearly)
- **Check Statistics**: View success rates, durations, and storage usage
- **Access Logs**: View detailed logs for each backup (success or failure)
- **Download Backups**: Download backup files as compressed tar.gz archives
- **Configure Display**: Show 5-30 recent backups per type

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `MONGO_CONNECTION_STRING` | MongoDB connection URI | - | ✅ |
| `DAILY_BACKUP_INTERVAL_MINUTES` | Daily backup frequency in minutes | `60` | ❌ |
| `MAX_DAILY_BACKUPS` | Max daily backups to keep (-1 = unlimited) | `24` | ❌ |
| `NUMBER_OF_WEEKLY_BACKUPS` | Weekly backups distributed over 7 days | `7` | ❌ |
| `MAX_AGE_OF_WEEKLY_BACKUPS` | Max age of weekly backups (weeks) | `4` | ❌ |
| `NUMBER_OF_MONTHLY_BACKUPS` | Monthly backups (1st of month) | `12` | ❌ |
| `MAX_AGE_OF_MONTHLY_BACKUPS` | Max age of monthly backups (months) | `12` | ❌ |
| `NUMBER_OF_YEARLY_BACKUPS` | Yearly backups (Jan 1st) | `5` | ❌ |
| `MAX_AGE_OF_YEARLY_BACKUPS` | Max age of yearly backups (years) | `5` | ❌ |
| `BACKUP_PATH` | Container path for backups | `/backups` | ❌ |
| `WEB_UI_PORT` | Web dashboard port | `3000` | ❌ |
| `TIMEZONE` | Timezone for scheduling | `UTC` | ❌ |

## MongoDB Connection String Examples

```bash
# Standard MongoDB
MONGO_CONNECTION_STRING=mongodb://username:password@localhost:27017/mydb

# MongoDB with authentication database
MONGO_CONNECTION_STRING=mongodb://username:password@localhost:27017/mydb?authSource=admin

# MongoDB Atlas
MONGO_CONNECTION_STRING=mongodb+srv://username:password@cluster.mongodb.net/mydb

# MongoDB Replica Set
MONGO_CONNECTION_STRING=mongodb://username:password@host1:27017,host2:27017,host3:27017/mydb?replicaSet=rs0
```

## Unraid Setup

### Method 1: Docker Compose Manager Plugin

1. Install **Docker Compose Manager** plugin from Community Applications
2. Create a new stack with the provided `docker-compose.yml`
3. Update environment variables in the compose file
4. Set volume path to your preferred backup location (e.g., `/mnt/user/backups/mongodb`)

### Method 2: Unraid Docker Template

1. Go to **Docker** tab in Unraid
2. Click **Add Container**
3. Configure as follows:

```
Name: mongodb-backup
Repository: jaaywags/automated-mongo-backup
Network Type: Bridge (or Host if MongoDB is on Unraid)

Environment Variables:
- MONGO_CONNECTION_STRING: mongodb://user:pass@192.168.1.100:27017/mydb
- DAILY_BACKUP_INTERVAL_MINUTES: 60
- MAX_DAILY_BACKUPS: 24
- NUMBER_OF_WEEKLY_BACKUPS: 7
- MAX_AGE_OF_WEEKLY_BACKUPS: 4
- WEB_UI_PORT: 3000
- TIMEZONE: America/New_York

Volume Mappings:
- Container Path: /backups
- Host Path: /mnt/user/backups/mongodb
- Access Mode: Read/Write

Port Mappings:
- Container Port: 3000
- Host Port: 3000
- Protocol: TCP

Resource Limits:
- CPU: 0.5
- Memory: 512MB
```

### Method 3: Command Line

```bash
docker run -d \
  --name mongodb-backup \
  --restart unless-stopped \
  -e MONGO_CONNECTION_STRING="mongodb://user:pass@host:27017/mydb" \
  -e DAILY_BACKUP_INTERVAL_MINUTES=60 \
  -e MAX_DAILY_BACKUPS=24 \
  -e NUMBER_OF_WEEKLY_BACKUPS=7 \
  -e WEB_UI_PORT=3000 \
  -v /mnt/user/backups/mongodb:/backups \
  -p 3000:3000 \
  --cpus="0.5" \
  --memory="512m" \
  mongo-backup
```

## Backup Structure

Backups are organized as follows:

```
/backups/
├── daily/
│   ├── 20250902_141500_MyDatabase_daily/
│   │   ├── MyDatabase/
│   │   │   ├── users.bson
│   │   │   ├── users.metadata.json
│   │   │   ├── orders.bson
│   │   │   └── orders.metadata.json
│   │   └── oplog.bson
│   └── 20250902_151500_MyDatabase_daily/
├── weekly/
│   └── 20250901_000000_MyDatabase_weekly/
├── monthly/
│   └── 20250801_000000_MyDatabase_monthly/
├── yearly/
│   └── 20250101_000000_MyDatabase_yearly/
├── backup_metadata.db
└── backup.log
```

## Production Considerations

### Performance Optimization

The backup system uses several MongoDB-specific optimizations:

- **`--readPreference=secondaryPreferred`**: Routes reads to secondary nodes when available
- **`--numParallelCollections=1`**: Limits concurrent collection backups
- **`--quiet`**: Reduces verbose output for cleaner logs
- **Resource limits**: Prevents backup process from overwhelming the system

### Security

- Runs as non-root user (`backup:nodejs`)
- Connection strings are redacted in logs
- No hardcoded credentials

### Monitoring

Check backup status:

```bash
# View logs
docker logs mongodb-backup

# Check backup files
ls -la /mnt/user/backups/mongodb/

# Monitor resource usage
docker stats mongodb-backup
```

## Troubleshooting

### Common Issues

**Connection Failed**
```bash
# Test MongoDB connectivity
docker exec mongodb-backup mongosh "your-connection-string" --eval "db.runCommand('ping')"
```

**Permission Denied**
```bash
# Fix backup directory permissions
sudo chown -R 1001:1001 /mnt/user/backups/mongodb
```

**High Memory Usage**
- Reduce `BACKUP_INTERVAL_MINUTES` for smaller, more frequent backups
- Increase memory limit in docker-compose.yml
- Consider backing up specific collections instead of entire database

### Logs Location

- Container logs: `docker logs mongodb-backup`
- Backup logs: `/mnt/user/backups/mongodb/backup.log`

## Restoration

To restore from a backup:

```bash
# Extract downloaded backup first
tar -xzf 20250902_141500_softgoods-stage.tar.gz

# Restore entire database
mongorestore --uri="mongodb://user:pass@host:27017" ./20250902_141500_softgoods-stage/

# Restore specific collection
mongorestore --uri="mongodb://user:pass@host:27017" --collection=users ./20250902_141500_softgoods-stage/softgoods-stage/users.bson
```

## License

MIT License - see LICENSE file for details.
