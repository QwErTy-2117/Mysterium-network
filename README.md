# Mysterium Network

![Version](https://img.shields.io/badge/version-3.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)

**Distributed Encrypted Storage System**

A privacy-focused, distributed storage protocol that encrypts your files client-side, splits them into fragments, and distributes them across volunteer storage nodes worldwide. Your data is protected by military-grade double encryption.

![Your logo](M.png)

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Running a Storage Node](#running-a-storage-node)
- [Security Model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

Mysterium Network is a decentralized storage protocol that provides military-grade encryption and privacy through data fragmentation and distribution. Unlike traditional cloud storage, no single entity can access or reconstruct your files without your recovery key.

### How It Works

```
Original File (10MB)
    ↓
Master Encryption (AES-256-GCM) → Client-side Layer 1
    ↓
Optional Compression (zlib)
    ↓
Split into N Partitions (e.g., 10 parts)
    ↓
Reed-Solomon Error Correction (adds parity shards)
    ↓
Fragment Encryption (unique key per fragment) → Client-side Layer 2
    ↓
Distribute across N×R nodes (e.g., 10×3 = 30 fragments)
    ↓
Generate Recovery File (.myst) - contains all keys
```

---

## Features

### Core Features

- **Double Encryption**: Master key encrypts entire file, then each fragment gets unique encryption
- **Zero-Knowledge**: Storage nodes cannot decrypt or correlate fragments
- **Redundancy**: Configurable replication factor (default 3x)
- **Reed-Solomon Error Correction**: Recover files even if some fragments are lost
- **Automatic Compression**: Reduces bandwidth and storage (optional)
- **Geographic Distribution**: Fragments spread across different nodes/locations
- **Password Protection**: Optional password-based encryption for sensitive files

### Advanced Features

- **Configurable Partitioning**: Split files into custom number of parts
- **Master Password Support**: Optional password-based key derivation
- **Node Health Monitoring**: Real-time tracking of node availability
- **Integrity Verification**: SHA-256 checksums at multiple levels
- **Latency-Based Selection**: Automatically chooses fastest nodes
- **Bandwidth Optimization**: Parallel upload/download
- **Fragment Deduplication**: Avoids storing identical data

---

## Architecture

```
┌────────────────────────────────────────┐
│ Central Directory Server (Managed)     │
│ - Node registry and discovery          │
│ - Health monitoring                    │
│ - Fragment location tracking           │
│ - NOT run by individual users          │
└────────┬───────────────────┬───────────┘
         │                   │
┌────────┴────────┐ ┌────────┴────────┐
│ Storage Node    │ │ Storage Node    │
│ (Volunteer 1)   │ │ (Volunteer 2)   │
│ - Stores        │ │ - Stores        │
│   encrypted     │ │   encrypted     │
│   fragments     │ │   fragments     │
│ - Heartbeat     │ │ - Heartbeat     │
└─────────────────┘ └─────────────────┘
          ▲                 ▲
          │                 │
          └────────┬────────┘
                   │
           ┌───────┴────────┐
           │ Your Client    │
           │ - Upload       │
           │ - Download     │
           │ - Verify       │
           └────────────────┘
```

---

## Installation

### Prerequisites

- **Node.js**: v14.0.0 or higher
- **npm**: v6.0.0 or higher
- **Internet connection**

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/mysterium-network/mysterium-client.git
cd mysterium-client

# 2. Install dependencies
npm install

# 3. Verify installation
node client/client.js config
```

---

## Quick Start

```bash
# Check network status
node client/client.js stats

# Upload a file
node client/client.js upload myfile.pdf

# Download a file
node client/client.js download myfile.pdf.myst

# Verify fragment availability
node client/client.js verify myfile.pdf.myst
```

---

## Usage

### Client Commands

| Command | Description | Example |
|---------|-------------|---------|
| `upload` | Upload and encrypt a file | `node client/client.js upload myfile.pdf` |
| `download` | Download and decrypt a file | `node client/client.js download myfile.pdf.myst` |
| `info` | Show recovery file details | `node client/client.js info myfile.pdf.myst` |
| `verify` | Check fragment availability | `node client/client.js verify myfile.pdf.myst` |
| `stats` | Display network statistics | `node client/client.js stats` |
| `config` | Show current configuration | `node client/client.js config` |

### Upload Options

| Option | Short | Default | Description | Example |
|--------|-------|---------|-------------|---------|
| `--partitions <n>` | `-p` | 10 | Number of data partitions | `--partitions 5` |
| `--redundancy <n>` | `-r` | 3 | Redundancy multiplier | `--redundancy 4` |
| `--master-password <pwd>` | `-m` | none | Password protection | `--master-password "SecurePass123"` |
| `--no-compression` | | false | Disable compression | `--no-compression` |
| `--no-reed-solomon` | | false | Disable error correction | `--no-reed-solomon` |
| `--server <url>` | `-s` | auto | Directory server URL | `--server http://localhost:8080` |

### Download Options

| Option | Short | Default | Description | Example |
|--------|-------|---------|-------------|---------|
| `--output <path>` | `-o` | original name | Output file path | `--output recovered.pdf` |
| `--master-password <pwd>` | `-m` | none | Decryption password | `--master-password "SecurePass123"` |
| `--server <url>` | `-s` | auto | Directory server URL | `--server http://localhost:8080` |

### Data Flow

**Upload Process:**

1. Client reads file and calculates hash
2. Master encryption applied on YOUR device (Layer 1)
3. Optional compression
4. File split into N partitions
5. Reed-Solomon encoding adds parity shards
6. Each shard encrypted with unique key on YOUR device (Layer 2)
7. Client asks Directory Server for available storage nodes
8. Shards distributed to volunteer nodes worldwide
9. Recovery file (.myst) generated with all keys - STORED LOCALLY

**Download Process:**

1. Client reads recovery file from YOUR device
2. Client asks Directory Server where fragments are stored
3. Requests fragments from nodes (parallel)
4. Verifies fragment integrity (checksums)
5. Decrypts fragments with unique keys on YOUR device (Layer 2)
6. Reconstructs using Reed-Solomon if needed
7. Decompresses if applicable
8. Decrypts with master key on YOUR device (Layer 1)
9. Verifies final file hash

---

## Running a Storage Node

### Why Run a Storage Node?

-  Support the decentralized network
-  Earn reputation (higher uptime = better selection)
-  Privacy preserved (only encrypted fragments)
-  Share unused disk space

### Requirements

- **Disk Space**: 1GB - 1TB+ (configurable)
- **Bandwidth**: Stable internet connection
- **Uptime**: 24/7 recommended 
- **Open Port**: One port accessible from internet

### Quick Start

```bash
# Create storage directory
mkdir -p storage/node9001

# Start node (default 10GB max storage)
node storage-node/server.js 9001

# Or specify custom storage
node storage-node/server.js 9001 50  # 50GB max
```

### Run as Background Service

**Using PM2 (recommended):**

```bash
# Install PM2
npm install -g pm2

# Start node
pm2 start storage-node/server.js --name mysterium-node -- 9001

# Enable auto-restart on boot
pm2 startup
pm2 save

# View logs
pm2 logs mysterium-node
```

**Using screen (Linux/macOS):**

```bash
screen -S mysterium-node
node storage-node/server.js 9001
# Press Ctrl+A then D to detach
```

### Monitor Your Node

```bash
# Check node health
curl http://localhost:9001/health

# View network stats
node client/client.js stats
```

### Firewall Configuration

**Linux (ufw):**

```bash
sudo ufw allow 9001/tcp
sudo ufw enable
```

**Windows Firewall:**

```powershell
New-NetFirewallRule -DisplayName "Mysterium Node" `
  -Direction Inbound -LocalPort 9001 -Protocol TCP -Action Allow
```

---

## Security Model

### Double Encryption (Both Client-Side)

**Layer 1: Master Encryption**
- Algorithm: AES-256-GCM
- Applied to entire file before splitting
- Optional PBKDF2 key derivation from password (100,000 iterations)
- Key stored in recovery file (or derived from password)

**Layer 2: Fragment Encryption**
- Algorithm: AES-256-GCM per fragment
- Unique key for each fragment (including redundant copies)
- PBKDF2 with unique salt per fragment
- Total keys = partitions × redundancy (e.g., 10 × 3 = 30 unique keys)

### Security Guarantees

| Feature | Status |
|---------|--------|
| Confidentiality | ✅ Multi-layer AES-256-GCM encryption |
| Integrity | ✅ SHA-256 checksums at file and fragment level |
| Authenticity | ✅ GCM authentication tags prevent tampering |
| Availability | ✅ Redundancy + Reed-Solomon error correction |
| Privacy | ✅ Zero-knowledge architecture |
| Client-Side Control | ✅ All encryption/decryption on YOUR device |

### Threat Model

| Threat Scenario | Protected? | Details |
|----------------|------------|---------|
| Compromised storage node | ✅ Yes | Only has encrypted fragments |
| Malicious directory server | ✅ Yes | Never sees data or keys |
| Network eavesdropping | ✅ Yes | All data encrypted |
| Man-in-the-middle | ✅ Yes | Checksums verify integrity |
| Data tampering | ✅ Yes | GCM authentication tags |
| Multiple node compromise | ✅ Yes* | *Below Reed-Solomon threshold |
| Lost recovery file (.myst) | ❌ No | Data permanently lost |
| Forgotten password | ❌ No | No recovery possible |

### Recovery File (.myst)

The `.myst` file contains all information needed to reconstruct your file:

```json
{
  "version": "3.0",
  "fileName": "document.pdf",
  "fileHash": "sha256-hash-of-original",
  "originalSize": 2560000,
  "compressed": true,
  "reedSolomon": true,
  "security": {
    "doubleEncryption": true,
    "masterEncryption": {
      "algorithm": "AES-256-GCM",
      "key": "base64-key or null if password-protected",
      "passwordProtected": true
    },
    "fragmentEncryption": {
      "uniqueKeysPerFragment": true,
      "totalUniqueKeys": 30
    }
  },
  "partitions": [...]
}
```

### ⚠️ Critical Warnings

- Without the `.myst` file, data is **PERMANENTLY LOST**
- Backup `.myst` files in multiple secure locations
- If password-protected, master key is NOT stored
- No recovery service exists

---

## Troubleshooting

### Common Issues

#### "Cannot connect to directory server"

```bash
# Check network status
node client/client.js stats

# Verify configuration
node client/client.js config
```

#### "Not enough nodes available"

```bash
# Reduce requirements
node client/client.js upload file.pdf --partitions 5 --redundancy 2

# Check network status
node client/client.js stats
```

#### "Download failed: Incorrect password"

```bash
# Check if file is password-protected
node client/client.js info file.pdf.myst

# Note: Passwords are case-sensitive
```

#### "Fragment not found"

```bash
# Verify fragment availability
node client/client.js verify file.pdf.myst

# Reed-Solomon can recover with partial fragments
# If too many missing, file cannot be recovered
```

#### "Port already in use" (Storage Node)

```bash
# Use different port
node storage-node/server.js 9002

# Or kill process using port
# Linux/Mac:
lsof -ti:9001 | xargs kill

# Windows:
netstat -ano | findstr :9001
taskkill /PID <PID> /F
```

### Debug Mode

```bash
# Windows
set DEBUG=mysterium:*
node client/client.js upload test.txt

# Linux/Mac
DEBUG=mysterium:* node client/client.js upload test.txt
```

---

## ❤️ Donate

Support the project:

**BTC**: `bc1q3pz8yy8qsmp50p28xa9ksds4ms00ke80zyxf5q`

---

## License

This project is licensed under the MIT License.
