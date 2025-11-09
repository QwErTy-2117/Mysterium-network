class ReedSolomonEncoder {
    constructor() {
        this.GF_SIZE = 256;
        this.PRIMITIVE_POLYNOMIAL = 0x11D;
        
        this.expTable = new Uint8Array(this.GF_SIZE * 2);
        this.logTable = new Uint8Array(this.GF_SIZE);
        
        this.initializeTables();
    }
    
    initializeTables() {
        let x = 1;
        
        for (let i = 0; i < this.GF_SIZE - 1; i++) {
            this.expTable[i] = x;
            this.logTable[x] = i;
            
            x <<= 1;
            if (x >= this.GF_SIZE) {
                x ^= this.PRIMITIVE_POLYNOMIAL;
                x &= this.GF_SIZE - 1;
            }
        }
        
        for (let i = this.GF_SIZE - 1; i < this.GF_SIZE * 2; i++) {
            this.expTable[i] = this.expTable[i - (this.GF_SIZE - 1)];
        }
    }
    
    multiply(a, b) {
        if (a === 0 || b === 0) return 0;
        return this.expTable[this.logTable[a] + this.logTable[b]];
    }
    
    divide(a, b) {
        if (a === 0) return 0;
        if (b === 0) throw new Error('Division by zero');
        return this.expTable[this.logTable[a] - this.logTable[b] + (this.GF_SIZE - 1)];
    }
    
    encode(data, dataShards, parityShards) {
        const shards = [];
        const shardSize = Math.ceil(data.length / dataShards);
        
        for (let i = 0; i < dataShards; i++) {
            const start = i * shardSize;
            const end = Math.min(start + shardSize, data.length);
            const shard = Buffer.alloc(shardSize);
            data.copy(shard, 0, start, end);
            shards.push(shard);
        }
        
        for (let p = 0; p < parityShards; p++) {
            const parityShard = Buffer.alloc(shardSize);
            
            for (let i = 0; i < shardSize; i++) {
                let parityByte = 0;
                
                for (let j = 0; j < dataShards; j++) {
                    if (i < shards[j].length) {
                        const coefficient = this.getCoefficient(p, j);
                        parityByte ^= this.multiply(shards[j][i], coefficient);
                    }
                }
                
                parityShard[i] = parityByte;
            }
            
            shards.push(parityShard);
        }
        
        return shards;
    }
    
    getCoefficient(parityIndex, dataIndex) {
        return this.expTable[(parityIndex + 1) * (dataIndex + 1) % (this.GF_SIZE - 1)];
    }
    
    decode(shards, dataShards, parityShards) {
        const availableShards = [];
        const missingIndices = [];
        
        for (let i = 0; i < shards.length; i++) {
            if (shards[i] !== null && shards[i] !== undefined) {
                availableShards.push({ index: i, data: shards[i] });
            } else if (i < dataShards) {
                missingIndices.push(i);
            }
        }
        
        if (missingIndices.length === 0) {
            return Buffer.concat(shards.slice(0, dataShards));
        }
        
        if (availableShards.length < dataShards) {
            throw new Error(`Not enough shards for recovery. Have ${availableShards.length}, need ${dataShards}`);
        }
        
        const recoveredShards = [];
        let availableIndex = 0;
        
        for (let i = 0; i < dataShards; i++) {
            if (shards[i] !== null && shards[i] !== undefined) {
                recoveredShards.push(shards[i]);
            } else {
                while (availableShards[availableIndex].index < dataShards && 
                       availableShards[availableIndex].index !== i) {
                    availableIndex++;
                }
                
                if (availableIndex < availableShards.length) {
                    recoveredShards.push(availableShards[availableIndex].data);
                    availableIndex++;
                }
            }
        }
        
        return Buffer.concat(recoveredShards);
    }
}

module.exports = ReedSolomonEncoder;