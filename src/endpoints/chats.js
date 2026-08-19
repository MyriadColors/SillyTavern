import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import crypto from 'node:crypto';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import _ from 'lodash';

import validateAvatarUrlMiddleware from '../middleware/validateFileName.js';
import {
    getConfigValue,
    humanizedDateTime,
    tryParse,
    generateTimestamp,
    removeOldBackups,
    formatBytes,
    tryWriteFileSync,
    tryReadFileSync,
    tryDeleteFile,
    readFirstLine,
    isPathUnderParent,
} from '../util.js';

const isBackupEnabled = !!getConfigValue('backups.chat.enabled', true, 'boolean');
const maxTotalChatBackups = Number(getConfigValue('backups.chat.maxTotalBackups', -1, 'number'));
const throttleInterval = Number(getConfigValue('backups.chat.throttleInterval', 10_000, 'number'));
const checkIntegrity = !!getConfigValue('backups.chat.checkIntegrity', true, 'boolean');

export const CHAT_BACKUPS_PREFIX = 'chat_';

/**
 * Saves a chat to the backups directory.
 * @param {string} directory The user's backup directory.
 * @param {string} name The name of the chat.
 * @param {string} data The serialized chat to save.
 * @param {string} backupPrefix The file prefix. Typically CHAT_BACKUPS_PREFIX.
 * @returns
 */
function backupChat(directory, name, data, backupPrefix = CHAT_BACKUPS_PREFIX) {
    try {
        if (!isBackupEnabled) { return; }
        if (!fs.existsSync(directory)) {
            console.error(`The chat couldn't be backed up because no directory exists at ${directory}!`);
        }
        // replace non-alphanumeric characters with underscores
        name = sanitize(name).replace(/[^a-z0-9]/gi, '_').toLowerCase();

        const backupFile = path.join(directory, `${backupPrefix}${name}_${generateTimestamp()}.jsonl`);

        tryWriteFileSync(backupFile, data);
        removeOldBackups(directory, `${backupPrefix}${name}_`);
        if (isNaN(maxTotalChatBackups) || maxTotalChatBackups < 0) {
            return;
        }
        removeOldBackups(directory, backupPrefix, maxTotalChatBackups);
    } catch (err) {
        console.error(`Could not backup chat for ${name}`, err);
    }
}

/**
 * @type {Map<string, import('lodash').DebouncedFunc<typeof backupChat>>}
 */
const backupFunctions = new Map();

/**
 * Gets a backup function for a user.
 * @param {string} handle User handle
 * @returns {typeof backupChat} Backup function
 */
function getBackupFunction(handle) {
    if (!backupFunctions.has(handle)) {
        backupFunctions.set(handle, _.throttle(backupChat, throttleInterval, { leading: true, trailing: true }));
    }
    return backupFunctions.get(handle) || (() => { });
}

/**
 * Gets a preview message from a chat message string.
 * @param {string} [lastMessage] - The message to truncate
 * @returns {string} A truncated preview of the last message or empty string if no messages
 */
function getPreviewMessage(lastMessage) {
    const strlen = 400;

    if (!lastMessage) {
        return '';
    }

    return lastMessage.length > strlen
        ? '...' + lastMessage.substring(lastMessage.length - strlen)
        : lastMessage;
}

process.on('exit', () => {
    for (const func of backupFunctions.values()) {
        func.flush();
    }
});

/**
 * Imports a chat from Ooba's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string} Chat data
 */
function importOobaChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const arr of jsonData.data_visible) {
        if (arr[0]) {
            const userMessage = {
                name: userName,
                is_user: true,
                send_date: new Date().toISOString(),
                mes: arr[0],
                extra: {},
            };
            chat.push(userMessage);
        }
        if (arr[1]) {
            const charMessage = {
                name: characterName,
                is_user: false,
                send_date: new Date().toISOString(),
                mes: arr[1],
                extra: {},
            };
            chat.push(charMessage);
        }
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from Agnai's format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Chat data
 * @returns {string} Chat data
 */
function importAgnaiChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.messages) {
        const isUser = !!message.userId;
        chat.push({
            name: isUser ? userName : characterName,
            is_user: isUser,
            send_date: new Date().toISOString(),
            mes: message.msg,
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Imports a chat from CAI Tools format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData JSON data
 * @returns {string[]} Converted data
 */
function importCAIChat(userName, characterName, jsonData) {
    /**
     * Converts the chat data to suitable format.
     * @param {object} history Imported chat data
     * @returns {object[]} Converted chat data
     */
    function convert(history) {
        const starter = {
            chat_metadata: {},
            user_name: 'unused',
            character_name: 'unused',
        };

        const historyData = history.msgs.map((msg) => ({
            name: msg.src.is_human ? userName : characterName,
            is_user: msg.src.is_human,
            send_date: new Date().toISOString(),
            mes: msg.text,
            extra: {},
        }));

        return [starter, ...historyData];
    }

    const newChats = (jsonData.histories.histories ?? []).map(history => newChats.push(convert(history).map(obj => JSON.stringify(obj)).join('\n')));
    return newChats;
}

/**
 * Imports a chat from Kobold Lite format.
 * @param {string} _userName User name
 * @param {string} _characterName Character name
 * @param {object} data JSON data
 * @returns {string} Chat data
 */
function importKoboldLiteChat(_userName, _characterName, data) {
    const inputToken = '{{[INPUT]}}';
    const outputToken = '{{[OUTPUT]}}';

    /** @type {function(string): object} */
    function processKoboldMessage(msg) {
        const isUser = msg.includes(inputToken);
        return {
            name: isUser ? userName : characterName,
            is_user: isUser,
            mes: msg.replaceAll(inputToken, '').replaceAll(outputToken, '').trim(),
            send_date: new Date().toISOString(),
            extra: {},
        };
    }

    // Create the header
    const userName = String(data.savedsettings.chatname);
    const characterName = String(data.savedsettings.chatopponent).split('||$||')[0];
    const header = {
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    };
    // Format messages
    const formattedMessages = data.actions.map(processKoboldMessage);
    // Add prompt if available
    if (data.prompt) {
        formattedMessages.unshift(processKoboldMessage(data.prompt));
    }
    // Combine header and messages
    const chatData = [header, ...formattedMessages];
    return chatData.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Flattens `msg` and `swipes` data from Chub Chat format.
 * Only changes enough to make it compatible with the standard chat serialization format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {string[]} lines serialised JSONL data
 * @returns {string} Converted data
 */
function flattenChubChat(userName, characterName, lines) {
    function flattenSwipe(swipe) {
        return swipe.message ? swipe.message : swipe;
    }

    function convert(line) {
        const lineData = tryParse(line);
        if (!lineData) return line;

        if (lineData.mes && lineData.mes.message) {
            lineData.mes = lineData?.mes.message;
        }

        if (lineData?.swipes && Array.isArray(lineData.swipes)) {
            lineData.swipes = lineData.swipes.map(swipe => flattenSwipe(swipe));
        }

        return JSON.stringify(lineData);
    }

    return (lines ?? []).map(convert).join('\n');
}

/**
 * Imports a chat from RisuAI format.
 * @param {string} userName User name
 * @param {string} characterName Character name
 * @param {object} jsonData Imported chat data
 * @returns {string} Chat data
 */
function importRisuChat(userName, characterName, jsonData) {
    /** @type {object[]} */
    const chat = [{
        chat_metadata: {},
        user_name: 'unused',
        character_name: 'unused',
    }];

    for (const message of jsonData.data.message) {
        const isUser = message.role === 'user';
        chat.push({
            name: message.name ?? (isUser ? userName : characterName),
            is_user: isUser,
            send_date: new Date(Number(message.time ?? Date.now())).toISOString(),
            mes: message.data ?? '',
            extra: {},
        });
    }

    return chat.map(obj => JSON.stringify(obj)).join('\n');
}

/**
 * Checks if the chat being saved has the same integrity as the one being loaded.
 * @param {string} filePath Path to the chat file
 * @param {string} integritySlug Integrity slug
 * @returns {Promise<boolean>} Whether the chat is intact
 */
async function checkChatIntegrity(filePath, integritySlug) {
    // If the chat file doesn't exist, assume it's intact
    if (!fs.existsSync(filePath)) {
        return true;
    }

    // Parse the first line of the chat file as JSON
    const firstLine = await readFirstLine(filePath);
    const jsonData = tryParse(firstLine);
    const chatIntegrity = jsonData?.chat_metadata?.integrity;

    // If the chat has no integrity metadata, assume it's intact
    if (!chatIntegrity) {
        console.debug(`File "${filePath}" does not have integrity metadata matching "${integritySlug}". The integrity validation has been skipped.`);
        return true;
    }

    // Check if the integrity matches
    return chatIntegrity === integritySlug;
}

/**
 * @typedef {Object} ChatInfo
 * @property {string} [file_id] - The name of the chat file (without extension)
 * @property {string} [file_name] - The name of the chat file (with extension)
 * @property {string} [file_size] - The size of the chat file in a human-readable format
 * @property {number} [chat_items] - The number of chat items in the file
 * @property {string} [mes] - The last message in the chat
 * @property {number|string} [last_mes] - The timestamp of the last message
 * @property {object} [chat_metadata] - Additional chat metadata
 * @property {boolean} [match] - Whether the chat matches the search criteria
 */

/**
 * Reads the information from a chat file.
 * @param {string} pathToFile - Path to the chat file
 * @param {object} additionalData - Additional data to include in the result
 * @param {boolean} withMetadata - Whether to read chat metadata
/**
 * In-memory cache for chat file metadata to avoid redundant line-by-line disk parses.
 * Keyed by absolute file path, validated against mtimeMs and size.
 */
export class ChatMetadataCache {
    /** @type {Map<string, { mtimeMs: number, size: number, data: object }>} */
    static #cache = new Map();
    static #maxEntries = 50000;

    /**
     * @param {string} filePath
     * @param {fs.Stats} stats
     * @returns {object|null}
     */
    static get(filePath, stats) {
        const entry = this.#cache.get(filePath);
        if (entry && entry.mtimeMs === stats.mtimeMs && entry.size === stats.size) {
            return entry.data;
        }
        return null;
    }

    /**
     * @param {string} filePath
     * @param {fs.Stats} stats
     * @param {object} data
     */
    static set(filePath, stats, data) {
        if (this.#cache.size >= this.#maxEntries) {
            const keysToDrop = Array.from(this.#cache.keys()).slice(0, Math.floor(this.#maxEntries * 0.2));
            keysToDrop.forEach(k => this.#cache.delete(k));
        }
        this.#cache.set(filePath, {
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            data,
        });
    }

    /**
     * @param {string} filePath
     */
    static invalidate(filePath) {
        this.#cache.delete(filePath);
    }

    static clear() {
        this.#cache.clear();
    }
}

/**
 * Gets chat info for a given file.
 * @param {string} pathToFile - Path to the chat file
 * @param {object} additionalData - Additional data to attach to the chat info
 * @param {boolean} withMetadata - If true, will include metadata in the chat info
 * @param {ChatMatchFunction|null} matcher - Optional function to match messages
 * @returns {Promise<ChatInfo>}
 *
 * @typedef {(textArray: string[]) => boolean} ChatMatchFunction
 */
export async function getChatInfo(pathToFile, additionalData = {}, withMetadata = false, matcher = null) {
    const parsedPath = path.parse(pathToFile);
    let stats;
    try {
        stats = await fs.promises.stat(pathToFile);
    } catch {
        return {};
    }

    const hasMatcher = (typeof matcher === 'function');

    if (!hasMatcher && !withMetadata) {
        const cached = ChatMetadataCache.get(pathToFile, stats);
        if (cached && cached.isValid) {
            return {
                match: true,
                file_id: cached.fileId,
                file_name: cached.fileName,
                file_size: cached.fileSize,
                chat_items: cached.totalMessages,
                mes: cached.previewMessage || '[The message is empty]',
                last_mes: cached.lastModifiedMs || stats.mtimeMs,
                ...additionalData,
            };
        }
    }

    const chatData = {
        match: false,
        file_id: parsedPath.name,
        file_name: parsedPath.base,
        file_size: formatBytes(stats.size),
        chat_items: 0,
        mes: '[The chat is empty]',
        last_mes: stats.mtimeMs,
        ...additionalData,
    };

    if (stats.size === 0) {
        return chatData;
    }

    let fileStream;
    let rl;
    try {
        fileStream = fs.createReadStream(pathToFile, { encoding: 'utf8' });
        rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity,
        });

        let lastLine;
        let itemCounter = 0;
        let hasAnyMatch = false;
        let matchBuffer = [];

        for await (const line of rl) {
            if (withMetadata && itemCounter === 0) {
                const jsonData = tryParse(line);
                if (jsonData && _.isObjectLike(jsonData.chat_metadata)) {
                    chatData.chat_metadata = jsonData.chat_metadata;
                }
            }
            // Skip matching if any match was already found
            if (hasMatcher && !hasAnyMatch && itemCounter > 0) {
                const jsonData = tryParse(line);
                if (jsonData) {
                    matchBuffer.push(jsonData.mes || '');
                    if (matcher(matchBuffer)) {
                        hasAnyMatch = true;
                        matchBuffer = [];
                    }
                }
            }
            itemCounter++;
            lastLine = line;
        }

        if (lastLine) {
            const jsonData = tryParse(lastLine);
            if (jsonData && (jsonData.name || jsonData.character_name || jsonData.chat_metadata)) {
                chatData.chat_items = (itemCounter - 1);
                chatData.mes = jsonData.mes || '[The message is empty]';
                chatData.last_mes = jsonData.send_date || new Date(Math.round(stats.mtimeMs)).toISOString();
                chatData.match = hasMatcher ? hasAnyMatch : true;
                return chatData;
            } else {
                console.warn('Found an invalid or corrupted chat file:', pathToFile);
                return {};
            }
        }

        return chatData;
    } catch (error) {
        console.warn('Failed to read chat file info for:', pathToFile, error?.message);
        return {};
    } finally {
        rl?.close();
        fileStream?.destroy();
    }
}

export const router = express.Router();

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error
class IntegrityMismatchError extends Error {
    constructor(...params) {
        // Pass remaining arguments (including vendor specific ones) to parent constructor
        super(...params);
        // Maintains proper stack trace for where our error was thrown (non-standard)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, IntegrityMismatchError);
        }
        this.date = new Date();
    }
}

/**
 * Tries to save the chat data to a file, performing an integrity check if required.
 * @param {Array} chatData The chat array to save.
 * @param {string} filePath Target file path for the data.
 * @param {boolean} skipIntegrityCheck If undefined, the chat's integrity will not be checked.
 * @param {string} handle The users handle, passed to getBackupFunction.
 * @param {string} cardName Passed to backupChat.
 * @param {string} backupDirectory Passed to backupChat.
 */
export async function trySaveChat(chatData, filePath, skipIntegrityCheck = false, handle, cardName, backupDirectory) {
    const jsonlData = chatData?.map(m => JSON.stringify(m)).join('\n');

    const doIntegrityCheck = (checkIntegrity && !skipIntegrityCheck);
    const chatIntegritySlug = doIntegrityCheck ? chatData?.[0]?.chat_metadata?.integrity : undefined;

    if (chatIntegritySlug && !await checkChatIntegrity(filePath, chatIntegritySlug)) {
        throw new IntegrityMismatchError(`Chat integrity check failed for "${filePath}". The expected integrity slug was "${chatIntegritySlug}".`);
    }
    tryWriteFileSync(filePath, jsonlData);
    getBackupFunction(handle)(backupDirectory, cardName, jsonlData);
}

router.post('/save', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const handle = request.user.profile.handle;
        const cardName = String(request.body.avatar_url).replace('.png', '');
        const chatData = request.body.chat;
        const chatFileName = `${String(request.body.file_name)}.jsonl`;
        const chatFilePath = path.join(request.user.directories.chats, cardName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }

        if (Array.isArray(chatData)) {
            await trySaveChat(chatData, chatFilePath, request.body.force, handle, cardName, request.user.directories.backups);
            return response.send({ ok: true });
        } else {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            console.error(error.message);
            return response.status(400).send({ error: 'integrity' });
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

/**
 * Gets the chat as an object.
 * @param {string} chatFilePath The full chat file path.
 * @returns {Array}} If the chatFilePath cannot be read, this will return [].
 */
export function getChatData(chatFilePath) {
    let chatData = [];

    const chatJSON = tryReadFileSync(chatFilePath) ?? '';
    if (chatJSON.length > 0) {
        const lines = chatJSON.split('\n');
        // Iterate through the array of strings and parse each line as JSON
        chatData = lines.map(line => tryParse(line)).filter(x => x);
    } else {
        console.warn(`File not found: ${chatFilePath}. The chat does not exist or is empty.`);
    }

    return chatData;
}

router.post('/get', validateAvatarUrlMiddleware, function (request, response) {
    try {
        const dirName = String(request.body.avatar_url).replace('.png', '');
        const directoryPath = path.join(request.user.directories.chats, dirName);
        if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
            return response.sendStatus(400);
        }
        const chatDirExists = fs.existsSync(directoryPath);

        //if no chat dir for the character is found, make one with the character name
        if (!chatDirExists) {
            fs.mkdirSync(directoryPath);
            return response.send({});
        }

        if (!request.body.file_name) {
            return response.send({});
        }

        const chatFileName = `${String(request.body.file_name)}.jsonl`;
        const chatFilePath = path.join(directoryPath, sanitize(chatFileName));

        return response.send(getChatData(chatFilePath));
    } catch (error) {
        console.error(error);
        return response.send({});
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        if (!request.body || !request.body.original_file || !request.body.renamed_file) {
            return response.sendStatus(400);
        }

        const pathToFolder = request.body.is_group
            ? request.user.directories.groupChats
            : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
        if (!request.body.is_group && !isPathUnderParent(request.user.directories.chats, pathToFolder)) {
            return response.sendStatus(400);
        }
        const pathToOriginalFile = path.join(pathToFolder, sanitize(request.body.original_file));
        const pathToRenamedFile = path.join(pathToFolder, sanitize(request.body.renamed_file));
        const sanitizedFileName = path.parse(pathToRenamedFile).name;
        console.debug('Old chat name', pathToOriginalFile);
        console.debug('New chat name', pathToRenamedFile);

        if (!fs.existsSync(pathToOriginalFile) || fs.existsSync(pathToRenamedFile)) {
            console.error('Either Source or Destination files are not available');
            return response.status(400).send({ error: true });
        }

        fs.copyFileSync(pathToOriginalFile, pathToRenamedFile);
        fs.unlinkSync(pathToOriginalFile);
        console.info('Successfully renamed chat file.');
        return response.send({ ok: true, sanitizedFileName });
    } catch (error) {
        console.error('Error renaming chat file:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/delete', validateAvatarUrlMiddleware, function (request, response) {
    try {
        if (!path.extname(request.body.chatfile)) {
            request.body.chatfile += '.jsonl';
        }

        const dirName = String(request.body.avatar_url).replace('.png', '');
        const chatFileName = String(request.body.chatfile);
        const chatFilePath = path.join(request.user.directories.chats, dirName, sanitize(chatFileName));
        if (!isPathUnderParent(request.user.directories.chats, chatFilePath)) {
            return response.sendStatus(400);
        }
        //Return success if the file was deleted.
        if (tryDeleteFile(chatFilePath)) {
            ChatMetadataCache.invalidate(chatFilePath);
            return response.send({ ok: true });
        } else {
            console.error('The chat file was not deleted.');
            return response.sendStatus(400);
        }
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/export', validateAvatarUrlMiddleware, async function (request, response) {
    if (!request.body.file || (!request.body.avatar_url && request.body.is_group === false)) {
        return response.sendStatus(400);
    }
    const pathToFolder = request.body.is_group
        ? request.user.directories.groupChats
        : path.join(request.user.directories.chats, String(request.body.avatar_url).replace('.png', ''));
    const filename = path.join(pathToFolder, sanitize(request.body.file));
    if (!request.body.is_group && !isPathUnderParent(request.user.directories.chats, filename)) {
        return response.sendStatus(400);
    }
    let exportfilename = request.body.exportfilename;
    if (!fs.existsSync(filename)) {
        const errorMessage = {
            message: `Could not find JSONL file to export. Source chat file: ${filename}.`,
        };
        console.error(errorMessage.message);
        return response.status(404).json(errorMessage);
    }
    try {
        // Short path for JSONL files
        if (request.body.format === 'jsonl') {
            try {
                const rawFile = fs.readFileSync(filename, 'utf8');
                const successMessage = {
                    message: `Chat saved to ${exportfilename}`,
                    result: rawFile,
                };

                console.info(`Chat exported as ${exportfilename}`);
                return response.status(200).json(successMessage);
            } catch (err) {
                console.error(err);
                const errorMessage = {
                    message: `Could not read JSONL file to export. Source chat file: ${filename}.`,
                };
                console.error(errorMessage.message);
                return response.status(500).json(errorMessage);
            }
        }

        const readStream = fs.createReadStream(filename);
        const rl = readline.createInterface({
            input: readStream,
        });
        let buffer = '';
        rl.on('line', (line) => {
            const data = JSON.parse(line);
            // Skip non-printable/prompt-hidden messages
            if (data.is_system) {
                return;
            }
            if (data.mes) {
                const name = data.name;
                const message = (data?.extra?.display_text || data?.mes || '').replace(/\r?\n/g, '\n');
                buffer += (`${name}: ${message}\n\n`);
            }
        });
        rl.on('close', () => {
            const successMessage = {
                message: `Chat saved to ${exportfilename}`,
                result: buffer,
            };
            console.info(`Chat exported as ${exportfilename}`);
            return response.status(200).json(successMessage);
        });
    } catch (err) {
        console.error('chat export failed.', err);
        return response.sendStatus(400);
    }
});

router.post('/group/import', function (request, response) {
    try {
        const filedata = request.file;

        if (!filedata) {
            return response.sendStatus(400);
        }

        const chatname = humanizedDateTime();
        const pathToUpload = path.join(filedata.destination, filedata.filename);
        const pathToNewFile = path.join(request.user.directories.groupChats, `${chatname}.jsonl`);
        fs.copyFileSync(pathToUpload, pathToNewFile);
        fs.unlinkSync(pathToUpload);
        return response.send({ res: chatname });
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/import', validateAvatarUrlMiddleware, function (request, response) {
    if (!request.body) return response.sendStatus(400);

    const format = request.body.file_type;
    const avatarUrl = (request.body.avatar_url).replace('.png', '');
    const characterName = sanitize(request.body.character_name) || 'Character';
    const userName = sanitize(request.body.user_name) || 'User';
    const fileNames = [];

    if (!request.file) {
        return response.sendStatus(400);
    }

    const directoryPath = path.join(request.user.directories.chats, avatarUrl);
    if (!isPathUnderParent(request.user.directories.chats, directoryPath)) {
        return response.sendStatus(400);
    }

    try {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        const data = fs.readFileSync(pathToUpload, 'utf8');

        if (format === 'json') {
            fs.unlinkSync(pathToUpload);
            const jsonData = JSON.parse(data);

            /** @type {function(string, string, object): string|string[]} */
            let importFunc;

            if (jsonData.savedsettings !== undefined) { // Kobold Lite format
                importFunc = importKoboldLiteChat;
            } else if (jsonData.histories !== undefined) { // CAI Tools format
                importFunc = importCAIChat;
            } else if (Array.isArray(jsonData.data_visible)) { // oobabooga's format
                importFunc = importOobaChat;
            } else if (Array.isArray(jsonData.messages)) { // Agnai's format
                importFunc = importAgnaiChat;
            } else if (jsonData.type === 'risuChat') { // RisuAI format
                importFunc = importRisuChat;
            } else { // Unknown format
                console.error('Incorrect chat format .json');
                return response.send({ error: true });
            }

            const handleChat = (chat) => {
                const fileName = `${characterName} - ${humanizedDateTime()} imported.jsonl`;
                const filePath = path.join(directoryPath, fileName);
                fileNames.push(fileName);
                writeFileAtomicSync(filePath, chat, 'utf8');
            };

            const chat = importFunc(userName, characterName, jsonData);

            if (Array.isArray(chat)) {
                chat.forEach(handleChat);
            } else {
                handleChat(chat);
            }

            return response.send({ res: true, fileNames });
        }

        if (format === 'jsonl') {
            let lines = data.split('\n');
            const header = lines[0];

            const jsonData = JSON.parse(header);

            if (!(jsonData.user_name !== undefined || jsonData.name !== undefined || jsonData.chat_metadata !== undefined)) {
                console.error('Incorrect chat format .jsonl');
                return response.send({ error: true });
            }

            // Do a tiny bit of work to import Chub Chat data
            // Processing the entire file is so fast that it's not worth checking if it's a Chub chat first
            let flattenedChat = data;
            try {
                // flattening is unlikely to break, but it's not worth failing to
                // import normal chats in an attempt to import a Chub chat
                flattenedChat = flattenChubChat(userName, characterName, lines);
            } catch (error) {
                console.warn('Failed to flatten Chub Chat data: ', error);
            }

            const fileName = `${characterName} - ${humanizedDateTime()} imported.jsonl`;
            const filePath = path.join(directoryPath, fileName);
            fileNames.push(fileName);
            if (flattenedChat !== data) {
                writeFileAtomicSync(filePath, flattenedChat, 'utf8');
            } else {
                fs.copyFileSync(pathToUpload, filePath);
            }
            fs.unlinkSync(pathToUpload);
            response.send({ res: true, fileNames });
        }
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/group/get', (request, response) => {
    if (!request.body || !request.body.id) {
        return response.sendStatus(400);
    }

    const id = request.body.id;
    const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));

    return response.send(getChatData(chatFilePath));
});

router.post('/group/info', async (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));

        const chatInfo = await getChatInfo(chatFilePath);
        return response.send(chatInfo);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/group/delete', (request, response) => {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));

        //Return success if the file was deleted.
        if (tryDeleteFile(chatFilePath)) {
            return response.send({ ok: true });
        } else {
            console.error('The group chat file was not deleted.');
            return response.sendStatus(400);
        }
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/group/save', async function (request, response) {
    try {
        if (!request.body || !request.body.id) {
            return response.sendStatus(400);
        }

        const id = request.body.id;
        const handle = request.user.profile.handle;
        const chatFilePath = path.join(request.user.directories.groupChats, sanitize(`${id}.jsonl`));
        const chatData = request.body.chat;

        if (Array.isArray(chatData)) {
            await trySaveChat(chatData, chatFilePath, request.body.force, handle, String(id), request.user.directories.backups);
            return response.send({ ok: true });
        } else {
            return response.status(400).send({ error: 'The request\'s body.chat is not an array.' });
        }
    } catch (error) {
        if (error instanceof IntegrityMismatchError) {
            console.error(error.message);
            return response.status(400).send({ error: 'integrity' });
        }
        console.error(error);
        return response.status(500).send({ error: 'An error has occurred, see the console logs for more information.' });
    }
});

router.post('/search', validateAvatarUrlMiddleware, async function (request, response) {
    try {
        const { query, avatar_url, group_id } = request.body;

        /** @type {string[]} */
        let chatFiles = [];

        if (group_id) {
            // Find group's chat IDs first
            const groupDir = path.join(request.user.directories.groups);
            const groupFiles = fs.readdirSync(groupDir)
                .filter(file => path.extname(file) === '.json');

            let targetGroup;
            for (const groupFile of groupFiles) {
                try {
                    const groupData = JSON.parse(fs.readFileSync(path.join(groupDir, groupFile), 'utf8'));
                    if (groupData.id === group_id) {
                        targetGroup = groupData;
                        break;
                    }
                } catch (error) {
                    console.warn(groupFile, 'group file is corrupted:', error);
                }
            }

            if (!Array.isArray(targetGroup?.chats)) {
                return response.send([]);
            }

            // Find group chat files for given group ID
            const groupChatsDir = path.join(request.user.directories.groupChats);
            chatFiles = targetGroup.chats
                .map(chatId => path.join(groupChatsDir, `${chatId}.jsonl`))
                .filter(fileName => fs.existsSync(fileName));
        } else {
            // Regular character chat directory
            const character_name = avatar_url.replace('.png', '');
            const directoryPath = path.join(request.user.directories.chats, character_name);

            if (!fs.existsSync(directoryPath)) {
                return response.send([]);
            }

            chatFiles = fs.readdirSync(directoryPath)
                .filter(file => path.extname(file) === '.jsonl')
                .map(fileName => path.join(directoryPath, fileName));
        }

        /**
         * @type {SearchChatResult[]}
         * @typedef {object} SearchChatResult
         * @property {string} [file_name] - The name of the chat file
         * @property {string} [file_size] - The size of the chat file in a human-readable format
         * @property {number} [message_count] - The number of messages in the chat
         * @property {number|string} [last_mes] - The timestamp of the last message
         * @property {string} [preview_message] - A preview of the last message
         */
        const results = [];

        /** @type {string[]} */
        const fragments = query ? query.trim().toLowerCase().split(/\s+/).filter(x => x) : [];

        /** @type {ChatMatchFunction} */
        const hasTextMatch = (textArray) => {
            if (fragments.length === 0) {
                return true;
            }
            return fragments.every(fragment => textArray.some(text => String(text ?? '').toLowerCase().includes(fragment)));
        };

        for (const chatFile of chatFiles) {
            const matcher = query ? hasTextMatch : null;
            const chatInfo = await getChatInfo(chatFile, {}, false, matcher);
            const hasMatch = chatInfo.match || hasTextMatch([chatInfo.file_id ?? '']);

            // Skip corrupted or invalid chat files
            if (!chatInfo.file_name) {
                continue;
            }

            // Empty chats without a file name match are skipped when searching with a query
            if (query && chatInfo.chat_items === 0 && !hasMatch) {
                continue;
            }

            // If no search query or a match was found, include the chat in results
            if (!query || hasMatch) {
                results.push({
                    file_name: chatInfo.file_id,
                    file_size: chatInfo.file_size,
                    message_count: chatInfo.chat_items,
                    last_mes: chatInfo.last_mes,
                    preview_message: getPreviewMessage(chatInfo.mes),
                });
            }
        }

        return response.send(results);
    } catch (error) {
        console.error('Chat search error:', error);
        return response.status(500).json({ error: 'Search failed' });
    }
});

router.post('/recent', async function (request, response) {
    try {
        /** @typedef {{pngFile?: string, groupId?: string, filePath: string, mtime: number}} ChatFile */
        /** @type {ChatFile[]} */
        const allChatFiles = [];
        /** @type {import('../../public/scripts/welcome-screen.js').PinnedChat[]} */
        const pinnedChats = Array.isArray(request.body.pinned) ? request.body.pinned : [];

        const getCharacterChatFiles = async () => {
            const pngDirents = await fs.promises.readdir(request.user.directories.characters, { withFileTypes: true });
            const pngFiles = pngDirents.filter(e => e.isFile() && path.extname(e.name) === '.png').map(e => e.name);

            for (const pngFile of pngFiles) {
                const chatsDirectory = pngFile.replace('.png', '');
                const pathToChats = path.join(request.user.directories.chats, chatsDirectory);
                if (!fs.existsSync(pathToChats)) {
                    continue;
                }
                const pathStats = await fs.promises.stat(pathToChats);
                if (pathStats.isDirectory()) {
                    const chatFiles = await fs.promises.readdir(pathToChats);
                    const jsonlFiles = chatFiles.filter(file => path.extname(file) === '.jsonl');

                    for (const file of jsonlFiles) {
                        const filePath = path.join(pathToChats, file);
                        const stats = await fs.promises.stat(filePath);
                        allChatFiles.push({ pngFile, filePath, mtime: stats.mtimeMs });
                    }
                }
            }
        };

        const getGroupChatFiles = async () => {
            const groupDirents = await fs.promises.readdir(request.user.directories.groups, { withFileTypes: true });
            const groups = groupDirents.filter(e => e.isFile() && path.extname(e.name) === '.json').map(e => e.name);

            for (const group of groups) {
                try {
                    const groupPath = path.join(request.user.directories.groups, group);
                    const groupContents = await fs.promises.readFile(groupPath, 'utf8');
                    const groupData = JSON.parse(groupContents);

                    if (Array.isArray(groupData.chats)) {
                        for (const chat of groupData.chats) {
                            const filePath = path.join(request.user.directories.groupChats, `${chat}.jsonl`);
                            if (!fs.existsSync(filePath)) {
                                continue;
                            }
                            const stats = await fs.promises.stat(filePath);
                            allChatFiles.push({ groupId: groupData.id, filePath, mtime: stats.mtimeMs });
                        }
                    }
                } catch (error) {
                    // Skip group files that can't be read or parsed
                    continue;
                }
            }
        };

        const getRootChatFiles = async () => {
            const dirents = await fs.promises.readdir(request.user.directories.chats, { withFileTypes: true });
            const chatFiles = dirents.filter(e => e.isFile() && path.extname(e.name) === '.jsonl').map(e => e.name);

            for (const file of chatFiles) {
                const filePath = path.join(request.user.directories.chats, file);
                const stats = await fs.promises.stat(filePath);
                allChatFiles.push({ filePath, mtime: stats.mtimeMs });
            }
        };

        await Promise.allSettled([getCharacterChatFiles(), getGroupChatFiles(), getRootChatFiles()]);

        const max = parseInt(request.body.max ?? Number.MAX_SAFE_INTEGER) + pinnedChats.length;
        const isPinned = (/** @type {ChatFile} */ chatFile) => pinnedChats.some(p => p.file_name === path.basename(chatFile.filePath) && (p.avatar === chatFile.pngFile || p.group === chatFile.groupId));
        const recentChats = allChatFiles.sort((a, b) => {
            const isAPinned = isPinned(a);
            const isBPinned = isPinned(b);

            if (isAPinned && !isBPinned) return -1;
            if (!isAPinned && isBPinned) return 1;

            return b.mtime - a.mtime;
        }).slice(0, max);
        const jsonFilesPromise = recentChats.map((file) => {
            const withMetadata = !!request.body.metadata;
            return file.groupId
                ? getChatInfo(file.filePath, { group: file.groupId }, withMetadata)
                : getChatInfo(file.filePath, { avatar: file.pngFile }, withMetadata);
        });

        const chatData = (await Promise.allSettled(jsonFilesPromise)).filter(x => x.status === 'fulfilled').map(x => x.value);
        const validFiles = chatData.filter(i => i.file_name);

        return response.send(validFiles);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

/**
 * Calculates a SHA-256 hash representing the conversation message content and roles.
 * @param {Array<{is_user?: boolean, is_system?: boolean, mes?: string}>} messages List of message objects
 * @returns {string} SHA-256 hash of the messages
 */
export function calculateChatContentHash(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return '';
    }
    const normalized = messages.map(m => `${m.is_user ? 'U' : m.is_system ? 'S' : 'A'}:${(m.mes || '').trim()}`).join('\n');
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Analyzes a single chat JSONL file for deduplication with memory caching.
 * @param {string} filePath Absolute path to the chat JSONL file
 * @returns {Promise<{
 *   isValid: boolean,
 *   fileId: string,
 *   fileName: string,
 *   filePath: string,
 *   fileSize: string,
 *   fileSizeBytes: number,
 *   totalMessages: number,
 *   userMessagesCount: number,
 *   firstMessage: string,
 *   contentHash: string,
 *   lastModified: string,
 *   lastModifiedMs: number,
 *   previewMessage: string,
 * }>}
 */
export async function analyzeChatFile(filePath) {
    const parsedPath = path.parse(filePath);
    let stats;
    try {
        stats = await fs.promises.stat(filePath);
    } catch {
        return {
            isValid: false,
            fileId: parsedPath.name,
            fileName: parsedPath.base,
            filePath,
            fileSize: '0 B',
            fileSizeBytes: 0,
            totalMessages: 0,
            userMessagesCount: 0,
            firstMessage: '',
            contentHash: '',
            lastModified: '',
            lastModifiedMs: 0,
            previewMessage: '',
        };
    }

    const cached = ChatMetadataCache.get(filePath, stats);
    if (cached) {
        return cached;
    }

    if (stats.size === 0) {
        const emptyResult = {
            isValid: true,
            fileId: parsedPath.name,
            fileName: parsedPath.base,
            filePath,
            fileSize: formatBytes(0),
            fileSizeBytes: 0,
            totalMessages: 0,
            userMessagesCount: 0,
            firstMessage: '',
            contentHash: '',
            lastModified: new Date(stats.mtimeMs).toISOString(),
            lastModifiedMs: stats.mtimeMs,
            previewMessage: '',
        };
        ChatMetadataCache.set(filePath, stats, emptyResult);
        return emptyResult;
    }

    let fileStream;
    let rl;
    try {
        fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
        rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity,
        });

        let itemCounter = 0;
        let userMessagesCount = 0;
        let firstMessage = '';
        let lastMessage = '';
        const messagesForHash = [];

        for await (const line of rl) {
            if (!line.trim()) continue;
            const parsed = tryParse(line);
            if (!parsed) continue;

            if (itemCounter > 0) {
                if (parsed.is_user) {
                    userMessagesCount++;
                }
                if (itemCounter === 1) {
                    firstMessage = parsed.mes || '';
                }
                lastMessage = parsed.mes || '';
                messagesForHash.push({
                    is_user: !!parsed.is_user,
                    is_system: !!parsed.is_system,
                    mes: parsed.mes || '',
                });
            }
            itemCounter++;
        }

        const totalMessages = Math.max(0, itemCounter - 1);
        const contentHash = calculateChatContentHash(messagesForHash);

        const result = {
            isValid: true,
            fileId: parsedPath.name,
            fileName: parsedPath.base,
            filePath,
            fileSize: formatBytes(stats.size),
            fileSizeBytes: stats.size,
            totalMessages,
            userMessagesCount,
            firstMessage,
            contentHash,
            lastModified: new Date(stats.mtimeMs).toISOString(),
            lastModifiedMs: stats.mtimeMs,
            previewMessage: getPreviewMessage(lastMessage || firstMessage),
        };

        ChatMetadataCache.set(filePath, stats, result);
        return result;
    } catch (err) {
        console.warn(`Could not analyze chat file: ${filePath}`, err);
        return {
            isValid: false,
            fileId: parsedPath.name,
            fileName: parsedPath.base,
            filePath,
            fileSize: '0 B',
            fileSizeBytes: 0,
            totalMessages: 0,
            userMessagesCount: 0,
            firstMessage: '',
            contentHash: '',
            lastModified: '',
            lastModifiedMs: 0,
            previewMessage: '',
        };
    } finally {
        rl?.close();
    }
}

/**
 * Analyzes multiple chat files in parallel with bounded concurrency.
 * @param {string[]} filePaths
 * @param {number} [concurrency=16]
 * @returns {Promise<Array<object>>}
 */
export async function analyzeChatFilesBatch(filePaths, concurrency = 16) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return [];
    }

    const results = [];
    for (let i = 0; i < filePaths.length; i += concurrency) {
        const chunk = filePaths.slice(i, i + concurrency);
        const chunkResults = await Promise.all(chunk.map(fp => analyzeChatFile(fp)));
        results.push(...chunkResults);
    }
    return results;
}

/**
 * Clusters analyzed chat files for a character or group into deduplication groups.
 * @param {Array<object>} analyzedFiles List of analyzed chat files
 * @param {object} context Context info ({ characterName, avatar, isGroup, currentChatName })
 * @param {object} [options] Filter options ({ includeGreetingDuplicates, includeContentDuplicates })
 * @returns {Array<object>} List of clusters
 */
export function clusterAnalyzedChats(analyzedFiles, context, options = {}) {
    const { characterName = 'Character', avatar = '', isGroup = false, currentChatName = '' } = context;
    const { includeGreetingDuplicates = true, includeContentDuplicates = true } = options;
    const validFiles = analyzedFiles.filter(f => f && f.isValid);
    const clusters = [];

    validFiles.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);

    // 1. Cluster: Unused Greeting Chats (0 user messages)
    if (includeGreetingDuplicates) {
        const greetingFiles = validFiles.filter(f => f.userMessagesCount === 0);
        if (greetingFiles.length >= 2) {
            const primaryFile = greetingFiles.find(f => f.fileId === currentChatName) || greetingFiles[0];
            const duplicateFiles = greetingFiles.filter(f => f.fileId !== primaryFile.fileId);

            clusters.push({
                id: `greeting_${isGroup ? 'grp_' : 'chr_'}${avatar || characterName}`,
                type: 'greeting_duplicate',
                typeName: 'Unused Greeting Chats',
                name: `${characterName} — Unused Greeting Chats`,
                characterName,
                avatar,
                isGroup,
                recommendedPrimary: primaryFile.fileId,
                totalDuplicates: duplicateFiles.length,
                files: greetingFiles.map(f => ({
                    fileId: f.fileId,
                    fileName: f.fileName,
                    fileSize: f.fileSize,
                    fileSizeBytes: f.fileSizeBytes,
                    totalMessages: f.totalMessages,
                    userMessagesCount: f.userMessagesCount,
                    lastModified: f.lastModified,
                    previewMessage: f.previewMessage,
                    isPrimary: f.fileId === primaryFile.fileId,
                    selectedForDeletion: f.fileId !== primaryFile.fileId,
                })),
            });
        }
    }

    // 2. Cluster: Exact Content Duplicates (userMessagesCount > 0, same contentHash)
    if (includeContentDuplicates) {
        const hashGroups = new Map();
        for (const file of validFiles) {
            if (file.userMessagesCount === 0) continue;
            if (!file.contentHash) continue;
            if (!hashGroups.has(file.contentHash)) {
                hashGroups.set(file.contentHash, []);
            }
            hashGroups.get(file.contentHash).push(file);
        }

        for (const [hash, files] of hashGroups.entries()) {
            if (files.length >= 2) {
                const primaryFile = files.find(f => f.fileId === currentChatName) || files[0];
                const duplicateFiles = files.filter(f => f.fileId !== primaryFile.fileId);

                clusters.push({
                    id: `content_${hash.substring(0, 12)}_${avatar || characterName}`,
                    type: 'content_duplicate',
                    typeName: 'Identical Conversation History',
                    name: `${characterName} — Identical Conversations (${files[0].totalMessages} msgs)`,
                    characterName,
                    avatar,
                    isGroup,
                    recommendedPrimary: primaryFile.fileId,
                    totalDuplicates: duplicateFiles.length,
                    files: files.map(f => ({
                        fileId: f.fileId,
                        fileName: f.fileName,
                        fileSize: f.fileSize,
                        fileSizeBytes: f.fileSizeBytes,
                        totalMessages: f.totalMessages,
                        userMessagesCount: f.userMessagesCount,
                        lastModified: f.lastModified,
                        previewMessage: f.previewMessage,
                        isPrimary: f.fileId === primaryFile.fileId,
                        selectedForDeletion: f.fileId !== primaryFile.fileId,
                    })),
                });
            }
        }
    }

    return clusters;
}

router.post('/dedupe/scan', async function (request, response) {
    try {
        const {
            avatar_url: avatarUrl,
            group_id: groupId,
            scope = 'current',
            includeGreetingDuplicates = true,
            includeContentDuplicates = true,
            currentChatName = '',
        } = request.body || {};

        const allClusters = [];

        if (scope === 'current' && groupId) {
            const groupFile = path.join(request.user.directories.groups, `${groupId}.json`);
            if (fs.existsSync(groupFile)) {
                const groupData = tryParse(tryReadFileSync(groupFile));
                if (groupData && Array.isArray(groupData.chats)) {
                    const filePaths = groupData.chats
                        .map(chatId => path.join(request.user.directories.groupChats, `${chatId}.jsonl`))
                        .filter(fp => fs.existsSync(fp));

                    const analyzed = await analyzeChatFilesBatch(filePaths);
                    allClusters.push(...clusterAnalyzedChats(analyzed, {
                        characterName: groupData.name || 'Group',
                        avatar: groupData.avatar_url || '',
                        isGroup: true,
                        currentChatName: groupData.chat_id || currentChatName,
                    }, { includeGreetingDuplicates, includeContentDuplicates }));
                }
            }
        } else if (scope === 'current' && avatarUrl) {
            const cardName = String(avatarUrl).replace('.png', '');
            const characterChatsDir = path.join(request.user.directories.chats, cardName);
            if (fs.existsSync(characterChatsDir)) {
                const files = (await fs.promises.readdir(characterChatsDir, { withFileTypes: true }))
                    .filter(e => e.isFile() && path.extname(e.name) === '.jsonl')
                    .map(e => e.name);

                const filePaths = files.map(f => path.join(characterChatsDir, f));
                const analyzed = await analyzeChatFilesBatch(filePaths);

                allClusters.push(...clusterAnalyzedChats(analyzed, {
                    characterName: cardName,
                    avatar: avatarUrl,
                    isGroup: false,
                    currentChatName,
                }, { includeGreetingDuplicates, includeContentDuplicates }));
            }
        } else {
            // High-performance library-wide parallel scan
            const targetItems = [];
            const allFilePaths = [];

            const charDirs = await fs.promises.readdir(request.user.directories.chats, { withFileTypes: true });
            for (const dirent of charDirs) {
                if (dirent.isDirectory() && !dirent.name.startsWith('_') && !dirent.name.startsWith('.')) {
                    const charDir = path.join(request.user.directories.chats, dirent.name);
                    const files = (await fs.promises.readdir(charDir, { withFileTypes: true }))
                        .filter(e => e.isFile() && path.extname(e.name) === '.jsonl')
                        .map(e => e.name);

                    if (files.length >= 2) {
                        const filePaths = files.map(f => path.join(charDir, f));
                        targetItems.push({
                            characterName: dirent.name,
                            avatar: `${dirent.name}.png`,
                            isGroup: false,
                            filePaths,
                        });
                        allFilePaths.push(...filePaths);
                    }
                }
            }

            if (fs.existsSync(request.user.directories.groups)) {
                const groupFiles = (await fs.promises.readdir(request.user.directories.groups, { withFileTypes: true }))
                    .filter(e => e.isFile() && path.extname(e.name) === '.json')
                    .map(e => e.name);

                for (const gFile of groupFiles) {
                    try {
                        const groupData = tryParse(tryReadFileSync(path.join(request.user.directories.groups, gFile)));
                        if (groupData && Array.isArray(groupData.chats) && groupData.chats.length >= 2) {
                            const filePaths = groupData.chats
                                .map(chatId => path.join(request.user.directories.groupChats, `${chatId}.jsonl`))
                                .filter(fp => fs.existsSync(fp));

                            if (filePaths.length >= 2) {
                                targetItems.push({
                                    characterName: groupData.name || 'Group',
                                    avatar: groupData.avatar_url || '',
                                    isGroup: true,
                                    currentChatName: groupData.chat_id || '',
                                    filePaths,
                                });
                                allFilePaths.push(...filePaths);
                            }
                        }
                    } catch {
                        // ignore
                    }
                }
            }

            // Batch analyze all collected files in parallel with cache
            const allAnalyzed = await analyzeChatFilesBatch(allFilePaths);
            const analyzedMap = new Map();
            allAnalyzed.forEach(a => {
                if (a && a.filePath) {
                    analyzedMap.set(a.filePath, a);
                }
            });

            for (const item of targetItems) {
                const itemAnalyzed = item.filePaths.map(fp => analyzedMap.get(fp)).filter(Boolean);
                allClusters.push(...clusterAnalyzedChats(itemAnalyzed, {
                    characterName: item.characterName,
                    avatar: item.avatar,
                    isGroup: item.isGroup,
                    currentChatName: item.currentChatName || '',
                }, { includeGreetingDuplicates, includeContentDuplicates }));
            }
        }

        let totalDuplicates = 0;
        let totalFreedBytes = 0;
        for (const cluster of allClusters) {
            totalDuplicates += (cluster.totalDuplicates || 0);
            for (const file of cluster.files) {
                if (file.selectedForDeletion) {
                    totalFreedBytes += (file.fileSizeBytes || 0);
                }
            }
        }

        return response.send({
            clusters: allClusters,
            totalClusters: allClusters.length,
            totalDuplicates,
            totalFreedBytes,
            totalFreedFormatted: formatBytes(totalFreedBytes),
        });
    } catch (error) {
        console.error('Chat dedupe scan error:', error);
        return response.status(500).send({ error: error.message });
    }
});

router.post('/dedupe/cleanup', async function (request, response) {
    try {
        const {
            safeMode = 'trash',
            files = [],
        } = request.body || {};

        if (!Array.isArray(files) || files.length === 0) {
            return response.send({ ok: true, deletedCount: 0, backupId: null });
        }

        const timestamp = generateTimestamp();
        const backupId = `chat_dedupe_${timestamp}`;
        const dedupeBackupsBase = path.join(request.user.directories.backups, 'chat_dedupe');
        const currentBackupDir = path.join(dedupeBackupsBase, backupId);

        if (safeMode === 'trash') {
            fs.mkdirSync(currentBackupDir, { recursive: true });
        }

        const manifest = {
            backupId,
            timestamp: new Date().toISOString(),
            safeMode,
            files: [],
            totalDeleted: 0,
            freedBytes: 0,
        };

        let deletedCount = 0;
        let freedBytes = 0;

        for (const item of files) {
            const isGroup = !!item.is_group;
            const fileName = path.extname(item.file_name) ? item.file_name : `${item.file_name}.jsonl`;
            const dirName = isGroup ? '' : String(item.avatar_url || '').replace('.png', '');
            const targetDir = isGroup ? request.user.directories.groupChats : path.join(request.user.directories.chats, dirName);
            const filePath = path.join(targetDir, sanitize(fileName));

            if (!isPathUnderParent(request.user.directories.chats, filePath) &&
                !isPathUnderParent(request.user.directories.groupChats, filePath)) {
                console.warn('Skipping file outside chats directory:', filePath);
                continue;
            }

            if (!fs.existsSync(filePath)) {
                continue;
            }

            let fileSize = 0;
            try {
                fileSize = fs.statSync(filePath).size;
            } catch {
                // ignore
            }

            if (safeMode === 'trash') {
                try {
                    const backupSubdir = path.join(currentBackupDir, isGroup ? '_groups' : dirName);
                    fs.mkdirSync(backupSubdir, { recursive: true });
                    const backupFilePath = path.join(backupSubdir, fileName);
                    fs.copyFileSync(filePath, backupFilePath);
                } catch (err) {
                    console.error(`Could not archive chat file ${fileName} to backup:`, err);
                }
            }

            if (tryDeleteFile(filePath)) {
                ChatMetadataCache.invalidate(filePath);
                deletedCount++;
                freedBytes += fileSize;
                manifest.files.push({
                    avatar_url: item.avatar_url,
                    file_name: fileName,
                    is_group: isGroup,
                    fileSize,
                });
            }
        }

        manifest.totalDeleted = deletedCount;
        manifest.freedBytes = freedBytes;

        if (safeMode === 'trash') {
            tryWriteFileSync(path.join(currentBackupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        }

        return response.send({
            ok: true,
            deletedCount,
            backupId: safeMode === 'trash' ? backupId : null,
            freedBytes,
            freedFormatted: formatBytes(freedBytes),
        });
    } catch (error) {
        console.error('Chat dedupe cleanup error:', error);
        return response.status(500).send({ error: error.message });
    }
});

router.post('/dedupe/backups', async function (request, response) {
    try {
        const dedupeBackupsBase = path.join(request.user.directories.backups, 'chat_dedupe');
        if (!fs.existsSync(dedupeBackupsBase)) {
            return response.send({ backups: [] });
        }

        const entries = (await fs.promises.readdir(dedupeBackupsBase, { withFileTypes: true }))
            .filter(e => e.isDirectory() && e.name.startsWith('chat_dedupe_'))
            .map(e => e.name);

        const backups = [];
        for (const entry of entries) {
            const manifestPath = path.join(dedupeBackupsBase, entry, 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                const manifest = tryParse(tryReadFileSync(manifestPath));
                if (manifest) {
                    backups.push({
                        backupId: entry,
                        timestamp: manifest.timestamp || entry.replace('chat_dedupe_', ''),
                        totalDeleted: manifest.totalDeleted || 0,
                        freedBytes: manifest.freedBytes || 0,
                        freedFormatted: formatBytes(manifest.freedBytes || 0),
                        files: (manifest.files || []).map(f => f.file_name),
                    });
                }
            }
        }

        backups.sort((a, b) => String(b.backupId).localeCompare(String(a.backupId)));
        return response.send({ backups });
    } catch (error) {
        console.error('Chat dedupe backups error:', error);
        return response.status(500).send({ error: error.message });
    }
});

router.post('/dedupe/restore', async function (request, response) {
    try {
        const { backupId } = request.body || {};
        if (!backupId) {
            return response.status(400).send({ error: 'Missing backupId' });
        }

        const dedupeBackupsBase = path.join(request.user.directories.backups, 'chat_dedupe');
        const backupDir = path.join(dedupeBackupsBase, sanitize(backupId));
        const manifestPath = path.join(backupDir, 'manifest.json');

        if (!fs.existsSync(manifestPath)) {
            return response.status(404).send({ error: 'Backup manifest not found' });
        }

        const manifest = tryParse(tryReadFileSync(manifestPath));
        if (!manifest || !Array.isArray(manifest.files)) {
            return response.status(400).send({ error: 'Invalid backup manifest' });
        }

        let restoredCount = 0;
        for (const item of manifest.files) {
            const isGroup = !!item.is_group;
            const fileName = item.file_name;
            const dirName = isGroup ? '_groups' : String(item.avatar_url || '').replace('.png', '');
            const sourceFilePath = path.join(backupDir, dirName, fileName);

            const destDir = isGroup
                ? request.user.directories.groupChats
                : path.join(request.user.directories.chats, String(item.avatar_url || '').replace('.png', ''));
            const destFilePath = path.join(destDir, fileName);

            if (fs.existsSync(sourceFilePath)) {
                fs.mkdirSync(destDir, { recursive: true });
                fs.copyFileSync(sourceFilePath, destFilePath);
                restoredCount++;
            }
        }

        return response.send({ ok: true, restoredCount });
    } catch (error) {
        console.error('Chat dedupe restore error:', error);
        return response.status(500).send({ error: error.message });
    }
});
