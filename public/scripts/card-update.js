import {
    characters,
    this_chid,
    getOneCharacter,
    eventSource,
    event_types,
    getRequestHeaders,
    getThumbnailUrl,
    default_avatar,
    chat,
    chat_metadata,
    getFirstMessage,
    clearChat,
    printMessages,
    saveChatConditional,
} from '../script.js';
import { renderTemplateAsync } from './templates.js';
import { Popup, POPUP_RESULT, POPUP_TYPE, callGenericPopup } from './popup.js';
import { t } from './i18n.js';
import { importTags } from './tags.js';

/**
 * @typedef {object} CardUpdateOptions
 * @property {boolean} updateAvatar Whether to replace the avatar image
 * @property {boolean} updateDefinitions Whether to update name, description, personality, scenario, notes
 * @property {boolean} updateFirstMes Whether to update the primary first message
 * @property {'replace'|'merge'|'keep'} alternateGreetingsMode Mode for alternate greetings
 * @property {boolean} updateMesExample Whether to update dialogue examples
 * @property {boolean} updateSystemPrompt Whether to update system prompt & post-history instructions
 * @property {'replace'|'merge'|'keep'} characterBookMode Mode for embedded lorebook
 * @property {'replace'|'merge'|'keep'} regexScriptsMode Mode for regex scripts
 * @property {'replace'|'merge'|'keep'} tagsMode Mode for tags
 * @property {boolean} preserveSettings Whether to keep local settings (fav, talkativeness, world, depth_prompt)
 */

/**
 * Character Card Update and Conflict Resolution Manager.
 */
export class CardUpdateManager {
    /**
     * Parses a character card file by sending it to the server parse endpoint.
     * @param {File} file Uploaded card file
     * @returns {Promise<{ card: object, avatarPreview?: string }>}
     */
    static async parseCardFile(file) {
        const ext = file.name.split('.').pop().toLowerCase();
        const formData = new FormData();
        formData.append('avatar', file);
        formData.append('file_type', ext);

        const response = await fetch('/api/characters/parse-card', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
            cache: 'no-cache',
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.message || `Failed to parse card (${response.statusText})`);
        }

        return await response.json();
    }

    /**
     * Searches for a matching character in the library.
     * @param {object} cardData Parsed card object
     * @param {string} [fileName] Original file name
     * @returns {number} Index in characters[] or -1
     */
    static findMatchingCharacterIndex(cardData, fileName = '') {
        if (!Array.isArray(characters) || characters.length === 0) {
            return -1;
        }

        const rawName = cardData?.data?.name || cardData?.name || '';
        const cleanName = String(rawName).trim().toLowerCase();
        const baseFileName = String(fileName).replace(/\.[^/.]+$/, '').trim().toLowerCase();

        // 1. Match by exact avatar file name if provided
        if (baseFileName) {
            const avatarMatch = characters.findIndex(c => {
                const cAvatarBase = String(c.avatar).replace(/\.[^/.]+$/, '').toLowerCase();
                return cAvatarBase === baseFileName;
            });
            if (avatarMatch !== -1) return avatarMatch;
        }

        // 2. Match by character display name
        if (cleanName) {
            const nameMatch = characters.findIndex(c => {
                const cName = String(c.name || '').trim().toLowerCase();
                return cName === cleanName;
            });
            if (nameMatch !== -1) return nameMatch;
        }

        // 3. Match by Chub full_path or source_url if available
        const incomingChubPath = cardData?.data?.extensions?.chub?.full_path;
        if (incomingChubPath) {
            const chubMatch = characters.findIndex(c => c?.data?.extensions?.chub?.full_path === incomingChubPath);
            if (chubMatch !== -1) return chubMatch;
        }

        return -1;
    }

    /**
     * Merges incoming card data into existing character structure according to user options.
     * @param {object} existingChar Existing character object from library
     * @param {object} newCard Parsed incoming card data (V2 format)
     * @param {CardUpdateOptions} options User-selected update options
     * @returns {object} Merged character card data (V2 compliant)
     */
    static mergeCardData(existingChar, newCard, options) {
        const merged = JSON.parse(JSON.stringify(existingChar));
        if (!merged.data) merged.data = {};

        const incomingData = newCard.data || newCard;

        // Core definitions
        if (options.updateDefinitions) {
            if (incomingData.name !== undefined) {
                merged.name = incomingData.name;
                merged.data.name = incomingData.name;
            }
            if (incomingData.description !== undefined) {
                merged.description = incomingData.description;
                merged.data.description = incomingData.description;
            }
            if (incomingData.personality !== undefined) {
                merged.personality = incomingData.personality;
                merged.data.personality = incomingData.personality;
            }
            if (incomingData.scenario !== undefined) {
                merged.scenario = incomingData.scenario;
                merged.data.scenario = incomingData.scenario;
            }
            if (incomingData.creator_notes !== undefined || incomingData.creatorcomment !== undefined) {
                const notes = incomingData.creator_notes ?? incomingData.creatorcomment ?? '';
                merged.creatorcomment = notes;
                merged.data.creator_notes = notes;
            }
            if (incomingData.creator !== undefined) {
                merged.creator = incomingData.creator;
                merged.data.creator = incomingData.creator;
            }
            if (incomingData.character_version !== undefined) {
                merged.character_version = incomingData.character_version;
                merged.data.character_version = incomingData.character_version;
            }
        }

        // First message
        if (options.updateFirstMes) {
            if (incomingData.first_mes !== undefined) {
                merged.first_mes = incomingData.first_mes;
                merged.data.first_mes = incomingData.first_mes;
            }
        }

        // Dialogue examples
        if (options.updateMesExample) {
            if (incomingData.mes_example !== undefined) {
                merged.mes_example = incomingData.mes_example;
                merged.data.mes_example = incomingData.mes_example;
            }
        }

        // System prompt & instructions
        if (options.updateSystemPrompt) {
            if (incomingData.system_prompt !== undefined) {
                merged.system_prompt = incomingData.system_prompt;
                merged.data.system_prompt = incomingData.system_prompt;
            }
            if (incomingData.post_history_instructions !== undefined) {
                merged.post_history_instructions = incomingData.post_history_instructions;
                merged.data.post_history_instructions = incomingData.post_history_instructions;
            }
        }

        // Alternate Greetings
        if (options.alternateGreetingsMode === 'replace') {
            merged.data.alternate_greetings = Array.isArray(incomingData.alternate_greetings)
                ? [...incomingData.alternate_greetings]
                : [];
        } else if (options.alternateGreetingsMode === 'merge') {
            const existingGreetings = Array.isArray(merged.data.alternate_greetings)
                ? [...merged.data.alternate_greetings]
                : [];
            const incomingGreetings = Array.isArray(incomingData.alternate_greetings)
                ? incomingData.alternate_greetings
                : [];

            for (const greeting of incomingGreetings) {
                const exists = existingGreetings.some(g => String(g).trim().toLowerCase() === String(greeting).trim().toLowerCase());
                if (!exists && String(greeting).trim().length > 0) {
                    existingGreetings.push(greeting);
                }
            }
            merged.data.alternate_greetings = existingGreetings;
        }

        // Character Book (Embedded Lorebook)
        if (options.characterBookMode === 'replace') {
            if (incomingData.character_book) {
                merged.data.character_book = JSON.parse(JSON.stringify(incomingData.character_book));
            } else {
                delete merged.data.character_book;
            }
        } else if (options.characterBookMode === 'merge') {
            if (incomingData.character_book && Array.isArray(incomingData.character_book.entries)) {
                if (!merged.data.character_book || !Array.isArray(merged.data.character_book.entries)) {
                    merged.data.character_book = JSON.parse(JSON.stringify(incomingData.character_book));
                } else {
                    const existingEntries = merged.data.character_book.entries;
                    let maxId = existingEntries.reduce((max, e) => Math.max(max, Number(e.id) || 0), 0);

                    for (const inEntry of incomingData.character_book.entries) {
                        const inKeys = Array.isArray(inEntry.keys) ? inEntry.keys.join(',') : '';
                        const matchIndex = existingEntries.findIndex(e => {
                            if (inEntry.comment && e.comment && inEntry.comment === e.comment) return true;
                            if (inKeys && Array.isArray(e.keys) && e.keys.join(',') === inKeys) return true;
                            return false;
                        });

                        if (matchIndex !== -1) {
                            existingEntries[matchIndex] = { ...existingEntries[matchIndex], ...inEntry, id: existingEntries[matchIndex].id };
                        } else {
                            maxId++;
                            existingEntries.push({ ...inEntry, id: maxId });
                        }
                    }
                }
            }
        }

        // Regex scripts
        if (!merged.data.extensions) merged.data.extensions = {};
        if (options.regexScriptsMode === 'replace') {
            merged.data.extensions.regex_scripts = Array.isArray(incomingData.extensions?.regex_scripts)
                ? [...incomingData.extensions.regex_scripts]
                : [];
        } else if (options.regexScriptsMode === 'merge') {
            const existingScripts = Array.isArray(merged.data.extensions?.regex_scripts)
                ? [...merged.data.extensions.regex_scripts]
                : [];
            const incomingScripts = Array.isArray(incomingData.extensions?.regex_scripts)
                ? incomingData.extensions.regex_scripts
                : [];

            for (const script of incomingScripts) {
                const exists = existingScripts.some(s =>
                    (script.id && s.id === script.id) ||
                    (script.scriptName && s.scriptName === script.scriptName) ||
                    (script.findRegex && s.findRegex === script.findRegex),
                );
                if (!exists) {
                    existingScripts.push(script);
                }
            }
            merged.data.extensions.regex_scripts = existingScripts;
        }

        // Tags
        if (options.tagsMode === 'replace') {
            const newTags = Array.isArray(incomingData.tags) ? [...incomingData.tags] : [];
            merged.tags = newTags;
            merged.data.tags = newTags;
        } else if (options.tagsMode === 'merge') {
            const existingTags = Array.isArray(merged.tags) ? merged.tags : (Array.isArray(merged.data?.tags) ? merged.data.tags : []);
            const incomingTags = Array.isArray(incomingData.tags) ? incomingData.tags : [];
            const combined = [...existingTags];

            for (const tag of incomingTags) {
                if (typeof tag === 'string' && !combined.some(t => t.toLowerCase() === tag.toLowerCase())) {
                    combined.push(tag);
                }
            }
            merged.tags = combined;
            merged.data.tags = combined;
        }

        // Settings preservation
        if (options.preserveSettings) {
            merged.fav = existingChar.fav;
            if (merged.data?.extensions) {
                merged.data.extensions.fav = existingChar.data?.extensions?.fav ?? existingChar.fav ?? false;
                merged.data.extensions.talkativeness = existingChar.data?.extensions?.talkativeness ?? existingChar.talkativeness ?? 0.5;
                if (existingChar.data?.extensions?.world !== undefined) {
                    merged.data.extensions.world = existingChar.data.extensions.world;
                }
                if (existingChar.data?.extensions?.depth_prompt !== undefined) {
                    merged.data.extensions.depth_prompt = existingChar.data.extensions.depth_prompt;
                }
            }
            merged.talkativeness = existingChar.talkativeness;
            merged.create_date = existingChar.create_date;
            merged.chat = existingChar.chat;
        }

        return merged;
    }

    /**
     * Displays the conflict resolution dialog when an imported character already exists.
     * @param {object} params
     * @param {object} params.existingChar Existing character from library
     * @param {File} params.file Uploaded file
     * @param {object} params.newCard Parsed incoming card data
     * @param {string} [params.avatarPreview] Data URL or preview
     * @returns {Promise<'update'|'duplicate'|'cancel'>}
     */
    static async showCardConflictDialog({ existingChar, file, newCard, avatarPreview }) {
        const existingAvatarUrl = existingChar.avatar && existingChar.avatar !== 'none'
            ? getThumbnailUrl('avatar', existingChar.avatar)
            : default_avatar;

        const templateHtml = await renderTemplateAsync('cardConflictPopup', {
            name: existingChar.name,
            existingAvatarUrl: existingAvatarUrl,
            existingAvatarFile: existingChar.avatar,
        });

        const POPUP_RESULT_UPDATE = POPUP_RESULT.CUSTOM1;
        const POPUP_RESULT_DUPLICATE = POPUP_RESULT.CUSTOM2;

        const result = await Popup.show.confirm(
            t`Character Already Exists`,
            templateHtml,
            {
                okButton: false,
                customButtons: [
                    {
                        text: t`Update Existing Card`,
                        result: POPUP_RESULT_UPDATE,
                        classes: ['popup-button-ok'],
                        icon: 'fa-solid fa-rotate',
                    },
                    {
                        text: t`Import as Duplicate`,
                        result: POPUP_RESULT_DUPLICATE,
                        classes: ['popup-button-secondary'],
                        icon: 'fa-solid fa-clone',
                    },
                ],
                defaultResult: POPUP_RESULT_UPDATE,
            },
        );

        if (result === POPUP_RESULT_UPDATE) {
            const existingIndex = characters.indexOf(existingChar);
            await CardUpdateManager.showCardUpdateDialog({
                existingCharIndex: existingIndex,
                newCardData: newCard,
                avatarFile: file,
                avatarPreview: avatarPreview,
            });
            return 'update';
        } else if (result === POPUP_RESULT_DUPLICATE) {
            return 'duplicate';
        }

        return 'cancel';
    }

    /**
     * Displays the main Card Update & Diff/Merge Wizard modal.
     * @param {object} params
     * @param {number} params.existingCharIndex Index in characters[]
     * @param {object} params.newCardData Parsed card object
     * @param {File} [params.avatarFile] Raw uploaded file (if avatar is to be updated)
     * @param {string} [params.avatarPreview] Image data URL
     * @returns {Promise<boolean>} True if update succeeded
     */
    static async showCardUpdateDialog({ existingCharIndex, newCardData, avatarFile, avatarPreview }) {
        const existingChar = characters[existingCharIndex];
        if (!existingChar) {
            toastr.error(t`Character not found`);
            return false;
        }

        const incomingData = newCardData.data || newCardData;
        const hasNewAvatar = !!avatarPreview || (avatarFile && ['png', 'charx', 'byaf'].includes(avatarFile.name.split('.').pop().toLowerCase()));

        const currentAvatarUrl = existingChar.avatar && existingChar.avatar !== 'none'
            ? getThumbnailUrl('avatar', existingChar.avatar)
            : default_avatar;

        const newAvatarUrl = avatarPreview || currentAvatarUrl;

        const templateData = {
            currentName: existingChar.name,
            currentVersion: existingChar.data?.character_version || existingChar.character_version || '1.0',
            currentCreator: existingChar.data?.creator || existingChar.creator || 'Anonymous',
            currentAvatarUrl: currentAvatarUrl,
            currentGreetingsCount: Array.isArray(existingChar.data?.alternate_greetings) ? existingChar.data.alternate_greetings.length : 0,
            currentLoreEntriesCount: Array.isArray(existingChar.data?.character_book?.entries) ? existingChar.data.character_book.entries.length : 0,
            currentRegexCount: Array.isArray(existingChar.data?.extensions?.regex_scripts) ? existingChar.data.extensions.regex_scripts.length : 0,
            currentTagsCount: Array.isArray(existingChar.tags) ? existingChar.tags.length : (Array.isArray(existingChar.data?.tags) ? existingChar.data.tags.length : 0),

            newName: incomingData.name || existingChar.name,
            newVersion: incomingData.character_version || '1.0',
            newCreator: incomingData.creator || 'Anonymous',
            newAvatarUrl: newAvatarUrl,
            hasNewAvatar: hasNewAvatar,
            newGreetingsCount: Array.isArray(incomingData.alternate_greetings) ? incomingData.alternate_greetings.length : 0,
            newLoreEntriesCount: Array.isArray(incomingData.character_book?.entries) ? incomingData.character_book.entries.length : 0,
            newRegexCount: Array.isArray(incomingData.extensions?.regex_scripts) ? incomingData.extensions.regex_scripts.length : 0,
            newTagsCount: Array.isArray(incomingData.tags) ? incomingData.tags.length : 0,
        };

        const $template = $(await renderTemplateAsync('cardUpdatePopup', templateData));

        const POPUP_RESULT_CONFIRM = POPUP_RESULT.AFFIRMATIVE;

        const result = await callGenericPopup($template, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Apply Card Update`,
            cancelButton: t`Cancel`,
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        });

        if (result !== POPUP_RESULT_CONFIRM) {
            return false;
        }

        // Collect options from the modal
        /** @type {CardUpdateOptions} */
        const options = {
            updateAvatar: $template.find('#card_update_opt_avatar').is(':checked'),
            updateDefinitions: $template.find('#card_update_opt_definitions').is(':checked'),
            updateFirstMes: $template.find('#card_update_opt_first_mes').is(':checked'),
            alternateGreetingsMode: String($template.find('#card_update_opt_alt_greetings').val()),
            updateMesExample: $template.find('#card_update_opt_mes_example').is(':checked'),
            updateSystemPrompt: $template.find('#card_update_opt_system_prompt').is(':checked'),
            characterBookMode: String($template.find('#card_update_opt_character_book').val()),
            regexScriptsMode: String($template.find('#card_update_opt_regex').val()),
            tagsMode: String($template.find('#card_update_opt_tags').val()),
            preserveSettings: $template.find('#card_update_opt_preserve_settings').is(':checked'),
        };

        return await CardUpdateManager.executeUpdate({
            existingCharIndex,
            newCardData,
            avatarFile: options.updateAvatar ? avatarFile : null,
            options,
        });
    }

    /**
     * Executes the character update request against the backend.
     * @param {object} params
     * @param {number} params.existingCharIndex
     * @param {object} params.newCardData
     * @param {File|null} [params.avatarFile]
     * @param {CardUpdateOptions} params.options
     * @returns {Promise<boolean>}
     */
    static async executeUpdate({ existingCharIndex, newCardData, avatarFile, options }) {
        const existingChar = characters[existingCharIndex];
        if (!existingChar) {
            toastr.error(t`Character not found`);
            return false;
        }

        try {
            const mergedCard = CardUpdateManager.mergeCardData(existingChar, newCardData, options);

            const formData = new FormData();
            formData.append('avatar_url', existingChar.avatar);
            formData.append('card_data', JSON.stringify(mergedCard));

            if (avatarFile && options.updateAvatar) {
                formData.append('avatar', avatarFile);
            }

            const response = await fetch('/api/characters/update-card', {
                method: 'POST',
                headers: getRequestHeaders({ omitContentType: true }),
                body: formData,
                cache: 'no-cache',
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.message || `Server returned status ${response.status}`);
            }

            // Reload character data from backend
            await getOneCharacter(existingChar.avatar);

            // Reload thumbnail cache if avatar was updated
            if (options.updateAvatar) {
                await fetch(getThumbnailUrl('avatar', existingChar.avatar), { cache: 'reload' }).catch(() => {});
            }

            // Refresh tags in UI if tags were merged or modified
            if (options.tagsMode !== 'keep' && Array.isArray(mergedCard.tags)) {
                await importTags(characters[existingCharIndex]);
            }

            // Emit character edited event
            await eventSource.emit(event_types.CHARACTER_EDITED, {
                detail: { id: existingCharIndex, character: characters[existingCharIndex] },
            });

            // If this is the currently selected character and chat has only 1 message, regenerate greeting if updated
            if (this_chid === existingCharIndex && options.updateFirstMes) {
                const message = getFirstMessage();
                const isPristineChat = chat.length === 1 && !chat[0].is_user && !chat[0].is_system && !chat_metadata.tainted;
                if (isPristineChat && message.mes) {
                    chat.splice(0, chat.length, message);
                    const messageId = chat.length - 1;
                    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'first_message');
                    await clearChat();
                    await printMessages();
                    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'first_message');
                    await saveChatConditional();
                }
            }

            toastr.success(t`Character card updated successfully: ${existingChar.name}`);
            return true;
        } catch (error) {
            console.error('Error executing card update:', error);
            toastr.error(error.message || t`Failed to update character card`);
            return false;
        }
    }
}
