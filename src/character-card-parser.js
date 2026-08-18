import fs from 'node:fs';
import { Buffer } from 'node:buffer';

import encode from './png/encode.js';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

/**
 * Writes Character metadata to a PNG image buffer.
 * Encodes both 'chara' (V2) and 'ccv3' (V3) tEXt chunks for maximum compatibility.
 * @param {Buffer} image PNG image buffer
 * @param {string|object} data Character data to write
 * @returns {Buffer} PNG image buffer with metadata
 */
export const write = (image, data) => {
    const chunks = extract(new Uint8Array(image));
    const tEXtChunks = chunks.filter(chunk => chunk.name === 'tEXt');

    // Remove existing character tEXt chunks
    for (const tEXtChunk of tEXtChunks) {
        const chunkData = PNGtext.decode(tEXtChunk.data);
        if (chunkData.keyword.toLowerCase() === 'chara' || chunkData.keyword.toLowerCase() === 'ccv3') {
            chunks.splice(chunks.indexOf(tEXtChunk), 1);
        }
    }

    try {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        let v2Payload = null;
        let v3Payload = null;

        if (parsed.spec === 'chara_card_v3') {
            v3Payload = parsed;
            // Backfill V2
            v2Payload = JSON.parse(JSON.stringify(parsed));
            v2Payload.spec = 'chara_card_v2';
            v2Payload.spec_version = '2.0';
        } else {
            v2Payload = parsed;
            v3Payload = JSON.parse(JSON.stringify(parsed));
            v3Payload.spec = 'chara_card_v3';
            v3Payload.spec_version = '3.0';
        }

        const base64V2 = Buffer.from(JSON.stringify(v2Payload), 'utf8').toString('base64');
        chunks.splice(-1, 0, PNGtext.encode('chara', base64V2));

        const base64V3 = Buffer.from(JSON.stringify(v3Payload), 'utf8').toString('base64');
        chunks.splice(-1, 0, PNGtext.encode('ccv3', base64V3));
    } catch {
        const base64EncodedData = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8').toString('base64');
        chunks.splice(-1, 0, PNGtext.encode('chara', base64EncodedData));
    }

    const newBuffer = Buffer.from(encode(chunks));
    return newBuffer;
};

/**
 * Reads Character metadata from a PNG image buffer.
 * Supports both V2 (chara) and V3 (ccv3). V3 (ccv3) takes precedence.
 * @param {Buffer} image PNG image buffer
 * @returns {string} Character data
 */
export const read = (image) => {
    const chunks = extract(new Uint8Array(image));

    const textChunks = chunks.filter((chunk) => chunk.name === 'tEXt').map((chunk) => PNGtext.decode(chunk.data));

    if (textChunks.length === 0) {
        console.error('PNG metadata does not contain any text chunks.');
        throw new Error('No PNG metadata.');
    }

    const ccv3Chunk = textChunks.find((chunk) => chunk.keyword.toLowerCase() === 'ccv3');
    const charaChunk = textChunks.find((chunk) => chunk.keyword.toLowerCase() === 'chara');

    let ccv3Data = null;
    let charaData = null;

    if (ccv3Chunk) {
        try {
            const raw = Buffer.from(ccv3Chunk.text, 'base64').toString('utf8');
            ccv3Data = JSON.parse(raw);
        } catch (error) {
            console.warn('Failed to parse ccv3 chunk, will attempt chara fallback:', error);
        }
    }

    if (charaChunk) {
        try {
            const raw = Buffer.from(charaChunk.text, 'base64').toString('utf8');
            charaData = JSON.parse(raw);
        } catch (error) {
            console.warn('Failed to parse chara chunk:', error);
        }
    }

    // If both chunks exist, synthesize and merge partial CCv3 data with chara baseline
    if (ccv3Data && charaData) {
        const v3Data = ccv3Data.data || ccv3Data;
        const charaBaseline = charaData.data || charaData;

        const mergedData = { ...charaBaseline, ...v3Data };
        if (charaBaseline.character_book && !v3Data.character_book) {
            mergedData.character_book = charaBaseline.character_book;
        }
        if (charaBaseline.extensions && v3Data.extensions) {
            mergedData.extensions = { ...charaBaseline.extensions, ...v3Data.extensions };
        }

        const mergedCard = {
            spec: 'chara_card_v3',
            spec_version: ccv3Data.spec_version || '3.0',
            data: mergedData,
        };
        return JSON.stringify(mergedCard);
    }

    if (ccv3Data) {
        return JSON.stringify(ccv3Data);
    }

    if (charaData) {
        return JSON.stringify(charaData);
    }

    console.error('PNG metadata does not contain any character data.');
    throw new Error('No PNG metadata.');
};

/**
 * Parses a card image and returns the character metadata.
 * @param {string} cardUrl Path to the card image
 * @param {string} format File format
 * @returns {Promise<string>} Character data
 */
export const parse = async (cardUrl, format) => {
    let fileFormat = format === undefined ? 'png' : format;

    switch (fileFormat) {
        case 'png': {
            const buffer = fs.readFileSync(cardUrl);
            return read(buffer);
        }
    }

    throw new Error('Unsupported format');
};

