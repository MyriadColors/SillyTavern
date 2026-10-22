import { getRequestHeaders, renameGroupOrCharacterChat } from '../script.js';
import { deleteGroupChatByName, editGroup, getGroupPastChats, groups, openGroupChat } from './group-chats.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from './popup.js';
import { t } from './i18n.js';

/**
 * @typedef {object} GroupChatManagerRow
 * @property {string} chatId Chat ID
 * @property {number} messageCount Number of messages
 * @property {string} preview Last message preview
 * @property {number} lastActive Timestamp of last activity
 * @property {string} size Human-readable file size
 * @property {string[]} tags Chat tags
 */

/**
 * Builds a manager row from a chat info response.
 * @param {string} chatId Chat ID
 * @param {object} info Chat info
 * @returns {GroupChatManagerRow} Manager row
 */
function buildRow(chatId, info) {
    const tags = Array.isArray(info?.chat_metadata?.group_chat_tags)
        ? info.chat_metadata.group_chat_tags.filter(tag => typeof tag === 'string')
        : [];

    return {
        chatId,
        messageCount: Number(info?.chat_items ?? 0),
        preview: String(info?.mes ?? ''),
        lastActive: Number(info?.last_mes ?? 0),
        size: String(info?.file_size ?? ''),
        tags,
    };
}

/**
 * Formats a timestamp for the manager list.
 * @param {number} timestamp Timestamp
 * @returns {string} Formatted date
 */
function formatDate(timestamp) {
    if (!timestamp) {
        return '';
    }

    return new Date(timestamp).toLocaleString();
}

/**
 * Shows the group chat manager popup.
 * @param {object} options Options
 * @param {string} options.groupId Group ID
 * @returns {Promise<void>}
 */
export async function showGroupChatManager({ groupId }) {
    const group = groups.find(x => x.id === groupId);

    if (!group) {
        return;
    }

    const container = document.createElement('div');
    container.classList.add('group_chat_manager');

    const popup = new Popup(container, POPUP_TYPE.DISPLAY, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    /** @type {GroupChatManagerRow[]} */
    let rows = [];
    let filterText = '';
    const selected = new Set();

    const header = document.createElement('div');
    header.classList.add('group_chat_manager_header', 'flex-container', 'flexFlowColumn', 'gap10');

    const title = document.createElement('h3');
    title.textContent = t`Manage group chats`;
    header.appendChild(title);

    const filter = document.createElement('input');
    filter.type = 'search';
    filter.classList.add('text_pole');
    filter.placeholder = t`Search chats and tags...`;
    filter.addEventListener('input', () => {
        filterText = filter.value.toLowerCase();
        renderList();
    });
    header.appendChild(filter);
    container.appendChild(header);

    const bulkBar = document.createElement('div');
    bulkBar.classList.add('group_chat_manager_bulk', 'flex-container', 'alignitemscenter', 'gap10');
    container.appendChild(bulkBar);

    const list = document.createElement('div');
    list.classList.add('group_chat_manager_list');
    container.appendChild(list);

    /**
     * Loads and renders the chat list.
     * @returns {Promise<void>}
     */
    async function refresh() {
        const infos = await getGroupPastChats(groupId, { withMetadata: true });
        const infoByChatId = new Map(infos.map(info => [info.file_id, info]));
        rows = group.chats.map(chatId => buildRow(chatId, infoByChatId.get(chatId)));
        rows.sort((a, b) => b.lastActive - a.lastActive);
        renderList();
        renderBulkBar();
    }

    /**
     * Renders the bulk action bar.
     */
    function renderBulkBar() {
        bulkBar.replaceChildren();

        const label = document.createElement('span');
        label.classList.add('notes');
        label.textContent = t`${selected.size} selected`;
        bulkBar.appendChild(label);

        const mergeButton = document.createElement('div');
        mergeButton.classList.add('menu_button', 'menu_button_icon');
        mergeButton.textContent = t`Merge selected`;
        mergeButton.classList.toggle('disabled', selected.size < 2);
        mergeButton.title = t`Combine the selected chats into one, ordered by message time.`;
        mergeButton.addEventListener('click', async () => {
            if (selected.size < 2) {
                return;
            }

            const chatIds = [...selected];
            const name = await Popup.show.input(
                t`Merge chats`,
                t`Enter a name for the merged chat. Leave blank to generate one automatically.`,
                '',
            );

            if (name === null || name === undefined) {
                return;
            }

            const confirmed = await callGenericPopup(
                t`Merge ${chatIds.length} chats and delete the source chats? This cannot be undone.`,
                POPUP_TYPE.CONFIRM,
            );

            if (!confirmed) {
                return;
            }

            const response = await fetch('/api/chats/group/merge', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ group_id: groupId, chat_ids: chatIds, name }),
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok || !data.name) {
                toastr.error(data.error ?? t`Could not merge the selected chats.`);
                return;
            }

            group.chats = group.chats.filter(id => !chatIds.includes(id));
            group.chats.push(data.name);
            group.chat_id = data.name;

            await editGroup(groupId, true, false);
            selected.clear();
            await popup.complete(POPUP_RESULT.AFFIRMATIVE);
            await openGroupChat(groupId, data.name);
        });
        bulkBar.appendChild(mergeButton);

        const deleteButton = document.createElement('div');
        deleteButton.classList.add('menu_button', 'menu_button_icon');
        deleteButton.textContent = t`Delete selected`;
        deleteButton.classList.toggle('disabled', selected.size === 0);
        deleteButton.addEventListener('click', async () => {
            if (!selected.size) {
                return;
            }

            const confirmed = await callGenericPopup(
                t`Delete ${selected.size} group chat(s)? This cannot be undone.`,
                POPUP_TYPE.CONFIRM,
            );

            if (!confirmed) {
                return;
            }

            for (const chatId of [...selected]) {
                await deleteGroupChatByName(groupId, chatId);
            }

            selected.clear();
            await refresh();
        });
        bulkBar.appendChild(deleteButton);
    }

    /**
     * Filters rows by the current search text.
     * @returns {GroupChatManagerRow[]} Filtered rows
     */
    function getVisibleRows() {
        if (!filterText) {
            return rows;
        }

        return rows.filter(row => [row.chatId, ...row.tags]
            .some(value => value.toLowerCase().includes(filterText)));
    }

    /**
     * Opens a chat and closes the manager.
     * @param {string} chatId Chat ID
     */
    async function openChat(chatId) {
        await popup.complete(POPUP_RESULT.AFFIRMATIVE);
        await openGroupChat(groupId, chatId);
    }

    /**
     * Renames a chat and refreshes the list.
     * @param {string} chatId Chat ID
     */
    async function renameChat(chatId) {
        const newName = await Popup.show.input(t`Rename chat`, t`Enter a new name for this chat.`, chatId);

        if (!newName || newName === chatId) {
            return;
        }

        await renameGroupOrCharacterChat({
            groupId,
            oldFileName: chatId,
            newFileName: newName,
            loader: true,
        });
        await refresh();
    }

    /**
     * Edits the tags of a chat.
     * @param {GroupChatManagerRow} row Chat row
     */
    async function editTags(row) {
        const value = await Popup.show.input(
            t`Chat tags`,
            t`Enter comma-separated tags for this chat.`,
            row.tags.join(', '),
        );

        if (value === null || value === undefined) {
            return;
        }

        const tags = value.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);

        const response = await fetch('/api/chats/group/tags', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ id: row.chatId, tags }),
        });

        if (!response.ok) {
            toastr.error(t`Could not save chat tags.`);
            return;
        }

        row.tags = tags;
        renderList();
    }

    /**
     * Renders the list of chats.
     */
    function renderList() {
        list.replaceChildren();

        const visibleRows = getVisibleRows();

        if (!visibleRows.length) {
            const empty = document.createElement('div');
            empty.classList.add('notes');
            empty.textContent = rows.length ? t`No chats match the search.` : t`This group has no chats yet.`;
            list.appendChild(empty);
            return;
        }

        for (const row of visibleRows) {
            const isActive = group.chat_id === row.chatId;
            const rowElement = document.createElement('div');
            rowElement.classList.add('group_chat_manager_row', 'flex-container', 'alignitemscenter', 'gap10');
            rowElement.classList.toggle('group_chat_manager_row_active', isActive);

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selected.has(row.chatId);
            checkbox.disabled = isActive;
            checkbox.title = isActive ? t`This chat is currently open and cannot be deleted here.` : '';
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    selected.add(row.chatId);
                } else {
                    selected.delete(row.chatId);
                }
                renderBulkBar();
            });
            rowElement.appendChild(checkbox);

            const details = document.createElement('div');
            details.classList.add('group_chat_manager_details', 'flex1', 'flexFlowColumn');

            const name = document.createElement('div');
            name.classList.add('group_chat_manager_name');
            name.textContent = row.chatId;
            details.appendChild(name);

            const summary = document.createElement('div');
            summary.classList.add('notes');
            summary.textContent = [
                t`${row.messageCount} messages`,
                row.size,
                formatDate(row.lastActive),
                row.preview ? row.preview.slice(0, 120) : '',
            ].filter(Boolean).join(' · ');
            details.appendChild(summary);

            if (row.tags.length) {
                const tags = document.createElement('div');
                tags.classList.add('group_chat_manager_tags', 'flex-container', 'flexGap5');

                for (const tag of row.tags) {
                    const chip = document.createElement('span');
                    chip.classList.add('tag', 'group_chat_manager_tag');
                    chip.textContent = tag;
                    tags.appendChild(chip);
                }

                details.appendChild(tags);
            }

            rowElement.appendChild(details);

            const actions = document.createElement('div');
            actions.classList.add('group_chat_manager_actions', 'flex-container', 'alignitemscenter', 'flexGap5');

            const openButton = document.createElement('div');
            openButton.classList.add('menu_button', 'menu_button_icon', 'fa-solid', 'fa-folder-open');
            openButton.title = t`Open chat`;
            openButton.addEventListener('click', () => openChat(row.chatId));
            actions.appendChild(openButton);

            const tagsButton = document.createElement('div');
            tagsButton.classList.add('menu_button', 'menu_button_icon', 'fa-solid', 'fa-tags');
            tagsButton.title = t`Edit tags`;
            tagsButton.addEventListener('click', () => editTags(row));
            actions.appendChild(tagsButton);

            const renameButton = document.createElement('div');
            renameButton.classList.add('menu_button', 'menu_button_icon', 'fa-solid', 'fa-pencil');
            renameButton.title = t`Rename chat`;
            renameButton.addEventListener('click', () => renameChat(row.chatId));
            actions.appendChild(renameButton);

            const deleteButton = document.createElement('div');
            deleteButton.classList.add('menu_button', 'menu_button_icon', 'fa-solid', 'fa-trash-can');
            deleteButton.title = isActive ? t`Close another chat before deleting this one.` : t`Delete chat`;
            deleteButton.classList.toggle('disabled', isActive);
            deleteButton.addEventListener('click', async () => {
                if (isActive) {
                    return;
                }

                const confirmed = await callGenericPopup(
                    t`Delete the chat "${row.chatId}"? This cannot be undone.`,
                    POPUP_TYPE.CONFIRM,
                );

                if (!confirmed) {
                    return;
                }

                await deleteGroupChatByName(groupId, row.chatId);
                selected.delete(row.chatId);
                await refresh();
            });
            actions.appendChild(deleteButton);

            rowElement.appendChild(actions);
            list.appendChild(rowElement);
        }
    }

    popup.show();
    await refresh();
}
