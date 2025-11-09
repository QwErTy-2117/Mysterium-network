#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const Uploader = require('./upload');
const Downloader = require('./download');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

const program = new Command();

program
    .name('mysterium')
    .description('Mysterium Network - Distributed Encrypted Storage Client')
    .version('3.0.0');

program
    .command('upload <file>')
    .description('Upload a file to the Mysterium network')
    .option('-p, --partitions <number>', 'Number of partitions', '10')
    .option('-r, --redundancy <number>', 'Redundancy factor', '3')
    .option('-s, --server <url>', 'Directory server URL', config.directoryServer.url)
    .option('--no-compression', 'Disable compression')
    .option('--no-reed-solomon', 'Disable Reed-Solomon error correction')
    .option('-m, --master-password <password>', 'Master password for encryption')
    .action(async (file, options) => {
        try {
            console.log(chalk.blue.bold(`
=======================================
     Mysterium Network Client          
=======================================
            `));
            console.log(chalk.cyan(`Directory Server: ${options.server}`));
            
            // Check if file exists
            try {
                await fs.access(file);
            } catch {
                console.error(chalk.red(`\nFile not found: ${file}`));
                console.error(chalk.yellow('\nUsage:'));
                console.error(chalk.gray('  node client/client.js upload <filename>'));
                console.error(chalk.gray('\nExample:'));
                console.error(chalk.gray('  node client/client.js upload document.pdf'));
                process.exit(1);
            }
            
            const uploader = new Uploader(options.server);
            await uploader.uploadFile(file, {
                partitions: parseInt(options.partitions),
                redundancy: parseInt(options.redundancy),
                compression: options.compression,
                reedSolomon: options.reedSolomon,
                masterPassword: options.masterPassword
            });
            
        } catch (error) {
            console.error(chalk.red.bold('\nUpload failed'));
            console.error(chalk.red('Error:'), error.message);
            
            if (error.response) {
                console.error(chalk.red('Server response:'), error.response.status);
            }
            
            if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
                console.error(chalk.yellow('\nCannot connect to directory server.'));
                console.error(chalk.gray('1. Check your .env file configuration'));
                console.error(chalk.gray('2. Verify the directory server is online'));
                console.error(chalk.gray('3. Run: node client/client.js stats'));
            }
            
            process.exit(1);
        }
    });

program
    .command('download <recoveryFile>')
    .description('Download a file from the Mysterium network')
    .option('-o, --output <path>', 'Output file path')
    .option('-s, --server <url>', 'Directory server URL', config.directoryServer.url)
    .option('-m, --master-password <password>', 'Master password if used during upload')
    .action(async (recoveryFile, options) => {
        try {
            console.log(chalk.blue.bold(`
=======================================
     Mysterium Network Client          
=======================================
            `));
            console.log(chalk.cyan(`Directory Server: ${options.server}`));
            
            // Check if recovery file exists
            try {
                await fs.access(recoveryFile);
            } catch {
                console.error(chalk.red(`\nRecovery file not found: ${recoveryFile}`));
                console.error(chalk.yellow('\nYou must use a .myst recovery file, not the original file.'));
                console.error(chalk.gray('\nHow it works:'));
                console.error(chalk.gray('  1. Upload a file: node client/client.js upload myfile.txt'));
                console.error(chalk.gray('  2. This creates: myfile.txt.myst (recovery file)'));
                console.error(chalk.gray('  3. Download with: node client/client.js download myfile.txt.myst'));
                process.exit(1);
            }
            
            // Check file extension
            if (!recoveryFile.endsWith('.myst')) {
                console.error(chalk.red('\nError: Invalid recovery file'));
                console.error(chalk.yellow('\nYou must use a .myst recovery file, not the original file.'));
                console.error(chalk.cyan('\nHow it works:'));
                console.error(chalk.white('  1. Upload a file: ') + chalk.gray('node client/client.js upload myfile.txt'));
                console.error(chalk.white('  2. This creates: ') + chalk.gray('myfile.txt.myst (recovery file)'));
                console.error(chalk.white('  3. Download with: ') + chalk.gray('node client/client.js download myfile.txt.myst'));
                console.error(chalk.yellow('\nYou tried to download: ') + chalk.red(recoveryFile));
                if (!recoveryFile.includes('.myst')) {
                    console.error(chalk.green('You should use: ') + chalk.cyan(recoveryFile + '.myst') + chalk.gray(' (if it exists)'));
                }
                process.exit(1);
            }
            
            const downloader = new Downloader(options.server);
            await downloader.downloadFile(recoveryFile, options.output, options.masterPassword);
            
        } catch (error) {
            console.error(chalk.red.bold('\nDownload failed'));
            console.error(chalk.red('Error:'), error.message);
            
            if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
                console.error(chalk.yellow('\nCannot connect to directory server.'));
                console.error(chalk.gray('1. Check your .env file configuration'));
                console.error(chalk.gray('2. Verify the directory server is online'));
                console.error(chalk.gray('3. Run: node client/client.js stats'));
            }
            
            process.exit(1);
        }
    });

program
    .command('verify <recoveryFile>')
    .description('Verify fragment availability')
    .option('-s, --server <url>', 'Directory server URL', config.directoryServer.url)
    .action(async (recoveryFile, options) => {
        try {
            // Check if recovery file exists
            try {
                await fs.access(recoveryFile);
            } catch {
                console.error(chalk.red(`Recovery file not found: ${recoveryFile}`));
                process.exit(1);
            }
            
            const downloader = new Downloader(options.server);
            await downloader.verifyAvailability(recoveryFile);
            
        } catch (error) {
            console.error(chalk.red.bold('\nVerification failed'));
            console.error(chalk.red('Error:'), error.message);
            process.exit(1);
        }
    });

program
    .command('info <recoveryFile>')
    .description('Show information about a recovery file')
    .action(async (recoveryFile) => {
        try {
            // Check if recovery file exists
            try {
                await fs.access(recoveryFile);
            } catch {
                console.error(chalk.red(`Recovery file not found: ${recoveryFile}`));
                process.exit(1);
            }
            
            const data = JSON.parse(await fs.readFile(recoveryFile, 'utf8'));
            
            console.log(chalk.cyan.bold('\nRecovery File Information'));
            console.log(chalk.gray('----------------------------------------'));
            console.log(chalk.white('File Name:'), data.fileName);
            console.log(chalk.white('Original Size:'), `${(data.originalSize / 1024 / 1024).toFixed(2)} MB`);
            console.log(chalk.white('File Hash:'), data.fileHash);
            console.log(chalk.white('Version:'), data.version || '1.0');
            console.log(chalk.white('Compressed:'), data.compressed ? 'Yes' : 'No');
            console.log(chalk.white('Reed-Solomon:'), data.reedSolomon ? 'Yes' : 'No');
            console.log(chalk.white('Partitions:'), data.partitions.length);
            console.log(chalk.white('Total Fragments:'), 
                data.partitions.reduce((sum, p) => sum + p.fragments.length, 0));
            console.log(chalk.white('Created:'), new Date(data.timestamp).toLocaleString());
            
            if (data.security) {
                console.log(chalk.cyan.bold('\nSecurity Information'));
                console.log(chalk.gray('----------------------------------------'));
                console.log(chalk.white('Double Encryption:'), data.security.doubleEncryption ? 'Yes' : 'No');
                
                if (data.security.masterEncryption) {
                    console.log(chalk.white('Master Encryption:'), data.security.masterEncryption.algorithm);
                    console.log(chalk.white('Master Key Type:'), data.security.masterEncryption.keyDerivation);
                    
                    if (data.security.masterEncryption.passwordProtected) {
                        console.log(chalk.yellow('Password Protected:'), 'YES - Password required for download');
                        console.log(chalk.yellow('Key Derivation:'), 'PBKDF2 (100,000 iterations)');
                    } else {
                        console.log(chalk.white('Password Protected:'), 'NO - Anyone with .myst file can download');
                    }
                }
                
                if (data.security.fragmentEncryption) {
                    console.log(chalk.white('Fragment Keys:'), data.security.fragmentEncryption.totalUniqueKeys);
                }
            }
            
            console.log(chalk.gray('----------------------------------------'));
            
            const nodeDistribution = {};
            data.partitions.forEach(p => {
                p.fragments.forEach(f => {
                    const nodeAddr = f.nodeAddress;
                    nodeDistribution[nodeAddr] = (nodeDistribution[nodeAddr] || 0) + 1;
                });
            });
            
            console.log(chalk.cyan.bold('\nNode Distribution'));
            console.log(chalk.gray('----------------------------------------'));
            Object.entries(nodeDistribution).forEach(([node, count]) => {
                console.log(chalk.white(`${node}:`), `${count} fragments`);
            });
            
        } catch (error) {
            console.error(chalk.red.bold('\nFailed to read recovery file'));
            console.error(chalk.red('Error:'), error.message);
            
            if (error instanceof SyntaxError) {
                console.error(chalk.yellow('\nThe file is not a valid JSON recovery file.'));
                console.error(chalk.gray('Make sure you are using a .myst file created by upload command.'));
            }
            
            process.exit(1);
        }
    });

program
    .command('stats')
    .description('Show network statistics')
    .option('-s, --server <url>', 'Directory server URL', config.directoryServer.url)
    .action(async (options) => {
        try {
            console.log(chalk.cyan.bold('\nConnecting to Directory Server...'));
            console.log(chalk.gray(`URL: ${options.server}`));
            console.log();
            
            const axios = require('axios');
            
            // Test connection first
            const testResponse = await axios.get(options.server, {
                timeout: 10000,
                validateStatus: function (status) {
                    return status < 600; // Accept any status
                }
            });
            
            console.log(chalk.green('Connected to server'));
            console.log(chalk.gray(`Server: ${testResponse.data.service || 'Unknown'}`));
            console.log(chalk.gray(`Version: ${testResponse.data.version || 'Unknown'}`));
            console.log();
            
            // Get stats
            const response = await axios.get(`${options.server}/stats`, {
                timeout: 10000,
                validateStatus: function (status) {
                    return status < 500;
                }
            });
            
            if (response.status !== 200) {
                console.error(chalk.red(`Server returned status: ${response.status}`));
                console.error(chalk.red(`Response: ${JSON.stringify(response.data)}`));
                process.exit(1);
            }
            
            const stats = response.data;
            
            console.log(chalk.cyan.bold('Network Statistics'));
            console.log(chalk.gray('----------------------------------------'));
            console.log(chalk.white('Total Nodes:'), stats.totalNodes);
            console.log(chalk.white('Active Nodes:'), stats.activeNodes);
            console.log(chalk.white('Total Storage:'), `${(stats.totalAvailableSpace / 1024 / 1024 / 1024).toFixed(2)} GB`);
            console.log(chalk.white('Total Fragments:'), stats.totalFragments);
            console.log(chalk.white('Average Reliability:'), `${stats.averageReliability}%`);
            console.log(chalk.gray('----------------------------------------'));
            
            if (stats.nodesByCountry && Object.keys(stats.nodesByCountry).length > 0) {
                console.log(chalk.cyan.bold('\nGeographic Distribution'));
                console.log(chalk.gray('----------------------------------------'));
                Object.entries(stats.nodesByCountry).forEach(([country, count]) => {
                    console.log(chalk.white(`${country}:`), `${count} nodes`);
                });
            }
            
            if (stats.activeNodes === 0) {
                console.log(chalk.yellow('\nNo storage nodes are currently online.'));
                console.log(chalk.gray('To start a storage node, run:'));
                console.log(chalk.cyan('  node storage-node/server.js 9001'));
            }
            
        } catch (error) {
            console.error(chalk.red.bold('\nFailed to get network stats'));
            console.error(chalk.red('Error Type:'), error.constructor.name);
            console.error(chalk.red('Error Message:'), error.message);
            
            if (error.code) {
                console.error(chalk.red('Error Code:'), error.code);
            }
            
            if (error.response) {
                console.error(chalk.red('Response Status:'), error.response.status);
                console.error(chalk.red('Response Data:'), JSON.stringify(error.response.data, null, 2));
            }
            
            if (error.request && error.config) {
                console.error(chalk.red('Request URL:'), error.config.url);
            }
            
            console.error(chalk.yellow('\nTroubleshooting Steps:'));
            
            if (error.code === 'ENOTFOUND') {
                console.error(chalk.gray('1. Domain name not found'));
                console.error(chalk.gray('2. Check DIRECTORY_SERVER_HOST in .env file'));
                console.error(chalk.gray('3. Make sure it does NOT include http:// or https://'));
                console.error(chalk.gray('4. Example: DIRECTORY_SERVER_HOST=mysterium.onrender.com'));
            } else if (error.code === 'ECONNREFUSED') {
                console.error(chalk.gray('1. Server refused connection'));
                console.error(chalk.gray('2. Check if directory server is running'));
                console.error(chalk.gray('3. For Render: Check deployment status'));
            } else if (error.code === 'ETIMEDOUT') {
                console.error(chalk.gray('1. Connection timeout'));
                console.error(chalk.gray('2. Server might be experiencing cold start (wait 30 seconds)'));
                console.error(chalk.gray('3. Try again in a moment'));
            } else if (error.message.includes('getaddrinfo')) {
                console.error(chalk.gray('1. DNS resolution failed'));
                console.error(chalk.gray('2. Check your .env file:'));
                console.error(chalk.cyan('   DIRECTORY_SERVER_HOST=your-url.onrender.com'));
                console.error(chalk.cyan('   DIRECTORY_SERVER_PORT=443'));
                console.error(chalk.gray('3. Remove any http:// or https:// prefix'));
            } else {
                console.error(chalk.gray('1. Check your .env file configuration'));
                console.error(chalk.gray('2. Verify directory server is deployed'));
                console.error(chalk.gray('3. Test URL in browser'));
            }
            
            console.error(chalk.yellow('\nCurrent Configuration:'));
            console.error(chalk.gray(`  Server URL: ${options.server}`));
            
            console.error(chalk.yellow('\nTo check your configuration, run:'));
            console.error(chalk.cyan('  node client/client.js config'));
            
            process.exit(1);
        }
    });

program
    .command('config')
    .description('Show current configuration')
    .action(async () => {
        console.log(chalk.cyan.bold('\nCurrent Configuration'));
        console.log(chalk.gray('----------------------------------------'));
        console.log(chalk.white('Directory Server:'), chalk.cyan(config.directoryServer.url));
        console.log(chalk.white('  Host:'), config.directoryServer.host);
        console.log(chalk.white('  Port:'), config.directoryServer.port);
        console.log(chalk.white('Storage Node Defaults:'));
        console.log(chalk.white('  Default Port:'), config.storageNode.defaultPort);
        console.log(chalk.white('  Max Storage:'), `${config.storageNode.maxStorageGB} GB`);
        console.log(chalk.white('Network:'));
        console.log(chalk.white('  Heartbeat Interval:'), `${config.network.heartbeatInterval}ms`);
        console.log(chalk.white('  Node Timeout:'), `${config.network.nodeTimeout}ms`);
        console.log(chalk.gray('----------------------------------------'));
        console.log(chalk.cyan('\nConfiguration file: .env'));
        
        // Check if .env file exists
        const envPath = path.join(__dirname, '..', '.env');
        try {
            await fs.access(envPath);
            console.log(chalk.green('.env file found'));
            
            const envContent = await fs.readFile(envPath, 'utf8');
            console.log(chalk.yellow('\n.env file contents:'));
            console.log(chalk.gray('----------------------------------------'));
            envContent.split('\n').forEach(line => {
                if (line.trim() && !line.startsWith('#')) {
                    console.log(chalk.cyan('  ' + line));
                } else if (line.trim()) {
                    console.log(chalk.gray('  ' + line));
                }
            });
            console.log(chalk.gray('----------------------------------------'));
        } catch {
            console.log(chalk.red('.env file NOT found'));
            console.log(chalk.yellow('\nCreate a .env file with:'));
            console.log(chalk.gray('  DIRECTORY_SERVER_HOST=your-render-url.onrender.com'));
            console.log(chalk.gray('  DIRECTORY_SERVER_PORT=443'));
        }
    });

program
    .command('test')
    .description('Test connection to directory server')
    .option('-s, --server <url>', 'Directory server URL', config.directoryServer.url)
    .action(async (options) => {
        const axios = require('axios');
        
        console.log(chalk.cyan.bold('\nTesting Directory Server Connection'));
        console.log(chalk.gray('========================================\n'));
        
        console.log(chalk.white('Server URL:'), chalk.yellow(options.server));
        console.log();
        
        try {
            // Test 1: Basic connection
            console.log(chalk.cyan('Test 1: Basic Connection'));
            const startTime = Date.now();
            const response = await axios.get(options.server, { 
                timeout: 10000,
                validateStatus: () => true // Accept any status
            });
            const duration = Date.now() - startTime;
            
            console.log(chalk.green('  Status: Connected'));
            console.log(chalk.gray(`  Response time: ${duration}ms`));
            console.log(chalk.gray(`  HTTP Status: ${response.status}`));
            console.log(chalk.gray(`  Service: ${response.data.service || 'Unknown'}`));
            
            // Test 2: Stats endpoint
            console.log(chalk.cyan('\nTest 2: Stats Endpoint'));
            const statsResponse = await axios.get(`${options.server}/stats`, { timeout: 10000 });
            console.log(chalk.green('  Status: Working'));
            console.log(chalk.gray(`  Active Nodes: ${statsResponse.data.activeNodes}`));
            console.log(chalk.gray(`  Total Nodes: ${statsResponse.data.totalNodes}`));
            
            // Test 3: Nodes endpoint
            console.log(chalk.cyan('\nTest 3: Nodes Endpoint'));
            const nodesResponse = await axios.get(`${options.server}/nodes`, { timeout: 10000 });
            console.log(chalk.green('  Status: Working'));
            console.log(chalk.gray(`  Nodes available: ${nodesResponse.data.nodes.length}`));
            
            console.log(chalk.green.bold('\nAll tests passed! Server is working correctly.'));
            
        } catch (error) {
            console.log(chalk.red.bold('\nConnection failed'));
            console.log(chalk.red('Error:'), error.message);
            console.log(chalk.red('Code:'), error.code || 'N/A');
            
            if (error.response) {
                console.log(chalk.red('HTTP Status:'), error.response.status);
            }
            
            process.exit(1);
        }
    });

program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
    program.outputHelp();
}