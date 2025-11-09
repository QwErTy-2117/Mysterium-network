require('dotenv').config();

const config = {
    directoryServer: {
        host: process.env.DIRECTORY_SERVER_HOST || 'localhost',
        port: parseInt(process.env.DIRECTORY_SERVER_PORT) || 8080,
        get url() {
            // If host already includes protocol, return as is
            if (this.host.startsWith('http://') || this.host.startsWith('https://')) {
                return this.host;
            }
            
            // For localhost, use http with port
            if (this.host === 'localhost' || this.host.startsWith('127.0.0.1')) {
                return `http://${this.host}:${this.port}`;
            }
            
            // For HTTPS (port 443), use https without port
            if (this.port === 443) {
                return `https://${this.host}`;
            }
            
            // Default: http with port
            return `http://${this.host}:${this.port}`;
        }
    },
    
    storageNode: {
        defaultPort: parseInt(process.env.STORAGE_NODE_DEFAULT_PORT) || 9000,
        maxStorageGB: parseInt(process.env.STORAGE_NODE_MAX_STORAGE_GB) || 10
    },
    
    network: {
        heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL) || 30000,
        nodeTimeout: parseInt(process.env.NODE_TIMEOUT) || 60000
    }
};

module.exports = config;