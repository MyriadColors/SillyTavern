import path from 'node:path';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync, default as writeFileAtomic } from 'write-file-atomic';
import yaml from 'yaml';
import _ from 'lodash';
import mime from 'mime-types';
import { Jimp, JimpMime } from '../jimp.js';
import storage from 'node-persist';

import { AVATAR_WIDTH, AVATAR_HEIGHT, DEFAULT_AVATAR_PATH } from '../constants.js';
import { default as validateAvatarUrlMiddleware, getFileNameValidationFunction, forbiddenRegExp } from '../middleware/validateFileName.js';
import { deepMerge, humanizedDateTime, tryParse, MemoryLimitedMap, getConfigValue, mutateJsonString, clientRelativePath, getUniqueName, sanitizeSafeCharacterReplacements } from '../util.js';
import { TavernCardValidator } from '../validator/TavernCardValidator.js';
import { parse, read, write } from '../character-card-parser.js';
import { readWorldInfoFile } from './worldinfo.js';
import { invalidateThumbnail } from './thumbnails.js';
import { importRisuSprites } from './sprites.js';
import { getUserDirectories } from '../users.js';
import { getChatInfo } from './chats.js';
import { ByafParser } from '../byaf.js';
import { CharXParser, persistCharXAssets } from '../charx.js';
import cacheBuster from '../middleware/cacheBuster.js';

// With 100 MB limit it would take roughly 3000 characters to reach this limit
const memoryCacheCapacity = getConfigValue('performance.memoryCacheCapacity', '100mb');
const memoryCache = new MemoryLimitedMap(memoryCacheCapacity);
// Some Android devices require tighter memory management
const isAndroid = process.platform === 'android';
// Use shallow character data for the character list
const useShallowCharacters = !!getConfigValue('performance.lazyLoadCharacters', false, 'boolean');
const useDiskCache = !!getConfigValue('performance.useDiskCache', true, 'boolean');

class DiskCache {
    /**
     * @type {string}
     * @readonly
     */
    static DIRECTORY = 'characters';

    /**
     * @type {number}
     * @readonly
     */
    static SYNC_INTERVAL = 5 * 60 * 1000;

    /** @type {import('node-persist').LocalStorage} */
    #instance;

    /** @type {NodeJS.Timeout} */
    #syncInterval;

    /**
     * Queue of user handles to sync.
     * @type {Set<string>}
     * @readonly
     */
    syncQueue = new Set();

    /**
     * Path to the cache directory.
     * @returns {string}
     */
    get cachePath() {
        return path.join(globalThis.DATA_ROOT, '_cache', DiskCache.DIRECTORY);
    }

    /**
     * Returns the list of hashed keys in the cache.
     * @returns {string[]}
     */
    get hashedKeys() {
        return fs.readdirSync(this.cachePath);
    }

    /**
     * Processes the synchronization queue.
     * @returns {Promise<void>}
     */
    async #syncCacheEntries() {
        try {
            if (!useDiskCache || this.syncQueue.size === 0) {
                return;
            }

            const directories = [...this.syncQueue].map(entry => getUserDirectories(entry));
            this.syncQueue.clear();

            await this.verify(directories);
        } catch (error) {
            console.error('Error while synchronizing cache entries:', error);
        }
    }

    /**
     * Gets the disk cache instance.
     * @returns {Promise<import('node-persist').LocalStorage>}
     */
    async instance() {
        if (this.#instance) {
            return this.#instance;
        }

        this.#instance = storage.create({
            dir: this.cachePath,
            ttl: false,
            forgiveParseErrors: true,
            expiredInterval: 0,
            // @ts-ignore
            maxFileDescriptors: 100,
        });
        await this.#instance.init();
        this.#syncInterval = setInterval(this.#syncCacheEntries.bind(this), DiskCache.SYNC_INTERVAL);
        return this.#instance;
    }

    /**
     * Verifies disk cache size and prunes it if necessary.
     * @param {import('../users.js').UserDirectoryList[]} directoriesList List of user directories
     * @returns {Promise<void>}
     */
    async verify(directoriesList) {
        try {
            if (!useDiskCache) {
                return;
            }

            const cache = await this.instance();
            const validKeys = new Set();
            for (const dir of directoriesList) {
                const files = fs.readdirSync(dir.characters, { withFileTypes: true });
                for (const file of files.filter(f => f.isFile() && path.extname(f.name) === '.png')) {
                    const filePath = path.join(dir.characters, file.name);
                    const cacheKey = getCacheKey(filePath);
                    validKeys.add(path.parse(cache.getDatumPath(cacheKey)).base);
                }
            }
            for (const key of this.hashedKeys) {
                if (!validKeys.has(key)) {
                    await cache.removeItem(key);
                }
            }
        } catch (error) {
            console.error('Error while verifying disk cache:', error);
        }
    }

    dispose() {
        if (this.#syncInterval) {
            clearInterval(this.#syncInterval);
        }
    }
}

export const diskCache = new DiskCache();

/**
 * Gets the cache key for the specified image file.
 * @param {string} inputFile - Path to the image file
 * @returns {string} - Cache key
 */
function getCacheKey(inputFile) {
    if (fs.existsSync(inputFile)) {
        const stat = fs.statSync(inputFile);
        return `${inputFile}-${stat.mtimeMs}`;
    }

    return inputFile;
}

/**
 * Reads the character card from the specified image file.
 * @param {string} inputFile - Path to the image file
 * @param {string} inputFormat - 'png'
 * @returns {Promise<string | undefined>} - Character card data
 */
async function readCharacterData(inputFile, inputFormat = 'png') {
    const cacheKey = getCacheKey(inputFile);
    if (memoryCache.has(cacheKey)) {
        return memoryCache.get(cacheKey);
    }
    if (useDiskCache) {
        try {
            const cache = await diskCache.instance();
            const cachedData = await cache.getItem(cacheKey);
            if (cachedData) {
                return cachedData;
            }
        } catch (error) {
            console.warn('Error while reading from disk cache:', error);
        }
    }

    const result = await parse(inputFile, inputFormat);
    !isAndroid && memoryCache.set(cacheKey, result);
    if (useDiskCache) {
        try {
            const cache = await diskCache.instance();
            await cache.setItem(cacheKey, result);
        } catch (error) {
            console.warn('Error while writing to disk cache:', error);
        }
    }
    return result;
}

/**
 * Writes the character card to the specified image file.
 * @param {string|Buffer} inputFile - Path to the image file or image buffer
 * @param {string} data - Character card data
 * @param {string} outputFile - Target image file name
 * @param {import('express').Request} request - Express request obejct
 * @param {Crop|undefined} crop - Crop parameters
 * @returns {Promise<boolean>} - True if the operation was successful
 */
async function writeCharacterData(inputFile, data, outputFile, request, crop = undefined) {
    try {
        // Reset the cache
        for (const key of memoryCache.keys()) {
            if (Buffer.isBuffer(inputFile)) {
                break;
            }
            if (key.startsWith(inputFile)) {
                memoryCache.delete(key);
                break;
            }
        }
        if (useDiskCache && !Buffer.isBuffer(inputFile)) {
            diskCache.syncQueue.add(request.user.profile.handle);
        }
        /**
         * Read the image, resize, and save it as a PNG into the buffer.
         * @returns {Promise<Buffer>} Image buffer
         */
        async function getInputImage() {
            try {
                if (Buffer.isBuffer(inputFile)) {
                    return await parseImageBuffer(inputFile, crop);
                }

                return await tryReadImage(inputFile, crop);
            } catch (error) {
                const message = Buffer.isBuffer(inputFile) ? 'Failed to read image buffer.' : `Failed to read image: ${inputFile}.`;
                console.warn(message, 'Using a fallback image.', error);
                return await fs.promises.readFile(DEFAULT_AVATAR_PATH);
            }
        }

        const inputImage = await getInputImage();

        // Get the chunks
        const outputImage = write(inputImage, data);
        const outputImagePath = path.join(request.user.directories.characters, `${outputFile}.png`);

        writeFileAtomicSync(outputImagePath, outputImage);
        return true;
    } catch (err) {
        console.error(err);
        return false;
    }
}

/**
 * @typedef {Object} Crop
 * @property {number} x X-coordinate
 * @property {number} y Y-coordinate
 * @property {number} width Width
 * @property {number} height Height
 * @property {boolean} want_resize Resize the image to the standard avatar size
 */

/**
 * Applies avatar crop and resize operations to an image.
 * I couldn't fix the type issue, so the first argument has {any} type.
 * @param {object} jimp Jimp image instance
 * @param {Crop|undefined} [crop] Crop parameters
 * @returns {Promise<Buffer>} Processed image buffer
 */
export async function applyAvatarCropResize(jimp, crop) {
    if (!(jimp instanceof Jimp)) {
        throw new TypeError('Expected a Jimp instance');
    }

    const image = /** @type {InstanceType<typeof Jimp>} */ (jimp);
    let finalWidth = image.bitmap.width, finalHeight = image.bitmap.height;

    // Apply crop if defined
    if (typeof crop == 'object' && [crop.x, crop.y, crop.width, crop.height].every(x => typeof x === 'number')) {
        image.crop({ x: crop.x, y: crop.y, w: crop.width, h: crop.height });
        // Apply standard resize if requested
        if (crop.want_resize) {
            finalWidth = AVATAR_WIDTH;
            finalHeight = AVATAR_HEIGHT;
        } else {
            finalWidth = crop.width;
            finalHeight = crop.height;
        }
    }

    image.cover({ w: finalWidth, h: finalHeight });
    return await image.getBuffer(JimpMime.png);
}

/**
 * Parses an image buffer and applies crop if defined.
 * @param {Buffer} buffer Buffer of the image
 * @param {Crop|undefined} [crop] Crop parameters
 * @returns {Promise<Buffer>} Image buffer
 */
async function parseImageBuffer(buffer, crop) {
    const image = await Jimp.fromBuffer(buffer);
    return await applyAvatarCropResize(image, crop);
}

/**
 * Reads an image file and applies crop if defined.
 * @param {string} imgPath Path to the image file
 * @param {Crop|undefined} crop Crop parameters
 * @returns {Promise<Buffer>} Image buffer
 */
async function tryReadImage(imgPath, crop) {
    try {
        const rawImg = await Jimp.read(imgPath);
        return await applyAvatarCropResize(rawImg, crop);
    } catch (error) {
        // If it's an unsupported type of image (APNG) - just read the file as buffer
        console.error(`Failed to read image: ${imgPath}`, error);
        return fs.readFileSync(imgPath);
    }
}

/**
 * calculateChatSize - Calculates the total chat size for a given character.
 *
 * @param  {string} charDir The directory where the chats are stored.
 * @return { {chatSize: number, dateLastChat: number} }         The total chat size.
 */
const calculateChatSize = (charDir) => {
    let chatSize = 0;
    let dateLastChat = 0;

    if (fs.existsSync(charDir)) {
        const chats = fs.readdirSync(charDir);
        if (Array.isArray(chats) && chats.length) {
            for (const chat of chats) {
                const chatStat = fs.statSync(path.join(charDir, chat));
                chatSize += chatStat.size;
                dateLastChat = Math.max(dateLastChat, chatStat.mtimeMs);
            }
        }
    }

    return { chatSize, dateLastChat };
};

// Calculate the total string length of the data object
const calculateDataSize = (data) => {
    return typeof data === 'object' ? Object.values(data).reduce((acc, val) => acc + String(val).length, 0) : 0;
};

/**
 * Only get fields that are used to display the character list.
 * @param {object} character Character object
 * @returns {{shallow: true, [key: string]: any}} Shallow character
 */
const toShallow = (character) => {
    return {
        shallow: true,
        name: character.name,
        avatar: character.avatar,
        chat: character.chat,
        fav: character.fav,
        date_added: character.date_added,
        create_date: character.create_date,
        date_last_chat: character.date_last_chat,
        chat_size: character.chat_size,
        data_size: character.data_size,
        tags: character.tags,
        data: {
            name: _.get(character, 'data.name', ''),
            character_version: _.get(character, 'data.character_version', ''),
            creator: _.get(character, 'data.creator', ''),
            creator_notes: _.get(character, 'data.creator_notes', ''),
            tags: _.get(character, 'data.tags', []),
            extensions: {
                fav: _.get(character, 'data.extensions.fav', false),
                world: _.get(character, 'data.extensions.world', ''),
            },
        },
    };
};

/**
 * processCharacter - Process a given character, read its data and calculate its statistics.
 *
 * @param  {string} item The name of the character.
 * @param  {import('../users.js').UserDirectoryList} directories User directories
 * @param  {object} options Options for the character processing
 * @param  {boolean} options.shallow If true, only return the core character's metadata
 * @return {Promise<object>}     A Promise that resolves when the character processing is done.
 */
const processCharacter = async (item, directories, { shallow }) => {
    try {
        const imgFile = path.join(directories.characters, item);
        const imgData = await readCharacterData(imgFile);
        if (imgData === undefined) throw new Error('Failed to read character file');

        let jsonObject = getCharaCardV2(JSON.parse(imgData), directories, false);
        jsonObject.avatar = item;
        const character = jsonObject;
        character.json_data = imgData;
        const charStat = fs.statSync(path.join(directories.characters, item));
        character.date_added = charStat.ctimeMs;
        character.create_date = jsonObject.create_date || new Date(Math.round(charStat.ctimeMs)).toISOString();
        const chatsDirectory = path.join(directories.chats, item.replace('.png', ''));

        const { chatSize, dateLastChat } = calculateChatSize(chatsDirectory);
        character.chat_size = chatSize;
        character.date_last_chat = dateLastChat;
        character.data_size = calculateDataSize(jsonObject?.data);
        return shallow ? toShallow(character) : character;
    } catch (err) {
        console.error(`Could not process character: ${item}`);

        if (err instanceof SyntaxError) {
            console.error(`${item} does not contain a valid JSON object.`);
        } else {
            console.error('An unexpected error occurred: ', err);
        }

        return {
            date_added: 0,
            date_last_chat: 0,
            chat_size: 0,
        };
    }
};

/**
 * Convert a character object to Spec V2 format.
 * @param {object} jsonObject Character object
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {boolean} hoistDate Will set the chat and create_date fields to the current date if they are missing
 * @returns {object} Character object in Spec V2 format
 */
function getCharaCardV2(jsonObject, directories, hoistDate = true) {
    if (jsonObject.spec === undefined) {
        jsonObject = convertToV2(jsonObject, directories);

        if (hoistDate && !jsonObject.create_date) {
            jsonObject.create_date = new Date().toISOString();
        }
    } else {
        jsonObject = readFromV2(jsonObject);
    }
    return jsonObject;
}

/**
 * Convert a character object to Spec V2 format.
 * @param {object} char Character object
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {object} Character object in Spec V2 format
 */
function convertToV2(char, directories) {
    // Simulate incoming data from frontend form
    const result = charaFormatData({
        json_data: JSON.stringify(char),
        ch_name: char.name,
        description: char.description,
        personality: char.personality,
        scenario: char.scenario,
        first_mes: char.first_mes,
        mes_example: char.mes_example,
        creator_notes: char.creatorcomment,
        talkativeness: char.talkativeness,
        fav: char.fav,
        creator: char.creator,
        tags: char.tags,
        depth_prompt_prompt: char.depth_prompt_prompt,
        depth_prompt_depth: char.depth_prompt_depth,
        depth_prompt_role: char.depth_prompt_role,
    }, directories);

    result.chat = char.chat ?? `${char.name} - ${humanizedDateTime()}`;
    result.create_date = char.create_date;

    return result;
}

/**
 * Removes fields that are not meant to be shared.
 */
function unsetPrivateFields(char) {
    _.set(char, 'fav', false);
    _.set(char, 'data.extensions.fav', false);
    _.unset(char, 'chat');
}

function readFromV2(char) {
    if (_.isUndefined(char.data)) {
        console.warn(`Char ${char.name} has Spec v2 data missing`);
        return char;
    }

    // If 'json_data' was already saved, don't let it propagate
    _.unset(char, 'json_data');

    // Bidirectional backfill: populate missing char.data fields from top-level char properties
    const coreFields = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];
    for (const field of coreFields) {
        if (_.isUndefined(char.data[field]) && !_.isUndefined(char[field])) {
            char.data[field] = char[field];
        }
    }

    // Normalize partial array fields
    if (typeof char.data.group_only_greetings === 'string') {
        char.data.group_only_greetings = [char.data.group_only_greetings];
    } else if (Array.isArray(char.data.group_only_greetings)) {
        char.data.group_only_greetings = char.data.group_only_greetings.filter(x => typeof x === 'string' && x.trim().length > 0);
    }

    if (typeof char.data.alternate_greetings === 'string') {
        char.data.alternate_greetings = [char.data.alternate_greetings];
    } else if (Array.isArray(char.data.alternate_greetings)) {
        char.data.alternate_greetings = char.data.alternate_greetings.filter(x => typeof x === 'string' && x.trim().length > 0);
    }

    if (typeof char.data.tags === 'string') {
        char.data.tags = char.data.tags.split(',').map(x => x.trim()).filter(Boolean);
    }

    if (typeof char.data.source === 'string') {
        char.data.source = [char.data.source];
    }

    // Normalize date fields to integer seconds
    if (typeof char.data.creation_date === 'string') {
        const parsed = Math.floor(Date.parse(char.data.creation_date) / 1000);
        char.data.creation_date = !isNaN(parsed) && parsed > 0 ? parsed : Math.floor(Date.now() / 1000);
    }
    if (typeof char.data.modification_date === 'string') {
        const parsed = Math.floor(Date.parse(char.data.modification_date) / 1000);
        char.data.modification_date = !isNaN(parsed) && parsed > 0 ? parsed : Math.floor(Date.now() / 1000);
    }

    // Ensure extensions object exists
    if (!char.data.extensions || typeof char.data.extensions !== 'object') {
        char.data.extensions = {};
    }

    const fieldMappings = {
        name: 'name',
        description: 'description',
        personality: 'personality',
        scenario: 'scenario',
        first_mes: 'first_mes',
        mes_example: 'mes_example',
        talkativeness: 'extensions.talkativeness',
        fav: 'extensions.fav',
        tags: 'tags',
    };

    _.forEach(fieldMappings, (v2Path, charField) => {
        //console.info(`Migrating field: ${charField} from ${v2Path}`);
        const v2Value = _.get(char.data, v2Path);
        if (_.isUndefined(v2Value)) {
            let defaultValue = undefined;

            // Backfill default values for missing ST extension fields
            if (v2Path === 'extensions.talkativeness') {
                defaultValue = 0.5;
            }

            if (v2Path === 'extensions.fav') {
                defaultValue = false;
            }

            if (!_.isUndefined(defaultValue)) {
                //console.warn(`Spec v2 extension data missing for field: ${charField}, using default value: ${defaultValue}`);
                char[charField] = defaultValue;
            } else {
                console.warn(`Char ${char.name} has Spec v2 data missing for unknown field: ${charField}`);
                return;
            }
        }
        if (!_.isUndefined(char[charField]) && !_.isUndefined(v2Value) && String(char[charField]) !== String(v2Value)) {
            console.warn(`Char ${char.name} has Spec v2 data mismatch with Spec v1 for field: ${charField}`, char[charField], v2Value);
        }
        char[charField] = v2Value;
    });

    char.chat = char.chat ?? `${char.name} - ${humanizedDateTime()}`;

    // Hoist CCv3 fields
    if (char.data.nickname) char.nickname = char.data.nickname;
    if (char.data.creator_notes_multilingual) char.creator_notes_multilingual = char.data.creator_notes_multilingual;
    if (char.data.source) char.source = char.data.source;
    if (char.data.group_only_greetings) char.group_only_greetings = char.data.group_only_greetings;
    if (char.data.creation_date !== undefined) char.creation_date = char.data.creation_date;
    if (char.data.modification_date !== undefined) char.modification_date = char.data.modification_date;
    if (char.data.assets) char.assets = char.data.assets;

    return char;
}

/**
 * Format character data to Spec V2 format.
 * @param {object} data Character data
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns
 */
function charaFormatData(data, directories) {
    // This is supposed to save all the foreign keys that ST doesn't care about
    const char = tryParse(data.json_data) || {};

    // Prevent erroneous 'json_data' recursive saving
    _.unset(char, 'json_data');

    // Checks if data.alternate_greetings is an array, a string, or neither, and acts accordingly. (expected to be an array of strings)
    const getAlternateGreetings = data => {
        if (Array.isArray(data.alternate_greetings)) return data.alternate_greetings;
        if (typeof data.alternate_greetings === 'string') return [data.alternate_greetings];
        return [];
    };

    // Spec V1 fields
    _.set(char, 'name', data.ch_name);
    _.set(char, 'description', data.description || '');
    _.set(char, 'personality', data.personality || '');
    _.set(char, 'scenario', data.scenario || '');
    _.set(char, 'first_mes', data.first_mes || '');
    _.set(char, 'mes_example', data.mes_example || '');

    // Old ST extension fields (for backward compatibility, will be deprecated)
    _.set(char, 'creatorcomment', data.creator_notes || '');
    _.set(char, 'avatar', 'none');
    _.set(char, 'chat', data.ch_name + ' - ' + humanizedDateTime());
    _.set(char, 'talkativeness', data.talkativeness || 0.5);
    _.set(char, 'fav', data.fav == 'true');
    _.set(char, 'tags', typeof data.tags == 'string' ? (data.tags.split(',').map(x => x.trim()).filter(x => x)) : data.tags || []);

    // Spec V2 fields
    _.set(char, 'spec', 'chara_card_v2');
    _.set(char, 'spec_version', '2.0');
    _.set(char, 'data.name', data.ch_name);
    _.set(char, 'data.description', data.description || '');
    _.set(char, 'data.personality', data.personality || '');
    _.set(char, 'data.scenario', data.scenario || '');
    _.set(char, 'data.first_mes', data.first_mes || '');
    _.set(char, 'data.mes_example', data.mes_example || '');

    // New V2 fields
    _.set(char, 'data.creator_notes', data.creator_notes || '');
    _.set(char, 'data.system_prompt', data.system_prompt || '');
    _.set(char, 'data.post_history_instructions', data.post_history_instructions || '');
    _.set(char, 'data.tags', typeof data.tags == 'string' ? (data.tags.split(',').map(x => x.trim()).filter(x => x)) : data.tags || []);
    _.set(char, 'data.creator', data.creator || '');
    _.set(char, 'data.character_version', data.character_version || '');
    _.set(char, 'data.alternate_greetings', getAlternateGreetings(data));

    // CCv3 fields
    if (data.nickname !== undefined) {
        _.set(char, 'nickname', data.nickname);
        _.set(char, 'data.nickname', data.nickname);
    }
    if (data.group_only_greetings !== undefined) {
        const groupGreetings = Array.isArray(data.group_only_greetings) ? data.group_only_greetings : [];
        _.set(char, 'group_only_greetings', groupGreetings);
        _.set(char, 'data.group_only_greetings', groupGreetings);
    }
    if (data.creator_notes_multilingual !== undefined) {
        _.set(char, 'creator_notes_multilingual', data.creator_notes_multilingual);
        _.set(char, 'data.creator_notes_multilingual', data.creator_notes_multilingual);
    }
    if (data.source !== undefined) {
        _.set(char, 'source', Array.isArray(data.source) ? data.source : [String(data.source)]);
        _.set(char, 'data.source', Array.isArray(data.source) ? data.source : [String(data.source)]);
    }
    if (data.assets !== undefined) {
        _.set(char, 'assets', Array.isArray(data.assets) ? data.assets : []);
        _.set(char, 'data.assets', Array.isArray(data.assets) ? data.assets : []);
    }

    const nowSecs = Math.floor(Date.now() / 1000);
    if (!_.get(char, 'data.creation_date') && !_.get(char, 'creation_date')) {
        _.set(char, 'data.creation_date', nowSecs);
        _.set(char, 'creation_date', nowSecs);
    }
    _.set(char, 'data.modification_date', nowSecs);
    _.set(char, 'modification_date', nowSecs);

    // ST extension fields to V2 object
    _.set(char, 'data.extensions.talkativeness', data.talkativeness || 0.5);
    _.set(char, 'data.extensions.fav', data.fav == 'true');
    _.set(char, 'data.extensions.world', data.world || '');

    // Spec extension: depth prompt
    const depth_default = 4;
    const role_default = 'system';
    const depth_value = !isNaN(Number(data.depth_prompt_depth)) ? Number(data.depth_prompt_depth) : depth_default;
    const role_value = data.depth_prompt_role ?? role_default;
    _.set(char, 'data.extensions.depth_prompt.prompt', data.depth_prompt_prompt ?? '');
    _.set(char, 'data.extensions.depth_prompt.depth', depth_value);
    _.set(char, 'data.extensions.depth_prompt.role', role_value);

    if (data.world) {
        try {
            const file = readWorldInfoFile(directories, data.world, false);

            // File was imported - save it to the character book
            if (file && file.originalData) {
                _.set(char, 'data.character_book', file.originalData);
            }

            // File was not imported - convert the world info to the character book
            if (file && file.entries) {
                _.set(char, 'data.character_book', convertWorldInfoToCharacterBook(data.world, file.entries));
            }
        } catch {
            console.warn(`Failed to read world info file: ${data.world}. Character book will not be available.`);
        }
    }

    if (data.extensions) {
        try {
            const extensions = JSON.parse(data.extensions);
            // Deep merge the extensions object
            _.set(char, 'data.extensions', deepMerge(char.data.extensions, extensions));
        } catch {
            console.warn(`Failed to parse extensions JSON: ${data.extensions}`);
        }
    }

    return char;
}

/**
 * @param {string} name Name of World Info file
 * @param {object} entries Entries object
 */
function convertWorldInfoToCharacterBook(name, entries) {
    /** @type {{ entries: object[]; name: string }} */
    const result = { entries: [], name };

    for (const index in entries) {
        const entry = entries[index];

        const originalEntry = {
            id: entry.uid,
            keys: entry.key,
            secondary_keys: entry.keysecondary,
            comment: entry.comment,
            content: entry.content,
            constant: entry.constant,
            selective: entry.selective,
            insertion_order: entry.order,
            enabled: !entry.disable,
            position: entry.position == 0 ? 'before_char' : 'after_char',
            use_regex: true, // ST keys are always regex
            extensions: {
                ...entry.extensions,
                position: entry.position,
                exclude_recursion: entry.excludeRecursion,
                display_index: entry.displayIndex,
                probability: entry.probability ?? null,
                useProbability: entry.useProbability ?? false,
                depth: entry.depth ?? 4,
                selectiveLogic: entry.selectiveLogic ?? 0,
                outlet_name: entry.outletName ?? '',
                group: entry.group ?? '',
                group_override: entry.groupOverride ?? false,
                group_weight: entry.groupWeight ?? null,
                prevent_recursion: entry.preventRecursion ?? false,
                delay_until_recursion: entry.delayUntilRecursion ?? false,
                scan_depth: entry.scanDepth ?? null,
                match_whole_words: entry.matchWholeWords ?? null,
                use_group_scoring: entry.useGroupScoring ?? false,
                case_sensitive: entry.caseSensitive ?? null,
                automation_id: entry.automationId ?? '',
                role: entry.role ?? 0,
                vectorized: entry.vectorized ?? false,
                sticky: entry.sticky ?? null,
                cooldown: entry.cooldown ?? null,
                delay: entry.delay ?? null,
                match_persona_description: entry.matchPersonaDescription ?? false,
                match_character_description: entry.matchCharacterDescription ?? false,
                match_character_personality: entry.matchCharacterPersonality ?? false,
                match_character_depth_prompt: entry.matchCharacterDepthPrompt ?? false,
                match_scenario: entry.matchScenario ?? false,
                match_creator_notes: entry.matchCreatorNotes ?? false,
                triggers: entry.triggers ?? [],
                ignore_budget: entry.ignoreBudget ?? false,
            },
        };

        result.entries.push(originalEntry);
    }

    return result;
}

/**
 * Import a character from a YAML file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromYaml(uploadPath, context, preservedFileName) {
    const fileText = fs.readFileSync(uploadPath, 'utf8');
    fs.unlinkSync(uploadPath);
    const yamlData = yaml.parse(fileText);
    console.info('Importing from YAML');
    yamlData.name = sanitize(yamlData.name);
    const fileName = preservedFileName || getPngName(yamlData.name, context.request.user.directories);
    let char = convertToV2({
        'name': yamlData.name,
        'description': yamlData.context ?? '',
        'first_mes': yamlData.greeting ?? '',
        'create_date': new Date().toISOString(),
        'chat': `${yamlData.name} - ${humanizedDateTime()}`,
        'personality': '',
        'creatorcomment': '',
        'avatar': 'none',
        'mes_example': '',
        'scenario': '',
        'talkativeness': 0.5,
        'creator': '',
        'tags': '',
    }, context.request.user.directories);
    const result = await writeCharacterData(DEFAULT_AVATAR_PATH, JSON.stringify(char), fileName, context.request);
    return result ? fileName : '';
}

/**
 * Imports a character card from CharX (ZIP) file.
 * @param {string} uploadPath
 * @param {object} params
 * @param {import('express').Request} params.request
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromCharX(uploadPath, { request }, preservedFileName) {
    const fileBuffer = fs.readFileSync(uploadPath);
    // Create a properly-sized ArrayBuffer (Node's buffer pool can cause oversized .buffer)
    const data = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
    fs.unlinkSync(uploadPath);

    const parser = new CharXParser(data);
    const { card, avatar, auxiliaryAssets, extractedBuffers } = await parser.parse();

    // Apply standard character transformations
    if (card.data?.name) {
        card.data.name = sanitize(card.data.name);
    }
    card.name = sanitize(card.data?.name || card.name);
    let processedCard = readFromV2(card);
    unsetPrivateFields(processedCard);
    processedCard.create_date = new Date().toISOString();

    const fileName = preservedFileName || getPngName(processedCard.name, request.user.directories);
    // Use the actual character name for asset folders, not the unique filename
    // ST's sprite system looks up by character name, not PNG filename
    const characterFolder = processedCard.name;

    if (auxiliaryAssets.length > 0) {
        try {
            const summary = persistCharXAssets(auxiliaryAssets, extractedBuffers, request.user.directories, characterFolder);
            if (summary.sprites || summary.backgrounds || summary.misc) {
                console.log(`CharX: Imported ${summary.sprites} sprite(s), ${summary.backgrounds} background(s), ${summary.misc} misc asset(s) for ${characterFolder}`);
            }
        } catch (error) {
            console.warn(`CharX: Failed to persist auxiliary assets for ${characterFolder}`, error);
        }
    }

    const result = await writeCharacterData(avatar, JSON.stringify(processedCard), fileName, request);
    return result ? fileName : '';
}

async function importFromByaf(uploadPath, { request }, preservedFileName) {
    const data = (await fsPromises.readFile(uploadPath)).buffer;
    await fsPromises.unlink(uploadPath);
    console.info('Importing from BYAF');

    const byafData = await new ByafParser(data).parse();
    const card = readFromV2(byafData.card);
    const fileName = preservedFileName || getPngName(sanitize(byafData.character.displayName || card.name, { replacement: sanitizeSafeCharacterReplacements }), request.user.directories);

    // Don't import chats and images if the character is being replaced or updated, instead of newly imported.
    if (!preservedFileName) {
        /**
         * @param {Partial<ByafScenario>} scenario
        */
        const createChatAsCurrentPersona = (scenario) => {
            const chatName = sanitize(`${scenario.title || card.name} - ${humanizedDateTime()} imported.jsonl`, { replacement: sanitizeSafeCharacterReplacements });
            const filePath = path.join(request.user.directories.chats, path.basename(fileName), chatName);
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            writeFileAtomicSync(filePath, ByafParser.getChatFromScenario(scenario, request.body.user_name, card.name, byafData.chatBackgrounds), 'utf8');
            console.log(`Created ${chatName} chat from BYAF import`);
            return chatName;
        };

        // Upload backgrounds
        for (const bg of byafData.chatBackgrounds) {
            const extension = path.extname(bg.paths?.[0]) || '.png';
            const baseName = `${path.basename(fileName)}_bg`;
            const filePath = path.join(request.user.directories.userImages, fileName);
            if (!fs.existsSync(filePath)) fs.mkdirSync(filePath, { recursive: true });
            const file = getUniqueName(baseName, (name) => fs.existsSync(path.join(filePath, `${name}${extension}`)));
            if (Buffer.isBuffer(bg.data)) {
                const newFile = `${file}${extension}`;
                writeFileAtomicSync(path.join(filePath, newFile), bg.data);
                bg.name = clientRelativePath(request.user.directories.root, path.join(filePath, newFile)); // Update background name to the new file
                console.log(`Created ${newFile} background from BYAF import`);
            }
        }

        const chats = [];
        // Create chats for each scenario
        if (Array.isArray(byafData.scenarios)) {
            for (const scenario of byafData.scenarios) {
                chats.push(createChatAsCurrentPersona(scenario));
            }
        }

        // Update the default chat if there are any so we open to an existing chat instead of creating a new one and opening that.
        if (chats.length > 0) {
            card.chat = path.basename(chats[0], path.extname(chats[0]));
        }

        // Save alternate icons for the character.
        for (const icon of byafData.images.slice(1)) {
            // BYAF does not support character expressions, so using the same structure will not result in conflicts,
            // even if the expression system did not tolerate additional icons that are not mapped to expressions.
            // This will not yet allow changing icons within the UI but at least the icons will be available for manual selection, rather than being lost.
            const altImagesFolder = path.join(request.user.directories.characters, sanitize(card.name));
            if (!fs.existsSync(altImagesFolder)) fs.mkdirSync(altImagesFolder, { recursive: true });
            const extension = path.extname(icon.filename) || '.png';
            const file = getUniqueName(`${sanitize(icon.label, { replacement: sanitizeSafeCharacterReplacements }) || 'alt'}`, (name) => fs.existsSync(path.join(altImagesFolder, `${name}${extension}`)));
            if (Buffer.isBuffer(icon.image)) {
                writeFileAtomicSync(path.join(altImagesFolder, `${file}${extension}`), icon.image);
                console.log(`Created ${file}${extension} alternate icon from BYAF import`);
            }
        }
    }

    const result = await writeCharacterData(byafData.images[0].image, JSON.stringify(card), fileName, request);

    return result ? fileName : '';
}

/**
 * Import a character from a JSON file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromJson(uploadPath, { request }, preservedFileName) {
    const data = fs.readFileSync(uploadPath, 'utf8');
    fs.unlinkSync(uploadPath);

    let jsonData = JSON.parse(data);

    if (jsonData.spec !== undefined) {
        console.info(`Importing from ${jsonData.spec} json`);
        importRisuSprites(request.user.directories, jsonData);
        unsetPrivateFields(jsonData);
        if (jsonData.data?.name) {
            jsonData.data.name = sanitize(jsonData.data.name);
        }
        jsonData.name = sanitize(jsonData.data?.name || jsonData.name);
        jsonData = readFromV2(jsonData);
        jsonData.create_date = new Date().toISOString();
        const pngName = preservedFileName || getPngName(jsonData.name, request.user.directories);
        const char = JSON.stringify(jsonData);
        const result = await writeCharacterData(DEFAULT_AVATAR_PATH, char, pngName, request);
        return result ? pngName : '';
    } else if (jsonData.name !== undefined) {
        console.info('Importing from v1 json');
        jsonData.name = sanitize(jsonData.name);
        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }
        const pngName = preservedFileName || getPngName(jsonData.name, request.user.directories);
        let char = {
            'name': jsonData.name,
            'description': jsonData.description ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': jsonData.personality ?? '',
            'first_mes': jsonData.first_mes ?? '',
            'avatar': 'none',
            'chat': jsonData.name + ' - ' + humanizedDateTime(),
            'mes_example': jsonData.mes_example ?? '',
            'scenario': jsonData.scenario ?? '',
            'create_date': new Date().toISOString(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, request.user.directories);
        let charJSON = JSON.stringify(char);
        const result = await writeCharacterData(DEFAULT_AVATAR_PATH, charJSON, pngName, request);
        return result ? pngName : '';
    } else if (jsonData.char_name !== undefined) {
        //json Pygmalion notepad
        console.info('Importing from gradio json');
        jsonData.char_name = sanitize(jsonData.char_name);
        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }
        const pngName = preservedFileName || getPngName(jsonData.char_name, request.user.directories);
        let char = {
            'name': jsonData.char_name,
            'description': jsonData.char_persona ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': '',
            'first_mes': jsonData.char_greeting ?? '',
            'avatar': 'none',
            'chat': jsonData.name + ' - ' + humanizedDateTime(),
            'mes_example': jsonData.example_dialogue ?? '',
            'scenario': jsonData.world_scenario ?? '',
            'create_date': new Date().toISOString(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, request.user.directories);
        const charJSON = JSON.stringify(char);
        const result = await writeCharacterData(DEFAULT_AVATAR_PATH, charJSON, pngName, request);
        return result ? pngName : '';
    }

    return '';
}

/**
 * Import a character from a PNG file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {{ request: import('express').Request, response: import('express').Response }} context Express request and response objects
 * @param {string|undefined} preservedFileName Preserved file name
 * @returns {Promise<string>} Internal name of the character
 */
async function importFromPng(uploadPath, { request }, preservedFileName) {
    const imgData = await readCharacterData(uploadPath);
    if (imgData === undefined) throw new Error('Failed to read character data');

    let jsonData = JSON.parse(imgData);

    if (jsonData.data?.name) {
        jsonData.data.name = sanitize(jsonData.data.name);
    }
    jsonData.name = sanitize(jsonData.data?.name || jsonData.name);
    const pngName = preservedFileName || getPngName(jsonData.name, request.user.directories);

    if (jsonData.spec !== undefined) {
        console.info(`Found a ${jsonData.spec} character file.`);
        importRisuSprites(request.user.directories, jsonData);
        unsetPrivateFields(jsonData);
        jsonData = readFromV2(jsonData);
        jsonData.create_date = new Date().toISOString();
        const char = JSON.stringify(jsonData);
        const result = await writeCharacterData(uploadPath, char, pngName, request);
        fs.unlinkSync(uploadPath);
        return result ? pngName : '';
    } else if (jsonData.name !== undefined) {
        console.info('Found a v1 character file.');

        if (jsonData.creator_notes) {
            jsonData.creator_notes = jsonData.creator_notes.replace('Creator\'s notes go here.', '');
        }

        let char = {
            'name': jsonData.name,
            'description': jsonData.description ?? '',
            'creatorcomment': jsonData.creatorcomment ?? jsonData.creator_notes ?? '',
            'personality': jsonData.personality ?? '',
            'first_mes': jsonData.first_mes ?? '',
            'avatar': 'none',
            'chat': jsonData.name + ' - ' + humanizedDateTime(),
            'mes_example': jsonData.mes_example ?? '',
            'scenario': jsonData.scenario ?? '',
            'create_date': new Date().toISOString(),
            'talkativeness': jsonData.talkativeness ?? 0.5,
            'creator': jsonData.creator ?? '',
            'tags': jsonData.tags ?? '',
        };
        char = convertToV2(char, request.user.directories);
        const charJSON = JSON.stringify(char);
        const result = await writeCharacterData(uploadPath, charJSON, pngName, request);
        fs.unlinkSync(uploadPath);
        return result ? pngName : '';
    }

    return '';
}

export const router = express.Router();

router.post('/create', getFileNameValidationFunction('file_name'), async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        request.body.ch_name = sanitize(request.body.ch_name);

        const char = JSON.stringify(charaFormatData(request.body, request.user.directories));
        const internalName = request.body.file_name || getPngName(request.body.ch_name, request.user.directories);
        const avatarName = `${internalName}.png`;
        const chatsPath = path.join(request.user.directories.chats, internalName);

        if (!fs.existsSync(chatsPath)) fs.mkdirSync(chatsPath);

        if (!request.file) {
            await writeCharacterData(DEFAULT_AVATAR_PATH, char, internalName, request);
            return response.send(avatarName);
        } else {
            const crop = tryParse(request.query.crop);
            const uploadPath = path.join(request.file.destination, request.file.filename);
            await writeCharacterData(uploadPath, char, internalName, request, crop);
            fs.unlinkSync(uploadPath);
            return response.send(avatarName);
        }
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.avatar_url || !request.body.new_name) {
        return response.sendStatus(400);
    }

    const oldAvatarName = request.body.avatar_url;
    const newName = sanitize(request.body.new_name);
    const oldInternalName = path.parse(request.body.avatar_url).name;
    const newInternalName = getPngName(newName, request.user.directories);
    const newAvatarName = `${newInternalName}.png`;

    const oldAvatarPath = path.join(request.user.directories.characters, oldAvatarName);

    const oldChatsPath = path.join(request.user.directories.chats, oldInternalName);
    const newChatsPath = path.join(request.user.directories.chats, newInternalName);

    try {
        // Read old file, replace name int it
        const rawOldData = await readCharacterData(oldAvatarPath);
        if (rawOldData === undefined) throw new Error('Failed to read character file');

        const oldData = getCharaCardV2(JSON.parse(rawOldData), request.user.directories);
        _.set(oldData, 'data.name', newName);
        _.set(oldData, 'name', newName);
        const newData = JSON.stringify(oldData);

        // Write data to new location
        await writeCharacterData(oldAvatarPath, newData, newInternalName, request);

        // Rename chats folder
        if (fs.existsSync(oldChatsPath) && !fs.existsSync(newChatsPath)) {
            fs.cpSync(oldChatsPath, newChatsPath, { recursive: true });
            fs.rmSync(oldChatsPath, { recursive: true, force: true });
        }

        // Remove the old character file
        fs.unlinkSync(oldAvatarPath);

        // Return new avatar name to ST
        return response.send({ avatar: newAvatarName });
    } catch (err) {
        console.error(err);
        return response.sendStatus(500);
    }
});

router.post('/edit', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body) {
        console.warn('Error: no response body detected');
        response.status(400).send('Error: no response body detected');
        return;
    }

    if (request.body.ch_name === '' || request.body.ch_name === undefined || request.body.ch_name === '.') {
        console.warn('Error: invalid name.');
        response.status(400).send('Error: invalid name.');
        return;
    }

    let char = charaFormatData(request.body, request.user.directories);
    char.chat = request.body.chat;
    char.create_date = request.body.create_date;
    char = JSON.stringify(char);
    let targetFile = (request.body.avatar_url).replace('.png', '');

    try {
        if (!request.file) {
            const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
            await writeCharacterData(avatarPath, char, targetFile, request);
        } else {
            const crop = tryParse(request.query.crop);
            const newAvatarPath = path.join(request.file.destination, request.file.filename);
            invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);
            await writeCharacterData(newAvatarPath, char, targetFile, request, crop);
            fs.unlinkSync(newAvatarPath);

            // Bust cache to reload the new avatar
            cacheBuster.bust(request, response);
        }

        return response.sendStatus(200);
    } catch (err) {
        console.error('An error occurred, character edit invalidated.', err);
        return response.sendStatus(500);
    }
});

router.post('/edit-avatar', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.file) {
            return response.status(400).send('Error: no file uploaded');
        }

        if (!request.body || !request.body.avatar_url) {
            return response.status(400).send('Error: no avatar_url in request body');
        }

        const uploadPath = path.join(request.file.destination, request.file.filename);
        if (!fs.existsSync(uploadPath)) {
            return response.status(400).send('Error: uploaded file does not exist');
        }
        const characterPath = path.join(request.user.directories.characters, request.body.avatar_url);
        if (!fs.existsSync(characterPath)) {
            return response.status(400).send('Error: character file does not exist');
        }
        const data = await readCharacterData(characterPath);
        if (!data) {
            return response.status(400).send('Error: failed to read character data');
        }

        const crop = tryParse(request.query.crop);
        const fileName = request.body.avatar_url.replace('.png', '');
        await writeCharacterData(uploadPath, data, fileName, request, crop);

        // Remove uploaded temp file
        fs.unlinkSync(uploadPath);

        // Reset images caches
        cacheBuster.bust(request, response);
        invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);

        return response.sendStatus(200);
    } catch (err) {
        console.error('An error occurred while editing avatar', err);
        return response.sendStatus(500);
    }
});

/**
 * Handle a POST request to edit a character attribute.
 *
 * This function reads the character data from a file, updates the specified attribute,
 * and writes the updated data back to the file.
 *
 * @param {Object} request - The HTTP request object.
 * @param {Object} response - The HTTP response object.
 * @returns {void}
 */
router.post('/edit-attribute', validateAvatarUrlMiddleware, async function (request, response) {
    console.debug(request.body);
    if (!request.body) {
        console.warn('Error: no response body detected');
        return response.status(400).send('Error: no response body detected');
    }

    if (request.body.ch_name === '' || request.body.ch_name === undefined || request.body.ch_name === '.') {
        console.warn('Error: invalid name.');
        return response.status(400).send('Error: invalid name.');
    }

    if (request.body.field === 'json_data') {
        console.warn('Error: cannot edit json_data field.');
        return response.status(400).send('Error: cannot edit json_data field.');
    }

    try {
        const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
        const charJSON = await readCharacterData(avatarPath);
        if (typeof charJSON !== 'string') throw new Error('Failed to read character file');

        const char = JSON.parse(charJSON);
        //check if the field exists
        if (char[request.body.field] === undefined && char.data[request.body.field] === undefined) {
            console.warn('Error: invalid field.');
            response.status(400).send('Error: invalid field.');
            return;
        }
        char[request.body.field] = request.body.value;
        char.data[request.body.field] = request.body.value;
        let newCharJSON = JSON.stringify(char);
        const targetFile = (request.body.avatar_url).replace('.png', '');
        await writeCharacterData(avatarPath, newCharJSON, targetFile, request);
        return response.sendStatus(200);
    } catch (err) {
        console.error('An error occurred, character edit invalidated.', err);
        return response.sendStatus(500);
    }
});

/**
 * Sentinel value that signals a field should be completely removed (unset)
 * from the character card rather than being set to any value. Use this in
 * the merge payload wherever a key should be deleted.
 *
 * Both the server and the frontend share this constant so that callers can
 * explicitly opt into deletion without overloading `null`.
 * @type {string}
 */
const UNSET_SENTINEL = '__@@UNSET@@__';

/** Maximum number of characters processed in parallel during bulk merge */
const BULK_MERGE_CONCURRENCY = 10;

/**
 * Recursively walks `source` and removes any key from `target` whose
 * corresponding value in `source` equals the {@link UNSET_SENTINEL}.
 * Called after {@link deepMerge} so that the sentinel gets replaced by
 * an actual key deletion.
 * @param {object} target The merged character object to clean up
 * @param {object} source The original update payload (pre-merge clone)
 */
function processUnsetSentinels(target, source) {
    for (const key of Object.keys(source)) {
        if (source[key] === UNSET_SENTINEL) {
            _.unset(target, key);
        } else if (_.isPlainObject(source[key]) && _.isPlainObject(target[key])) {
            processUnsetSentinels(target[key], source[key]);
        }
    }
}

/**
 * Reads a character card, applies a merge update (with sentinel-based
 * unsetting), validates the result, and writes it back.
 * @param {string} avatarPath Full path to the character PNG
 * @param {string} avatar     Avatar filename (e.g. "char.png")
 * @param {object} updateData The merge payload to apply
 * @param {import("express").Request} request Express request object
 * @param {((data: any) => boolean) | null} [shouldSkip] Optional function to determine if a character should be skipped based on its original data (used for bulk merge filtering)
 * @returns {Promise<{ok: boolean, error?: string, skipped?: boolean}>} Result of the merge operation, including any validation error
 */
async function mergeCharacterUpdate(avatarPath, avatar, updateData, request, shouldSkip = null) {
    const pngStringData = await readCharacterData(avatarPath);
    if (!pngStringData) {
        return { ok: false, error: 'Invalid character file' };
    }

    let character = JSON.parse(pngStringData);

    if (typeof shouldSkip === 'function' && shouldSkip(character)) {
        return { ok: false, skipped: true };
    }

    const update = _.cloneDeep(updateData);
    _.unset(update, 'json_data');
    _.unset(character, 'json_data');

    character = deepMerge(character, update);
    processUnsetSentinels(character, update);

    const validator = new TavernCardValidator(character);
    //Accept either V1 or V2.
    if (!validator.validate()) {
        return { ok: false, error: validator.lastValidationError ?? 'Validation failed' };
    }

    const targetImg = avatar.replace('.png', '');
    await writeCharacterData(avatarPath, JSON.stringify(character), targetImg, request);
    return { ok: true };
}

/**
 * Handle a POST request to edit character properties.
 *
 * Operates in two modes depending on the request body:
 *
 * **Single mode** (default behavior) — when `avatar` (string) is present:
 *   Merges the request body with the selected character and validates the
 *   result against TavernCard V2 specification.
 *
 * **Bulk mode** — when `avatars` (array) is present:
 *   Applies the same merge to multiple characters in parallel. Supports:
 *   - An explicit list of avatars, or all characters when the array is empty
 *   - An optional server-side `filter` so only characters where a given
 *     JSON path exists and is non-null are updated
 *
 * In both modes, any value equal to the sentinel `__@@UNSET@@__` will cause
 * that key to be **deleted** from the character card instead of being set.
 *
 * @param {import("express").Request} request - The HTTP request object
 * @param {import("express").Response} response - The HTTP response object
 * @returns {void}
 */
router.post('/merge-attributes', getFileNameValidationFunction('avatar'), async function (request, response) {
    try {
        // ── Bulk mode: avatars array is present ──────────────────
        if (Array.isArray(request.body.avatars)) {
            const { avatars, data, filter } = request.body;

            if (!_.isPlainObject(data)) {
                return response.status(400).send({ message: 'No valid update data provided.' });
            }

            // Determine which avatar files to process
            let targetAvatars;
            if (avatars.length > 0) {
                for (const avatar of avatars) {
                    if (typeof avatar !== 'string' || forbiddenRegExp.test(avatar) || path.extname(avatar).toLowerCase() !== '.png') {
                        return response.status(400).send({ message: `Invalid avatar filename: ${avatar}` });
                    }
                }
                targetAvatars = avatars;
            } else {
                // Empty array → scan all characters in the directory
                const files = fs.readdirSync(request.user.directories.characters);
                targetAvatars = files.filter(file => path.extname(file).toLowerCase() === '.png');
            }

            const updated = [];
            const skipped = [];
            const failed = [];

            /**
             * Process a single character in bulk: read, filter, merge, validate, write.
             * @param {string} avatar Avatar filename
             */
            const processOne = async (avatar) => {
                const avatarPath = path.join(request.user.directories.characters, avatar);

                try {
                    /** @type {(character: object) => boolean} */
                    let shouldSkip = () => false;

                    // Apply optional server-side filter before updating the card
                    if (filter && typeof filter.path === 'string') {
                        shouldSkip = (character) => {
                            const value = _.get(character, filter.path);
                            return value === undefined;
                        };
                    }

                    const result = await mergeCharacterUpdate(avatarPath, avatar, data, request, shouldSkip);
                    if (result.ok) {
                        updated.push(avatar);
                    } else if (result.skipped) {
                        skipped.push(avatar);
                    } else {
                        console.warn(`Bulk merge failed for ${avatar}:`, result.error);
                        failed.push(avatar);
                    }
                } catch (error) {
                    console.error(`Bulk merge failed for ${avatar}:`, error);
                    failed.push(avatar);
                }
            };

            // Process in parallel with a concurrency limit
            for (let i = 0; i < targetAvatars.length; i += BULK_MERGE_CONCURRENCY) {
                const batch = targetAvatars.slice(i, i + BULK_MERGE_CONCURRENCY);
                await Promise.allSettled(batch.map(processOne));
            }

            return response.send({ updated, skipped, failed });
        }

        // ── Single mode (default behavior) ───────────────────────
        const update = request.body;
        const avatarPath = path.join(request.user.directories.characters, update.avatar);

        const result = await mergeCharacterUpdate(avatarPath, update.avatar, update, request);
        if (result.ok) {
            response.sendStatus(200);
        } else {
            console.warn(result.error);
            response.status(400).send({ message: `Validation failed for ${update.avatar}`, error: result.error });
        }
    } catch (exception) {
        response.status(500).send({ message: 'Unexpected error while saving character.', error: exception.toString() });
    }
});

router.post('/delete', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body || !request.body.avatar_url) {
        return response.sendStatus(400);
    }

    if (request.body.avatar_url !== sanitize(request.body.avatar_url)) {
        console.error('Malicious filename prevented');
        return response.sendStatus(403);
    }

    const avatarPath = path.join(request.user.directories.characters, request.body.avatar_url);
    if (!fs.existsSync(avatarPath)) {
        return response.sendStatus(400);
    }

    fs.unlinkSync(avatarPath);
    invalidateThumbnail(request.user.directories, 'avatar', request.body.avatar_url);
    let dir_name = (request.body.avatar_url.replace('.png', ''));

    if (!dir_name.length) {
        console.error('Malicious dirname prevented');
        return response.sendStatus(403);
    }

    if (request.body.delete_chats == true) {
        try {
            await fs.promises.rm(path.join(request.user.directories.chats, sanitize(dir_name)), { recursive: true, force: true });
        } catch (err) {
            console.error(err);
            return response.sendStatus(500);
        }
    }

    return response.sendStatus(200);
});

/**
 * HTTP POST endpoint for the "/api/characters/all" route.
 *
 * This endpoint is responsible for reading character files from the `charactersPath` directory,
 * parsing character data, calculating stats for each character and responding with the data.
 * Stats are calculated only on the first run, on subsequent runs the stats are fetched from
 * the `charStats` variable.
 * The stats are calculated by the `calculateStats` function.
 * The characters are processed by the `processCharacter` function.
 *
 * @param  {import("express").Request} request The HTTP request object.
 * @param  {import("express").Response} response The HTTP response object.
 * @return {void}
 */
router.post('/all', async function (request, response) {
    try {
        const files = fs.readdirSync(request.user.directories.characters);
        const pngFiles = files.filter(file => file.endsWith('.png'));
        const processingPromises = pngFiles.map(file => processCharacter(file, request.user.directories, { shallow: useShallowCharacters }));
        const data = (await Promise.all(processingPromises)).filter(c => c.name);
        return response.send(data);
    } catch (err) {
        console.error(err);
        const isRangeError = err instanceof RangeError;
        response.status(500).send({ overflow: isRangeError, error: true });
    }
});

router.post('/get', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);
        const item = request.body.avatar_url;
        const filePath = path.join(request.user.directories.characters, item);

        if (!fs.existsSync(filePath)) {
            return response.sendStatus(404);
        }

        const data = await processCharacter(item, request.user.directories, { shallow: false });

        return response.send(data);
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});

router.post('/chats', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body) return response.sendStatus(400);

        const characterDirectory = (request.body.avatar_url).replace('.png', '');
        const chatsDirectory = path.join(request.user.directories.chats, characterDirectory);

        if (!fs.existsSync(chatsDirectory)) {
            return response.send({ error: true });
        }

        const files = fs.readdirSync(chatsDirectory, { withFileTypes: true });
        const jsonFiles = files.filter(file => file.isFile() && path.extname(file.name) === '.jsonl').map(file => file.name);

        if (jsonFiles.length === 0) {
            return response.send([]);
        }

        if (request.body.simple) {
            return response.send(jsonFiles.map(file => ({ file_name: file, file_id: path.parse(file).name })));
        }

        const jsonFilesPromise = jsonFiles.map((file) => {
            const withMetadata = !!request.body.metadata;
            const pathToFile = path.join(request.user.directories.chats, characterDirectory, file);
            return getChatInfo(pathToFile, {}, withMetadata);
        });

        const chatData = (await Promise.allSettled(jsonFilesPromise)).filter(x => x.status === 'fulfilled').map(x => x.value);
        const validFiles = chatData.filter(i => i.file_name);

        return response.send(validFiles);
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

/**
 * Gets the name for the uploaded PNG file.
 * @param {string} file File name
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string} - The name for the uploaded PNG file
 */
function getPngName(file, directories) {
    file = sanitize(file);
    return getUniqueName(file, (name) => fs.existsSync(path.join(directories.characters, `${name}.png`)),
        { nameBuilder: (base, i) => i === 0 ? base : `${base}${i}`, startIndex: 0, maxTries: 10000 }) ?? file;
}

/**
 * Gets the preserved name for the uploaded file if the request is valid.
 * @param {import("express").Request} request - Express request object
 * @returns {string | undefined} - The preserved name if the request is valid, otherwise undefined
 */
function getPreservedName(request) {
    return typeof request.body.preserved_name === 'string' && request.body.preserved_name.length > 0
        ? path.parse(request.body.preserved_name).name
        : undefined;
}

router.post('/import', async function (request, response) {
    if (!request.body || !request.file) return response.sendStatus(400);

    const uploadPath = path.join(request.file.destination, request.file.filename);
    const format = request.body.file_type;
    const preservedFileName = getPreservedName(request);

    const formatImportFunctions = {
        'yaml': importFromYaml,
        'yml': importFromYaml,
        'json': importFromJson,
        'png': importFromPng,
        'charx': importFromCharX,
        'byaf': importFromByaf,
    };

    try {
        const importFunction = formatImportFunctions[format];

        if (!importFunction) {
            throw new Error(`Unsupported format: ${format}`);
        }

        const fileName = await importFunction(uploadPath, { request, response }, preservedFileName);

        if (!fileName) {
            console.warn('Failed to import character');
            return response.sendStatus(400);
        }

        if (preservedFileName) {
            invalidateThumbnail(request.user.directories, 'avatar', `${preservedFileName}.png`);
        }

        response.send({ file_name: fileName });
    } catch (err) {
        console.error(err);
        response.send({ error: true });
    }
});

/**
 * Parses card data and optional avatar preview from an uploaded file.
 * @param {string} uploadPath Path to the uploaded file
 * @param {string} format File format ('png', 'json', 'yaml', 'yml', 'charx', 'byaf')
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Promise<{ card: object, avatarPreview?: string }>}
 */
async function parseCardData(uploadPath, format, directories) {
    let card = null;
    let avatarPreview = undefined;

    switch (format.toLowerCase()) {
        case 'png': {
            const imgData = await readCharacterData(uploadPath);
            if (!imgData) throw new Error('Failed to read character data from PNG');
            const rawJson = JSON.parse(imgData);
            card = getCharaCardV2(rawJson, directories, false);
            const imgBuffer = fs.readFileSync(uploadPath);
            avatarPreview = `data:image/png;base64,${imgBuffer.toString('base64')}`;
            break;
        }
        case 'json': {
            const data = fs.readFileSync(uploadPath, 'utf8');
            const rawJson = JSON.parse(data);
            card = getCharaCardV2(rawJson, directories, false);
            break;
        }
        case 'yaml':
        case 'yml': {
            const fileText = fs.readFileSync(uploadPath, 'utf8');
            const yamlData = yaml.parse(fileText);
            card = getCharaCardV2({
                name: yamlData.name ?? '',
                description: yamlData.context ?? '',
                first_mes: yamlData.greeting ?? '',
            }, directories, false);
            break;
        }
        case 'charx': {
            const fileBuffer = fs.readFileSync(uploadPath);
            const data = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
            const parser = new CharXParser(data);
            const { card: parsedCard, avatar } = await parser.parse();
            card = getCharaCardV2(parsedCard, directories, false);
            if (avatar) {
                avatarPreview = `data:image/png;base64,${Buffer.from(avatar).toString('base64')}`;
            }
            break;
        }
        case 'byaf': {
            const fileBuffer = fs.readFileSync(uploadPath);
            const byafData = await new ByafParser(fileBuffer).parse();
            const byafCard = byafData.character.card;
            card = getCharaCardV2(byafCard, directories, false);
            if (byafData.images?.[0]?.image && Buffer.isBuffer(byafData.images[0].image)) {
                avatarPreview = `data:image/png;base64,${byafData.images[0].image.toString('base64')}`;
            }
            break;
        }
        default:
            throw new Error(`Unsupported format: ${format}`);
    }

    if (!card) {
        throw new Error('Could not parse character card');
    }

    return { card, avatarPreview };
}

router.post('/parse-card', async function (request, response) {
    if (!request.file) {
        return response.status(400).send({ message: 'No file uploaded' });
    }
    const uploadPath = path.join(request.file.destination, request.file.filename);
    const format = request.body.file_type || path.extname(request.file.originalname).replace('.', '').toLowerCase();

    try {
        const result = await parseCardData(uploadPath, format, request.user.directories);
        if (fs.existsSync(uploadPath)) {
            fs.unlinkSync(uploadPath);
        }
        return response.send(result);
    } catch (err) {
        if (fs.existsSync(uploadPath)) {
            fs.unlinkSync(uploadPath);
        }
        console.error('Failed to parse card:', err);
        return response.status(400).send({ message: err.message || 'Failed to parse card' });
    }
});

router.post('/update-card', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body || !request.body.avatar_url || !request.body.card_data) {
            return response.status(400).send({ message: 'Missing avatar_url or card_data in request body' });
        }

        const avatarUrl = sanitize(request.body.avatar_url);
        const avatarPath = path.join(request.user.directories.characters, avatarUrl);
        if (!fs.existsSync(avatarPath)) {
            return response.status(404).send({ message: 'Character file not found' });
        }

        const rawOldData = await readCharacterData(avatarPath);
        if (!rawOldData) {
            return response.status(500).send({ message: 'Failed to read existing character data' });
        }

        const oldCard = getCharaCardV2(JSON.parse(rawOldData), request.user.directories);

        let newCard = typeof request.body.card_data === 'string'
            ? JSON.parse(request.body.card_data)
            : request.body.card_data;

        newCard = getCharaCardV2(newCard, request.user.directories, false);

        // Preserve critical metadata from existing card
        if (oldCard.create_date) {
            newCard.create_date = oldCard.create_date;
            if (newCard.data) newCard.data.create_date = oldCard.create_date;
        }
        if (oldCard.chat) {
            newCard.chat = oldCard.chat;
        }

        // Validate merged card
        const validator = new TavernCardValidator(newCard);
        if (!validator.validate()) {
            return response.status(400).send({ message: validator.lastValidationError ?? 'Validation failed' });
        }

        const targetFile = avatarUrl.replace('.png', '');
        const serializedCard = JSON.stringify(newCard);

        if (request.file) {
            const crop = tryParse(request.query.crop);
            const uploadPath = path.join(request.file.destination, request.file.filename);
            await writeCharacterData(uploadPath, serializedCard, targetFile, request, crop);
            if (fs.existsSync(uploadPath)) {
                fs.unlinkSync(uploadPath);
            }
            invalidateThumbnail(request.user.directories, 'avatar', avatarUrl);
            cacheBuster.bust(request, response);
        } else {
            await writeCharacterData(avatarPath, serializedCard, targetFile, request);
        }

        return response.send({ ok: true, avatar: avatarUrl });
    } catch (err) {
        console.error('Failed to update character card:', err);
        return response.status(500).send({ message: err.message || 'An error occurred while updating character card' });
    }
});

router.post('/duplicate', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body.avatar_url) {
            console.warn('avatar URL not found in request body');
            console.debug(request.body);
            return response.sendStatus(400);
        }
        let filename = path.join(request.user.directories.characters, sanitize(request.body.avatar_url));
        if (!fs.existsSync(filename)) {
            console.error('file for dupe not found', filename);
            return response.sendStatus(404);
        }
        let suffix = 1;
        let newFilename = filename;

        // If filename ends with a _number, increment the number
        const nameParts = path.basename(filename, path.extname(filename)).split('_');
        const lastPart = nameParts[nameParts.length - 1];

        let baseName;

        if (!isNaN(Number(lastPart)) && nameParts.length > 1) {
            suffix = parseInt(lastPart) + 1;
            baseName = nameParts.slice(0, -1).join('_'); // construct baseName without suffix
        } else {
            baseName = nameParts.join('_'); // original filename is completely the baseName
        }

        newFilename = path.join(request.user.directories.characters, `${baseName}_${suffix}${path.extname(filename)}`);

        while (fs.existsSync(newFilename)) {
            let suffixStr = '_' + suffix;
            newFilename = path.join(request.user.directories.characters, `${baseName}${suffixStr}${path.extname(filename)}`);
            suffix++;
        }

        fs.copyFileSync(filename, newFilename);
        console.info(`${filename} was copied to ${newFilename}`);
        response.send({ path: path.parse(newFilename).base });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body.format || !request.body.avatar_url) {
            return response.sendStatus(400);
        }

        let filename = path.join(request.user.directories.characters, sanitize(request.body.avatar_url));

        if (!fs.existsSync(filename)) {
            return response.sendStatus(404);
        }

        switch (request.body.format) {
            case 'png': {
                const rawBuffer = await fsPromises.readFile(filename);
                const rawData = read(rawBuffer);
                const mutatedData = mutateJsonString(rawData, unsetPrivateFields);
                const mutatedBuffer = write(rawBuffer, mutatedData);
                const contentType = mime.lookup(filename) || 'image/png';
                response.setHeader('Content-Type', contentType);
                response.setHeader('Content-Disposition', `attachment; filename="${encodeURI(path.basename(filename))}"`);
                return response.send(mutatedBuffer);
            }
            case 'json': {
                try {
                    const json = await readCharacterData(filename);
                    if (json === undefined) return response.sendStatus(400);
                    const jsonObject = getCharaCardV2(JSON.parse(json), request.user.directories);
                    unsetPrivateFields(jsonObject);
                    return response.type('json').send(JSON.stringify(jsonObject, null, 4));
                } catch {
                    return response.sendStatus(400);
                }
            }
            case 'json_v3':
            case 'v3': {
                try {
                    const json = await readCharacterData(filename);
                    if (json === undefined) return response.sendStatus(400);
                    const jsonObject = getCharaCardV2(JSON.parse(json), request.user.directories);
                    unsetPrivateFields(jsonObject);
                    const nowSecs = Math.floor(Date.now() / 1000);
                    const v3Object = {
                        spec: 'chara_card_v3',
                        spec_version: '3.0',
                        data: {
                            ...jsonObject.data,
                            name: jsonObject.name || jsonObject.data?.name || '',
                            description: jsonObject.description || jsonObject.data?.description || '',
                            personality: jsonObject.personality || jsonObject.data?.personality || '',
                            scenario: jsonObject.scenario || jsonObject.data?.scenario || '',
                            first_mes: jsonObject.first_mes || jsonObject.data?.first_mes || '',
                            mes_example: jsonObject.mes_example || jsonObject.data?.mes_example || '',
                            creator_notes: jsonObject.data?.creator_notes ?? jsonObject.creatorcomment ?? '',
                            tags: Array.isArray(jsonObject.tags) ? jsonObject.tags : (Array.isArray(jsonObject.data?.tags) ? jsonObject.data.tags : []),
                            system_prompt: jsonObject.data?.system_prompt ?? '',
                            post_history_instructions: jsonObject.data?.post_history_instructions ?? '',
                            creator: jsonObject.creator || jsonObject.data?.creator || '',
                            character_version: jsonObject.character_version || jsonObject.data?.character_version || '1.0',
                            alternate_greetings: Array.isArray(jsonObject.data?.alternate_greetings) ? jsonObject.data.alternate_greetings : [],
                            group_only_greetings: Array.isArray(jsonObject.data?.group_only_greetings) ? jsonObject.data.group_only_greetings : (Array.isArray(jsonObject.group_only_greetings) ? jsonObject.group_only_greetings : []),
                            extensions: jsonObject.data?.extensions || {},
                            modification_date: nowSecs,
                        },
                    };
                    if (jsonObject.data?.nickname || jsonObject.nickname) {
                        v3Object.data.nickname = jsonObject.data?.nickname || jsonObject.nickname;
                    }
                    if (jsonObject.data?.creator_notes_multilingual || jsonObject.creator_notes_multilingual) {
                        v3Object.data.creator_notes_multilingual = jsonObject.data?.creator_notes_multilingual || jsonObject.creator_notes_multilingual;
                    }
                    if (jsonObject.data?.source || jsonObject.source) {
                        v3Object.data.source = jsonObject.data?.source || jsonObject.source;
                    }
                    if (jsonObject.data?.creation_date || jsonObject.creation_date) {
                        v3Object.data.creation_date = jsonObject.data?.creation_date || jsonObject.creation_date;
                    } else {
                        v3Object.data.creation_date = nowSecs;
                    }
                    if (jsonObject.data?.assets || jsonObject.assets) {
                        v3Object.data.assets = jsonObject.data?.assets || jsonObject.assets;
                    }
                    if (jsonObject.data?.character_book) {
                        v3Object.data.character_book = jsonObject.data.character_book;
                    }
                    return response.type('json').send(JSON.stringify(v3Object, null, 4));
                } catch {
                    return response.sendStatus(400);
                }
            }
        }

        return response.sendStatus(400);
    } catch (err) {
        console.error('Character export failed', err);
        response.sendStatus(500);
    }
});

router.post('/upgrade-v3', async function (request, response) {
    try {
        const avatars = Array.isArray(request.body.avatar_urls)
            ? request.body.avatar_urls
            : (request.body.avatar_url ? [request.body.avatar_url] : []);

        if (avatars.length === 0) {
            return response.status(400).send('No avatar URLs provided');
        }

        const updated = [];
        for (const avatar of avatars) {
            const filename = path.join(request.user.directories.characters, sanitize(avatar));
            if (!fs.existsSync(filename)) continue;

            const raw = await readCharacterData(filename);
            if (!raw) continue;

            const charObj = getCharaCardV2(JSON.parse(raw), request.user.directories);
            const nowSecs = Math.floor(Date.now() / 1000);

            const v3Data = {
                ...charObj.data,
                name: charObj.name || charObj.data?.name || '',
                description: charObj.description || charObj.data?.description || '',
                personality: charObj.personality || charObj.data?.personality || '',
                scenario: charObj.scenario || charObj.data?.scenario || '',
                first_mes: charObj.first_mes || charObj.data?.first_mes || '',
                mes_example: charObj.mes_example || charObj.data?.mes_example || '',
                creator_notes: charObj.data?.creator_notes ?? charObj.creatorcomment ?? '',
                tags: Array.isArray(charObj.tags) ? charObj.tags : (Array.isArray(charObj.data?.tags) ? charObj.data.tags : []),
                system_prompt: charObj.data?.system_prompt ?? '',
                post_history_instructions: charObj.data?.post_history_instructions ?? '',
                creator: charObj.creator || charObj.data?.creator || '',
                character_version: charObj.character_version || charObj.data?.character_version || '1.0',
                alternate_greetings: Array.isArray(charObj.data?.alternate_greetings) ? charObj.data.alternate_greetings : [],
                group_only_greetings: Array.isArray(charObj.data?.group_only_greetings) ? charObj.data.group_only_greetings : (Array.isArray(charObj.group_only_greetings) ? charObj.group_only_greetings : []),
                extensions: charObj.data?.extensions || {},
                creation_date: charObj.data?.creation_date || charObj.creation_date || nowSecs,
                modification_date: nowSecs,
            };

            if (charObj.data?.nickname || charObj.nickname) {
                v3Data.nickname = charObj.data?.nickname || charObj.nickname;
            }
            if (charObj.data?.creator_notes_multilingual || charObj.creator_notes_multilingual) {
                v3Data.creator_notes_multilingual = charObj.data?.creator_notes_multilingual || charObj.creator_notes_multilingual;
            }
            if (charObj.data?.source || charObj.source) {
                v3Data.source = charObj.data?.source || charObj.source;
            }
            if (charObj.data?.assets || charObj.assets) {
                v3Data.assets = charObj.data?.assets || charObj.assets;
            }
            if (charObj.data?.character_book) {
                v3Data.character_book = charObj.data.character_book;
            }

            const v3Card = {
                spec: 'chara_card_v3',
                spec_version: '3.0',
                data: v3Data,
            };

            const targetFile = avatar.replace(/\.png$/i, '');
            await writeCharacterData(filename, JSON.stringify(v3Card), targetFile, request);
            updated.push(avatar);
        }

        return response.json({ success: true, count: updated.length, updated });
    } catch (err) {
        console.error('Failed to upgrade character(s) to CCv3:', err);
        return response.sendStatus(500);
    }
});

/**
 * Normalizes a character name by removing numbered suffixes, copy tags, extensions, and whitespace.
 * @param {string} name Character name or filename
 * @returns {string}
 */
export function normalizeCharacterName(name) {
    if (!name || typeof name !== 'string') return '';
    return name
        .replace(/\.png$/i, '')
        .replace(/[\s_-]*\(\s*\d+\s*\)$/g, '') // e.g. " (1)" or "(2)"
        .replace(/[\s_-]+\d+$/g, '') // e.g. " 1", "_1", "-1"
        .replace(/[\s_-]+copy(?:\s*\d+)?$/i, '') // e.g. " - Copy"
        .replace(/[\s_-]+v(?:er(?:sion)?)?\s*\d+(?:\.\d+)*$/i, '') // e.g. " v2", " - v1.0"
        .trim()
        .toLowerCase();
}

/**
 * Computes a SHA-256 hash over normalized core card content fields.
 * @param {object} card Character card object
 * @returns {string}
 */
export function calculateContentHash(card) {
    if (!card || typeof card !== 'object') return '';
    const data = card.data || card;
    const text = [
        (data.description || '').trim(),
        (data.personality || '').trim(),
        (data.scenario || '').trim(),
        (data.first_mes || '').trim(),
        (data.mes_example || '').trim(),
        (data.system_prompt || '').trim(),
    ].join('\n---\n');
    return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Calculates Dice coefficient similarity between two strings using bigrams.
 * @param {string} textA First text
 * @param {string} textB Second text
 * @returns {number} Value between 0.0 and 1.0
 */
export function calculateSimilarityScore(textA, textB) {
    if (!textA || !textB) return 0;
    const cleanA = textA.toLowerCase().replace(/\s+/g, ' ').trim();
    const cleanB = textB.toLowerCase().replace(/\s+/g, ' ').trim();
    if (cleanA === cleanB) return 1;
    if (cleanA.length < 2 || cleanB.length < 2) return 0;

    const getBigrams = (str) => {
        const bigrams = new Map();
        for (let i = 0; i < str.length - 1; i++) {
            const bigram = str.substring(i, i + 2);
            bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
        }
        return bigrams;
    };

    const bigramsA = getBigrams(cleanA);
    const bigramsB = getBigrams(cleanB);
    let intersection = 0;

    for (const [bigram, countA] of bigramsA.entries()) {
        const countB = bigramsB.get(bigram) || 0;
        intersection += Math.min(countA, countB);
    }

    const totalBigrams = (cleanA.length - 1) + (cleanB.length - 1);
    return (2 * intersection) / totalBigrams;
}

/**
 * Retrieves chat count and total message count for a character.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} internalName Character internal folder name
 * @returns {Promise<{ chatCount: number, messageCount: number }>}
 */
async function getCharacterChatStats(directories, internalName) {
    const chatsPath = path.join(directories.chats, internalName);
    if (!fs.existsSync(chatsPath)) {
        return { chatCount: 0, messageCount: 0 };
    }
    try {
        const files = await fsPromises.readdir(chatsPath, { withFileTypes: true });
        const jsonlFiles = files.filter(f => f.isFile() && f.name.endsWith('.jsonl'));
        let messageCount = 0;
        for (const file of jsonlFiles) {
            try {
                const content = await fsPromises.readFile(path.join(chatsPath, file.name), 'utf8');
                const lines = content.split('\n').filter(l => l.trim().length > 0);
                messageCount += Math.max(0, lines.length - 1);
            } catch {
                // ignore unreadable file
            }
        }
        return { chatCount: jsonlFiles.length, messageCount };
    } catch {
        return { chatCount: 0, messageCount: 0 };
    }
}

router.post('/dedupe/scan', async function (request, response) {
    try {
        const {
            matchTypes = ['name', 'hash'],
            similarityThreshold = 0.85,
            ignoredPairs = [],
        } = request.body || {};

        const charactersDir = request.user.directories.characters;
        if (!fs.existsSync(charactersDir)) {
            return response.json({ clusters: [], totalCharacters: 0, totalDuplicates: 0 });
        }

        const files = await fsPromises.readdir(charactersDir, { withFileTypes: true });
        const pngFiles = files.filter(f => f.isFile() && f.name.toLowerCase().endsWith('.png'));

        const cardRecords = [];

        for (const file of pngFiles) {
            const avatar = file.name;
            const fullPath = path.join(charactersDir, avatar);
            try {
                const stat = await fsPromises.stat(fullPath);
                const rawData = await readCharacterData(fullPath);
                if (!rawData) continue;

                const parsed = JSON.parse(rawData);
                const card = getCharaCardV2(parsed, request.user.directories);
                const data = card.data || card;
                const internalName = path.parse(avatar).name;
                const stats = await getCharacterChatStats(request.user.directories, internalName);

                const chubPath = data.extensions?.chub?.full_path || '';
                const chubId = data.extensions?.chub?.id !== undefined ? String(data.extensions.chub.id) : '';
                const v3Id = data.id || card.id || '';
                const sourceUrl = data.extensions?.source_url || data.extensions?.character_id || '';

                cardRecords.push({
                    avatar,
                    name: data.name || internalName,
                    normalizedName: normalizeCharacterName(data.name || internalName),
                    character_version: data.character_version || '',
                    creator: String(data.creator || card.creator || '').trim(),
                    creator_notes: data.creator_notes || data.creatorcomment || '',
                    contentHash: calculateContentHash(card),
                    chubPath,
                    chubId,
                    v3Id,
                    sourceUrl,
                    descriptionText: [data.description, data.personality, data.scenario].filter(Boolean).join(' '),
                    chatCount: stats.chatCount,
                    messageCount: stats.messageCount,
                    mtime: stat.mtimeMs,
                    size: stat.size,
                    card,
                });
            } catch (err) {
                console.warn(`Could not read character for dedupe scan: ${avatar}`, err);
            }
        }

        const ignoredSet = new Set(ignoredPairs.map(p => Array.isArray(p) ? p.sort().join('::') : ''));
        const isIgnored = (avA, avB) => ignoredSet.has([avA, avB].sort().join('::'));

        const parent = new Map();
        const find = (i) => {
            if (parent.get(i) === i) return i;
            const root = find(parent.get(i));
            parent.set(i, root);
            return root;
        };
        const union = (i, j) => {
            const rootI = find(i);
            const rootJ = find(j);
            if (rootI !== rootJ) {
                parent.set(rootI, rootJ);
            }
        };

        for (let i = 0; i < cardRecords.length; i++) {
            parent.set(i, i);
        }

        for (let i = 0; i < cardRecords.length; i++) {
            for (let j = i + 1; j < cardRecords.length; j++) {
                const a = cardRecords[i];
                const b = cardRecords[j];

                if (isIgnored(a.avatar, b.avatar)) {
                    continue;
                }

                let matched = false;

                // 1. Upstream Source ID Match (exact same upstream character)
                if (
                    (a.chubPath && b.chubPath && a.chubPath === b.chubPath) ||
                    (a.chubId && b.chubId && a.chubId === b.chubId) ||
                    (a.v3Id && b.v3Id && a.v3Id === b.v3Id) ||
                    (a.sourceUrl && b.sourceUrl && a.sourceUrl === b.sourceUrl)
                ) {
                    matched = true;
                }

                // 2. Exact Definition Content Hash Match
                if (!matched && matchTypes.includes('hash') && a.contentHash && a.contentHash === b.contentHash) {
                    matched = true;
                }

                // 3. If creators are both non-empty and differ, they are by different authors and not duplicates
                const aCreator = a.creator.toLowerCase();
                const bCreator = b.creator.toLowerCase();
                const creatorsConflict = aCreator && bCreator && aCreator !== bCreator;

                if (!matched && !creatorsConflict) {
                    // 4. Guarded Name Match
                    if (matchTypes.includes('name') && a.normalizedName && a.normalizedName === b.normalizedName) {
                        const simScore = calculateSimilarityScore(a.descriptionText, b.descriptionText);
                        if (aCreator && bCreator && aCreator === bCreator) {
                            // Same creator + same normalized name: allow if text similarity is moderate (>= 0.35) or version differs
                            if (simScore >= 0.35 || (a.character_version && b.character_version && a.character_version !== b.character_version)) {
                                matched = true;
                            }
                        } else if (simScore >= similarityThreshold) {
                            // Creator omitted on one/both: require high similarity to avoid false positive on common names
                            matched = true;
                        }
                    }

                    // 5. Fuzzy Description Similarity Match
                    if (!matched && matchTypes.includes('fuzzy') && a.descriptionText && b.descriptionText) {
                        const score = calculateSimilarityScore(a.descriptionText, b.descriptionText);
                        if (score >= similarityThreshold) {
                            matched = true;
                        }
                    }
                }

                if (matched) {
                    union(i, j);
                }
            }
        }

        const clusterMap = new Map();
        for (let i = 0; i < cardRecords.length; i++) {
            const root = find(i);
            if (!clusterMap.has(root)) {
                clusterMap.set(root, []);
            }
            clusterMap.get(root).push(cardRecords[i]);
        }

        const clusters = [];
        let totalDuplicates = 0;

        for (const [root, members] of clusterMap.entries()) {
            if (members.length < 2) {
                continue;
            }

            members.sort((a, b) => {
                const vA = parseFloat(a.character_version) || 0;
                const vB = parseFloat(b.character_version) || 0;
                if (vB !== vA) return vB - vA;
                if (b.chatCount !== a.chatCount) return b.chatCount - a.chatCount;
                return b.mtime - a.mtime;
            });

            const recommendedPrimary = members[0].avatar;
            totalDuplicates += (members.length - 1);

            clusters.push({
                id: `cluster_${members[0].normalizedName || root}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                name: members[0].name,
                normalizedName: members[0].normalizedName,
                recommendedPrimary,
                cards: members.map(m => ({
                    avatar: m.avatar,
                    name: m.name,
                    character_version: m.character_version,
                    creator: m.creator,
                    creator_notes: m.creator_notes,
                    chatCount: m.chatCount,
                    messageCount: m.messageCount,
                    mtime: m.mtime,
                    size: m.size,
                    isRecommendedPrimary: m.avatar === recommendedPrimary,
                })),
            });
        }

        return response.json({
            clusters,
            totalCharacters: cardRecords.length,
            totalDuplicates,
        });
    } catch (err) {
        console.error('Dedupe scan error:', err);
        return response.status(500).send({ message: 'Error scanning for duplicates', error: err.message });
    }
});

router.post('/dedupe/consolidate', async function (request, response) {
    try {
        const {
            primaryAvatar,
            duplicateAvatars = [],
            strategy = 'smart_merge',
            safeMode = 'trash',
            options = {},
        } = request.body || {};

        if (!primaryAvatar || !Array.isArray(duplicateAvatars) || duplicateAvatars.length === 0) {
            return response.status(400).send({ message: 'Missing primaryAvatar or duplicateAvatars' });
        }

        const charactersDir = request.user.directories.characters;
        const chatsDir = request.user.directories.chats;
        const groupsDir = request.user.directories.groups;
        const backupsDir = path.join(request.user.directories.backups, 'dedupe');

        const primaryPath = path.join(charactersDir, sanitize(primaryAvatar));
        if (!fs.existsSync(primaryPath)) {
            return response.status(404).send({ message: `Primary avatar not found: ${primaryAvatar}` });
        }

        const validDupAvatars = duplicateAvatars
            .map(av => sanitize(av))
            .filter(av => av !== primaryAvatar && fs.existsSync(path.join(charactersDir, av)));

        if (validDupAvatars.length === 0) {
            return response.status(400).send({ message: 'No valid duplicate avatars to consolidate' });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupId = `dedupe_${timestamp}`;
        const backupPath = path.join(backupsDir, backupId);

        if (options.createBackup !== false) {
            await fsPromises.mkdir(backupPath, { recursive: true });
            await fsPromises.mkdir(path.join(backupPath, 'characters'), { recursive: true });
            await fsPromises.mkdir(path.join(backupPath, 'chats'), { recursive: true });
            await fsPromises.mkdir(path.join(backupPath, 'groups'), { recursive: true });

            // Backup character cards
            await fsPromises.copyFile(primaryPath, path.join(backupPath, 'characters', primaryAvatar));
            for (const dup of validDupAvatars) {
                await fsPromises.copyFile(path.join(charactersDir, dup), path.join(backupPath, 'characters', dup));
            }

            // Backup chats
            const primaryInternal = path.parse(primaryAvatar).name;
            const primaryChatDir = path.join(chatsDir, primaryInternal);
            if (fs.existsSync(primaryChatDir)) {
                await fsPromises.cp(primaryChatDir, path.join(backupPath, 'chats', primaryInternal), { recursive: true });
            }

            for (const dup of validDupAvatars) {
                const dupInternal = path.parse(dup).name;
                const dupChatDir = path.join(chatsDir, dupInternal);
                if (fs.existsSync(dupChatDir)) {
                    await fsPromises.cp(dupChatDir, path.join(backupPath, 'chats', dupInternal), { recursive: true });
                }
            }

            // Backup groups
            if (fs.existsSync(groupsDir)) {
                const groupFiles = await fsPromises.readdir(groupsDir);
                for (const gFile of groupFiles) {
                    if (gFile.endsWith('.json')) {
                        await fsPromises.copyFile(path.join(groupsDir, gFile), path.join(backupPath, 'groups', gFile));
                    }
                }
            }

            const manifest = {
                id: backupId,
                timestamp: new Date().toISOString(),
                primaryAvatar,
                duplicateAvatars: validDupAvatars,
                strategy,
                safeMode,
            };
            await writeFileAtomic(path.join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 4), 'utf8');
        }

        // 1. Migrate Chats
        let totalChatsMigrated = 0;
        const primaryInternal = path.parse(primaryAvatar).name;
        const primaryChatDir = path.join(chatsDir, primaryInternal);
        await fsPromises.mkdir(primaryChatDir, { recursive: true });

        for (const dup of validDupAvatars) {
            const dupInternal = path.parse(dup).name;
            const dupChatDir = path.join(chatsDir, dupInternal);
            if (fs.existsSync(dupChatDir)) {
                const chatFiles = await fsPromises.readdir(dupChatDir);
                for (const cFile of chatFiles) {
                    if (cFile.endsWith('.jsonl')) {
                        let destFile = cFile;
                        let targetPath = path.join(primaryChatDir, destFile);
                        if (fs.existsSync(targetPath)) {
                            const ext = path.extname(cFile);
                            const base = path.basename(cFile, ext);
                            destFile = `${base} - (from ${dupInternal})${ext}`;
                            targetPath = path.join(primaryChatDir, destFile);
                        }
                        await fsPromises.copyFile(path.join(dupChatDir, cFile), targetPath);
                        totalChatsMigrated++;
                    }
                }
                await fsPromises.rm(dupChatDir, { recursive: true, force: true });
            }
        }

        // 2. Relink Groups
        let groupsUpdatedCount = 0;
        if (fs.existsSync(groupsDir) && options.updateGroups !== false) {
            const groupFiles = await fsPromises.readdir(groupsDir);
            for (const gFile of groupFiles) {
                if (gFile.endsWith('.json')) {
                    try {
                        const gPath = path.join(groupsDir, gFile);
                        const raw = await fsPromises.readFile(gPath, 'utf8');
                        const groupObj = tryParse(raw);
                        if (groupObj && Array.isArray(groupObj.members)) {
                            let modified = false;
                            const newMembers = [];
                            for (const member of groupObj.members) {
                                if (validDupAvatars.includes(member)) {
                                    if (!newMembers.includes(primaryAvatar)) {
                                        newMembers.push(primaryAvatar);
                                    }
                                    modified = true;
                                } else {
                                    if (!newMembers.includes(member)) {
                                        newMembers.push(member);
                                    }
                                }
                            }
                            if (modified) {
                                groupObj.members = newMembers;
                                await writeFileAtomic(gPath, JSON.stringify(groupObj, null, 4), 'utf8');
                                groupsUpdatedCount++;
                            }
                        }
                    } catch (gErr) {
                        console.warn(`Could not update group file ${gFile}:`, gErr);
                    }
                }
            }
        }

        // 3. Migrate Expression Sprites
        for (const dup of validDupAvatars) {
            const dupInternal = path.parse(dup).name;
            const dupSpriteDir = path.join(charactersDir, dupInternal);
            const primarySpriteDir = path.join(charactersDir, primaryInternal);
            if (fs.existsSync(dupSpriteDir)) {
                await fsPromises.mkdir(primarySpriteDir, { recursive: true });
                const spriteFiles = await fsPromises.readdir(dupSpriteDir);
                for (const sFile of spriteFiles) {
                    const targetSprite = path.join(primarySpriteDir, sFile);
                    if (!fs.existsSync(targetSprite)) {
                        await fsPromises.copyFile(path.join(dupSpriteDir, sFile), targetSprite);
                    }
                }
                await fsPromises.rm(dupSpriteDir, { recursive: true, force: true });
            }
        }

        // 4. Smart Merge Card Data into Primary if requested
        if (strategy === 'smart_merge') {
            try {
                const primaryRaw = await readCharacterData(primaryPath);
                if (primaryRaw) {
                    let primaryCard = getCharaCardV2(JSON.parse(primaryRaw), request.user.directories);
                    let data = primaryCard.data || primaryCard;

                    for (const dup of validDupAvatars) {
                        const dupRaw = await readCharacterData(path.join(charactersDir, dup));
                        if (!dupRaw) continue;
                        const dupCard = getCharaCardV2(JSON.parse(dupRaw), request.user.directories);
                        const dupData = dupCard.data || dupCard;

                        // Merge Alternate Greetings
                        if (options.mergeGreetings !== false && Array.isArray(dupData.alternate_greetings)) {
                            const existingGreetings = new Set(data.alternate_greetings || []);
                            for (const g of dupData.alternate_greetings) {
                                if (g && typeof g === 'string' && !existingGreetings.has(g)) {
                                    if (!data.alternate_greetings) data.alternate_greetings = [];
                                    data.alternate_greetings.push(g);
                                    existingGreetings.add(g);
                                }
                            }
                        }

                        // Merge Character Book Entries
                        if (options.mergeLorebook !== false && dupData.character_book && Array.isArray(dupData.character_book.entries)) {
                            if (!data.character_book) {
                                data.character_book = _.cloneDeep(dupData.character_book);
                            } else {
                                if (!Array.isArray(data.character_book.entries)) data.character_book.entries = [];
                                for (const dupEntry of dupData.character_book.entries) {
                                    const match = data.character_book.entries.find(e =>
                                        (e.id !== undefined && e.id === dupEntry.id) ||
                                        (e.comment && e.comment === dupEntry.comment) ||
                                        (Array.isArray(e.keys) && Array.isArray(dupEntry.keys) && e.keys.join(',') === dupEntry.keys.join(',')),
                                    );
                                    if (!match) {
                                        data.character_book.entries.push(_.cloneDeep(dupEntry));
                                    }
                                }
                            }
                        }

                        // Merge Regex Scripts
                        if (options.mergeRegex !== false && dupData.extensions?.regex_scripts && Array.isArray(dupData.extensions.regex_scripts)) {
                            if (!data.extensions) data.extensions = {};
                            if (!Array.isArray(data.extensions.regex_scripts)) data.extensions.regex_scripts = [];
                            const existingScripts = new Set(data.extensions.regex_scripts.map(s => s.scriptName || s.id));
                            for (const script of dupData.extensions.regex_scripts) {
                                if (!existingScripts.has(script.scriptName || script.id)) {
                                    data.extensions.regex_scripts.push(_.cloneDeep(script));
                                    existingScripts.add(script.scriptName || script.id);
                                }
                            }
                        }

                        // Merge Tags
                        if (options.mergeTags !== false && Array.isArray(dupData.tags)) {
                            const existingTags = new Set(data.tags || []);
                            for (const t of dupData.tags) {
                                if (t && typeof t === 'string' && !existingTags.has(t)) {
                                    if (!data.tags) data.tags = [];
                                    data.tags.push(t);
                                    existingTags.add(t);
                                }
                            }
                        }
                    }

                    // Save merged primary card
                    const primaryBuffer = await fsPromises.readFile(primaryPath);
                    const updatedBuffer = write(primaryBuffer, JSON.stringify(primaryCard));
                    await writeFileAtomic(primaryPath, updatedBuffer);
                }
            } catch (mergeErr) {
                console.warn('Smart merge metadata warning:', mergeErr);
            }
        }

        // 5. Dispose Duplicate Character Files according to SafeMode
        const archiveDir = path.join(charactersDir, '_dedupe_archive');
        if (safeMode === 'trash') {
            await fsPromises.mkdir(archiveDir, { recursive: true });
        }

        for (const dup of validDupAvatars) {
            const dupPath = path.join(charactersDir, dup);
            invalidateThumbnail(request.user.directories, 'avatar', dup);
            if (fs.existsSync(dupPath)) {
                if (safeMode === 'trash') {
                    const destArchive = path.join(archiveDir, `${dup}.disabled`);
                    await fsPromises.rename(dupPath, destArchive);
                } else if (safeMode === 'delete') {
                    await fsPromises.unlink(dupPath);
                }
            }
        }

        // Invalidate in-memory and disk caches for modified and removed characters
        for (const key of memoryCache.keys()) {
            if (key.startsWith(primaryPath) || validDupAvatars.some(dup => key.startsWith(path.join(charactersDir, dup)))) {
                memoryCache.delete(key);
            }
        }
        if (useDiskCache) {
            diskCache.syncQueue.add(request.user.profile.handle);
        }

        return response.json({
            success: true,
            backupId,
            primaryAvatar,
            duplicatesProcessed: validDupAvatars.length,
            chatsMigrated: totalChatsMigrated,
            groupsUpdated: groupsUpdatedCount,
            safeMode,
        });
    } catch (err) {
        console.error('Dedupe consolidate error:', err);
        return response.status(500).send({ message: 'Error consolidating duplicates', error: err.message });
    }
});

router.post('/dedupe/backups', async function (request, response) {
    try {
        const backupsDir = path.join(request.user.directories.backups, 'dedupe');
        if (!fs.existsSync(backupsDir)) {
            return response.json({ backups: [] });
        }

        const entries = await fsPromises.readdir(backupsDir, { withFileTypes: true });
        const backups = [];

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const manifestPath = path.join(backupsDir, entry.name, 'manifest.json');
                if (fs.existsSync(manifestPath)) {
                    try {
                        const raw = await fsPromises.readFile(manifestPath, 'utf8');
                        const manifest = tryParse(raw);
                        if (manifest) {
                            backups.push(manifest);
                        }
                    } catch {
                        // ignore unreadable manifest
                    }
                }
            }
        }

        backups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return response.json({ backups });
    } catch (err) {
        console.error('Dedupe backups error:', err);
        return response.status(500).send({ message: 'Error listing backups', error: err.message });
    }
});

router.post('/dedupe/restore', async function (request, response) {
    try {
        const { backupId } = request.body || {};
        if (!backupId || typeof backupId !== 'string') {
            return response.status(400).send({ message: 'Missing backupId' });
        }

        const backupsDir = path.join(request.user.directories.backups, 'dedupe');
        const backupPath = path.join(backupsDir, sanitize(backupId));
        const manifestPath = path.join(backupPath, 'manifest.json');

        if (!fs.existsSync(manifestPath)) {
            return response.status(404).send({ message: `Backup not found: ${backupId}` });
        }

        const manifestRaw = await fsPromises.readFile(manifestPath, 'utf8');
        const manifest = tryParse(manifestRaw);
        if (!manifest) {
            return response.status(500).send({ message: 'Corrupted backup manifest' });
        }

        const charactersDir = request.user.directories.characters;
        const chatsDir = request.user.directories.chats;
        const groupsDir = request.user.directories.groups;
        const archiveDir = path.join(charactersDir, '_dedupe_archive');

        // Restore character cards
        const backupCharDir = path.join(backupPath, 'characters');
        if (fs.existsSync(backupCharDir)) {
            const charFiles = await fsPromises.readdir(backupCharDir);
            for (const cFile of charFiles) {
                await fsPromises.copyFile(path.join(backupCharDir, cFile), path.join(charactersDir, cFile));
                invalidateThumbnail(request.user.directories, 'avatar', cFile);

                // If disabled archive exists, clean it up
                const archivedFile = path.join(archiveDir, `${cFile}.disabled`);
                if (fs.existsSync(archivedFile)) {
                    await fsPromises.unlink(archivedFile).catch(() => {});
                }
            }
        }

        // Restore chats
        const backupChatsDir = path.join(backupPath, 'chats');
        if (fs.existsSync(backupChatsDir)) {
            const chatDirs = await fsPromises.readdir(backupChatsDir);
            for (const cDir of chatDirs) {
                const targetChatDir = path.join(chatsDir, cDir);
                await fsPromises.rm(targetChatDir, { recursive: true, force: true }).catch(() => {});
                await fsPromises.cp(path.join(backupChatsDir, cDir), targetChatDir, { recursive: true });
            }
        }

        // Restore groups
        const backupGroupsDir = path.join(backupPath, 'groups');
        if (fs.existsSync(backupGroupsDir)) {
            const groupFiles = await fsPromises.readdir(backupGroupsDir);
            for (const gFile of groupFiles) {
                await fsPromises.copyFile(path.join(backupGroupsDir, gFile), path.join(groupsDir, gFile));
            }
        }

        return response.json({
            success: true,
            message: 'Rollback completed successfully. All cards, chats, and groups restored.',
        });
    } catch (err) {
        console.error('Dedupe restore error:', err);
        return response.status(500).send({ message: 'Error restoring backup', error: err.message });
    }
});
