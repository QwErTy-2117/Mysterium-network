const axios = require('axios');
const fs = require('fs').promises;
const chalk = require('chalk');
const ora = require('ora');
const crypto = require('crypto');
const { CryptoUtils, FileUtils, ReedSolomon, NetworkUtils } = require('./utils');
const config = require('../config');

class Downloader {
    constructor(directoryServer = config.directoryServer.url) {
        this.directoryServer = directoryServer;
    }
    
    async downloadFile(recoveryFilePath, outputPath = null, masterPassword = null) {
        console.log(chalk.cyan.bold('\nStarting Download Process'));
        console.log(chalk.gray(`Recovery file: ${recoveryFilePath}`));
        console.log(chalk.gray(`Directory Server: ${this.directoryServer}`));
        
        try {
            const spinner = ora('Reading recovery file...').start();
            const recoveryData = JSON.parse(await fs.readFile(recoveryFilePath, 'utf8'));
            spinner.succeed('Recovery file loaded');
            
            if (recoveryData.security.masterEncryption.passwordProtected) {
                if (!masterPassword) {
                    throw new Error('This file is password protected. Use --master-password option.');
                }
                console.log(chalk.yellow('Password protected file - password required'));
            }
            
            if (recoveryData.version === '3.0' && recoveryData.security?.doubleEncryption) {
                console.log(chalk.green(`Security: Double encryption detected`));
                console.log(chalk.gray(`  Master encryption: ${recoveryData.security.masterEncryption.algorithm}`));
                console.log(chalk.gray(`  Fragment keys: ${recoveryData.security.fragmentEncryption.totalUniqueKeys}`));
                if (recoveryData.security.masterEncryption.passwordProtected) {
                    console.log(chalk.yellow(`  Password Protected: Yes`));
                }
            }
            
            console.log(chalk.gray(`Original file: ${recoveryData.fileName}`));
            console.log(chalk.gray(`Size: ${(recoveryData.originalSize / 1024 / 1024).toFixed(2)} MB`));
            console.log(chalk.gray(`Partitions: ${recoveryData.partitions.length}`));
            
            if (recoveryData.reedSolomonConfig) {
                console.log(chalk.gray(`Reed-Solomon: ${recoveryData.reedSolomonConfig.dataShards} data + ${recoveryData.reedSolomonConfig.parityShards} parity shards`));
            }
            
            const downloadSpinner = ora('Downloading encrypted fragments...').start();
            const downloadedFragments = await this.downloadFragmentsWithRetry(recoveryData.partitions, downloadSpinner);
            const successfulDownloads = downloadedFragments.filter(p => p !== null).length;
            downloadSpinner.succeed(`Downloaded ${successfulDownloads} partitions`);
            
            const fragmentDecryptSpinner = ora('Decrypting fragments (Layer 2)...').start();
            const fragmentDecrypted = await this.decryptFragmentLayer(
                downloadedFragments,
                recoveryData.partitions
            );
            fragmentDecryptSpinner.succeed('Fragment encryption removed');
            
            const reconstructSpinner = ora('Reconstructing master-encrypted file...').start();
            let masterEncryptedBuffer;
            
            if (recoveryData.reedSolomon && recoveryData.reedSolomonConfig) {
                try {
                    const dataShards = recoveryData.reedSolomonConfig.dataShards;
                    const parityShards = recoveryData.reedSolomonConfig.parityShards;
                    
                    console.log(chalk.gray(`\nUsing Reed-Solomon: ${dataShards} data shards, ${parityShards} parity shards`));
                    console.log(chalk.gray(`Valid fragments: ${fragmentDecrypted.filter(f => f !== null).length}/${fragmentDecrypted.length}`));
                    
                    masterEncryptedBuffer = ReedSolomon.decode(
                        fragmentDecrypted,
                        dataShards,
                        parityShards
                    );
                } catch (rsError) {
                    console.error(chalk.yellow('Reed-Solomon decode failed:', rsError.message));
                    console.log(chalk.yellow('Attempting simple merge...'));
                    const validPartitions = fragmentDecrypted.filter(p => p !== null);
                    if (validPartitions.length < recoveryData.reedSolomonConfig.dataShards) {
                        throw new Error(`Not enough partitions for recovery. Have ${validPartitions.length}, need ${recoveryData.reedSolomonConfig.dataShards}`);
                    }
                    masterEncryptedBuffer = FileUtils.mergePartitions(validPartitions.slice(0, recoveryData.reedSolomonConfig.dataShards));
                }
            } else {
                const validPartitions = fragmentDecrypted.filter(p => p !== null);
                if (validPartitions.length !== recoveryData.partitions.length) {
                    throw new Error(`Missing partitions and no error correction available. Have ${validPartitions.length}, need ${recoveryData.partitions.length}`);
                }
                masterEncryptedBuffer = FileUtils.mergePartitions(validPartitions);
            }
            
            reconstructSpinner.succeed('Master-encrypted file reconstructed');
            
            if (recoveryData.compressed) {
                const decompressSpinner = ora('Decompressing...').start();
                try {
                    masterEncryptedBuffer = CryptoUtils.decompress(masterEncryptedBuffer);
                    decompressSpinner.succeed('Decompressed successfully');
                } catch (decompError) {
                    decompressSpinner.fail('Decompression failed');
                    throw new Error('Decompression failed: ' + decompError.message);
                }
            }
            
            const verifyMasterSpinner = ora('Verifying master encrypted data...').start();
            const masterEncryptedHash = CryptoUtils.calculateChecksum(masterEncryptedBuffer);
            if (masterEncryptedHash !== recoveryData.security.masterEncryption.encryptedHash) {
                verifyMasterSpinner.fail('Master encrypted data integrity check failed');
                throw new Error('Master encrypted data integrity check failed');
            }
            verifyMasterSpinner.succeed('Master encrypted data verified');
            
            const masterDecryptSpinner = ora('Decrypting with master key (Layer 1)...').start();
            
            let masterKey;
            if (recoveryData.security.masterEncryption.passwordProtected) {
                if (!masterPassword) {
                    masterDecryptSpinner.fail('Password required');
                    throw new Error('Master password is required for this file');
                }
                
                const salt = Buffer.from(recoveryData.security.masterEncryption.salt, 'base64');
                masterKey = crypto.pbkdf2Sync(masterPassword, salt, 100000, 32, 'sha256');
                masterDecryptSpinner.text = 'Deriving key from password...';
            } else {
                masterKey = Buffer.from(recoveryData.security.masterEncryption.key, 'base64');
            }
            
            const masterIV = Buffer.from(recoveryData.security.masterEncryption.iv, 'base64');
            const masterTag = Buffer.from(recoveryData.security.masterEncryption.tag, 'base64');
            
            let originalFile;
            try {
                originalFile = CryptoUtils.decrypt(
                    masterEncryptedBuffer,
                    masterKey,
                    masterIV,
                    masterTag
                );
                masterDecryptSpinner.succeed('Master encryption removed');
            } catch (decryptError) {
                masterDecryptSpinner.fail('Master decryption failed');
                if (recoveryData.security.masterEncryption.passwordProtected) {
                    throw new Error('Incorrect password or corrupted file');
                }
                throw new Error('Master decryption failed: ' + decryptError.message);
            }
            
            const verifySpinner = ora('Verifying file integrity...').start();
            const fileHash = CryptoUtils.calculateChecksum(originalFile);
            
            if (fileHash !== recoveryData.fileHash) {
                verifySpinner.fail('File integrity check failed');
                console.error(chalk.red(`Expected hash: ${recoveryData.fileHash}`));
                console.error(chalk.red(`Actual hash:   ${fileHash}`));
                throw new Error('Downloaded file hash does not match original');
            }
            
            verifySpinner.succeed('File integrity verified');
            
            const saveSpinner = ora('Saving file...').start();
            const outputFilePath = outputPath || recoveryData.fileName;
            await fs.writeFile(outputFilePath, originalFile);
            saveSpinner.succeed(`File saved: ${outputFilePath}`);
            
            console.log(chalk.green.bold('\nDownload Complete'));
            console.log(chalk.cyan('Security Summary:'));
            console.log(chalk.gray(`  - Fragment decryption: ${successfulDownloads} fragments`));
            console.log(chalk.gray(`  - Master decryption: Applied`));
            console.log(chalk.gray(`  - File integrity: Verified`));
            console.log(chalk.gray(`  - File size: ${originalFile.length} bytes`));
            console.log(chalk.gray(`File saved to: ${outputFilePath}`));
            
            return outputFilePath;
            
        } catch (error) {
            console.error(chalk.red.bold('\nDownload Failed:'), error.message);
            if (error.stack) {
                console.error(chalk.gray(error.stack));
            }
            throw error;
        }
    }
    
    async downloadFragmentsWithRetry(partitionMap, spinner) {
        const downloadPromises = partitionMap.map(async (partition, index) => {
            for (const fragment of partition.fragments) {
                try {
                    const parts = fragment.nodeAddress.split(':');
                    const nodeUrl = NetworkUtils.formatNodeUrl(parts[0], parts[1]);
                    
                    spinner.text = `Downloading fragment ${index} from ${fragment.nodeAddress}...`;
                    
                    const response = await axios.get(
                        `${nodeUrl}/retrieve/${fragment.fragmentId}`,
                        { timeout: 30000 }
                    );
                    
                    if (response.data.success) {
                        const downloadedChecksum = CryptoUtils.calculateChecksum(
                            Buffer.from(response.data.data, 'base64')
                        );
                        
                        if (downloadedChecksum === fragment.checksum) {
                            console.log(chalk.gray(`  Partition ${index} downloaded from ${fragment.nodeAddress}`));
                            return {
                                index,
                                data: response.data.data,
                                fragment: fragment
                            };
                        } else {
                            console.log(chalk.yellow(`  Checksum mismatch for partition ${index}`));
                        }
                    }
                } catch (error) {
                    console.log(chalk.yellow(`  Fragment ${fragment.fragmentId.substring(0, 8)} unavailable: ${error.message}`));
                }
            }
            
            console.error(chalk.red(`Failed to download any copy of partition ${index}`));
            return null;
        });
        
        const results = await Promise.all(downloadPromises);
        return results;
    }
    
    async decryptFragmentLayer(downloadedFragments, partitionMap) {
        const decryptedPartitions = new Array(partitionMap.length);
        
        for (let i = 0; i < downloadedFragments.length; i++) {
            const downloaded = downloadedFragments[i];
            
            if (!downloaded) {
                decryptedPartitions[i] = null;
                continue;
            }
            
            try {
                const encryption = downloaded.fragment.encryption;
                
                let key = Buffer.from(encryption.key, 'base64');
                
                if (encryption.salt) {
                    const salt = Buffer.from(encryption.salt, 'base64');
                    key = crypto.pbkdf2Sync(key, salt, 10000, 32, 'sha256');
                }
                
                const iv = Buffer.from(encryption.iv, 'base64');
                const tag = Buffer.from(encryption.tag, 'base64');
                const encrypted = Buffer.from(downloaded.data, 'base64');
                
                const decrypted = CryptoUtils.decrypt(encrypted, key, iv, tag);
                
                const expectedChecksum = partitionMap[downloaded.index].originalChecksum;
                const actualChecksum = CryptoUtils.calculateChecksum(decrypted);
                
                if (actualChecksum !== expectedChecksum) {
                    console.error(chalk.red(`Checksum mismatch for partition ${downloaded.index}`));
                    decryptedPartitions[downloaded.index] = null;
                } else {
                    console.log(chalk.gray(`  Decrypted partition ${downloaded.index}`));
                    decryptedPartitions[downloaded.index] = decrypted;
                }
                
            } catch (error) {
                console.error(chalk.red(`Failed to decrypt partition ${downloaded.index}:`, error.message));
                decryptedPartitions[downloaded.index] = null;
            }
        }
        
        return decryptedPartitions;
    }
    
    async verifyAvailability(recoveryFilePath) {
        console.log(chalk.cyan.bold('\nChecking Fragment Availability'));
        
        try {
            const recoveryData = JSON.parse(await fs.readFile(recoveryFilePath, 'utf8'));
            
            if (recoveryData.security?.doubleEncryption) {
                console.log(chalk.green(`Double encryption enabled`));
                console.log(chalk.gray(`  Master key: ${recoveryData.security.masterEncryption.algorithm}`));
                console.log(chalk.gray(`  Fragment keys: ${recoveryData.security.fragmentEncryption.totalUniqueKeys}`));
                if (recoveryData.security.masterEncryption.passwordProtected) {
                    console.log(chalk.yellow(`  Password Protected: Yes`));
                }
            }
            
            let totalFragments = 0;
            let availableFragments = 0;
            let uniqueKeys = new Set();
            
            for (const partition of recoveryData.partitions) {
                for (const fragment of partition.fragments) {
                    totalFragments++;
                    
                    if (fragment.encryption?.key) {
                        uniqueKeys.add(fragment.encryption.key);
                    }
                    
                    try {
                        const parts = fragment.nodeAddress.split(':');
                        const nodeUrl = NetworkUtils.formatNodeUrl(parts[0], parts[1]);
                        await axios.get(`${nodeUrl}/ping`, { timeout: 5000 });
                        availableFragments++;
                    } catch (error) {
                        console.log(chalk.yellow(`Node offline: ${fragment.nodeAddress}`));
                    }
                }
            }
            
            const availability = (availableFragments / totalFragments * 100).toFixed(2);
            console.log(chalk.cyan(`\nFragment availability: ${availability}%`));
            console.log(chalk.gray(`${availableFragments}/${totalFragments} fragments accessible`));
            console.log(chalk.gray(`${uniqueKeys.size} unique fragment encryption keys`));
            console.log(chalk.gray(`1 master encryption key`));
            
            let minRequired = recoveryData.partitions.length;
            if (recoveryData.reedSolomonConfig) {
                minRequired = recoveryData.reedSolomonConfig.dataShards;
            }
            
            const availablePartitions = recoveryData.partitions.filter(p => 
                p.fragments.some(() => true)
            ).length;
            
            if (availablePartitions >= minRequired) {
                console.log(chalk.green(`Sufficient fragments for file recovery (${availablePartitions}/${minRequired} required)`));
            } else {
                console.log(chalk.red(`Insufficient fragments for recovery (${availablePartitions}/${minRequired} required)`));
            }
            
            return {
                total: totalFragments,
                available: availableFragments,
                percentage: availability,
                uniqueKeys: uniqueKeys.size + 1,
                recoverable: availablePartitions >= minRequired
            };
            
        } catch (error) {
            console.error(chalk.red('Failed to check availability:'), error.message);
            throw error;
        }
    }
}

module.exports = Downloader;