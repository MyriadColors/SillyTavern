import {
    characters,
    this_chid,
    getRequestHeaders,
    getThumbnailUrl,
    default_avatar,
    getCurrentChatDetails,
    openCharacterChat,
    displayPastChats,
} from '../script.js';
import { selected_group, openGroupChat } from './group-chats.js';
import { renderTemplateAsync } from './templates.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';
import { eventSource, event_types } from './events.js';

const SETTINGS_KEY = 'st_chat_deduper_settings';

/**
 * Controller for scanning, reviewing, and safely cleaning up duplicate or unused greeting chat files.
 */
export class ChatDeduperManager {
    static getSettings() {
        const defaultSettings = {
            safeMode: 'trash', // 'trash' | 'delete'
            includeGreetingDuplicates: true,
            includeContentDuplicates: true,
        };
        try {
            const saved = accountStorage.getItem(SETTINGS_KEY);
            return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
        } catch {
            return defaultSettings;
        }
    }

    static saveSettings(settings) {
        try {
            accountStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (err) {
            console.error('Could not save chat deduper settings:', err);
        }
    }

    /**
     * Opens the Chat Deduper modal dialog.
     * @param {object} [options]
     * @param {string|number} [options.characterId]
     * @param {string} [options.groupId]
     */
    static async openDeduperDialog({ characterId = this_chid, groupId = selected_group } = {}) {
        const templateHtml = await renderTemplateAsync('chatDeduperPopup');
        const dom = $(templateHtml);

        let currentClusters = [];
        let currentSettings = this.getSettings();

        // ── Tabs Setup ──────────────────────────────────────────────────────────
        const tabs = {
            clusters: $(dom).find('#chat_deduper_tab_clusters'),
            settings: $(dom).find('#chat_deduper_tab_settings'),
            backups: $(dom).find('#chat_deduper_tab_backups'),
        };
        const pages = {
            clusters: $(dom).find('#chat_deduper_page_clusters'),
            settings: $(dom).find('#chat_deduper_page_settings'),
            backups: $(dom).find('#chat_deduper_page_backups'),
        };

        function switchTab(activeKey) {
            Object.keys(tabs).forEach(k => tabs[k].toggleClass('active', k === activeKey));
            Object.keys(pages).forEach(k => pages[k].toggle(k === activeKey));
            if (activeKey === 'backups') {
                loadBackups();
            }
        }

        tabs.clusters.on('click', () => switchTab('clusters'));
        tabs.settings.on('click', () => switchTab('settings'));
        tabs.backups.on('click', () => switchTab('backups'));

        // ── Settings UI ────────────────────────────────────────────────────────
        $(dom).find(`input[name="chat_deduper_safe_mode"][value="${currentSettings.safeMode}"]`).prop('checked', true);
        $(dom).find('#chat_deduper_opt_greetings').prop('checked', currentSettings.includeGreetingDuplicates);
        $(dom).find('#chat_deduper_opt_content').prop('checked', currentSettings.includeContentDuplicates);

        function syncSettingsFromUI() {
            currentSettings.safeMode = $(dom).find('input[name="chat_deduper_safe_mode"]:checked').val() || 'trash';
            currentSettings.includeGreetingDuplicates = $(dom).find('#chat_deduper_opt_greetings').is(':checked');
            currentSettings.includeContentDuplicates = $(dom).find('#chat_deduper_opt_content').is(':checked');
            ChatDeduperManager.saveSettings(currentSettings);
        }

        $(dom).find('#chat_deduper_page_settings input').on('change', () => {
            syncSettingsFromUI();
        });

        // ── Scope & Scan ────────────────────────────────────────────────────────
        const scopeSelect = $(dom).find('#chat_deduper_scope_select');
        if (characterId === undefined && !groupId) {
            scopeSelect.val('all').prop('disabled', true);
        }

        scopeSelect.on('change', () => {
            runScan();
        });

        $(dom).find('#chat_deduper_rescan_btn').on('click', () => {
            runScan();
        });

        $(dom).find('#chat_deduper_select_all_btn').on('click', () => {
            const allChecked = $(dom).find('.chat-deduper-file-check').length > 0 &&
                $(dom).find('.chat-deduper-file-check:not(:checked)').length === 0;

            $(dom).find('.chat-deduper-file-check').prop('checked', !allChecked).trigger('change');
        });

        async function runScan() {
            syncSettingsFromUI();
            const container = $(dom).find('#chat_deduper_clusters_container');
            container.html(`
                <div class="chat-deduper-loading flex-container flexFlowColumn alignItemsCenter justifyCenter" style="padding: 40px 0; gap: 10px;">
                    <i class="fa-solid fa-spinner fa-spin fa-2xl"></i>
                    <span>${t`Scanning chats for duplicates...`}</span>
                </div>
            `);

            const currentScope = scopeSelect.val();
            const charObj = (characterId !== undefined) ? characters[characterId] : null;
            const currentChatDetails = getCurrentChatDetails();

            try {
                const response = await fetch('/api/chats/dedupe/scan', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        scope: currentScope,
                        avatar_url: charObj?.avatar || null,
                        group_id: groupId || null,
                        currentChatName: currentChatDetails?.sessionName || '',
                        includeGreetingDuplicates: currentSettings.includeGreetingDuplicates,
                        includeContentDuplicates: currentSettings.includeContentDuplicates,
                    }),
                });

                if (!response.ok) {
                    throw new Error(response.statusText);
                }

                const data = await response.json();
                currentClusters = data.clusters || [];

                $(dom).find('#chat_deduper_stat_clusters').text(data.totalClusters || 0);
                $(dom).find('#chat_deduper_stat_duplicates').text(data.totalDuplicates || 0);
                $(dom).find('#chat_deduper_stat_freed').text(data.totalFreedFormatted || '0 B');

                renderClusters();
            } catch (err) {
                console.error('Chat dedupe scan error:', err);
                container.html(`<div class="notes" style="color: var(--crimson); padding: 20px 0; text-align: center;">${t`Failed to scan chats: `}${err.message}</div>`);
            }
        }

        function renderClusters() {
            const container = $(dom).find('#chat_deduper_clusters_container');
            container.empty();

            if (currentClusters.length === 0) {
                container.html(`
                    <div class="flex-container flexFlowColumn alignItemsCenter justifyCenter" style="padding: 40px 0; gap: 12px; opacity: 0.8;">
                        <i class="fa-solid fa-circle-check fa-3x" style="color: var(--green);"></i>
                        <h3>${t`No Duplicate Chats Found!`}</h3>
                        <p class="notes margin0">${t`Your chat library is tidy with no redundant greeting or duplicate chats.`}</p>
                    </div>
                `);
                $(dom).find('#chat_deduper_batch_cleanup_btn').prop('disabled', true);
                return;
            }

            $(dom).find('#chat_deduper_batch_cleanup_btn').prop('disabled', false);

            const clusterBlocksToAppend = [];

            currentClusters.forEach((cluster, clusterIdx) => {
                let avatarSrc = default_avatar;
                if (cluster.avatar) {
                    avatarSrc = cluster.isGroup ? cluster.avatar : getThumbnailUrl('avatar', cluster.avatar);
                }

                const clusterBlock = $(`
                    <div class="chat-deduper-cluster-block highlight-block" style="padding: 12px 14px; border-radius: 8px; margin-bottom: 8px;">
                        <div class="flex-container justifySpaceBetween alignItemsCenter flexWrap" style="margin-bottom: 10px; gap: 8px;">
                            <div class="flex-container alignItemsCenter" style="gap: 10px;">
                                <img src="${avatarSrc}" style="width: 36px; height: 36px; object-fit: cover; border-radius: 50%;" />
                                <div>
                                    <h4 class="margin0">
                                        <i class="${cluster.type === 'greeting_duplicate' ? 'fa-solid fa-comments' : 'fa-solid fa-clone'}"></i> ${cluster.name}
                                    </h4>
                                    <small class="notes" style="font-size: 0.8em;">
                                        <span class="badge" style="background-color: var(--black30a); padding: 2px 6px; border-radius: 4px;">${cluster.typeName}</span> &bull; ${cluster.files.length} chats
                                    </small>
                                </div>
                            </div>
                            <div class="flex-container" style="gap: 6px;">
                                <button class="menu_button btn-cluster-select-all" style="font-size: 0.8em;" title="${t`Select all in cluster`}">
                                    <i class="fa-solid fa-check-double"></i> ${t`Select Redundant`}
                                </button>
                            </div>
                        </div>
                        <div class="chat-deduper-files-list flex-container flexFlowColumn" style="gap: 8px;"></div>
                    </div>
                `);

                const filesList = clusterBlock.find('.chat-deduper-files-list');
                const fileRowsToAppend = [];

                cluster.files.forEach((file) => {
                    const isPrimary = file.fileId === cluster.recommendedPrimary;
                    const fileRow = $(`
                        <div class="chat-deduper-file-item flex-container justifySpaceBetween alignItemsCenter flexWrap ${isPrimary ? 'is-primary-chat' : ''}" style="padding: 8px 12px; background-color: var(--black30a); border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; gap: 10px;">
                            <div class="flex-container alignItemsCenter" style="gap: 10px; min-width: 0; flex: 1 1 auto;">
                                <input type="checkbox" class="chat-deduper-file-check" data-cluster-idx="${clusterIdx}" data-file-id="${file.fileId}" ${file.selectedForDeletion ? 'checked' : ''} ${isPrimary ? 'disabled' : ''} title="${isPrimary ? t`Primary chat is preserved` : t`Select for cleanup`}" />
                                <div class="flex-container flexFlowColumn" style="min-width: 0;">
                                    <div class="flex-container alignItemsCenter" style="gap: 6px; flex-wrap: wrap;">
                                        <strong><span style="word-break: break-all;">${file.fileName}</span></strong>
                                        ${isPrimary ? `<span class="badge" style="background-color: var(--green); color: #000; font-size: 0.75em; padding: 2px 6px; border-radius: 4px; font-weight: bold;"><i class="fa-solid fa-star"></i> ${t`Keep`}</span>` : ''}
                                        <small class="notes">(${file.fileSize}, ${file.totalMessages} 💬)</small>
                                    </div>
                                    ${file.previewMessage ? `<small class="notes" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 500px; opacity: 0.8;">${file.previewMessage}</small>` : ''}
                                </div>
                            </div>
                            <div class="flex-container alignItemsCenter" style="gap: 8px;">
                                <small class="notes">${new Date(file.lastModified).toLocaleString()}</small>
                                ${!isPrimary ? `
                                    <button class="menu_button btn-make-primary" style="font-size: 0.75em; padding: 3px 8px;" title="${t`Make this the chat to keep`}">
                                        <i class="fa-solid fa-star"></i> ${t`Make Keeper`}
                                    </button>
                                ` : ''}
                            </div>
                        </div>
                    `);

                    fileRow.find('.btn-make-primary').on('click', () => {
                        cluster.recommendedPrimary = file.fileId;
                        cluster.files.forEach(f => {
                            f.isPrimary = (f.fileId === file.fileId);
                            f.selectedForDeletion = (f.fileId !== file.fileId);
                        });
                        renderClusters();
                    });

                    fileRow.find('.chat-deduper-file-check').on('change', function () {
                        file.selectedForDeletion = $(this).is(':checked');
                        updateHeaderStats();
                    });

                    fileRowsToAppend.push(fileRow);
                });

                filesList.append(fileRowsToAppend);

                clusterBlock.find('.btn-cluster-select-all').on('click', () => {
                    cluster.files.forEach(f => {
                        if (f.fileId !== cluster.recommendedPrimary) {
                            f.selectedForDeletion = true;
                        }
                    });
                    renderClusters();
                });

                clusterBlocksToAppend.push(clusterBlock);
            });

            container.append(clusterBlocksToAppend);
            updateHeaderStats();
        }

        function updateHeaderStats() {
            let totalSelected = 0;
            currentClusters.forEach(cl => {
                cl.files.forEach(f => {
                    if (f.selectedForDeletion) {
                        totalSelected++;
                    }
                });
            });

            $(dom).find('#chat_deduper_stat_duplicates').text(totalSelected);
            $(dom).find('#chat_deduper_batch_cleanup_btn').text(`${t`Clean Up Selected`} (${totalSelected})`);
            $(dom).find('#chat_deduper_batch_cleanup_btn').prop('disabled', totalSelected === 0);
        }

        // ── Clean Up Selected ──────────────────────────────────────────────────
        $(dom).find('#chat_deduper_batch_cleanup_btn').on('click', async () => {
            const filesToDelete = [];
            const activeChatDetails = getCurrentChatDetails();
            let needActiveChatSwitch = null;

            currentClusters.forEach(cluster => {
                cluster.files.forEach(file => {
                    if (file.selectedForDeletion) {
                        filesToDelete.push({
                            avatar_url: cluster.avatar,
                            file_name: file.fileName,
                            is_group: cluster.isGroup,
                        });

                        if (activeChatDetails?.sessionName === file.fileId) {
                            needActiveChatSwitch = {
                                isGroup: cluster.isGroup,
                                avatar: cluster.avatar,
                                keeperChatId: cluster.recommendedPrimary,
                            };
                        }
                    }
                });
            });

            if (filesToDelete.length === 0) {
                toastr.warning(t`No duplicate chat files selected.`);
                return;
            }

            const confirmMsg = currentSettings.safeMode === 'trash'
                ? t`Safely clean up ${filesToDelete.length} duplicate chat files? (They will be backed up to backups/chat_dedupe/ and can be restored anytime).`
                : t`Permanently delete ${filesToDelete.length} duplicate chat files from disk?`;

            const confirmed = await Popup.show.confirm(t`Confirm Chat Cleanup`, confirmMsg);
            if (!confirmed) {
                return;
            }

            const cleanupBtn = $(dom).find('#chat_deduper_batch_cleanup_btn');
            cleanupBtn.prop('disabled', true).html(`<i class="fa-solid fa-spinner fa-spin"></i> ${t`Cleaning up...`}`);

            try {
                // If active chat is being deleted, switch character to keeper chat first
                if (needActiveChatSwitch) {
                    if (needActiveChatSwitch.isGroup) {
                        await openGroupChat(needActiveChatSwitch.keeperChatId);
                    } else if (characterId !== undefined) {
                        await openCharacterChat(needActiveChatSwitch.keeperChatId);
                    }
                }

                const response = await fetch('/api/chats/dedupe/cleanup', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        safeMode: currentSettings.safeMode,
                        files: filesToDelete,
                    }),
                });

                if (!response.ok) {
                    throw new Error(response.statusText);
                }

                const result = await response.json();
                toastr.success(t`Successfully cleaned up ${result.deletedCount || filesToDelete.length} duplicate chat files!`);

                // Refresh Manage Chat Files view if open
                if ($('#shadow_select_chat_popup').is(':visible')) {
                    await displayPastChats();
                }

                await eventSource.emit(event_types.CHAT_DELETED, 'bulk_dedupe');
                runScan();
            } catch (err) {
                console.error('Cleanup execution failed:', err);
                toastr.error(t`Failed to clean up duplicate chats: ${err.message}`);
                cleanupBtn.prop('disabled', false).html(`<i class="fa-solid fa-trash-can"></i> ${t`Clean Up Selected`}`);
            }
        });

        // ── Load Backups ───────────────────────────────────────────────────────
        async function loadBackups() {
            const container = $(dom).find('#chat_deduper_backups_container');
            container.html(`
                <div class="flex-container justifyCenter alignItemsCenter" style="padding: 30px 0;">
                    <i class="fa-solid fa-spinner fa-spin fa-xl"></i>
                </div>
            `);

            try {
                const response = await fetch('/api/chats/dedupe/backups', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                });

                if (!response.ok) {
                    throw new Error(response.statusText);
                }

                const data = await response.json();
                const backups = data.backups || [];

                container.empty();

                if (backups.length === 0) {
                    container.html(`
                        <div class="notes textAlignCenter" style="padding: 30px 0;">
                            <i class="fa-solid fa-box-open fa-2x" style="opacity: 0.5; margin-bottom: 8px;"></i>
                            <p class="margin0">${t`No chat deduplication snapshots found.`}</p>
                        </div>
                    `);
                    return;
                }

                backups.forEach(backup => {
                    const row = $(`
                        <div class="highlight-block flex-container justifySpaceBetween alignItemsCenter flexWrap" style="padding: 10px 14px; border-radius: 6px; gap: 10px;">
                            <div>
                                <strong><i class="fa-solid fa-file-zipper"></i> ${backup.backupId}</strong>
                                <div class="notes" style="font-size: 0.85em;">
                                    ${new Date(backup.timestamp).toLocaleString()} &bull; ${backup.totalDeleted} chats &bull; ${backup.freedFormatted || ''}
                                </div>
                            </div>
                            <div>
                                <button class="menu_button popup-button-ok btn-restore-backup" style="font-size: 0.85em;">
                                    <i class="fa-solid fa-rotate-left"></i> ${t`Restore`}
                                </button>
                            </div>
                        </div>
                    `);

                    row.find('.btn-restore-backup').on('click', async function () {
                        const restoreConfirmed = await Popup.show.confirm(
                            t`Restore Snapshot`,
                            t`Restore all ${backup.totalDeleted} chat files from snapshot ${backup.backupId}?`,
                        );
                        if (!restoreConfirmed) return;

                        $(this).prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');

                        try {
                            const res = await fetch('/api/chats/dedupe/restore', {
                                method: 'POST',
                                headers: getRequestHeaders(),
                                body: JSON.stringify({ backupId: backup.backupId }),
                            });

                            if (!res.ok) throw new Error(res.statusText);

                            const restoreResult = await res.json();
                            toastr.success(t`Successfully restored ${restoreResult.restoredCount} chat files!`);

                            if ($('#shadow_select_chat_popup').is(':visible')) {
                                await displayPastChats();
                            }
                            loadBackups();
                        } catch (err) {
                            console.error('Restore error:', err);
                            toastr.error(t`Failed to restore snapshot: ${err.message}`);
                        }
                    });

                    container.append(row);
                });
            } catch (err) {
                console.error('Failed to load backups:', err);
                container.html(`<div class="notes" style="color: var(--crimson); text-align: center;">${t`Could not load backups: `}${err.message}</div>`);
            }
        }

        // Initial scan
        runScan();

        // ── Show Popup ────────────────────────────────────────────────────────
        const popup = new Popup(dom, POPUP_TYPE.TEXT, '', {
            wide: true,
            large: true,
            okButton: t`Close`,
            cancelButton: false,
        });

        await popup.show();
    }
}
