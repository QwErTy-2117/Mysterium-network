const crypto = require('crypto');
const pako = require('pako');
const constants = require('../shared/constants');
const ReedSolomonEncoder = require('./reed-solomon');

class CryptoUtils {
    static generateKey() {
        return crypto.randomBytes(constants.ENCRYPTION.KEY_LENGTH);
    }
    
    static generateIV() {
        return crypto.randomBytes(constants.ENCRYPTION.IV_LENGTH);
    }
    
    static encrypt(data, key, iv) {
        const cipher = crypto.createCipheriv(
            constants.ENCRYPTION.ALGORITHM,
            key,
            iv
        );
        
        const encrypted = Buffer.concat([
            cipher.update(data),
            cipher.final()
        ]);
        
        const tag = cipher.getAuthTag();
        
        return {
            encrypted,
            tag
        };
    }
    
    static decrypt(encryptedData, key, iv, tag) {
        const decipher = crypto.createDecipheriv(
            constants.ENCRYPTION.ALGORITHM,
            key,
            iv
        );
        
        decipher.setAuthTag(tag);
        
        const decrypted = Buffer.concat([
            decipher.update(encryptedData),
            decipher.final()
        ]);
        
        return decrypted;
    }
    
    static calculateChecksum(data) {
        return crypto.createHash('sha256').update(data).digest('hex');
    }
    
    static compress(data) {
        return Buffer.from(pako.deflate(data));
    }
    
    static decompress(data) {
        return Buffer.from(pako.inflate(data));
    }
}

class FileUtils {
    static splitFile(buffer, partitionCount) {
        const partitions = [];
        const chunkSize = Math.ceil(buffer.length / partitionCount);
        
        for (let i = 0; i < partitionCount; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, buffer.length);
            partitions.push(buffer.slice(start, end));
        }
        
        return partitions;
    }
    
    static mergePartitions(partitions) {
        return Buffer.concat(partitions);
    }
    
    static async measureLatency(nodeAddress) {
        const axios = require('axios');
        const start = Date.now();
        try {
            await axios.get(`http://${nodeAddress}/ping`);
            return Date.now() - start;
        } catch (error) {
            return Infinity;
        }
    }
}

class NetworkUtils {
    static formatNodeUrl(address, port) {
        if (address.substr(0, 7) === "::ffff:") {
            address = address.substr(7);
        }
        
        if (address === "::1" || address === "127.0.0.1") {
            address = "localhost";
        }
        
        return `http://${address}:${port}`;
    }
}

class ReedSolomon {
    static encoder = new ReedSolomonEncoder();
    
    static encode(data, dataShards, parityShards) {
        return this.encoder.encode(data, dataShards, parityShards);
    }
    
    static decode(shards, dataShards, parityShards) {
        return this.encoder.decode(shards, dataShards, parityShards);
    }
}

module.exports = {
    CryptoUtils,
    FileUtils,
    ReedSolomon,
    NetworkUtils
};