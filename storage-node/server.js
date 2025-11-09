const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const chalk = require('chalk');
const compression = require('compression');
const checkDiskSpace = require('check-disk-space').default;
const publicIp = require('public-ip');
const ora = require('ora');
const constants = require('../shared/constants');
const config = require('../config');

class StorageNode {
    constructor(nodeConfig = {}) {
        this.app = express();
        
        const port = nodeConfig.port || config.storageNode.defaultPort;
        const storagePath = path.resolve(nodeConfig.storagePath || `./storage/node${port}`);
        
        this.config = {
            port: port,
            directoryServer: nodeConfig.directoryServer || config.directoryServer.url,
            storagePath: storagePath,
            maxStorage: nodeConfig.maxStorage || (config.storageNode.maxStorageGB * 1024 * 1024 * 1024),
            publicKey: nodeConfig.publicKey || this.generateKeyPair().publicKey,
            usePublicIp: nodeConfig.usePublicIp !== false
        };
        
        this.nodeId = null;
        this.publicIp = null;
        this.fragments = new Map();
        this.usedSpace = 0;
        this.nodeIdFilePath = path.join(this.config.storagePath, 'node_id.json');
        
        this.setupMiddleware();
        this.setupRoutes();
        this.initialize();
    }
    
    generateKeyPair() {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        return { publicKey, privateKey };
    }
    
    setupMiddleware() {
        this.app.use(compression());
        this.app.use(express.json({ limit: '50mb' }));
        this.app.use(express.raw({ 
            type: 'application/octet-stream', 
            limit: '50mb' 
        }));
    }
    
    setupRoutes() {
        this.app.get('/health', async (req, res) => {
            const availableSpace = await this.getAvailableSpace();
            const diskInfo = await this.getDiskInfo();
            
            res.json({
                status: 'active',
                nodeId: this.nodeId,
                publicIp: this.publicIp,
                availableSpace: availableSpace,
                usedSpace: this.usedSpace,
                fragments: this.fragments.size,
                uptime: process.uptime(),
                directoryServer: this.config.directoryServer,
                diskInfo: {
                    actualFree: diskInfo.free,
                    total: diskInfo.size,
                    used: diskInfo.size - diskInfo.free,
                    configuredMax: this.config.maxStorage
                }
            });
        });
        
        this.app.post('/store', async (req, res) => {
            try {
                const { fragmentId, data, checksum, metadata } = req.body;
                
                const fragmentSize = Buffer.from(data, 'base64').length;
                const availableSpace = await this.getAvailableSpace();
                
                if (fragmentSize > availableSpace) {
                    return res.status(507).json({
                        success: false,
                        message: 'Insufficient storage space',
                        required: fragmentSize,
                        available: availableSpace
                    });
                }
                
                const calculatedChecksum = crypto
                    .createHash('sha256')
                    .update(Buffer.from(data, 'base64'))
                    .digest('hex');
                
                if (calculatedChecksum !== checksum) {
                    return res.status(400).json({
                        success: false,
                        message: 'Checksum mismatch'
                    });
                }
                
                const fragmentPath = path.join(
                    this.config.storagePath,
                    `${fragmentId}.frag`
                );
                
                await fs.writeFile(fragmentPath, data, 'base64');
                
                this.fragments.set(fragmentId, {
                    path: fragmentPath,
                    size: fragmentSize,
                    checksum,
                    metadata,
                    storedAt: Date.now(),
                    accessCount: 0
                });
                
                this.usedSpace += fragmentSize;
                
                this.reportFragmentStorage(fragmentId, metadata);
                
                console.log(chalk.green(`Stored fragment: ${fragmentId} (${(fragmentSize / 1024).toFixed(2)} KB)`));
                
                res.json({
                    success: true,
                    fragmentId,
                    size: fragmentSize
                });
            } catch (error) {
                console.error(chalk.red(`Error storing fragment:`, error));
                res.status(500).json({
                    success: false,
                    message: error.message
                });
            }
        });
        
        this.app.get('/retrieve/:fragmentId', async (req, res) => {
            try {
                const { fragmentId } = req.params;
                
                if (!this.fragments.has(fragmentId)) {
                    return res.status(404).json({
                        success: false,
                        message: 'Fragment not found'
                    });
                }
                
                const fragment = this.fragments.get(fragmentId);
                fragment.accessCount++;
                fragment.lastAccessed = Date.now();
                
                const data = await fs.readFile(fragment.path, 'base64');
                
                const checksum = crypto
                    .createHash('sha256')
                    .update(Buffer.from(data, 'base64'))
                    .digest('hex');
                
                if (checksum !== fragment.checksum) {
                    console.error(chalk.red(`Corruption detected in fragment: ${fragmentId}`));
                    return res.status(500).json({
                        success: false,
                        message: 'Fragment corrupted'
                    });
                }
                
                console.log(chalk.cyan(`Retrieved fragment: ${fragmentId}`));
                
                res.json({
                    success: true,
                    data,
                    checksum: fragment.checksum,
                    metadata: fragment.metadata
                });
            } catch (error) {
                console.error(chalk.red(`Error retrieving fragment:`, error));
                res.status(500).json({
                    success: false,
                    message: error.message
                });
            }
        });
        
        this.app.get('/ping', (req, res) => {
            res.json({ 
                timestamp: Date.now(),
                nodeId: this.nodeId,
                publicIp: this.publicIp
            });
        });
    }
    
    async initialize() {
        try {
            await this.detectPublicIp();
            await fs.mkdir(this.config.storagePath, { recursive: true });
            await this.loadNodeId();
            await this.scanExistingFragments();
            await this.checkDiskSpace();
            await this.registerWithDirectory();
            
            this.startHeartbeat();
            this.startIntegrityCheck();
            this.startDiskSpaceMonitor();
            this.start();
        } catch (error) {
            console.error(chalk.red('Failed to initialize storage node:', error));
            process.exit(1);
        }
    }
    
    async loadNodeId() {
        try {
            const data = await fs.readFile(this.nodeIdFilePath, 'utf8');
            const storedId = JSON.parse(data);
            if (storedId && storedId.nodeId) {
                this.nodeId = storedId.nodeId;
                console.log(chalk.green(`Reusing existing Node ID: ${this.nodeId}`));
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log(chalk.cyan('No existing Node ID found. A new one will be generated.'));
            } else {
                console.error(chalk.yellow('Could not read node ID file:', error.message));
            }
        }
    }
    
    async saveNodeId(nodeId) {
        try {
            await fs.writeFile(this.nodeIdFilePath, JSON.stringify({ nodeId }), 'utf8');
            console.log(chalk.gray(`Node ID saved to file for future use.`));
        } catch (error) {
            console.error(chalk.red('Failed to save Node ID:', error.message));
        }
    }
    
    async detectPublicIp() {
        const spinner = ora('Detecting public IP address...').start();
        
        try {
            if (this.config.usePublicIp) {
                this.publicIp = await publicIp.v4();
                spinner.succeed(`Public IP detected: ${this.publicIp}`);
            } else {
                this.publicIp = 'localhost';
                spinner.info('Using localhost (local mode)');
            }
        } catch (error) {
            spinner.warn('Could not detect public IP, falling back to localhost');
            this.publicIp = 'localhost';
            console.log(chalk.yellow('Node will only be accessible locally.'));
            console.log(chalk.yellow('To accept connections from the internet, ensure port forwarding is configured.'));
        }
    }
    
    async scanExistingFragments() {
        try {
            const files = await fs.readdir(this.config.storagePath);
            let totalSize = 0;
            
            for (const file of files) {
                if (file.endsWith('.frag')) {
                    const fragmentId = file.replace('.frag', '');
                    const filePath = path.join(this.config.storagePath, file);
                    const stats = await fs.stat(filePath);
                    totalSize += stats.size;
                }
            }
            this.usedSpace = totalSize;
            
            console.log(chalk.cyan(`Loaded ${files.length} existing fragments (${(this.usedSpace / 1024 / 1024).toFixed(2)} MB)`));
        } catch (error) {
            console.error(chalk.yellow('Error scanning fragments:', error));
        }
    }
    
    async getDiskInfo() {
        try {
            const diskPath = process.platform === 'win32' 
                ? this.config.storagePath.split(':')[0] + ':/' 
                : '/';
            
            const diskSpace = await checkDiskSpace(diskPath);
            return diskSpace;
        } catch (error) {
            console.error(chalk.yellow('Error checking disk space:', error.message));
            return {
                free: this.config.maxStorage,
                size: this.config.maxStorage * 2
            };
        }
    }
    
    async checkDiskSpace() {
        const diskInfo = await this.getDiskInfo();
        this.actualDiskSpace = diskInfo.free;
        
        console.log(chalk.cyan('Disk Space Information:'));
        console.log(chalk.gray(`  Total Disk: ${(diskInfo.size / 1024 / 1024 / 1024).toFixed(2)} GB`));
        console.log(chalk.gray(`  Free Disk: ${(diskInfo.free / 1024 / 1024 / 1024).toFixed(2)} GB`));
        console.log(chalk.gray(`  Configured Max: ${(this.config.maxStorage / 1024 / 1024 / 1024).toFixed(2)} GB`));
        
        if (diskInfo.free < this.config.maxStorage) {
            console.log(chalk.yellow(`  Warning: Actual free space is less than configured max`));
        }
    }
    
    async getAvailableSpace() {
        const diskInfo = await this.getDiskInfo();
        const configuredAvailable = this.config.maxStorage - this.usedSpace;
        const bufferSpace = 100 * 1024 * 1024;
        const availableWithBuffer = Math.max(0, diskInfo.free - bufferSpace);
        
        return Math.min(configuredAvailable, availableWithBuffer);
    }
    
    async registerWithDirectory() {
        try {
            console.log(chalk.cyan(`Registering with directory server: ${this.config.directoryServer}`));
            
            const availableSpace = await this.getAvailableSpace();
            
            const registrationPayload = {
                port: this.config.port,
                availableSpace: availableSpace,
                publicKey: this.config.publicKey,
                publicIp: this.publicIp,
                nodeId: this.nodeId
            };
            
            const response = await axios.post(
                `${this.config.directoryServer}/register`,
                registrationPayload,
                { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
            );
            
            const newOrConfirmedNodeId = response.data.nodeId;
            
            if (!this.nodeId) {
                this.nodeId = newOrConfirmedNodeId;
                await this.saveNodeId(this.nodeId);
            } else if (this.nodeId !== newOrConfirmedNodeId) {
                console.log(chalk.yellow(`Directory assigned a new ID. Updating local ID.`));
                this.nodeId = newOrConfirmedNodeId;
                await this.saveNodeId(this.nodeId);
            }
            
            console.log(chalk.green(`Registered with directory. Node ID: ${this.nodeId}`));
            
            if (this.publicIp === 'localhost') {
                console.log(chalk.yellow('\nWARNING: Node is in local mode'));
                console.log(chalk.yellow('To accept connections from the internet:'));
                console.log(chalk.gray('1. Configure port forwarding on your router for port ' + this.config.port));
                console.log(chalk.gray('2. Ensure your firewall is not blocking this port'));
            }
            
        } catch (error) {
            console.error(chalk.red('Failed to register with directory:', error.message));
            throw error;
        }
    }
    
    startHeartbeat() {
        setInterval(async () => {
            if (!this.nodeId) return;
            try {
                const availableSpace = await this.getAvailableSpace();
                
                await axios.post(
                    `${this.config.directoryServer}/heartbeat/${this.nodeId}`,
                    {
                        availableSpace: availableSpace,
                        storedFragments: this.fragments.size
                    }
                );
            } catch (error) {
                console.error(chalk.yellow('Heartbeat failed:', error.message));
                if (error.response && error.response.status === 404) {
                    console.log(chalk.red('Node not found on directory. Re-registering...'));
                    await this.registerWithDirectory();
                }
            }
        }, config.network.heartbeatInterval);
    }
    
    startIntegrityCheck() {
        setInterval(async () => {
            console.log(chalk.cyan('Running integrity check...'));
            let corruptedCount = 0;
            
            for (const [fragmentId, fragment] of this.fragments.entries()) {
                try {
                    const data = await fs.readFile(fragment.path);
                    const checksum = crypto
                        .createHash('sha256')
                        .update(data)
                        .digest('hex');
                    
                    if (checksum !== fragment.checksum) {
                        corruptedCount++;
                        console.error(chalk.red(`Corrupted fragment detected: ${fragmentId}`));
                    }
                } catch (error) {
                    console.error(chalk.red(`Error checking fragment ${fragmentId}:`, error));
                }
            }
            
            if (corruptedCount === 0) {
                console.log(chalk.green('All fragments intact'));
            } else {
                console.log(chalk.red(`${corruptedCount} corrupted fragments found`));
            }
        }, 3600000);
    }
    
    startDiskSpaceMonitor() {
        setInterval(async () => {
            const diskInfo = await this.getDiskInfo();
            const availableSpace = await this.getAvailableSpace();
            
            const diskFreePercent = (diskInfo.free / diskInfo.size) * 100;
            
            if (diskFreePercent < 10) {
                console.log(chalk.red.bold(`WARNING: Disk space critically low! ${diskFreePercent.toFixed(2)}% free`));
            }
            
            console.log(chalk.gray(`Disk space check: ${(availableSpace / 1024 / 1024 / 1024).toFixed(2)} GB available`));
        }, 300000);
    }
    
    async reportFragmentStorage(fragmentId, metadata) {
        if (!this.nodeId) return;
        try {
            if (metadata && metadata.fileHash && metadata.partitionIndex !== undefined) {
                await axios.post(`${this.config.directoryServer}/fragment/register`, {
                    fragmentId,
                    nodeId: this.nodeId,
                    fileHash: metadata.fileHash,
                    partitionIndex: metadata.partitionIndex
                });
            }
        } catch (error) {
            console.error(chalk.yellow('Failed to report fragment storage:', error.message));
        }
    }
    
    async unregister() {
        if (!this.nodeId) return;
        
        console.log(chalk.yellow(`Unregistering node ${this.nodeId} from directory...`));
        
        try {
            await axios.post(
                `${this.config.directoryServer}/unregister/${this.nodeId}`,
                {},
                { timeout: 5000 }
            );
            console.log(chalk.green('Successfully unregistered.'));
        } catch (error) {
            console.error(chalk.red('Failed to unregister node:', error.message));
        }
    }
    
    start() {
        this.app.listen(this.config.port, '0.0.0.0', async () => {
            const availableSpace = await this.getAvailableSpace();
            const diskInfo = await this.getDiskInfo();
            
            console.log(chalk.green.bold(`
=======================================
   Mysterium Storage Node              
   Node ID: ${this.nodeId ? this.nodeId.substring(0, 8) + '...' : 'pending'}
   Public IP: ${this.publicIp}:${this.config.port}
   Directory: ${this.config.directoryServer}
---------------------------------------
   Disk Status:
   Total Disk: ${(diskInfo.size / 1024 / 1024 / 1024).toFixed(2)} GB
   Free Disk: ${(diskInfo.free / 1024 / 1024 / 1024).toFixed(2)} GB
   Used by Node: ${(this.usedSpace / 1024 / 1024 / 1024).toFixed(2)} GB
   Available: ${(availableSpace / 1024 / 1024 / 1024).toFixed(2)} GB
   Configured Max: ${(this.config.maxStorage / 1024 / 1024 / 1024).toFixed(2)} GB
=======================================
            `));
        });
    }
}

const args = process.argv.slice(2);
const nodeConfig = {
    port: args[0] ? parseInt(args[0]) : config.storageNode.defaultPort,
    usePublicIp: !args.includes('--local')
};

if (args[1] && !args[1].startsWith('--')) {
    nodeConfig.directoryServer = args[1];
}

if (args[2] && !args[2].startsWith('--')) {
    nodeConfig.maxStorage = parseInt(args[2]) * 1024 * 1024 * 1024;
}

const node = new StorageNode(nodeConfig);

async function shutdown(signal) {
    console.log(chalk.yellow(`\nReceived ${signal}. Shutting down gracefully...`));
    await node.unregister();
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));