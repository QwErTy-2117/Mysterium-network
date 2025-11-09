const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const crypto = require('crypto');
const { CryptoUtils, FileUtils, ReedSolomon, NetworkUtils } = require('./utils');
const config = require('../config');

class Uploader {
    constructor(directoryServer = config.directoryServer.url) {
        this.directoryServer = directoryServer;
    }
    
    async uploadFile(filePath, options = {}) {
        const {
            partitions = 10,
            redundancy = 3,
            compression = true,
            reedSolomon = true,
            masterPassword = null
        } = options;
        
        console.log(chalk.cyan.bold('\nStarting Upload Process'));
        console.log(chalk.gray(`File: ${filePath}`));
        console.log(chalk.gray(`Partitions: ${partitions}, Redundancy: ${redundancy}x`));
        console.log(chalk.gray(`Directory Server: ${this.directoryServer}`));
        
        try {
            const spinner = ora('Reading file...').start();
            const fileBuffer = await fs.readFile(filePath);
            const fileName = path.basename(filePath);
            const originalFileHash = CryptoUtils.calculateChecksum(fileBuffer);
            spinner.succeed(`File read successfully (${fileBuffer.length} bytes)`);
            
            const masterSpinner = ora('Applying master encryption...').start();
            let masterKey;
            let masterKeySalt = null;
            let passwordProtected = false;
            
            if (masterPassword) {
                const result = this.deriveMasterKey(masterPassword, true);
                masterKey = result.key;
                masterKeySalt = result.salt;
                passwordProtected = true;
                masterSpinner.succeed('Master encryption applied (Password Protected)');
            } else {
                masterKey = this.deriveMasterKey(crypto.randomBytes(32));
                masterSpinner.succeed('Master encryption applied');
            }
            
            const masterIV = CryptoUtils.generateIV();
            const { encrypted: masterEncrypted, tag: masterTag } = CryptoUtils.encrypt(
                fileBuffer,
                masterKey,
                masterIV
            );
            const masterEncryptedHash = CryptoUtils.calculateChecksum(masterEncrypted);
            
            let processedBuffer = masterEncrypted;
            if (compression) {
                const compressSpinner = ora('Compressing encrypted data...').start();
                processedBuffer = CryptoUtils.compress(masterEncrypted);
                const compressionRatio = ((1 - processedBuffer.length / masterEncrypted.length) * 100).toFixed(2);
                compressSpinner.succeed(`Compressed (${compressionRatio}% reduction)`);
            }
            
            const partitionSpinner = ora('Splitting into partitions...').start();
            let filePartitions;
            let dataShards = partitions;
            let parityShards = 0;
            
            if (reedSolomon) {
                parityShards = Math.ceil(partitions * 0.4);
                filePartitions = ReedSolomon.encode(processedBuffer, dataShards, parityShards);
                partitionSpinner.succeed(`Created ${dataShards} data + ${parityShards} parity shards`);
            } else {
                filePartitions = FileUtils.splitFile(processedBuffer, partitions);
                partitionSpinner.succeed(`Split into ${partitions} partitions`);
            }
            
            console.log(chalk.gray(`Total shards to distribute: ${filePartitions.length}`));
            
            const nodeSpinner = ora('Discovering storage nodes...').start();
            const requiredNodes = filePartitions.length * redundancy;
            const nodesResponse = await axios.get(`${this.directoryServer}/nodes`, {
                params: {
                    count: requiredNodes,
                    minSpace: Math.max(...filePartitions.map(p => p.length))
                }
            });
            
            const availableNodes = nodesResponse.data.nodes;
            
            if (availableNodes.length < requiredNodes) {
                nodeSpinner.fail(`Not enough nodes available (${availableNodes.length}/${requiredNodes})`);
                throw new Error('Insufficient storage nodes available');
            }
            
            nodeSpinner.succeed(`Found ${availableNodes.length} storage nodes`);
            
            const latencySpinner = ora('Measuring node latencies...').start();
            const nodeLatencies = await this.measureNodeLatencies(availableNodes);
            const sortedNodes = this.sortNodesByPerformance(availableNodes, nodeLatencies);
            latencySpinner.succeed('Node performance measured');
            
            const uploadSpinner = ora('Applying fragment encryption and uploading...').start();
            const recoveryMap = await this.distributePartitionsWithDoubleEncryption(
                filePartitions,
                sortedNodes,
                redundancy,
                {
                    fileHash: originalFileHash,
                    masterEncryptedHash,
                    fileName,
                    originalSize: fileBuffer.length,
                    compressed: compression
                },
                uploadSpinner
            );
            
            const totalFragments = recoveryMap.reduce((sum, p) => sum + p.fragments.length, 0);
            uploadSpinner.succeed(`Uploaded ${totalFragments} fragments with double encryption`);
            
            const recoverySpinner = ora('Generating recovery file...').start();
            const recoveryFile = {
                version: '3.0',
                fileName,
                fileHash: originalFileHash,
                originalSize: fileBuffer.length,
                compressed: compression,
                reedSolomon: reedSolomon,
                reedSolomonConfig: reedSolomon ? {
                    dataShards: dataShards,
                    parityShards: parityShards,
                    totalShards: dataShards + parityShards
                } : null,
                timestamp: Date.now(),
                security: {
                    doubleEncryption: true,
                    masterEncryption: {
                        algorithm: 'AES-256-GCM',
                        key: passwordProtected ? null : masterKey.toString('base64'),
                        iv: masterIV.toString('base64'),
                        tag: masterTag.toString('base64'),
                        salt: masterKeySalt ? masterKeySalt.toString('base64') : null,
                        encryptedHash: masterEncryptedHash,
                        keyDerivation: masterPassword ? 'PBKDF2' : 'RANDOM',
                        passwordProtected: passwordProtected
                    },
                    fragmentEncryption: {
                        algorithm: 'AES-256-GCM',
                        uniqueKeysPerFragment: true,
                        totalUniqueKeys: totalFragments
                    }
                },
                partitions: recoveryMap
            };
            
            const recoveryFileName = `${fileName}.myst`;
            await fs.writeFile(
                recoveryFileName,
                JSON.stringify(recoveryFile, null, 2),
                'utf8'
            );
            recoverySpinner.succeed(`Recovery file saved: ${recoveryFileName}`);
            
            console.log(chalk.green.bold('\nUpload Complete'));
            console.log(chalk.cyan('Security Summary:'));
            console.log(chalk.gray(`  - Master encryption: AES-256-GCM`));
            if (passwordProtected) {
                console.log(chalk.yellow(`  - Password Protected: YES`));
                console.log(chalk.yellow(`  - Password required for download`));
            }
            console.log(chalk.gray(`  - Fragment encryption: ${totalFragments} unique keys`));
            console.log(chalk.gray(`  - Total encryption layers: 2`));
            console.log(chalk.gray(`  - All encryption client-side`));
            console.log(chalk.gray(`Recovery file: ${recoveryFileName} (${(Buffer.from(JSON.stringify(recoveryFile)).length / 1024).toFixed(2)} KB)`));
            
            return recoveryFileName;
            
        } catch (error) {
            console.error(chalk.red.bold('\nUpload Failed:'), error.message);
            console.error(error.stack);
            throw error;
        }
    }
    
    deriveMasterKey(input, returnSalt = false) {
        if (typeof input === 'string') {
            const salt = crypto.randomBytes(32);
            const key = crypto.pbkdf2Sync(input, salt, 100000, 32, 'sha256');
            
            if (returnSalt) {
                return { key, salt };
            }
            return key;
        } else {
            if (returnSalt) {
                return { key: input, salt: null };
            }
            return input;
        }
    }
    
    async distributePartitionsWithDoubleEncryption(partitions, nodes, redundancy, metadata, spinner) {
        const recoveryMap = [];
        let nodeIndex = 0;
        let totalEncryptions = 0;
        
        for (let i = 0; i < partitions.length; i++) {
            const partition = partitions[i];
            const partitionInfo = {
                index: i,
                originalChecksum: CryptoUtils.calculateChecksum(partition),
                size: partition.length,
                fragments: []
            };
            
            for (let r = 0; r < redundancy; r++) {
                const node = nodes[nodeIndex % nodes.length];
                
                const fragmentKey = CryptoUtils.generateKey();
                const fragmentIV = CryptoUtils.generateIV();
                
                const salt = crypto.randomBytes(16);
                const derivedFragmentKey = crypto.pbkdf2Sync(
                    fragmentKey,
                    salt,
                    10000,
                    32,
                    'sha256'
                );
                
                const { encrypted, tag } = CryptoUtils.encrypt(
                    partition,
                    derivedFragmentKey,
                    fragmentIV
                );
                
                const fragmentId = CryptoUtils.calculateChecksum(
                    Buffer.concat([
                        encrypted,
                        fragmentKey,
                        fragmentIV,
                        Buffer.from(`${i}-${r}-${Date.now()}`)
                    ])
                );
                
                try {
                    const nodeUrl = NetworkUtils.formatNodeUrl(node.address, node.port);
                    
                    spinner.text = `Uploading fragment ${i}-${r} to ${node.address}:${node.port}...`;
                    
                    await axios.post(`${nodeUrl}/store`, {
                        fragmentId,
                        data: encrypted.toString('base64'),
                        checksum: CryptoUtils.calculateChecksum(encrypted),
                        metadata: {
                            fileHash: metadata.fileHash,
                            partitionIndex: i,
                            redundancyIndex: r,
                            doubleEncrypted: true,
                            timestamp: Date.now()
                        }
                    }, {
                        timeout: 30000,
                        maxContentLength: Infinity,
                        maxBodyLength: Infinity
                    });
                    
                    partitionInfo.fragments.push({
                        fragmentId,
                        redundancyIndex: r,
                        nodeId: node.id,
                        nodeAddress: `${node.address}:${node.port}`,
                        checksum: CryptoUtils.calculateChecksum(encrypted),
                        encryption: {
                            key: fragmentKey.toString('base64'),
                            iv: fragmentIV.toString('base64'),
                            tag: tag.toString('base64'),
                            salt: salt.toString('base64'),
                            algorithm: 'AES-256-GCM-LAYER2'
                        }
                    });
                    
                    totalEncryptions++;
                    nodeIndex++;
                    
                    console.log(chalk.gray(`  Fragment ${i}-${r}: Uploaded to ${node.address}:${node.port}`));
                    
                } catch (error) {
                    console.error(chalk.yellow(`Failed to upload fragment ${i}-${r} to node ${node.id}:`, error.message));
                    r--;
                }
            }
            
            recoveryMap.push(partitionInfo);
        }
        
        console.log(chalk.green(`\nCreated ${totalEncryptions} double-encrypted fragments`));
        return recoveryMap;
    }
    
    async measureNodeLatencies(nodes) {
        const latencies = {};
        
        await Promise.all(nodes.map(async (node) => {
            try {
                const nodeUrl = NetworkUtils.formatNodeUrl(node.address, node.port);
                const start = Date.now();
                await axios.get(`${nodeUrl}/ping`, { timeout: 5000 });
                latencies[node.id] = Date.now() - start;
            } catch (error) {
                latencies[node.id] = 999999;
            }
        }));
        
        return latencies;
    }
    
    sortNodesByPerformance(nodes, latencies) {
        return nodes.sort((a, b) => {
            const scoreA = (latencies[a.id] || 999999) / a.reliability;
            const scoreB = (latencies[b.id] || 999999) / b.reliability;
            return scoreA - scoreB;
        });
    }
}

module.exports = Uploader;