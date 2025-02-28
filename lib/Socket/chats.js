import { Boom } from "@hapi/boom";
import NodeCache from "@cacheable/node-cache";
import { proto } from "../../WAProto/index.js";
import { DEFAULT_CACHE_TTLS, PROCESSABLE_HISTORY_TYPES } from "../Defaults/index.js";
import { ALL_WA_PATCH_NAMES } from "../Types";
import { chatModificationToAppPatch, decodePatches, decodeSyncdSnapshot, encodeSyncdPatch, extractSyncdPatches, generateProfilePicture, getHistoryMsg, newLTHashState, processSyncAction } from "../Utils/index.js";
import { makeMutex } from "../Utils/make-mutex.js";
import processMessage from "../Utils/process-message.js";
import { getBinaryNodeChild, getBinaryNodeChildren, jidNormalizedUser, reduceBinaryNodeToDictionary, S_WHATSAPP_NET } from "../WABinary/index.js";
import { USyncQuery, USyncUser } from "../WAUSync/index.js";
import { makeUSyncSocket } from "./usync.js";
const MAX_SYNC_ATTEMPTS = 2;
export const makeChatsSocket = (config) => {
    const sock = makeUSyncSocket(config);
    let privacySettings;
    let needToFlushWithAppStateSync = false;
    let pendingAppStateSync = false;
    const processingMutex = makeMutex();
    const placeholderResendCache = config.placeholderResendCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY,
            useClones: false
        });
    if (!config.placeholderResendCache) {
        config.placeholderResendCache = placeholderResendCache;
    }
    const getAppStateSyncKey = async (keyId) => {
        const { [keyId]: key } = await sock.authState.keys.get("app-state-sync-key", [keyId]);
        return key;
    };
    const fetchPrivacySettings = async (force = false) => {
        if (!privacySettings || force) {
            const { content } = await sock.query({
                tag: "iq",
                attrs: {
                    xmlns: "privacy",
                    to: S_WHATSAPP_NET,
                    type: "get"
                },
                content: [{ tag: "privacy", attrs: {} }]
            });
            privacySettings = reduceBinaryNodeToDictionary(content?.[0], "category");
        }
        return privacySettings;
    };
    const privacyQuery = async (name, value) => {
        await sock.query({
            tag: "iq",
            attrs: {
                xmlns: "privacy",
                to: S_WHATSAPP_NET,
                type: "set"
            },
            content: [
                {
                    tag: "privacy",
                    attrs: {},
                    content: [
                        {
                            tag: "category",
                            attrs: { name, value }
                        }
                    ]
                }
            ]
        });
    };
    const updateCallPrivacy = async (value) => {
        await privacyQuery("calladd", value);
    };
    const updateLastSeenPrivacy = async (value) => {
        await privacyQuery("last", value);
    };
    const updateOnlinePrivacy = async (value) => {
        await privacyQuery("online", value);
    };
    const updateProfilePicturePrivacy = async (value) => {
        await privacyQuery("profile", value);
    };
    const updateStatusPrivacy = async (value) => {
        await privacyQuery("status", value);
    };
    const updateReadReceiptsPrivacy = async (value) => {
        await privacyQuery("readreceipts", value);
    };
    const updateGroupsAddPrivacy = async (value) => {
        await privacyQuery("groupadd", value);
    };
    const updateDefaultDisappearingMode = async (duration) => {
        await sock.query({
            tag: "iq",
            attrs: {
                xmlns: "disappearing_mode",
                to: S_WHATSAPP_NET,
                type: "set"
            },
            content: [
                {
                    tag: "disappearing_mode",
                    attrs: {
                        duration: duration.toString()
                    }
                }
            ]
        });
    };
    const onWhatsApp = async (...jids) => {
        const usyncQuery = new USyncQuery().withContactProtocol();
        for (let jid of jids) {
            jid = jidNormalizedUser(jid);
            if (!/^\d+@s\.whatsapp\.net$/.test(jid)) {
                throw new Error("The entered jid does not have a valid format");
            }
            const phone = `+${jid.match(/\d+/)[0]}`;
            usyncQuery.withUser(new USyncUser().withPhone(phone));
        }
        const results = await sock.executeUSyncQuery(usyncQuery);
        if (results) {
            return results.list
                .filter((a) => !!a.contact)
                .map(({ contact, id }) => ({ jid: id, exists: contact }));
        }
    };
    const fetchStatus = async (...jids) => {
        const usyncQuery = new USyncQuery().withStatusProtocol();
        for (const jid of jids) {
            usyncQuery.withUser(new USyncUser().withId(jid));
        }
        const result = await sock.executeUSyncQuery(usyncQuery);
        if (result) {
            return result.list;
        }
    };
    const fetchDisappearingDuration = async (...jids) => {
        const usyncQuery = new USyncQuery().withDisappearingModeProtocol();
        for (const jid of jids) {
            usyncQuery.withUser(new USyncUser().withId(jid));
        }
        const result = await sock.executeUSyncQuery(usyncQuery);
        if (result) {
            return result.list;
        }
    };
    const updateProfilePicture = async (jid, content) => {
        jid = jidNormalizedUser(jid);
        if (!jid ||
            !/^\d+@s\.whatsapp\.net$/.test(jid) ||
            !/^\d+@g\.us$/.test(jid)) {
            throw new Error(`The entered jid '${jid}' is not valid, enter your own jid or that of a group to continue`);
        }
        if (/^\d+@s\.whatsapp\.net$/.test(jid)) {
            if (jid !== jidNormalizedUser(sock.authState.creds.me.id)) {
                throw new Error("You can only update your own profile picture or that of a group where you are an administrator");
            }
        }
        const { img } = await generateProfilePicture(content);
        if (!Buffer.isBuffer(img)) {
            throw new Error("An error occurred while generating the profile image");
        }
        await sock.query({
            tag: "iq",
            attrs: {
                target: jid,
                to: S_WHATSAPP_NET,
                type: "set",
                xmlns: "w:profile:picture"
            },
            content: [
                {
                    tag: "picture",
                    attrs: { type: "image" },
                    content: img
                }
            ]
        });
    };
    const removeProfilePicture = async (jid) => {
        jid = jidNormalizedUser(jid);
        if (!jid ||
            !/^\d+@s\.whatsapp\.net$/.test(jid) ||
            !/^\d+@g\.us$/.test(jid)) {
            throw new Error(`The entered jid '${jid}' is not valid, enter your own jid or that of a group to continue`);
        }
        if (/^\d+@s\.whatsapp\.net$/.test(jid)) {
            if (jid !== jidNormalizedUser(sock.authState.creds.me.id)) {
                throw new Error("You can only delete your own profile picture or the one of a group where you are an administrator");
            }
        }
        await sock.query({
            tag: "iq",
            attrs: {
                target: jid,
                to: S_WHATSAPP_NET,
                type: "set",
                xmlns: "w:profile:picture"
            }
        });
    };
    const updateProfileStatus = async (status) => {
        await sock.query({
            tag: "iq",
            attrs: {
                to: S_WHATSAPP_NET,
                type: "set",
                xmlns: "status"
            },
            content: [
                {
                    tag: "status",
                    attrs: {},
                    content: Buffer.from(status, "utf-8")
                }
            ]
        });
    };
    const updateProfileName = async (name) => {
        await chatModify({ pushNameSetting: name }, "");
    };
    const fetchBlocklist = async () => {
        const result = await sock.query({
            tag: "iq",
            attrs: {
                xmlns: "blocklist",
                to: S_WHATSAPP_NET,
                type: "get"
            }
        });
        const listNode = getBinaryNodeChild(result, "list");
        return getBinaryNodeChildren(listNode, "item").map((n) => n.attrs.jid);
    };
    const updateBlockStatus = async (jid, action) => {
        await sock.query({
            tag: "iq",
            attrs: {
                xmlns: "blocklist",
                to: S_WHATSAPP_NET,
                type: "set"
            },
            content: [
                {
                    tag: "item",
                    attrs: {
                        action,
                        jid
                    }
                }
            ]
        });
    };
    const getBusinessProfile = async (jid) => {
        const results = await sock.query({
            tag: "iq",
            attrs: {
                to: "s.whatsapp.net",
                xmlns: "w:biz",
                type: "get"
            },
            content: [
                {
                    tag: "business_profile",
                    attrs: { v: "244" },
                    content: [
                        {
                            tag: "profile",
                            attrs: { jid }
                        }
                    ]
                }
            ]
        });
        const profileNode = getBinaryNodeChild(results, "business_profile");
        const profiles = getBinaryNodeChild(profileNode, "profile");
        if (profiles) {
            const address = getBinaryNodeChild(profiles, "address");
            const description = getBinaryNodeChild(profiles, "description");
            const website = getBinaryNodeChild(profiles, "website");
            const email = getBinaryNodeChild(profiles, "email");
            const category = getBinaryNodeChild(getBinaryNodeChild(profiles, "categories"), "category");
            const businessHours = getBinaryNodeChild(profiles, "business_hours");
            const businessHoursConfig = businessHours
                ? getBinaryNodeChildren(businessHours, "business_hours_config")
                : undefined;
            const websiteStr = website?.content?.toString();
            return {
                wid: profiles.attrs?.jid,
                address: address?.content?.toString(),
                description: description?.content?.toString() || "",
                website: websiteStr ? [websiteStr] : [],
                email: email?.content?.toString(),
                category: category?.content?.toString(),
                business_hours: {
                    timezone: businessHours?.attrs?.timezone,
                    business_config: businessHoursConfig?.map(({ attrs }) => attrs)
                }
            };
        }
    };
    const cleanDirtyBits = async (type, fromTimestamp) => {
        config.logger.info({ fromTimestamp }, "clean dirty bits " + type);
        await sock.sendNode({
            tag: "iq",
            attrs: {
                to: S_WHATSAPP_NET,
                type: "set",
                xmlns: "urn:xmpp:whatsapp:dirty",
                id: sock.generateMessageTag()
            },
            content: [
                {
                    tag: "clean",
                    attrs: {
                        type,
                        ...(fromTimestamp ? { timestamp: fromTimestamp.toString() } : null)
                    }
                }
            ]
        });
    };
    const newAppStateChunkHandler = (isInitialSync) => {
        return {
            onMutation(mutation) {
                processSyncAction(mutation, sock.ev, sock.authState.creds.me, isInitialSync
                    ? { accountSettings: sock.authState.creds.accountSettings }
                    : undefined, config.logger);
            }
        };
    };
    const resyncAppState = sock.ev.createBufferedFunction(async (collections, isInitialSync) => {
        const initialVersionMap = {};
        const globalMutationMap = {};
        await sock.authState.keys.transaction(async () => {
            const collectionsToHandle = new Set(collections);
            const attemptsMap = {};
            while (collectionsToHandle.size) {
                const states = {};
                const nodes = [];
                for (const name of collectionsToHandle) {
                    const result = await sock.authState.keys.get("app-state-sync-version", [name]);
                    let state = result[name];
                    if (state) {
                        if (typeof initialVersionMap[name] === "undefined") {
                            initialVersionMap[name] = state.version;
                        }
                    }
                    else {
                        state = newLTHashState();
                    }
                    states[name] = state;
                    config.logger.info(`resyncing ${name} from v${state.version}`);
                    nodes.push({
                        tag: "collection",
                        attrs: {
                            name,
                            version: state.version.toString(),
                            return_snapshot: (!state.version).toString()
                        }
                    });
                }
                const result = await sock.query({
                    tag: "iq",
                    attrs: {
                        to: S_WHATSAPP_NET,
                        xmlns: "w:sync:app:state",
                        type: "set"
                    },
                    content: [
                        {
                            tag: "sync",
                            attrs: {},
                            content: nodes
                        }
                    ]
                });
                const decoded = await extractSyncdPatches(result, config?.options);
                for (const key in decoded) {
                    const name = key;
                    const { patches, hasMorePatches, snapshot } = decoded[name];
                    try {
                        if (snapshot) {
                            const { state: newState, mutationMap } = await decodeSyncdSnapshot(name, snapshot, getAppStateSyncKey, initialVersionMap[name], config.appStateMacVerification.snapshot);
                            states[name] = newState;
                            Object.assign(globalMutationMap, mutationMap);
                            config.logger.info(`restored state of ${name} from snapshot to v${newState.version} with mutations`);
                            await sock.authState.keys.set({
                                "app-state-sync-version": { [name]: newState }
                            });
                        }
                        if (patches.length) {
                            const { state: newState, mutationMap } = await decodePatches(name, patches, states[name], getAppStateSyncKey, config.options, initialVersionMap[name], config.logger, config.appStateMacVerification.patch);
                            await sock.authState.keys.set({
                                "app-state-sync-version": { [name]: newState }
                            });
                            config.logger.info(`synced ${name} to v${newState.version}`);
                            initialVersionMap[name] = newState.version;
                            Object.assign(globalMutationMap, mutationMap);
                        }
                        if (hasMorePatches) {
                            config.logger.info(`${name} has more patches...`);
                        }
                        else {
                            collectionsToHandle.delete(name);
                        }
                    }
                    catch (error) {
                        const isIrrecoverableError = attemptsMap[name] >= MAX_SYNC_ATTEMPTS ||
                            error.output?.statusCode === 404 ||
                            error.name === "TypeError";
                        config.logger.info({ name, error: error.stack }, `failed to sync state from version${isIrrecoverableError
                            ? ""
                            : ", removing and trying from scratch"}`);
                        await sock.authState.keys.set({
                            "app-state-sync-version": { [name]: null }
                        });
                        attemptsMap[name] = (attemptsMap[name] || 0) + 1;
                        if (isIrrecoverableError) {
                            collectionsToHandle.delete(name);
                        }
                    }
                }
            }
        });
        const { onMutation } = newAppStateChunkHandler(isInitialSync);
        for (const key in globalMutationMap) {
            onMutation(globalMutationMap[key]);
        }
    });
    const profilePictureUrl = async (jid, type = "preview", timeoutMs) => {
        jid = jidNormalizedUser(jid);
        if (!jid ||
            !/^\d+@s\.whatsapp\.net$/.test(jid) ||
            !/^\d+@g\.us$/.test(jid)) {
            throw new Error(`The entered jid '${jid}' is not valid, please enter the jid of a person or group to continue`);
        }
        const result = await sock.query({
            tag: "iq",
            attrs: {
                target: jid,
                to: S_WHATSAPP_NET,
                type: "get",
                xmlns: "w:profile:picture"
            },
            content: [{ tag: "picture", attrs: { type, query: "url" } }]
        }, timeoutMs);
        const child = getBinaryNodeChild(result, "picture");
        return child?.attrs?.url;
    };
    const sendPresenceUpdate = async (type, toJid) => {
        const me = sock.authState.creds.me;
        if (/^(available|unavailable)$/.test(type)) {
            if (!me.name) {
                config.logger.warn("no name present, ignoring presence update request...");
                return;
            }
            sock.ev.emit("connection.update", { isOnline: type === "available" });
            await sock.sendNode({
                tag: "presence",
                attrs: {
                    name: me.name,
                    type
                }
            });
        }
        else {
            await sock.sendNode({
                tag: "chatstate",
                attrs: {
                    from: me.id,
                    to: toJid
                },
                content: [
                    {
                        tag: type === "recording" ? "composing" : type,
                        attrs: type === "recording" ? { media: "audio" } : {}
                    }
                ]
            });
        }
    };
    const presenceSubscribe = (jid, tcToken) => sock.sendNode({
        tag: "presence",
        attrs: {
            to: jid,
            id: sock.generateMessageTag(),
            type: "subscribe"
        },
        content: tcToken
            ? [
                {
                    tag: "tctoken",
                    attrs: {},
                    content: tcToken
                }
            ]
            : undefined
    });
    const handlePresenceUpdate = ({ tag, attrs, content }) => {
        let presence;
        const jid = attrs.from;
        const participant = attrs.participant || attrs.from;
        if (config.shouldIgnoreJid(jid) && jid !== "@s.whatsapp.net") {
            return;
        }
        if (tag === "presence") {
            presence = {
                lastKnownPresence: attrs.type === "unavailable" ? "unavailable" : "available",
                lastSeen: attrs.last && attrs.last !== "deny" ? +attrs.last : undefined
            };
        }
        else if (Array.isArray(content)) {
            const [firstChild] = content;
            let type = firstChild.tag;
            if (type === "paused") {
                type = "available";
            }
            if (firstChild.attrs?.media === "audio") {
                type = "recording";
            }
            presence = { lastKnownPresence: type };
        }
        else {
            config.logger.error({ tag, attrs, content }, "recv invalid presence node");
        }
        if (presence) {
            sock.ev.emit("presence.update", {
                id: jid,
                presences: { [participant]: presence }
            });
        }
    };
    const appPatch = async (patchCreate) => {
        const name = patchCreate.type;
        const myAppStateKeyId = sock.authState.creds.myAppStateKeyId;
        if (!myAppStateKeyId) {
            throw new Boom("App state key not present", { statusCode: 400 });
        }
        let initial;
        let encodeResult;
        await processingMutex.mutex(async () => {
            await sock.authState.keys.transaction(async () => {
                config.logger.debug({ patch: patchCreate }, "applying app patch");
                await resyncAppState([name], false);
                const { [name]: currentSyncVersion } = await sock.authState.keys.get("app-state-sync-version", [name]);
                initial = currentSyncVersion || newLTHashState();
                encodeResult = await encodeSyncdPatch(patchCreate, myAppStateKeyId, initial, getAppStateSyncKey);
                const { patch, state } = encodeResult;
                const node = {
                    tag: "iq",
                    attrs: {
                        to: S_WHATSAPP_NET,
                        type: "set",
                        xmlns: "w:sync:app:state"
                    },
                    content: [
                        {
                            tag: "sync",
                            attrs: {},
                            content: [
                                {
                                    tag: "collection",
                                    attrs: {
                                        name,
                                        version: (state.version - 1).toString(),
                                        return_snapshot: "false"
                                    },
                                    content: [
                                        {
                                            tag: "patch",
                                            attrs: {},
                                            content: proto.SyncdPatch.encode(patch).finish()
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                };
                await sock.query(node);
                await sock.authState.keys.set({
                    "app-state-sync-version": { [name]: state }
                });
            });
        });
        if (config.emitOwnEvents) {
            const { onMutation } = newAppStateChunkHandler(false);
            const { mutationMap } = await decodePatches(name, [
                {
                    ...encodeResult.patch,
                    version: { version: encodeResult.state.version }
                }
            ], initial, getAppStateSyncKey, config.options, undefined, config.logger);
            for (const key in mutationMap) {
                onMutation(mutationMap[key]);
            }
        }
    };
    const fetchProps = async () => {
        const resultNode = await sock.query({
            tag: "iq",
            attrs: {
                to: S_WHATSAPP_NET,
                xmlns: "w",
                type: "get"
            },
            content: [
                {
                    tag: "props",
                    attrs: {
                        protocol: "2",
                        hash: sock.authState?.creds?.lastPropHash || ""
                    }
                }
            ]
        });
        const propsNode = getBinaryNodeChild(resultNode, "props");
        let props = {};
        if (propsNode) {
            if (propsNode.attrs?.hash) {
                sock.authState.creds.lastPropHash = propsNode?.attrs?.hash;
                sock.ev.emit("creds.update", sock.authState.creds);
            }
            props = reduceBinaryNodeToDictionary(propsNode, "prop");
        }
        config.logger.debug("fetched props");
        return props;
    };
    const chatModify = (mod, jid) => {
        const patch = chatModificationToAppPatch(mod, jid);
        return appPatch(patch);
    };
    const star = (jid, messages, star) => {
        return chatModify({
            star: {
                messages,
                star
            }
        }, jid);
    };
    const addLabel = (jid, labels) => {
        return chatModify({
            addLabel: {
                ...labels
            }
        }, jid);
    };
    const addChatLabel = (jid, labelId) => {
        return chatModify({
            addChatLabel: {
                labelId
            }
        }, jid);
    };
    const removeChatLabel = (jid, labelId) => {
        return chatModify({
            removeChatLabel: {
                labelId
            }
        }, jid);
    };
    const addMessageLabel = (jid, messageId, labelId) => {
        return chatModify({
            addMessageLabel: {
                messageId,
                labelId
            }
        }, jid);
    };
    const removeMessageLabel = (jid, messageId, labelId) => {
        return chatModify({
            removeMessageLabel: {
                messageId,
                labelId
            }
        }, jid);
    };
    const executeInitQueries = async () => {
        await Promise.all([fetchProps(), fetchBlocklist(), fetchPrivacySettings()]);
    };
    const upsertMessage = sock.ev.createBufferedFunction(async (msg, type) => {
        sock.ev.emit("messages.upsert", { messages: [msg], type });
        if (!!msg.pushName) {
            let jid = msg.key.fromMe
                ? sock.authState.creds.me.id
                : msg.key.participant || msg.key.remoteJid;
            jid = jidNormalizedUser(jid);
            if (!msg.key.fromMe) {
                sock.ev.emit("contacts.update", [
                    {
                        id: jid,
                        notify: msg.pushName,
                        verifiedName: msg.verifiedBizName
                    }
                ]);
            }
            if (msg.key.fromMe &&
                msg.pushName &&
                sock.authState.creds.me.name !== msg.pushName) {
                sock.ev.emit("creds.update", {
                    me: { ...sock.authState.creds.me, name: msg.pushName }
                });
            }
        }
        const historyMsg = getHistoryMsg(msg.message);
        const shouldProcessHistoryMsg = historyMsg
            ? config.shouldSyncHistoryMessage(historyMsg) &&
                PROCESSABLE_HISTORY_TYPES.includes(historyMsg.syncType)
            : false;
        if (historyMsg && !sock.authState.creds.myAppStateKeyId) {
            config.logger.warn("skipping app state sync, as myAppStateKeyId is not set");
            pendingAppStateSync = true;
        }
        await Promise.all([
            (async () => {
                if (historyMsg && sock.authState.creds.myAppStateKeyId) {
                    pendingAppStateSync = false;
                    await doAppStateSync();
                }
            })(),
            processMessage(msg, {
                shouldProcessHistoryMsg,
                placeholderResendCache,
                ev: sock.ev,
                creds: sock.authState.creds,
                keyStore: sock.authState.keys,
                logger: config.logger,
                options: config.options,
                getMessage: config.getMessage
            })
        ]);
        if (msg.message?.protocolMessage?.appStateSyncKeyShare &&
            pendingAppStateSync) {
            await doAppStateSync();
            pendingAppStateSync = false;
        }
        async function doAppStateSync() {
            if (!sock.authState.creds.accountSyncCounter) {
                config.logger.info("doing initial app state sync");
                await resyncAppState(ALL_WA_PATCH_NAMES, true);
                const accountSyncCounter = (sock.authState.creds.accountSyncCounter || 0) + 1;
                sock.ev.emit("creds.update", { accountSyncCounter });
                if (needToFlushWithAppStateSync) {
                    config.logger.debug("flushing with app state sync");
                    sock.ev.flush();
                }
            }
        }
    });
    sock.ws.on("CB:presence", handlePresenceUpdate);
    sock.ws.on("CB:chatstate", handlePresenceUpdate);
    sock.ws.on("CB:ib,,dirty", async (node) => {
        const { attrs } = getBinaryNodeChild(node, "dirty");
        const type = attrs.type;
        switch (type) {
            case "account_sync":
                if (attrs.timestamp) {
                    let { lastAccountSyncTimestamp } = sock.authState.creds;
                    if (lastAccountSyncTimestamp) {
                        await cleanDirtyBits("account_sync", lastAccountSyncTimestamp);
                    }
                    lastAccountSyncTimestamp = +attrs.timestamp;
                    sock.ev.emit("creds.update", { lastAccountSyncTimestamp });
                }
                break;
            case "groups":
                break;
            default:
                config.logger.info({ node }, "received unknown sync");
                break;
        }
    });
    sock.ev.on("connection.update", ({ connection, receivedPendingNotifications }) => {
        if (connection === "open") {
            if (config.fireInitQueries) {
                executeInitQueries().catch((error) => sock.onUnexpectedError(error, "init queries"));
            }
            sendPresenceUpdate(config.markOnlineOnConnect ? "available" : "unavailable").catch((error) => sock.onUnexpectedError(error, "presence update requests"));
        }
        if (receivedPendingNotifications &&
            !sock.authState.creds?.myAppStateKeyId) {
            sock.ev.buffer();
            needToFlushWithAppStateSync = true;
        }
    });
    return {
        ...sock,
        processingMutex,
        fetchPrivacySettings,
        upsertMessage,
        appPatch,
        sendPresenceUpdate,
        presenceSubscribe,
        profilePictureUrl,
        onWhatsApp,
        fetchBlocklist,
        fetchStatus,
        fetchDisappearingDuration,
        updateProfilePicture,
        removeProfilePicture,
        updateProfileStatus,
        updateProfileName,
        updateBlockStatus,
        updateCallPrivacy,
        updateLastSeenPrivacy,
        updateOnlinePrivacy,
        updateProfilePicturePrivacy,
        updateStatusPrivacy,
        updateReadReceiptsPrivacy,
        updateGroupsAddPrivacy,
        updateDefaultDisappearingMode,
        getBusinessProfile,
        resyncAppState,
        chatModify,
        cleanDirtyBits,
        addLabel,
        addChatLabel,
        removeChatLabel,
        addMessageLabel,
        removeMessageLabel,
        star
    };
};
