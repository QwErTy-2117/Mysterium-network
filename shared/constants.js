module.exports = {
    DEFAULT_PORT: {
        DIRECTORY: 8080,
        STORAGE_NODE: 9000
    },
    ENCRYPTION: {
        ALGORITHM: 'aes-256-gcm',
        KEY_LENGTH: 32,
        IV_LENGTH: 16,
        TAG_LENGTH: 16
    },
    NETWORK: {
        HEARTBEAT_INTERVAL: 30000,
        NODE_TIMEOUT: 60000,
        MAX_RETRIES: 3,
        CHUNK_SIZE: 1024 * 1024,
        MIN_NODES_REQUIRED: 3
    },
    REED_SOLOMON: {
        DATA_SHARDS: 10,
        PARITY_SHARDS: 4
    }
};