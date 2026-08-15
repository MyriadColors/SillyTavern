import {
    getOneCharacter,
    getRequestHeaders,
    getThumbnailUrl,
    default_avatar,
    printCharacters,
    saveSettingsDebounced,
} from '../script.js';
import { renderTemplateAsync } from './templates.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';
import { tag_map } from './tags.js';
import { groups } from './group-chats.js';

const SETTINGS_KEY = 'st_card_deduper_settings';
const IGNORED_PAIRS_KEY = 'st_card_deduper_ignored_pairs';

/**
 * Controller for scanning, managing, and safely consolidating duplicate character cards.
 */
export class CardDeduperManager {
    static getSettings() {
        const defaultSettings = {
            safeMode: 'trash', // 'trash' | 'tag' | 'delete'
            createBackup: true,
            migrateChats: true,
            updateGroups: true,
            mergeLorebook: true,
            mergeGreetings: true,
            mergeTags: true,
            mergeRegex: true,
            matchTypes: ['name', 'hash'],
            similarityThreshold: 0.85,
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
            console.error('Could not save deduper settings:', err);
        }
    }

    static getIgnoredPairs() {
        try {
            const saved = accountStorage.getItem(IGNORED_PAIRS_KEY);
            return saved ? JSON.parse(saved) : [];
        } catch {
            return [];
        }
    }

    static addIgnoredPair(avatarA, avatarB) {
        const list = this.getIgnoredPairs();
        const pair = [avatarA, avatarB].sort();
        const pairKey = pair.join('::');
        if (!list.some(p => [p[0], p[1]].sort().join('::') === pairKey)) {
            list.push(pair);
            accountStorage.setItem(IGNORED_PAIRS_KEY, JSON.stringify(list));
        }
    }

    static clearIgnoredPairs() {
        accountStorage.removeItem(IGNORED_PAIRS_KEY);
    }

    /**
     * Opens the Deduper & Consolidation modal dialog.
     */
    static async openDeduperDialog() {
        const templateHtml = await renderTemplateAsync('cardDeduperPopup');
        const popup = new Popup(templateHtml, POPUP_TYPE.TEXT, '', {
            okButton: false,
            cancelButton: t`Close`,
            classes: ['wide_dialogue_popup'],
        });

        const dialog = await popup.show();
        const dom = dialog.dialog;

        let currentClusters = [];
        let currentSettings = this.getSettings();

        // ── Tabs Setup ──────────────────────────────────────────────────────────
        const tabs = {
            clusters: $(dom).find('#card_deduper_tab_clusters'),
            settings: $(dom).find('#card_deduper_tab_settings'),
            backups: $(dom).find('#card_deduper_tab_backups'),
        };
        const pages = {
            clusters: $(dom).find('#card_deduper_page_clusters'),
            settings: $(dom).find('#card_deduper_page_settings'),
            backups: $(dom).find('#card_deduper_page_backups'),
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

        // ── Load Settings to UI ────────────────────────────────────────────────
        $(dom).find(`input[name="card_deduper_safe_mode"][value="${currentSettings.safeMode}"]`).prop('checked', true);
        $(dom).find('#card_deduper_opt_backup').prop('checked', currentSettings.createBackup);
        $(dom).find('#card_deduper_opt_chats').prop('checked', currentSettings.migrateChats);
        $(dom).find('#card_deduper_opt_groups').prop('checked', currentSettings.updateGroups);
        $(dom).find('#card_deduper_opt_lorebook').prop('checked', currentSettings.mergeLorebook);
        $(dom).find('#card_deduper_opt_greetings').prop('checked', currentSettings.mergeGreetings);
        $(dom).find('#card_deduper_opt_tags').prop('checked', currentSettings.mergeTags);

        $(dom).find('#card_deduper_detect_name').prop('checked', currentSettings.matchTypes.includes('name'));
        $(dom).find('#card_deduper_detect_hash').prop('checked', currentSettings.matchTypes.includes('hash'));
        $(dom).find('#card_deduper_detect_fuzzy').prop('checked', currentSettings.matchTypes.includes('fuzzy'));

        function syncSettingsFromUI() {
            currentSettings.safeMode = $(dom).find('input[name="card_deduper_safe_mode"]:checked').val() || 'trash';
            currentSettings.createBackup = $(dom).find('#card_deduper_opt_backup').is(':checked');
            currentSettings.migrateChats = $(dom).find('#card_deduper_opt_chats').is(':checked');
            currentSettings.updateGroups = $(dom).find('#card_deduper_opt_groups').is(':checked');
            currentSettings.mergeLorebook = $(dom).find('#card_deduper_opt_lorebook').is(':checked');
            currentSettings.mergeGreetings = $(dom).find('#card_deduper_opt_greetings').is(':checked');
            currentSettings.mergeTags = $(dom).find('#card_deduper_opt_tags').is(':checked');

            const matchTypes = [];
            if ($(dom).find('#card_deduper_detect_name').is(':checked')) matchTypes.push('name');
            if ($(dom).find('#card_deduper_detect_hash').is(':checked')) matchTypes.push('hash');
            if ($(dom).find('#card_deduper_detect_fuzzy').is(':checked')) matchTypes.push('fuzzy');
            currentSettings.matchTypes = matchTypes;

            CardDeduperManager.saveSettings(currentSettings);
        }

        $(dom).find('#card_deduper_page_settings input').on('change', () => {
            syncSettingsFromUI();
        });

        $(dom).find('#card_deduper_clear_whitelist_btn').on('click', () => {
            CardDeduperManager.clearIgnoredPairs();
            toastr.success(t`Ignored pairs whitelist cleared.`);
            runScan();
        });

        // ── Scan & Render Clusters ─────────────────────────────────────────────
        async function runScan() {
            syncSettingsFromUI();
            const container = $(dom).find('#card_deduper_clusters_container');
            container.html(`
                <div class="card-deduper-loading flex-container flexFlowColumn alignItemsCenter justifyCenter" style="padding: 40px 0; gap: 10px;">
                    <i class="fa-solid fa-spinner fa-spin fa-2xl"></i>
                    <span>${t`Scanning character library for duplicates...`}</span>
                </div>
            `);

            try {
                const response = await fetch('/api/characters/dedupe/scan', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        matchTypes: currentSettings.matchTypes,
                        similarityThreshold: currentSettings.similarityThreshold,
                        ignoredPairs: CardDeduperManager.getIgnoredPairs(),
                    }),
                });

                if (!response.ok) {
                    throw new Error(response.statusText);
                }

                const data = await response.json();
                currentClusters = data.clusters || [];

                let totalChats = 0;
                currentClusters.forEach(cl => {
                    cl.cards.forEach(c => {
                        if (!c.isRecommendedPrimary) totalChats += (c.chatCount || 0);
                    });
                });

                $(dom).find('#card_deduper_stat_clusters').text(currentClusters.length);
                $(dom).find('#card_deduper_stat_duplicates').text(data.totalDuplicates || 0);
                $(dom).find('#card_deduper_stat_chats').text(totalChats);

                renderClusters();
            } catch (err) {
                console.error('Scan error:', err);
                container.html(`<div class="notes" style="color: var(--crimson); padding: 20px 0; text-align: center;">${t`Failed to scan library: `}${err.message}</div>`);
            }
        }

        function renderClusters() {
            const container = $(dom).find('#card_deduper_clusters_container');
            container.empty();

            if (currentClusters.length === 0) {
                container.html(`
                    <div class="flex-container flexFlowColumn alignItemsCenter justifyCenter" style="padding: 40px 0; gap: 12px; opacity: 0.8;">
                        <i class="fa-solid fa-circle-check fa-3x" style="color: var(--green);"></i>
                        <h3>${t`No Duplicates Found!`}</h3>
                        <p class="notes margin0">${t`Your character library is completely tidy and deduplicated.`}</p>
                    </div>
                `);
                $(dom).find('#card_deduper_batch_consolidate_btn').prop('disabled', true);
                return;
            }

            $(dom).find('#card_deduper_batch_consolidate_btn').prop('disabled', false);

            currentClusters.forEach((cluster, clusterIdx) => {
                const clusterBlock = $(`
                    <div class="card-deduper-cluster-block highlight-block" style="padding: 12px 14px; border-radius: 8px; margin-bottom: 8px;">
                        <div class="flex-container justifySpaceBetween alignItemsCenter" style="margin-bottom: 10px;">
                            <div>
                                <h4 class="margin0">
                                    <i class="fa-solid fa-folder-tree"></i> ${cluster.name}
                                    <span class="notes" style="font-size: 0.8em; font-weight: normal;">(${cluster.cards.length} cards)</span>
                                </h4>
                            </div>
                            <div class="flex-container" style="gap: 6px;">
                                <button class="menu_button btn-ignore-pair" style="font-size: 0.8em;" title="${t`Ignore as duplicate`}">
                                    <i class="fa-solid fa-eye-slash"></i> ${t`Ignore`}
                                </button>
                                <button class="menu_button btn-dryrun-cluster" style="font-size: 0.8em;" title="${t`Preview dry run`}">
                                    <i class="fa-solid fa-magnifying-glass-chart"></i> ${t`Preview`}
                                </button>
                                <button class="menu_button popup-button-ok btn-consolidate-cluster" style="font-size: 0.8em;">
                                    <i class="fa-solid fa-wand-magic-sparkles"></i> ${t`Consolidate`}
                                </button>
                            </div>
                        </div>
                        <div class="card-deduper-cards-grid flex-container" style="gap: 10px; flex-wrap: wrap;"></div>
                    </div>
                `);

                const cardsGrid = clusterBlock.find('.card-deduper-cards-grid');

                cluster.cards.forEach((card) => {
                    const isPrimary = card.avatar === cluster.recommendedPrimary;
                    const cardItem = $(`
                        <div class="card-deduper-card-item flex-container alignItemsCenter ${isPrimary ? 'is-primary-card' : ''}" style="flex: 1; min-width: 260px; padding: 8px 10px; background-color: var(--black30a); border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; gap: 10px;">
                            <input type="radio" name="primary_card_${clusterIdx}" value="${card.avatar}" ${isPrimary ? 'checked' : ''} title="${t`Select as Primary (to keep)`}" />
                            <img src="${getThumbnailUrl('avatar', card.avatar)}" onerror="this.src='${default_avatar}'" style="width: 48px; height: 48px; object-fit: cover; border-radius: 4px; flex-shrink: 0;" />
                            <div class="flex1" style="overflow: hidden;">
                                <div class="flex-container alignItemsCenter" style="gap: 4px;">
                                    <strong style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${card.name}</strong>
                                    ${card.character_version ? `<span class="tag" style="font-size: 0.7em; padding: 1px 4px;">v${card.character_version}</span>` : ''}
                                    ${isPrimary ? `<span class="tag" style="font-size: 0.7em; padding: 1px 4px; background-color: var(--green);">${t`Primary`}</span>` : ''}
                                </div>
                                <div class="notes" style="font-size: 0.8em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${card.avatar}</div>
                                <div class="notes" style="font-size: 0.75em;">
                                    <i class="fa-solid fa-comments"></i> ${card.chatCount || 0} chats (${card.messageCount || 0} msgs)
                                </div>
                            </div>
                        </div>
                    `);

                    cardItem.find(`input[name="primary_card_${clusterIdx}"]`).on('change', function () {
                        cluster.recommendedPrimary = $(this).val();
                        cardsGrid.find('.card-deduper-card-item').removeClass('is-primary-card');
                        cardsGrid.find('.tag:contains("Primary")').remove();
                        cardItem.addClass('is-primary-card');
                        cardItem.find('strong').after(`<span class="tag" style="font-size: 0.7em; padding: 1px 4px; background-color: var(--green);">${t`Primary`}</span>`);
                    });

                    cardsGrid.append(cardItem);
                });

                clusterBlock.find('.btn-ignore-pair').on('click', () => {
                    for (let i = 0; i < cluster.cards.length; i++) {
                        for (let j = i + 1; j < cluster.cards.length; j++) {
                            CardDeduperManager.addIgnoredPair(cluster.cards[i].avatar, cluster.cards[j].avatar);
                        }
                    }
                    toastr.info(t`Pair ignored from future scans.`);
                    runScan();
                });

                clusterBlock.find('.btn-dryrun-cluster').on('click', () => {
                    CardDeduperManager.showDryRunPreview(cluster, currentSettings);
                });

                clusterBlock.find('.btn-consolidate-cluster').on('click', async () => {
                    const ok = await Popup.show.confirm(
                        t`Consolidate Cluster: ${cluster.name}`,
                        `<p>${t`Are you sure you want to consolidate this cluster into <strong>${cluster.recommendedPrimary}</strong>?`}</p>` +
                        `<p class="notes">${t`Safety Mode: <strong>${currentSettings.safeMode}</strong>. All chats and groups will be safely preserved.`}</p>`,
                    );
                    if (ok) {
                        await CardDeduperManager.executeConsolidation(cluster, currentSettings);
                        runScan();
                    }
                });

                container.append(clusterBlock);
            });
        }

        // ── Batch Consolidate All ──────────────────────────────────────────────
        $(dom).find('#card_deduper_batch_consolidate_btn').on('click', async () => {
            if (currentClusters.length === 0) return;
            const ok = await Popup.show.confirm(
                t`Consolidate All Duplicate Clusters`,
                `<p>${t`This will consolidate all <strong>${currentClusters.length}</strong> duplicate clusters.`}</p>` +
                `<p class="notes">${t`Safety Mode: <strong>${currentSettings.safeMode}</strong>. Automatic backup will be created.`}</p>`,
            );
            if (!ok) return;

            for (const cluster of currentClusters) {
                await CardDeduperManager.executeConsolidation(cluster, currentSettings, false);
            }
            toastr.success(t`All duplicate clusters consolidated successfully!`);
            runScan();
        });

        $(dom).find('#card_deduper_rescan_btn').on('click', () => {
            runScan();
        });

        // ── Backups & Rollback Tab ─────────────────────────────────────────────
        async function loadBackups() {
            const container = $(dom).find('#card_deduper_backups_container');
            container.html(`
                <div class="flex-container justifyCenter alignItemsCenter" style="padding: 30px 0;">
                    <i class="fa-solid fa-spinner fa-spin fa-xl"></i>
                </div>
            `);

            try {
                const response = await fetch('/api/characters/dedupe/backups', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                });

                if (!response.ok) throw new Error(response.statusText);
                const data = await response.json();
                const backups = data.backups || [];

                container.empty();

                if (backups.length === 0) {
                    container.html(`<div class="notes" style="text-align: center; padding: 20px 0;">${t`No deduplication snapshots available yet.`}</div>`);
                    return;
                }

                backups.forEach(b => {
                    const dateStr = new Date(b.timestamp).toLocaleString();
                    const item = $(`
                        <div class="highlight-block flex-container justifySpaceBetween alignItemsCenter" style="padding: 10px 14px; border-radius: 6px;">
                            <div>
                                <strong><i class="fa-solid fa-box-archive"></i> ${b.primaryAvatar}</strong>
                                <div class="notes" style="font-size: 0.85em;">${dateStr} &bull; ${b.duplicateAvatars?.length || 0} duplicates merged &bull; Strategy: ${b.strategy}</div>
                            </div>
                            <button class="menu_button popup-button-ok btn-restore-backup" style="font-size: 0.85em;">
                                <i class="fa-solid fa-clock-rotate-left"></i> ${t`Restore / Undo`}
                            </button>
                        </div>
                    `);

                    item.find('.btn-restore-backup').on('click', async () => {
                        const confirm = await Popup.show.confirm(
                            t`Restore Pre-Consolidation Snapshot`,
                            `<p>${t`Are you sure you want to restore the snapshot from <strong>${dateStr}</strong>?`}</p>` +
                            `<p class="notes">${t`This will revert all character cards, chats, and groups to their exact state before this consolidation.`}</p>`,
                        );
                        if (confirm) {
                            await CardDeduperManager.restoreBackup(b.id);
                            loadBackups();
                            runScan();
                        }
                    });

                    container.append(item);
                });
            } catch (err) {
                container.html(`<div class="notes" style="color: var(--crimson); text-align: center;">${t`Failed to load backups: `}${err.message}</div>`);
            }
        }

        // Initial scan
        runScan();
    }

    /**
     * Previews a dry run breakdown for a cluster.
     */
    static showDryRunPreview(cluster, settings) {
        const primary = cluster.recommendedPrimary;
        const duplicates = cluster.cards.filter(c => c.avatar !== primary);
        const totalChats = duplicates.reduce((sum, c) => sum + (c.chatCount || 0), 0);

        const html = `
            <div class="flex-container flexFlowColumn" style="gap: 10px;">
                <p><strong>${t`Consolidation Summary for: `} ${cluster.name}</strong></p>
                <ul style="margin: 0; padding-left: 20px;">
                    <li>${t`Primary card to retain:`} <strong>${primary}</strong></li>
                    <li>${t`Duplicate cards to process:`} <strong>${duplicates.map(d => d.avatar).join(', ')}</strong></li>
                    <li>${t`Chat histories to migrate safely:`} <strong>${totalChats} chats</strong></li>
                    <li>${t`Safety Mode:`} <strong>${settings.safeMode === 'trash' ? t`Move to _dedupe_archive/ (.disabled)` : settings.safeMode}</strong></li>
                    <li>${t`Auto Backup Snapshot:`} <strong>${settings.createBackup ? t`Enabled (Rollback Available)` : t`Disabled`}</strong></li>
                    <li>${t`Group Relinking:`} <strong>${settings.updateGroups ? t`Enabled` : t`Disabled`}</strong></li>
                </ul>
            </div>
        `;

        Popup.show.alert(t`Dry Run Consolidation Preview`, html);
    }

    /**
     * Executes consolidation for a single cluster.
     */
    static async executeConsolidation(cluster, settings, showToast = true) {
        const primaryAvatar = cluster.recommendedPrimary;
        const duplicateAvatars = cluster.cards.map(c => c.avatar).filter(av => av !== primaryAvatar);

        if (duplicateAvatars.length === 0) {
            return;
        }

        try {
            const response = await fetch('/api/characters/dedupe/consolidate', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    primaryAvatar,
                    duplicateAvatars,
                    strategy: 'smart_merge',
                    safeMode: settings.safeMode,
                    options: settings,
                }),
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.message || response.statusText);
            }

            const result = await response.json();

            // Synchronize client-side tags
            duplicateAvatars.forEach(dup => {
                if (tag_map[dup]) {
                    if (!tag_map[primaryAvatar]) tag_map[primaryAvatar] = [];
                    tag_map[dup].forEach(tag => {
                        if (!tag_map[primaryAvatar].includes(tag)) tag_map[primaryAvatar].push(tag);
                    });
                    delete tag_map[dup];
                }
            });
            saveSettingsDebounced();

            // Synchronize client-side groups
            groups.forEach(g => {
                if (Array.isArray(g.members)) {
                    let changed = false;
                    const newMembers = [];
                    g.members.forEach(m => {
                        if (duplicateAvatars.includes(m)) {
                            if (!newMembers.includes(primaryAvatar)) newMembers.push(primaryAvatar);
                            changed = true;
                        } else {
                            if (!newMembers.includes(m)) newMembers.push(m);
                        }
                    });
                    if (changed) g.members = newMembers;
                }
            });

            // Refresh character library
            await fetch(getThumbnailUrl('avatar', primaryAvatar), { cache: 'reload' }).catch(() => {});
            await getOneCharacter(primaryAvatar);
            await printCharacters(true);

            if (showToast) {
                toastr.success(t`Consolidated ${result.duplicatesProcessed} duplicate(s) into ${primaryAvatar} (${result.chatsMigrated} chats migrated)`);
            }
        } catch (err) {
            console.error('Consolidation failed:', err);
            toastr.error(err.message || t`Failed to consolidate duplicates`, t`Error`);
        }
    }

    /**
     * Restores a backup snapshot.
     */
    static async restoreBackup(backupId) {
        try {
            const response = await fetch('/api/characters/dedupe/restore', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ backupId }),
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.message || response.statusText);
            }

            await printCharacters(true);
            toastr.success(t`Rollback completed! Character library, chats, and groups restored.`);
        } catch (err) {
            console.error('Rollback failed:', err);
            toastr.error(err.message || t`Failed to rollback backup`, t`Error`);
        }
    }
}
