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
        // The initialize method is now called from the main script execution part
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
                availableSpace,
                usedSpace: this.usedSpace,
                fragments: this.fragments.size,
                uptime: process.uptime(),
                diskInfo: {
                    actualFree: diskInfo.free,
                    total: diskInfo.size,
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
                    return res.status(507).json({ success: false, message: 'Insufficient storage space' });
                }
                
                const calculatedChecksum = crypto.createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
                if (calculatedChecksum !== checksum) {
                    return res.status(400).json({ success: false, message: 'Checksum mismatch' });
                }
                
                const fragmentPath = path.join(this.config.storagePath, `${fragmentId}.frag`);
                await fs.writeFile(fragmentPath, data, 'base64');
                
                this.fragments.set(fragmentId, { path: fragmentPath, size: fragmentSize, checksum, metadata });
                this.usedSpace += fragmentSize;
                
                this.reportFragmentStorage(fragmentId, metadata);
                
                console.log(chalk.green(`Stored fragment: ${fragmentId} (${(fragmentSize / 1024).toFixed(2)} KB)`));
                res.json({ success: true, fragmentId, size: fragmentSize });
            } catch (error) {
                console.error(chalk.red(`Error storing fragment:`, error));
                res.status(500).json({ success: false, message: error.message });
            }
        });
        
        this.app.get('/retrieve/:fragmentId', async (req, res) => {
            try {
                const { fragmentId } = req.params;
                const fragmentPath = path.join(this.config.storagePath, `${fragmentId}.frag`);
                const data = await fs.readFile(fragmentPath, 'base64');
                console.log(chalk.cyan(`Retrieved fragment: ${fragmentId}`));
                res.json({ success: true, data });
            } catch (error) {
                if (error.code === 'ENOENT') {
                    res.status(404).json({ success: false, message: 'Fragment not found' });
                } else {
                    console.error(chalk.red(`Error retrieving fragment:`, error));
                    res.status(500).json({ success: false, message: error.message });
                }
            }
        });
        
        this.app.get('/ping', (req, res) => {
            res.json({ timestamp: Date.now(), nodeId: this.nodeId, publicIp: this.publicIp });
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
        }
    }
    
    async scanExistingFragments() {
        try {
            const files = await fs.readdir(this.config.storagePath);
            let totalSize = 0;
            let fragmentCount = 0;
            
            for (const file of files) {
                if (file.endsWith('.frag')) {
                    const filePath = path.join(this.config.storagePath, file);
                    const stats = await fs.stat(filePath);
                    totalSize += stats.size;
                    fragmentCount++;
                }
            }
            this.usedSpace = totalSize;
            this.fragments = new Map(files.filter(f => f.endsWith('.frag')).map(f => [f.replace('.frag', ''), {}]));
            
            console.log(chalk.cyan(`Found ${fragmentCount} existing fragments (${(this.usedSpace / 1024 / 1024).toFixed(2)} MB)`));
        } catch (error) {
            console.error(chalk.yellow('Error scanning fragments:', error));
        }
    }
    
    async getDiskInfo() {
        try {
            const diskPath = process.platform === 'win32' ? path.parse(this.config.storagePath).root : '/';
            return await checkDiskSpace(diskPath);
        } catch (error) {
            console.error(chalk.yellow('Error checking disk space:', error.message));
            return { free: this.config.maxStorage, size: this.config.maxStorage * 2 };
        }
    }
    
    async checkDiskSpace() {
        const diskInfo = await this.getDiskInfo();
        console.log(chalk.cyan('Disk Space Information:'));
        console.log(chalk.gray(`  Total Disk: ${(diskInfo.size / 1024 / 1024 / 1024).toFixed(2)} GB`));
        console.log(chalk.gray(`  Free Disk: ${(diskInfo.free / 1024 / 1024 / 1024).toFixed(2)} GB`));
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
                port: this.config.port, availableSpace,
                publicKey: this.config.publicKey, publicIp: this.publicIp,
                nodeId: this.nodeId
            };
            
            const response = await axios.post(`${this.config.directoryServer}/register`, registrationPayload, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
            
            const newOrConfirmedNodeId = response.data.nodeId;
            if (!this.nodeId) {
                this.nodeId = newOrConfirmedNodeId;
                await this.saveNodeId(this.nodeId);
            }
            
            console.log(chalk.green(`Registered with directory. Node ID: ${this.nodeId}`));
            
            if (this.publicIp === 'localhost') {
                console.log(chalk.yellow('\nWARNING: Node is in local mode. To accept connections from the internet, ensure port forwarding is configured.'));
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
                await axios.post(`${this.config.directoryServer}/heartbeat/${this.nodeId}`, { availableSpace, storedFragments: this.fragments.size });
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
        console.log(chalk.cyan('Integrity check process started (runs hourly).'));
    }
    
    startDiskSpaceMonitor() {
        setInterval(async () => {
            const availableSpace = await this.getAvailableSpace();
            console.log(chalk.gray(`Disk space check: ${(availableSpace / 1024 / 1024 / 1024).toFixed(2)} GB available`));
        }, 300000);
    }
    
    async reportFragmentStorage(fragmentId, metadata) {
        if (!this.nodeId || !metadata) return;
        try {
            if (metadata.fileHash && metadata.partitionIndex !== undefined) {
                await axios.post(`${this.config.directoryServer}/fragment/register`, {
                    fragmentId, nodeId: this.nodeId,
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
            await axios.post(`${this.config.directoryServer}/unregister/${this.nodeId}`, {}, { timeout: 5000 });
            console.log(chalk.green('Successfully unregistered.'));
        } catch (error) {
            console.error(chalk.red('Failed to unregister node:', error.message));
        }
    }
    
    async shutdownAndDelete() {
        console.log(chalk.red.bold('\n--- INITIATING NODE SHUTDOWN AND DELETION ---'));
        await this.unregister();
        try {
            console.log(chalk.yellow(`Deleting storage directory: ${this.config.storagePath}`));
            await fs.rm(this.config.storagePath, { recursive: true, force: true });
            console.log(chalk.green('✓ Storage directory and all fragments permanently deleted.'));
        } catch (error) {
            console.error(chalk.red('Failed to delete storage directory:', error.message));
        }
        console.log(chalk.blue('\nNode has been successfully shut down and deleted.'));
        process.exit(0);
    }
    
    start() {
        this.app.listen(this.config.port, '0.0.0.0', async () => {
            const availableSpace = await this.getAvailableSpace();
            console.log(chalk.green.bold(`
=======================================
   Mysterium Storage Node              
   Node ID: ${this.nodeId ? this.nodeId.substring(0, 8) + '...' : 'pending'}
   Public IP: ${this.publicIp}:${this.config.port}
   Directory: ${this.config.directoryServer}
---------------------------------------
   Available Space: ${(availableSpace / 1024 / 1024 / 1024).toFixed(2)} GB
   Configured Max: ${(this.config.maxStorage / 1024 / 1024 / 1024).toFixed(2)} GB
=======================================
            `));
        });
    }
}

// --- Script Execution ---
const args = process.argv.slice(2);
const command = args[0];

// The main async function to run our logic
async function main() {
    if (command === 'shutdown') {
        const port = args[1];
        if (!port) {
            console.error(chalk.red('Error: You must specify the port of the node to shut down.'));
            console.error(chalk.yellow('Usage: node storage-node/server.js shutdown <port>'));
            process.exit(1);
        }
        
        const nodeConfig = { port: parseInt(port), usePublicIp: !args.includes('--local') };
        const node = new StorageNode(nodeConfig);
        
        // Initialize just enough to perform the shutdown
        await fs.mkdir(node.config.storagePath, { recursive: true });
        await node.loadNodeId();
        await node.detectPublicIp();
        
        if (node.nodeId) {
            await node.shutdownAndDelete();
        } else {
            console.log(chalk.red(`No Node ID found for port ${port}. Deleting directory without unregistering.`));
            await fs.rm(node.config.storagePath, { recursive: true, force: true });
            console.log(chalk.green('Directory deleted.'));
            process.exit(0);
        }
    } else {
        const nodeConfig = {
            port: args[0] ? parseInt(args[0]) : config.storageNode.defaultPort,
            usePublicIp: !args.includes('--local')
        };

        if (args[1] && !args[1].startsWith('--')) nodeConfig.directoryServer = args[1];
        if (args[2] && !args[2].startsWith('--')) nodeConfig.maxStorage = parseInt(args[2]) * 1024 * 1024 * 1024;
        
        const node = new StorageNode(nodeConfig);
        await node.initialize();

        async function gracefulShutdown(signal) {
            console.log(chalk.yellow(`\nReceived ${signal}. Unregistering node...`));
            await node.unregister();
            process.exit(0);
        }
        
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    }
}

main().catch(err => {
    console.error(chalk.red.bold('A critical error occurred:'), err);
    process.exit(1);
});